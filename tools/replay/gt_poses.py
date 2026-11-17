"""Ground-truth pose per keyframe, as a world <- world correction applied to the keyframe's raw (odometry) pose.

Sources, as specs (a list is tried in order):
  {"db": path, "tf": ["map", "odom"]}       the Map Editor icp_stitch edge, which IS the correction C(t)
  {"db": path, "stream": "odometry_corrected", "odom_stream": "pointlio_odometry", "direct": true, "body_tf": "tf"}
      a corrected odometry track; "direct" places each keyframe by the corrected pose at its own time (a correction
      interpolated between samples swings far keyframes by its rotation error); "body_tf": "tf" re-expresses the
      corrected stream in the odometry's frame when the two name different frames.
gt(kf) is re-anchored by heading at the first sample, so GT starts where the runs' maps start.
`auto_specs` picks the source for a recording: a Point-LIO corrected stream first, else the map->odom / world->odom tf."""
from pathlib import Path

import numpy as np
from scipy.spatial.transform import Rotation as R, Slerp

from store import SqliteStore

# Point-LIO's post-processed corrected tracks, best first
POINTLIO_CORRECTED = ("odometry_corrected", "pointlio_odometry_corrected")
TF_CORRECTIONS = (("map", "odom"), ("world", "odom"))


def _table(rows):
    a = np.array(rows, dtype=float)
    return a[np.unique(a[:, 0], return_index=True)[1]]


def _interp(a, ts):
    ts = np.clip(ts, a[0, 0], a[-1, 0])
    rotation = Slerp(a[:, 0], R.from_quat(a[:, 4:]))(ts) if len(a) > 1 else R.from_quat(np.repeat(a[:, 4:], len(ts), 0))
    return rotation, np.stack([np.interp(ts, a[:, 0], a[:, k]) for k in (1, 2, 3)], 1)


def pose_rows(stream):
    rows = []
    for o in stream.order_by("ts"):
        p = o.data.pose if hasattr(o.data, "pose") and hasattr(o.data.pose, "position") else o.data
        rows.append((o.ts, p.position.x, p.position.y, p.position.z, p.orientation.x, p.orientation.y, p.orientation.z, p.orientation.w))
    return _table(rows) if rows else None


def _tf_rows(store, parent, child):
    rows = []
    for message in store.stream("tf").tags(child_frame=child).order_by("ts"):
        for tr in message.data.transforms:
            if tr.frame_id.lstrip("/") == parent and tr.child_frame_id.lstrip("/") == child:
                t, q = tr.translation, tr.rotation
                rows.append((message.ts, t.x, t.y, t.z, q.x, q.y, q.z, q.w))
    return rows


def _correction_from_tf(spec):
    parent, child = spec["tf"]
    with SqliteStore(path=str(spec["db"])) as store:
        if "tf" not in store.list_streams():
            return None
        rows = _tf_rows(store, parent, child)
    if len(rows) < 2:
        return None
    return _table(rows), f"tf {parent}->{child} ({len(rows)} samples)"


def child_frame(stream):
    first = next(iter(stream.order_by("ts").limit(1)), None)
    return getattr(first.data, "child_frame_id", None) if first else None


def tf_edges(store, log=print):
    """First sample of every edge in the db's tf streams (tf, tf_static, tf_*): {(parent, child): (rotation, translation)},
    each also stored inverted."""
    edges = {}
    for name in [n for n in store.list_streams() if n == "tf" or n.startswith("tf_")]:
        try:
            for message in store.stream(name).order_by("ts").limit(5000):
                for tr in message.data.transforms:
                    parent, child = tr.frame_id.lstrip("/"), tr.child_frame_id.lstrip("/")
                    if (parent, child) not in edges:
                        t, q = tr.translation, tr.rotation
                        pose = (R.from_quat([q.x, q.y, q.z, q.w]), np.array([t.x, t.y, t.z]))
                        edges[(parent, child)] = pose
                        edges[(child, parent)] = (pose[0].inv(), -pose[0].inv().apply(pose[1]))
        except Exception as error:  # a tf stream of another message type: skip it, the chain search still fails loudly
            log(f"tf stream {name} unreadable ({type(error).__name__})")
    return edges


def static_chain(edges, source, target):
    """Pose of `target` in `source` (rotation, translation), or None when the tf has no chain between them."""
    paths = {source: (R.identity(), np.zeros(3))}
    frontier = [source]
    while frontier and target not in paths:
        frame = frontier.pop(0)
        for (parent, child), (rotation, translation) in edges.items():
            if parent == frame and child not in paths:
                base_rotation, base_translation = paths[frame]
                paths[child] = (base_rotation * rotation, base_translation + base_rotation.apply(translation))
                frontier.append(child)
    return paths.get(target)


