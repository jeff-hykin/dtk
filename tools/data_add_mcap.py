"""`dtk data add` on an .mcap: run modules over a recording's streams and append their outputs to it.

A StreamModule (one In, one Out, a `pipeline` over a memory Stream) runs OFFLINE: its
pipeline is applied straight to the recorded stream, as fast as the module can go,
with no transport and no clock. Every input message reaches it and every output lands,
whatever their size -- a global map of tens of megabytes included, which a network
transport would drop.

Outputs go into the same file through the dimos mcap appender, which writes past the
old data and rewrites only the summary. A payload type ROS has a message for
(PointCloud2, Image, Odometry, ...) goes in as a ROS 2 CDR channel, so Foxglove and
every ROS tool can read it; anything else goes in as a dimos observation envelope.

Two spec fields exist for this path:

    "config": {...}           keyword arguments for the module, e.g. {"emit_every": 78}
    "frame": "odom"           register every point cloud input into this frame through
                              the recording's own /tf before the module sees it (a
                              Point-LIO scan is recorded in the sensor frame, and a
                              mapper wants the world)

`overwrite` moves the old topic to /_delete_me_<topic> first and drops it once the new
one is written, like the .db path does.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
MCAP_EDIT = HERE / "mcap_edit.py"
DELETE_PREFIX = "_delete_me_"


def topic_of(name: str) -> str:
    return name if name.startswith("/") else "/" + name


def mcap_topics(path: Path) -> dict[str, int]:
    from mcap.reader import make_reader

    with open(path, "rb") as f:
        summary = make_reader(f).get_summary()
    counts = summary.statistics.channel_message_counts
    return {c.topic: counts.get(cid, 0) for cid, c in summary.channels.items()}


def mcap_edit(path: Path, *args: str) -> None:
    result = subprocess.run([sys.executable, str(MCAP_EDIT), str(path), *args])
    if result.returncode != 0:
        sys.exit(f"mcap_edit {' '.join(args)} failed on {path}")


def open_store(path: Path):
    """The recording as a dimos store, its ROS channels decoded to dimos messages."""
    try:
        from dimos.teleop.memory_world.recording import open_ros2_mcap
    except ImportError:
        sys.exit(
            "this dimos has no ROS 2 mcap reader (dimos.teleop.memory_world.recording."
            "open_ros2_mcap); run from a checkout that has one"
        )
    return open_ros2_mcap(path)


def is_stream_module(module_class) -> bool:
    try:
        from dimos.memory.module import StreamModule
    except ImportError:
        return False
    return isinstance(module_class, type) and issubclass(module_class, StreamModule)


class RegisterInto:
    """A memory transformer: each point cloud comes out in `frame`, via the recording's tf."""

    def __init__(self, frame: str, tf, tolerance: float = 0.2) -> None:
        self.frame, self.tf, self.tolerance = frame, tf, tolerance
        self.missed = 0

    def __call__(self, upstream):
        from dimos.msgs.sensor_msgs.PointCloud2 import PointCloud2

        for obs in upstream:
            cloud = obs.data
            if cloud.frame_id == self.frame:
                yield obs
                continue
            # the cloud's own stamp, not the time it was logged: a scan is logged after it
            # was taken, and looking it up at the log time smears it by the latency
            stamp = cloud.ts if getattr(cloud, "ts", None) else obs.ts
            transform = self.tf.get(self.frame, cloud.frame_id, stamp, self.tolerance)
            if transform is None:
                self.missed += 1
                continue
            matrix = transform.to_matrix()
            points = cloud.points_f32() @ matrix[:3, :3].T.astype(np.float32) + matrix[:3, 3].astype(np.float32)
            yield obs.derive(
                data=PointCloud2.from_numpy(np.ascontiguousarray(points, dtype=np.float32), frame_id=self.frame, timestamp=stamp)
            )


def ros_writer_for(payload_type):
    """(ros type name, dimos payload -> CDR bytes) when ROS has a message for this type."""
    import db_to_mcap as ros  # the converters `dtk data to_mcap` uses

    name = getattr(payload_type, "__name__", "")
    if name not in ros.CONVERTERS:
        return None
    ros_type, convert = ros.CONVERTERS[name]

    def encode(payload, seconds):
        return bytes(ros.typestore.serialize_cdr(convert(payload, seconds), ros_type))

    definition, _ = ros.typestore.generate_msgdef(ros_type)
    return ros_type, definition.encode(), encode


