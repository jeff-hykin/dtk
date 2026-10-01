"""`dtk data add` on an .mcap: run modules over a recording's streams and append their outputs to it.

dimos supplies the module and nothing else. Reading the recording, decoding its ROS 2
messages, looking frames up in its /tf, encoding the outputs and appending them are all
done here, so this works from any dimos checkout that has the module -- main included.

A StreamModule (one In, one Out, a `pipeline` over a memory Stream) runs OFFLINE: its
pipeline is applied straight to the recorded messages, as fast as the module can go,
with no transport and no clock. Every input message reaches it and every output lands,
whatever their size -- a global map of tens of megabytes included, which a network
transport would drop. The module object is never constructed: that would open an RPC
transport. Its pipeline runs against its config alone.

The recording is not touched until the module has finished. Outputs are written to a
scratch .mcap beside it as ROS 2 CDR, then copied in with `mcap_edit --copy-topic-from`,
which appends past the old data and rewrites only the summary, and verifies the result.

Two spec fields exist for this path:

    "config": {...}           the module's config, e.g. {"emit_every": 78}
    "frame": "odom"           register every point cloud input into this frame through
                              the recording's own tf before the module sees it (a
                              Point-LIO scan is recorded in the sensor frame, and a
                              mapper wants the world)

`overwrite` moves the old topic to _delete_me_<topic> first and drops it once the new
one is in, like the .db path does; if the copy fails it is moved back.
"""

from __future__ import annotations

import bisect
import subprocess
import sys
import typing
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
MCAP_EDIT = HERE / "mcap_edit.py"
DELETE_PREFIX = "_delete_me_"
TF_TOPICS = ("tf", "/tf", "tf_static", "/tf_static")


def topic_of(name: str) -> str:
    return name if name.startswith("/") else "/" + name


def resolve_topic(name: str, present) -> str:
    """The recording's own spelling of a topic: dimos writes `/lidar`, web_ctrl writes `lidar`."""
    for candidate in (name, topic_of(name), name.lstrip("/")):
        if candidate in present:
            return candidate
    return topic_of(name)


def moved_name(topic: str) -> str:
    slash = "/" if topic.startswith("/") else ""
    return slash + DELETE_PREFIX + topic.lstrip("/")


def mcap_topics(path: Path) -> dict[str, str]:
    """topic -> schema name, from the summary alone."""
    from mcap_edit import Mcap

    mcap = Mcap(path)
    topics = {c.topic: mcap.schemas.get(c.schema_id, "") for c in mcap.channels.values()}
    mcap.file.close()
    return topics


def mcap_edit(path: Path, *args: str) -> bool:
    return subprocess.run([sys.executable, str(MCAP_EDIT), str(path), *args]).returncode == 0


# ---------------------------------------------------------------- tf, from the recording

def quaternion_matrix(qx, qy, qz, qw) -> np.ndarray:
    return np.array([
        [1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw), 2 * (qx * qz + qy * qw)],
        [2 * (qx * qy + qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qx * qw)],
        [2 * (qx * qz - qy * qw), 2 * (qy * qz + qx * qw), 1 - 2 * (qx * qx + qy * qy)],
    ])


def pose_matrix(pose) -> np.ndarray:
    x, y, z, qx, qy, qz, qw = pose
    norm = (qx * qx + qy * qy + qz * qz + qw * qw) ** 0.5 or 1.0
    matrix = np.eye(4)
    matrix[:3, :3] = quaternion_matrix(qx / norm, qy / norm, qz / norm, qw / norm)
    matrix[:3, 3] = (x, y, z)
    return matrix


def interpolate(before, after, fraction):
    """Linear in translation, normalised-lerp in rotation (the samples are milliseconds apart)."""
    translation = [a + (b - a) * fraction for a, b in zip(before[:3], after[:3])]
    q0, q1 = before[3:], after[3:]
    if sum(a * b for a, b in zip(q0, q1)) < 0:
        q1 = [-b for b in q1]
    q = [a + (b - a) * fraction for a, b in zip(q0, q1)]
    norm = sum(v * v for v in q) ** 0.5 or 1.0
    return (*translation, *(v / norm for v in q))