def _correction_from_stream(spec):
    with SqliteStore(path=str(spec["db"])) as store:
        if spec["stream"] not in store.list_streams():
            return None
        corrected = pose_rows(store.stream(spec["stream"]))
        if spec.get("body_tf") == "tf" and corrected is not None:
            body_frame = (child_frame(store.stream(spec["odom_stream"])) or "").lstrip("/")
            sensor_frame = (child_frame(store.stream(spec["stream"])) or "").lstrip("/")
            if sensor_frame and body_frame and sensor_frame != body_frame:
                chain = static_chain(tf_edges(store), sensor_frame, body_frame)
                if chain is None:
                    raise SystemExit(f"gt: {spec['stream']} is in {sensor_frame}, the odometry in {body_frame}, and the tf joins neither")
                body_rotation, body_translation = chain
                sensor_rotation = R.from_quat(corrected[:, 4:])
                corrected[:, 1:4] += sensor_rotation.apply(body_translation)
                corrected[:, 4:] = (sensor_rotation * body_rotation).as_quat()
        odom = pose_rows(store.stream(spec["odom_stream"]))
    if corrected is None or odom is None:
        return None
    if spec.get("direct"):
        return {"corrected": corrected, "odom": odom}, f"stream {spec['stream']} ({len(corrected)} samples, direct)"
    odom_rotation, odom_translation = _interp(odom, corrected[:, 0])
    rotation = R.from_quat(corrected[:, 4:]) * odom_rotation.inv()
    translation = corrected[:, 1:4] - rotation.apply(odom_translation)
    return np.concatenate([corrected[:, :1], translation, rotation.as_quat()], 1), f"stream {spec['stream']} ({len(corrected)} samples)"


def auto_specs(db, odom_stream, log=print):
    """The GT source for a recording: a Point-LIO corrected stream, else the db's map->odom / world->odom tf, else none.
    Says which, and says so when it had to fall back."""
    with SqliteStore(path=str(db)) as store:
        streams = set(store.list_streams())
        for name in POINTLIO_CORRECTED:
            if name in streams:
                log(f"gt: Point-LIO corrected stream {name}")
                return [{"db": str(db), "stream": name, "odom_stream": odom_stream, "body_tf": "tf", "direct": True}]
        others = sorted(n for n in streams if n.endswith("_corrected"))
        if "tf" in streams:
            for parent, child in TF_CORRECTIONS:
                if len(_tf_rows(store, parent, child)) >= 2:
                    log(f"gt: NO Point-LIO corrected stream in this db; falling back to its tf {parent}->{child}"
                        + (f" (it also has {', '.join(others)}, not used: --gt-stream picks one)" if others else ""))
                    return [{"db": str(db), "tf": [parent, child]}]
    log("gt: NONE: no Point-LIO corrected stream and no map->odom / world->odom tf"
        + (f" (it has {', '.join(others)}: --gt-stream {others[0]} uses it)" if others else ""))
    return []


def correction(gt_specs):
    """(table, description) from the first spec that works, or None."""
    specs = gt_specs if isinstance(gt_specs, list) else [gt_specs] if gt_specs else []
    for spec in specs:
        spec = {k: str(Path(v).expanduser()) if k.endswith("db") else v for k, v in spec.items()}
        if not Path(spec["db"]).exists():
            continue
        found = _correction_from_tf(spec) if "tf" in spec else _correction_from_stream(spec)
        if found is not None:
            return found
    return None


def gt_poses(found, ts, raw):
    """(N, 7) GT xyz + xyzw for poses at ts with raw (odometry-frame) poses (N, 7); NaN outside the GT's time span."""
    table, _ = found
    ts = np.asarray(ts, float)
    if isinstance(table, dict):
        return _gt_direct(table, ts, raw)
    c_rotation, c_translation = _interp(table, ts)
    anchor_rotation, anchor_translation = _interp(table, table[:1, 0])
    # re-anchor by heading only: another sensor's correction carries its mount tilt, which would tip the GT out of level
    anchor_inv = R.from_euler("z", anchor_rotation.as_euler("ZYX")[:, 0]).inv()
    rotation = anchor_inv * c_rotation * R.from_quat(raw[:, 3:])
    xyz = anchor_inv.apply(c_rotation.apply(raw[:, :3]) + c_translation - anchor_translation)
    out = np.concatenate([xyz, rotation.as_quat()], 1)
    out[(ts < table[0, 0] - 1.0) | (ts > table[-1, 0] + 1.0)] = np.nan
    return out


def _gt_direct(tables, ts, raw):
    """GT = corrected(t) * (odom(t)^-1 * raw): the pose's offset from the odometry carried onto the corrected pose."""
    corrected, odom = tables["corrected"], tables["odom"]
    c_rotation, c_translation = _interp(corrected, ts)
    o_rotation, o_translation = _interp(odom, ts)
    rel_rotation = o_rotation.inv() * R.from_quat(raw[:, 3:])
    rel_translation = o_rotation.inv().apply(raw[:, :3] - o_translation)
    rotation = c_rotation * rel_rotation
    xyz = c_translation + c_rotation.apply(rel_translation)
    t_first = corrected[:1, 0]
    a_c_rotation, a_c_translation = _interp(corrected, t_first)
    a_o_rotation, a_o_translation = _interp(odom, t_first)
    anchor_rotation = a_c_rotation * a_o_rotation.inv()
    anchor_translation = a_c_translation - anchor_rotation.apply(a_o_translation)
    anchor_inv = R.from_euler("z", anchor_rotation.as_euler("ZYX")[:, 0]).inv()
    out = np.concatenate([anchor_inv.apply(xyz - anchor_translation), (anchor_inv * rotation).as_quat()], 1)
    out[(ts < corrected[0, 0] - 1.0) | (ts > corrected[-1, 0] + 1.0)] = np.nan
    return out