def run(arguments, specs) -> None:
    recording: Path = arguments.recording
    sys.path.insert(0, str(HERE))
    prefix = arguments.namespace or ""
    present = mcap_topics(recording)

    plans = []
    for spec in specs:
        outputs = {stream: topic_of(prefix + name) for stream, name in spec["outputs"].items()}
        clashes = [t for t in outputs.values() if t in present]
        if clashes and not spec["overwrite"]:
            sys.exit(f"{', '.join(clashes)} already exist; set \"overwrite\": true to replace them")
        plans.append({"spec": spec, "outputs": outputs, "clashes": clashes})

    print(f"{recording}  (mcap)")
    for plan in plans:
        spec = plan["spec"]
        print(f"  {spec['module']}  config={spec.get('config') or {}}")
        for stream, name in spec["inputs"].items():
            missing = "" if topic_of(name) in present else "   (NOT IN THIS RECORDING)"
            frame = f"  registered into {spec['frame']!r}" if spec.get("frame") else ""
            print(f"    in   {stream:<20} <- {topic_of(name)}{missing}{frame}")
        for stream, topic in plan["outputs"].items():
            note = "  (replacing)" if topic in plan["clashes"] else ""
            print(f"    out  {stream:<20} -> {topic}{note}")
    missing = [topic_of(n) for p in plans for n in p["spec"]["inputs"].values() if topic_of(n) not in present]
    if missing:
        sys.exit(f"these input topics are not in the recording: {', '.join(sorted(set(missing)))}")
    if arguments.dry_run:
        print("dry run: nothing written")
        return
    if not arguments.yes:
        if input("Run it? [y/N] ").strip().lower() not in ("y", "yes"):
            print("aborted")
            return

    from data_add import load_class, stream_payload_types

    try:
        # Appending while the module reads the same file is only safe with a mcap store
        # whose flush and summary reads share a lock; before that, a read landing between
        # a chunk write and the next flush tore the file's footer.
        from dimos.memory.store.mcap_append import load_summary  # noqa: F401
    except ImportError:
        sys.exit("this dimos's mcap appender can tear a file that is read while it appends; "
                 "run from a checkout that has dimos.memory.store.mcap_append.load_summary")
    from dimos.core.global_config import global_config

    for plan in plans:
        spec = plan["spec"]
        module_class = load_class(spec["module"])
        if not is_stream_module(module_class):
            sys.exit(
                f"{module_class.__name__} is not a StreamModule; on an .mcap only StreamModules "
                "run (offline, through their pipeline). Convert to a .db for a live replay."
            )
        if len(spec["inputs"]) != 1 or len(spec["outputs"]) != 1:
            sys.exit("a StreamModule has exactly one input and one output; map exactly one of each")
        (in_stream, source), = spec["inputs"].items()
        (out_stream, target), = plan["outputs"].items()
        payload_types = stream_payload_types(module_class)
        if in_stream not in payload_types or out_stream not in payload_types:
            sys.exit(f"{module_class.__name__} has no {in_stream!r} input or no {out_stream!r} output")

        for topic in plan["clashes"]:
            moved = "/" + DELETE_PREFIX + topic.lstrip("/")
            mcap_edit(recording, "--rename", f"{topic}={moved}")

        store = open_store(recording)
        try:
            from dimos.memory.store.mcap_append import ChannelSpec, McapAppender

            stream_name = next(n for n in store.list_streams() if store._stream_topic.get(n) == topic_of(source))
            upstream = store.stream(stream_name, payload_types[in_stream])
            register = None
            if spec.get("frame"):
                from dimos.memory.tf import StreamTF

                register = RegisterInto(spec["frame"], StreamTF.from_store(store))
                upstream = upstream.transform(register)
            module = module_class(g=global_config, **(spec.get("config") or {}))
            outputs = module._apply_pipeline(upstream)

            writer = ros_writer_for(payload_types[out_stream])
            written = 0
            with McapAppender(recording) as appender:
                if writer is not None:
                    ros_type, schema_data, encode = writer
                    channel = appender.add_channel(ChannelSpec(
                        target, "cdr", schema_name=ros_type, schema_encoding="ros2msg", schema_data=schema_data,
                        metadata={"dtk.data_add.module": spec["module"]},
                    ))
                    for obs in outputs:
                        at = int(round(obs.ts * 1e9))
                        appender.add_message(channel, log_time=at, publish_time=at, data=encode(obs.data, obs.ts))
                        written += 1
                        if written % 10 == 0:
                            print(f"    {written:,} {target}", flush=True)
            if writer is None:
                # no ROS message for it: a dimos observation envelope, through the store
                sink = store.stream(target.lstrip("/"), payload_types[out_stream])
                for obs in outputs:
                    sink.append(obs.data, ts=obs.ts, pose=obs.pose, tags=obs.tags)
                    written += 1
            try:
                module.stop()
            except Exception:
                pass
        finally:
            store.stop()

        if register is not None and register.missed:
            print(f"  {register.missed:,} input(s) had no tf into {spec['frame']!r} and were skipped")
        print(f"  wrote {written:,} message(s) to {target}")
        if written == 0:
            print("nothing came out, so any replaced topic is being kept under its _delete_me_ name")
            continue
        for topic in plan["clashes"]:
            mcap_edit(recording, "--delete", "/" + DELETE_PREFIX + topic.lstrip("/"))