class RecordedTf:
    """Every tf edge in the recording, looked up at a time. One parent per frame (the last
    one seen wins); an edge published once is static; otherwise the two samples around the
    time are interpolated, or the nearest one within `tolerance` is used."""

    def __init__(self, samples, tolerance: float = 0.2) -> None:
        self.tolerance = tolerance
        self.parent = {}
        self.edges = {}
        for stamp, parent, child, pose in sorted(samples, key=lambda sample: sample[0]):
            self.parent[child] = parent
            times, poses = self.edges.setdefault((parent, child), ([], []))
            times.append(stamp)
            poses.append(pose)

    def edge_at(self, parent, child, stamp):
        times, poses = self.edges[(parent, child)]
        if len(times) == 1:
            return poses[0]
        at = bisect.bisect_left(times, stamp)
        if 0 < at < len(times) and times[at] - times[at - 1] <= 1.0:
            span = times[at] - times[at - 1]
            return interpolate(poses[at - 1], poses[at], (stamp - times[at - 1]) / span if span else 0.0)
        nearest = min((i for i in (at - 1, at) if 0 <= i < len(times)), key=lambda i: abs(times[i] - stamp))
        return poses[nearest] if abs(times[nearest] - stamp) <= self.tolerance else None

    def to_root(self, frame, stamp):
        """(root frame, 4x4 of `frame` in it), or None when an edge on the way has no sample near `stamp`."""
        matrix = np.eye(4)
        seen = set()
        while frame in self.parent and frame not in seen:
            seen.add(frame)
            pose = self.edge_at(self.parent[frame], frame, stamp)
            if pose is None:
                return None
            matrix = pose_matrix(pose) @ matrix
            frame = self.parent[frame]
        return frame, matrix

    def lookup(self, target, source, stamp):
        """4x4 taking a point in `source` to `target` at `stamp`, or None."""
        a, b = self.to_root(target, stamp), self.to_root(source, stamp)
        if a is None or b is None or a[0] != b[0]:
            return None
        return np.linalg.inv(a[1]) @ b[1]


def read_tf(path: Path, present) -> RecordedTf:
    from mcap.reader import make_reader
    from mcap_edit import read_tf_message

    topics = [t for t in TF_TOPICS if t in present]
    samples = []
    with open(path, "rb") as f:
        for _, _, message in make_reader(f).iter_messages(topics=topics):
            for (sec, nsec), parent, child, pose in read_tf_message(message.data):
                samples.append((sec + nsec * 1e-9, parent, child, pose))
    return RecordedTf(samples)


# ---------------------------------------------------------------- ROS 2 <-> dimos

POINT_DTYPES = {1: "i1", 2: "u1", 3: "i2", 4: "u2", 5: "i4", 6: "u4", 7: "f4", 8: "f8"}


def decode_pointcloud(ros_cloud):
    """A sensor_msgs/PointCloud2 as a dimos PointCloud2: x, y, z and intensity when it has one."""
    from dimos.msgs.sensor_msgs.PointCloud2 import PointCloud2

    count = ros_cloud.width * ros_cloud.height
    order = ">" if ros_cloud.is_bigendian else "<"
    fields = {f.name: f for f in ros_cloud.fields}
    raw = np.frombuffer(bytes(ros_cloud.data), dtype=np.uint8)[: count * ros_cloud.point_step]

    def column(name):
        field = fields[name]
        dtype = np.dtype(order + POINT_DTYPES[field.datatype])
        view = np.ndarray((count,), dtype=dtype, buffer=raw, offset=field.offset, strides=(ros_cloud.point_step,))
        return view.astype(np.float32)

    points = np.stack([column("x"), column("y"), column("z")], axis=1) if count else np.zeros((0, 3), np.float32)
    keep = np.isfinite(points).all(axis=1)
    intensities = column("intensity")[keep] if count and "intensity" in fields else None
    stamp = ros_cloud.header.stamp.sec + ros_cloud.header.stamp.nanosec * 1e-9
    return PointCloud2.from_numpy(
        np.ascontiguousarray(points[keep]), frame_id=ros_cloud.header.frame_id, timestamp=stamp, intensities=intensities
    )


DECODERS = {"PointCloud2": ("sensor_msgs/msg/PointCloud2", decode_pointcloud)}


def register(cloud, frame, tf: RecordedTf):
    """The cloud in `frame`, via the recording's tf at the cloud's own stamp -- not the time it
    was logged: a scan is logged after it was taken, and the log time smears it by the latency."""
    from dimos.msgs.sensor_msgs.PointCloud2 import PointCloud2

    if cloud.frame_id == frame:
        return cloud
    matrix = tf.lookup(frame, cloud.frame_id, cloud.ts)
    if matrix is None:
        return None
    points = cloud.points_f32() @ matrix[:3, :3].T.astype(np.float32) + matrix[:3, 3].astype(np.float32)
    return PointCloud2.from_numpy(
        np.ascontiguousarray(points, dtype=np.float32), frame_id=frame, timestamp=cloud.ts,
        intensities=cloud.intensities_f32(),
    )


class RecordedSource:
    """Just enough of a memory Backend for a Stream to iterate: the decoded input messages, in log-time order."""

    def __init__(self, name, data_type, observations) -> None:
        self.name, self.data_type, self._observations = name, data_type, observations

    def iterate(self, query):
        return query.apply(iter(self._observations), live=False)

    def dispose(self) -> None:
        pass


class Counts:
    read = 0
    no_tf = 0
    empty = 0


def recorded_observations(path: Path, topic, payload_type, frame, tf, counts: Counts):
    from mcap.reader import make_reader
    from dimos.memory.type.observation import Observation
    import db_to_mcap as ros

    ros_type, decode = DECODERS[payload_type.__name__]
    with open(path, "rb") as f:
        for index, (_, _, message) in enumerate(make_reader(f).iter_messages(topics=[topic], log_time_order=True)):
            payload = decode(ros.typestore.deserialize_cdr(message.data, ros_type))
            counts.read += 1
            if frame:
                payload = register(payload, frame, tf)
                if payload is None:
                    counts.no_tf += 1
                    continue
            yield Observation(id=index, ts=message.log_time / 1e9, data_type=payload_type, _data=payload)


# ---------------------------------------------------------------- the module

def is_stream_module(module_class) -> bool:
    try:
        from dimos.memory.module import StreamModule
    except ImportError:
        return False
    return isinstance(module_class, type) and issubclass(module_class, StreamModule)


def module_pipeline(module_class, config):
    """The module's pipeline as a function of a stream, without constructing the module."""
    config_class = typing.get_type_hints(module_class).get("config")
    if config_class is None:
        sys.exit(f"{module_class.__name__} has no `config` annotation to build its config from")
    stand_in = module_class.__new__(module_class)
    stand_in.config = config_class(**(config or {}))
    return lambda stream: module_class._apply_pipeline(stand_in, stream)


# ---------------------------------------------------------------- the run

def plan_specs(arguments, specs, present):
    prefix = arguments.namespace or ""
    plans = []
    for spec in specs:
        outputs = {stream: resolve_topic(prefix + name, present) for stream, name in spec["outputs"].items()}
        clashes = [t for t in outputs.values() if t in present]
        if clashes and not spec["overwrite"]:
            sys.exit(f"{', '.join(clashes)} already exist; set \"overwrite\": true to replace them")
        inputs = {stream: resolve_topic(name, present) for stream, name in spec["inputs"].items()}
        plans.append({"spec": spec, "inputs": inputs, "outputs": outputs, "clashes": clashes})
    return plans


def check_plan(plan, present):
    """Everything that can fail before the recording is touched, so nothing is left half-edited."""
    from data_add import load_class, stream_payload_types
    import db_to_mcap as ros

    spec = plan["spec"]
    module_class = load_class(spec["module"])
    if not is_stream_module(module_class):
        sys.exit(f"{module_class.__name__} is not a StreamModule; on an .mcap only StreamModules "
                 "run (offline, through their pipeline). Convert to a .db for a live replay.")
    if len(plan["inputs"]) != 1 or len(plan["outputs"]) != 1:
        sys.exit("a StreamModule has exactly one input and one output; map exactly one of each")
    (in_stream, source), = plan["inputs"].items()
    (out_stream, target), = plan["outputs"].items()
    payload_types = stream_payload_types(module_class)
    if in_stream not in payload_types or out_stream not in payload_types:
        sys.exit(f"{module_class.__name__} has no {in_stream!r} input or no {out_stream!r} output")
    in_type, out_type = payload_types[in_stream], payload_types[out_stream]
    if in_type.__name__ not in DECODERS:
        sys.exit(f"reading {in_type.__name__} from an .mcap is not written yet (only {', '.join(DECODERS)})")
    if present[source] != DECODERS[in_type.__name__][0]:
        sys.exit(f"{source} holds {present[source] or 'no schema'}, and {in_stream} wants {DECODERS[in_type.__name__][0]}")
    if out_type.__name__ not in ros.CONVERTERS:
        sys.exit(f"{out_type.__name__} has no ROS 2 message to write it as")
    if spec.get("frame") and in_type.__name__ != "PointCloud2":
        sys.exit("\"frame\" registers point clouds; this input is not one")
    return module_class, in_type, out_type, source, target, module_pipeline(module_class, spec.get("config"))


def run_one(recording: Path, plan, present, tf) -> None:
    from mcap.writer import CompressionType, Writer
    from dimos.memory.stream import Stream
    import db_to_mcap as ros

    spec = plan["spec"]
    module_class, in_type, out_type, source, target, pipeline = check_plan(plan, present)
    counts = Counts()
    observations = recorded_observations(recording, source, in_type, spec.get("frame"), tf, counts)
    outputs = pipeline(Stream(RecordedSource(source, in_type, observations)))

    ros_type, convert = ros.CONVERTERS[out_type.__name__]
    definition, _ = ros.typestore.generate_msgdef(ros_type)
    scratch = recording.with_name(f".{recording.stem}.data_add.{target.strip('/').replace('/', '_')}.mcap")
    written = 0
    try:
        with open(scratch, "wb") as out:
            writer = Writer(out, compression=CompressionType.NONE)
            writer.start()
            schema = writer.register_schema(ros_type, "ros2msg", definition.encode())
            channel = writer.register_channel(target, "cdr", schema, metadata={"dtk.data_add.module": spec["module"]})
            for obs in outputs:
                at = int(round(obs.ts * 1e9))
                data = bytes(ros.typestore.serialize_cdr(convert(obs.data, obs.ts), ros_type))
                writer.add_message(channel, log_time=at, publish_time=at, data=data)
                written += 1
                if written % 10 == 0:
                    print(f"    {written:,} {target}  ({counts.read:,} {source} read)", flush=True)
            writer.finish()

        if counts.no_tf:
            print(f"  {counts.no_tf:,} of {counts.read:,} input(s) had no tf into {spec['frame']!r} and were skipped")
        print(f"  {written:,} message(s) for {target} from {counts.read:,} {source}")
        if written == 0:
            print("  nothing came out; the recording is unchanged")
            return

        for topic in plan["clashes"]:
            if not mcap_edit(recording, "--rename", f"{topic}={moved_name(topic)}"):
                sys.exit(f"could not move {topic} aside; the recording is unchanged")
        if not mcap_edit(recording, "--copy-topic-from", f"{scratch}:{target}"):
            for topic in plan["clashes"]:
                mcap_edit(recording, "--rename", f"{moved_name(topic)}={topic}")
            sys.exit(f"appending {target} failed; the old topic is back under its own name")
        for topic in plan["clashes"]:
            mcap_edit(recording, "--delete", moved_name(topic))
    finally:
        scratch.unlink(missing_ok=True)


def run(arguments, specs) -> None:
    recording: Path = arguments.recording
    sys.path.insert(0, str(HERE))
    sys.stdout.reconfigure(line_buffering=True)  # interleave with mcap_edit's own output
    present = mcap_topics(recording)
    plans = plan_specs(arguments, specs, present)

    print(f"{recording}  (mcap)")
    for plan in plans:
        spec = plan["spec"]
        print(f"  {spec['module']}  config={spec.get('config') or {}}")
        for stream, topic in plan["inputs"].items():
            missing = "" if topic in present else "   (NOT IN THIS RECORDING)"
            frame = f"  registered into {spec['frame']!r}" if spec.get("frame") else ""
            print(f"    in   {stream:<20} <- {topic}{missing}{frame}")
        for stream, topic in plan["outputs"].items():
            note = "  (replacing)" if topic in plan["clashes"] else ""
            print(f"    out  {stream:<20} -> {topic}{note}")
    missing = [t for p in plans for t in p["inputs"].values() if t not in present]
    if missing:
        sys.exit(f"these input topics are not in the recording: {', '.join(sorted(set(missing)))}")
    try:
        import db_to_mcap  # noqa: F401  the ROS types, for reading and writing
    except ImportError as error:
        sys.exit(f"cannot read or write ROS 2 messages ({error}); this python needs mcap and rosbags")
    for plan in plans:
        check_plan(plan, present)
    if arguments.dry_run:
        print("dry run: nothing written")
        return
    if not arguments.yes:
        if input("Run it? [y/N] ").strip().lower() not in ("y", "yes"):
            print("aborted")
            return

    tf = read_tf(recording, present) if any(p["spec"].get("frame") for p in plans) else None
    for plan in plans:
        run_one(recording, plan, present, tf)
        present = mcap_topics(recording)
