"""Export one map of a GSC replay page: per-keyframe top-down points (keyframe body frame), each run's published graph
states over time, GT poses, closure edges, closure-gate diagnostics and a bounded set of ICP clouds.
usage: export.py <entry JSON (inline or a path)> <out dir>      -> <out dir>/<entry name>/...
`dtk replay` writes the entry; its fields:
  name, label, config_name     tab name, heading, caption
  runs {"gsc": dir, "ivan": dir}  left and right pgo-eval run dirs (a.kf, a.kf.closures, a.kf.edges, a.json); "ivan" optional
  db, streams {lidar, odom}    the recording and the streams pgo-eval read
  gt                           "auto", a spec list (gt_poses.py), or null; gt_stream forces one corrected stream
  options                      size knobs (see opts below); scores {"gsc": {...}, "ivan": {...}} for the summary table
Binary blobs are written base64 (.b64) so the folder works where only text is served. viewer.html decodes them."""
import base64
import json
import math
import shutil
import struct
import sys
import time
from pathlib import Path

import numpy as np
from scipy.spatial.transform import Rotation as R

sys.path.insert(0, str(Path(__file__).parent))
from gt_poses import auto_specs, child_frame, correction, gt_poses, static_chain, tf_edges  # noqa: E402
from store import EDGE, KEYFRAME, SqliteStore, read_closures  # noqa: E402

DIAG_COLUMNS = ["outcome", "source_id", "target_id", "source_time", "candidate_distance", "from_scan_context", "lowe_ratio",
                "scan_context_best", "descriptor_occupancy", "degeneracy_min", "icp_converged", "icp_iterations", "icp_stop",
                "icp_init_offset_m", "icp_init_offset_deg", "icp_fitness", "icp_overlap",
                "icp_translation_norm", "yank_translation", "yank_rotation_deg", "yank_drift_scale", "sigma_translation_m",
                "sigma_rotation_deg", "yank_stdevs", "scan_context_factor", "icp_factor", "degeneracy_factor", "confidence",
                "required_confidence", "extended_keyframes", "extended_source_points", "extended_target_points", "extension_budget", "single_inliers", "extended_inliers", "extended_fitness",
                "extended_confidence", "cloud_ratios", "cloud_agreement", "agreement_multiplier", "cost_lookup_s", "cost_begin_s", "cost_submap_s", "cost_degeneracy_s", "cost_icp_s",
                "cost_extension_s", "cost_extension_rounds_s", "cost_gates_s", "cost_search_s", "map_keyframes",
                "scan_context_candidates", "alternatives_left", "alternative_try", "extension_clouds_planned",
                "extension_clouds_used", "single_source_points", "single_target_points", "single_target_points_thinned",
                "speed_mps", "scan_index_proposed", "scan_index_finished", "strain", "pressure", "likelihood_ratio", "extended_likelihood_ratio", "learned_odometry_error_estimate"]
REJECTS = ("icp_reject", "degeneracy_reject", "yank_confidence_reject")

entry_arg, out_root = sys.argv[1], Path(sys.argv[2])
entry = json.loads(entry_arg if entry_arg.lstrip().startswith("{") else Path(entry_arg).read_text())
opts = dict(voxel_m=0.2, max_points=80, scans_per_keyframe=5, max_range_m=25.0, band_m=[0.3, 2.2], state_budget_bytes=1_400_000,
            odom_hz=2.0, icp_accepted=10, icp_rejected=10, icp_single=[1500, 2500], icp_extended=[2500, 3500])
opts.update(entry.get("options") or {})
db_path = Path(entry["db"]).expanduser()
out = out_root / entry["name"]
if out.exists():
    shutil.rmtree(out)
out.mkdir(parents=True)
icp_blob = bytearray()
started = time.monotonic()


def log(*a):
    print(f"[{entry['name']} {time.monotonic() - started:5.1f}s]", *a, flush=True)


def write_b64(path, data: bytes):
    path.write_bytes(base64.b64encode(data))
    return path.name


def yaw_of(rotation):
    return rotation.as_euler("zyx")[:, 0]


def read_json(path):
    return json.loads(path.read_text()) if path.exists() else None


def edge_list(run, t0):
    """[source, target, ts shown (applied, else first event), state (6 applied / 5 GNC-rejected / other last state),
    confidence, [[ts, state], ...] its committed (2) / rejected (5) / applied (6) events], from a.kf.edges."""
    pairs = {}
    for r in np.fromfile(run / "a.kf.edges", EDGE):
        p = pairs.setdefault((int(r["source_id"]), int(r["target_id"])), dict(first=float(r["ts"]), applied=None, last=0, conf=0.0, events=[]))
        p["last"] = int(r["state"])
        if r["state"] in (2, 5, 6):
            p["events"].append([round(float(r["ts"]) - t0, 2), int(r["state"])])
        p["conf"] = max(p["conf"], float(r["confidence"]))
        if r["state"] == 6 and p["applied"] is None:
            p["applied"] = float(r["ts"])
    return [[s, t, round((p["applied"] or p["first"]) - t0, 2), 6 if p["applied"] is not None else p["last"], round(p["conf"], 3), p["events"]]
            for (s, t), p in pairs.items() if p["applied"] is not None or p["last"] in (2, 3, 4, 5)]


# ---- runs: keyframes + graph states ----
methods = {}
for key in ("gsc", "ivan"):
    run = (entry.get("runs") or {}).get(key)
    if not run:
        continue
    run = Path(run).expanduser()
    kf = np.fromfile(run / "a.kf", KEYFRAME)
    states = read_closures(run / "a.kf.closures") if (run / "a.kf.closures").exists() else []
    run_log = (run / "run.log").read_text(errors="replace") if (run / "run.log").exists() else ""
    if run_log and "base_link from tf" not in run_log:
        log(f"WARNING {key}: {run}/run.log never says pgo-eval took base_link from tf: its keyframes may be the sensor's poses")
    methods[key] = dict(run=run, kf=kf, states=states)
    log(key, run, len(kf), "keyframes", len(states), "graph states")
if not methods:
    raise SystemExit("no runs given")
t0 = min(float(m["kf"]["ts"][0]) for m in methods.values())
# the stand-still tail adds graph states after the last keyframe: the timeline runs to the newest state
t1 = max(max(float(m["kf"]["ts"][-1]), max((float(ts) for ts, _ in m["states"]), default=0.0)) for m in methods.values())
data_end = max(float(m["kf"]["ts"][-1]) for m in methods.values())

# ---- GT ----
streams = entry["streams"]
gt_spec = entry.get("gt", "auto")
if entry.get("gt_stream"):
    gt_spec = [{"db": str(db_path), "stream": entry["gt_stream"], "odom_stream": streams["odom"], "body_tf": "tf", "direct": True}]
    log(f"gt: stream {entry['gt_stream']} (asked for)")
elif gt_spec == "auto":
    gt_spec = auto_specs(db_path, streams["odom"], log)
gt_found = correction(gt_spec) if gt_spec else None
log("gt:", gt_found[1] if gt_found else "none")

# ---- per-keyframe points from the recording ----
with SqliteStore(path=str(db_path)) as store:
    names = store.list_streams()
    for role in ("lidar", "odom"):
        if streams[role] not in names:
            raise SystemExit(f"{db_path} has no stream {streams[role]} ({role}); it has {', '.join(sorted(names))}")
    lidar = getattr(store.streams, streams["lidar"])
    scan_ts = np.array([o.ts for o in lidar.order_by("ts")])
    odom_rows = []
    for o in getattr(store.streams, streams["odom"]).order_by("ts"):
        p = o.data.pose if hasattr(o.data, "pose") and hasattr(o.data.pose, "position") else o.data
        odom_rows.append((o.ts, p.position.x, p.position.y, p.position.z, p.orientation.x, p.orientation.y, p.orientation.z, p.orientation.w))
    odom = np.array(odom_rows)
    odom = odom[np.unique(odom[:, 0], return_index=True)[1]]
    # the robot arrow is base_link: the odometry's child frame -> base_link from the db's tf / tf_static
    sensor = (child_frame(getattr(store.streams, streams["odom"])) or "").lstrip("/")
    if not sensor:
        raise SystemExit(f"{streams['odom']} names no child frame; cannot place base_link")
    if sensor == "base_link":
        to_base = (R.identity(), np.zeros(3))
    else:
        to_base = static_chain(tf_edges(store, log), sensor, "base_link")
        if to_base is None:
            raise SystemExit(f"no tf chain {sensor} -> base_link in {db_path}; refusing to draw the sensor's heading as the robot's")
    log(f"arrow: base_link from {sensor} via tf: yaw {np.degrees(to_base[0].as_euler('zyx')[0]):.1f} deg, "
        f"pitch {np.degrees(to_base[0].as_euler('zyx')[1]):.1f} deg, offset {np.round(to_base[1], 3).tolist()} m")

    half = opts["scans_per_keyframe"] // 2
    jobs = []
    for key, m in methods.items():
        m["points"] = [None] * len(m["kf"])
        centers = np.clip(np.searchsorted(scan_ts, m["kf"]["ts"]), 0, len(scan_ts) - 1)
        for k, c in enumerate(centers.tolist()):
            jobs.append((max(0, c - half), min(len(scan_ts) - 1, c + half), key, k))
    jobs.sort(key=lambda j: j[1])
    wanted = {i for s, e, _, _ in jobs for i in range(s, e + 1)}
    buffer, next_job = {}, 0
    voxel, band = opts["voxel_m"], opts["band_m"]

    def local_points(key, k, start, end):
        raw = methods[key]["kf"]["raw"][k]
        world = np.concatenate([buffer[i] for i in range(start, end + 1) if i in buffer] or [np.zeros((0, 3))])
        local = R.from_quat(raw[3:]).inv().apply(world - raw[:3]) if len(world) else world
        local = local[np.linalg.norm(local[:, :2], axis=1) < opts["max_range_m"]]
        near = local[np.linalg.norm(local[:, :2], axis=1) < 5.0]
        if len(near) > 50:  # drop floor and ceiling: keep a height band above the local floor
            floor = np.percentile(near[:, 2], 5)
            local = local[(local[:, 2] > floor + band[0]) & (local[:, 2] < floor + band[1])]
        cells = np.floor(local[:, :2] / voxel).astype(np.int64)
        _, first = np.unique(cells, axis=0, return_index=True)
        xy = (np.floor(local[first, :2] / voxel) + 0.5) * voxel
        if len(xy) > opts["max_points"]:
            xy = xy[np.random.default_rng(k).choice(len(xy), opts["max_points"], replace=False)]
        return np.round(xy * 100).astype("<i2")

    for i, o in enumerate(lidar.order_by("ts")):
        if i in wanted:
            buffer[i] = np.asarray(o.data.points_f32(), np.float64)
            if o.data.frame_id != "world":  # a sensor-frame scan: place it by the odometry at its time
                pose = odom[min(len(odom) - 1, np.searchsorted(odom[:, 0], o.ts))]
                buffer[i] = R.from_quat(pose[4:]).apply(buffer[i]) + pose[1:4]
        while next_job < len(jobs) and jobs[next_job][1] <= i:
            s, e, key, k = jobs[next_job]
            methods[key]["points"][k] = local_points(key, k, s, e)
            next_job += 1
        low = jobs[next_job][0] if next_job < len(jobs) else i + 1
        for j in [j for j in buffer if j < low]:
            del buffer[j]
    log("points done,", len(scan_ts), "scans")


def big_moves(kf, states):
    """Every published state's largest keyframe move from the previous one (the first from raw odometry), biggest first."""
    prev, moves = None, []
    for ts, rec in states:
        xyz = R.from_quat(rec["dq"].astype(float)).apply(rec["xyz"].astype(float)) + rec["dt"]
        cur = dict(zip(rec["id"].tolist(), xyz[:, :2]))
        if prev is None:
            prev = dict(zip(rec["id"].tolist(), kf["raw"][rec["id"].astype(int), :2]))
        ids = [i for i in cur if i in prev]
        if ids:
            moves.append((max(float(np.linalg.norm(cur[i] - prev[i])) for i in ids), float(ts)))
        prev = cur
    moves.sort(reverse=True)
    return [dict(move_m=round(mv, 2), at_s=round(t - t0, 1), after_data=t > data_end) for mv, t in moves[:5]]


# ---- write per run ----
meta_methods = {}
for key, m in methods.items():
    kf = m["kf"]
    raw_rotation = R.from_quat(kf["raw"][:, 3:])
    # points: u32 count per keyframe, then int16 x, y (cm, keyframe body frame) for all keyframes in order
    counts = np.array([len(p) for p in m["points"]], "<u4")
    points_file = write_b64(out / f"{key}_points.b64", counts.tobytes() + b"".join(p.tobytes() for p in m["points"]))
    # states: per state f64 ts (s since t0), u32 n, then n x int16 (x / xy_scale, y / xy_scale, yaw / pi * 32767), ids 0..n-1
    poses = []
    for ts, rec in m["states"]:
        rec = rec[np.argsort(rec["id"])]
        delta = R.from_quat(rec["dq"].astype(float))
        xyz = delta.apply(rec["xyz"].astype(float)) + rec["dt"]
        poses.append((ts, rec["id"].astype(int), xyz[:, :2], yaw_of(delta * R.from_quat(rec["q"].astype(float)))))
    extent = max(float(np.abs(kf["raw"][:, :2]).max()), float(np.abs(kf["corrected"][:, :2]).max()), *(float(np.abs(p[2]).max()) for p in poses))
    xy_scale = max(0.01, extent / 32000)
    raw_xy, raw_yaw = kf["raw"][:, :2], yaw_of(raw_rotation)

    def shown_error(a, b):
        """How far (m) the map drawn from state a is from state b's, over b's keyframes (as viewer.html belief())."""
        _, ids_a, xy_a, yaw_a = a
        n, m_ = len(b[1]), min(len(ids_a), len(b[1]))
        error = np.linalg.norm(xy_a[:m_] - b[2][:m_], axis=1).max(initial=0.0)
        if n > m_:
            j = len(ids_a) - 1
            turn = yaw_a[j] - raw_yaw[j]
            c, s = np.cos(turn), np.sin(turn)
            rel = raw_xy[m_:n] - raw_xy[j]
            carried = xy_a[j] + np.stack([c * rel[:, 0] - s * rel[:, 1], s * rel[:, 0] + c * rel[:, 1]], 1)
            error = max(error, np.linalg.norm(carried - b[2][m_:n], axis=1).max())
        return error

    def keep_within(threshold_m):
        """States to keep so the map drawn between kept states is never more than threshold_m off the true state."""
        keep = [0]
        for i in range(1, len(poses)):
            if shown_error(poses[keep[-1]], poses[i]) > threshold_m:
                keep.append(i)
        return sorted(set(keep) | {len(poses) - 1})

    size = lambda keep: sum(12 + 6 * len(poses[i][1]) for i in keep)  # noqa: E731
    # the smallest error that fits the byte budget, so the big map jumps (closures) always show when they happen
    keep, threshold_m = list(range(len(poses))), 0.0
    if poses and size(keep) > opts["state_budget_bytes"]:
        low, high = 0.0, 1e4
        for _ in range(30):
            middle = (low + high) / 2
            if size(keep_within(middle)) > opts["state_budget_bytes"]:
                low = middle
            else:
                high = middle
        keep, threshold_m = keep_within(high), high
    chunks = []
    for s in keep:
        ts, ids, xy, yaw = poses[s]
        assert (ids == np.arange(len(ids))).all(), "state ids must be 0..n-1"
        body = np.stack([np.round(xy[:, 0] / xy_scale), np.round(xy[:, 1] / xy_scale), np.round(yaw / np.pi * 32767)], 1)
        chunks += [struct.pack("<dI", ts - t0, len(ids)), np.clip(body, -32767, 32767).astype("<i2").tobytes()]
    states_file = write_b64(out / f"{key}_states.b64", b"".join(chunks))
    gt = gt_poses(gt_found, kf["ts"], kf["raw"]) if gt_found else None
    final_rotation = R.from_quat(kf["corrected"][:, 3:])
    meta_methods[key] = dict(
        run=m["run"].name, keyframes=len(kf), states_total=len(poses), states_kept=len(keep), states_error_m=round(threshold_m, 2), xy_scale=xy_scale,
        points=points_file, states=states_file,
        kf_ts=np.round(kf["ts"] - t0, 3).tolist(),
        raw=np.round(np.stack([kf["raw"][:, 0], kf["raw"][:, 1], yaw_of(raw_rotation)], 1), 3).tolist(),
        final=np.round(np.stack([kf["corrected"][:, 0], kf["corrected"][:, 1], yaw_of(final_rotation)], 1), 3).tolist(),
        gt=None if gt is None else [None if np.isnan(g[0]) else [round(g[0], 3), round(g[1], 3), round(float(y), 3)]
                                    for g, y in zip(gt.tolist(), yaw_of(R.from_quat(np.nan_to_num(gt[:, 3:], nan=0.0) + np.array([0, 0, 0, 1e-9]))), strict=True)],
        big_moves=big_moves(kf, m["states"]),
    )
    if (m["run"] / "a.kf.edges").exists():
        meta_methods[key]["edges"] = edge_list(m["run"], t0)
    a_json = read_json(m["run"] / "a.json") or {}
    meta_methods[key]["pressure"] = [[round(ts - t0, 2), round(o["unresolved_loop_probability"], 3),
                                      None if o.get("soft_pressure") is None else round(o["soft_pressure"], 3)] for ts, o, *_ in a_json.get("loop_overlap", [])]
    m["a"] = a_json
    log(key, f"{counts.sum()} points, states {len(keep)}/{len(poses)} kept (drawn map within {threshold_m:.2f} m of the true state)")

# ---- the left run's closure-gate diagnostics and ICP clouds ----
gsc_meta = {}
if "gsc" in methods:
    run, a = methods["gsc"]["run"], methods["gsc"]["a"]
    edges = meta_methods["gsc"].get("edges")
    if edges is None:
        ts_of = methods["gsc"]["kf"]["ts"]
        edges = meta_methods["gsc"]["edges"] = [[e["source_id"], e["target_id"], round(float(ts_of[e["source_id"]]) - t0, 2), 6, 1.0]
                                               for e in a.get("committed_closure_edges", [])]
    config = a.get("config", {})
    diag = a.get("closure_diagnostics", [])
    rows = []
    old_names = {"yank_stdevs": "yank_z", "learned_odometry_error_estimate": "odometry_noise"}  # older runs' a.json
    for d in diag:
        row = [d.get(c, d.get(old_names[c])) if c in old_names else d.get(c) for c in DIAG_COLUMNS]
        row[3] = None if d.get("source_time") is None else round(d["source_time"] - t0, 2)
        rows.append([round(v, 4) if isinstance(v, float) else [round(x, 3) for x in v] if isinstance(v, list) else v for v in row])
    thresholds = dict(icp_fitness=config.get("closure_score_thresh"), degeneracy_min=config.get("closure_min_degeneracy"))

    def evidence(p):
        return -math.log(max(1e-12, 1.0 - min(p, 1 - 1e-12)))
    # each edge's strength against its yank: match evidence / the evidence its yank alone requires (1 = just enough)
    strength = {}
    for d in diag:
        best = max(v for v in (d.get("confidence"), d.get("extended_confidence"), 0.0) if isinstance(v, (int, float)) and v == v)
        need = d.get("required_confidence")
        if d.get("outcome") == "accepted" and isinstance(need, (int, float)) and need == need and need > 0:
            strength[(d["source_id"], d["target_id"])] = round(evidence(best) / evidence(need), 3)
    for e in edges:
        e.append(strength.get((e[0], e[1])))

    def margin(d):
        """How far past its gate a rejected candidate was (0 = on the threshold)."""
        try:
            if d["outcome"] == "icp_reject":
                return abs(d["icp_fitness"] / thresholds["icp_fitness"] - 1)
            if d["outcome"] == "degeneracy_reject":
                return abs(1 - d["degeneracy_min"] / thresholds["degeneracy_min"])
            if d["outcome"] == "yank_confidence_reject":
                return abs(1 - d["confidence"] / d["required_confidence"])
        except (TypeError, ZeroDivisionError, KeyError):
            pass
        return 1e9

    icp_dir = Path(config.get("closure_icp_dump_dir") or run / "icp")
    if not icp_dir.exists():
        icp_dir = run / "icp"
    picks = []
    if icp_dir.exists():
        accepted = [i for i, d in enumerate(diag) if d["outcome"] == "accepted"]
        if len(accepted) > opts["icp_accepted"]:
            accepted = [accepted[int(j)] for j in np.linspace(0, len(accepted) - 1, opts["icp_accepted"])]
        by_outcome = {o: sorted((i for i, d in enumerate(diag) if d["outcome"] == o), key=lambda i: margin(diag[i])) for o in REJECTS}
        rejected = []
        while len(rejected) < opts["icp_rejected"] and any(by_outcome.values()):
            for o in REJECTS:
                if by_outcome[o] and len(rejected) < opts["icp_rejected"]:
                    rejected.append(by_outcome[o].pop(0))
        picks = accepted + rejected

    def read_icp(path):
        raw = path.read_bytes()
        ns, nt = (int(v) for v in np.frombuffer(raw, "<u4", 2))
        points = np.frombuffer(raw, "<f4", 3 * (ns + nt), 8).reshape(-1, 3)
        tail = np.frombuffer(raw, "<f8", 13, 8 + 12 * (ns + nt))
        return points[:ns], points[ns:], tail

    def pack_cloud(points, limit, seed):
        """f32 offset xyz, u32 n, int16 cm xyz relative to the offset."""
        if len(points) > limit:
            points = points[np.random.default_rng(seed).choice(len(points), limit, replace=False)]
        offset = points.mean(0) if len(points) else np.zeros(3)
        rel = np.clip(np.round((points - offset) * 100), -32767, 32767).astype("<i2")
        return struct.pack("<3fI", *offset, len(points)) + rel.tobytes()

    icp_index = {}
    for i in picks:
        d = diag[i]
        stem = f"{d['source_id']}_{d['target_id']}"
        stages = [(1, icp_dir / f"{stem}.icp"), *sorted(((int(p.stem.rsplit("_x", 1)[1]), p) for p in icp_dir.glob(f"{stem}_x*.icp")), key=lambda s: s[0])]
        stages = [s for s in stages if s[1].exists()]
        if not stages:
            continue
        info, blobs = [], []
        largest = stages[-1][0]
        for keyframes, path in stages:
            source, target, tail = read_icp(path)
            info.append(dict(keyframes=keyframes, source_points=len(source), target_points=len(target), fitness=round(float(tail[12]), 4),
                             rotation_deg=round(float(np.degrees(R.from_matrix(tail[:9].reshape(3, 3)).magnitude())), 2),
                             translation_m=round(float(np.linalg.norm(tail[9:12])), 3)))
            # clouds only for the single round and the largest extended round; the rest keep their numbers
            if keyframes == 1 or keyframes == largest:
                limits = opts["icp_single"] if keyframes == 1 else opts["icp_extended"]
                blobs.append(struct.pack("<I", keyframes) + tail.astype("<f8").tobytes() + pack_cloud(source, limits[0], i) + pack_cloud(target, limits[1], i + 1))
        record = struct.pack("<I", len(blobs)) + b"".join(blobs)
        icp_index[str(i)] = dict(offset=len(icp_blob), length=len(record), stages=info)
        icp_blob.extend(record)
    write_b64(out / "icp.b64", bytes(icp_blob))
    log(f"diag {len(diag)} candidates, icp clouds for {len(icp_index)}")
    gsc_meta = dict(edges=edges, diag_columns=DIAG_COLUMNS, diag=rows, thresholds=thresholds, icp=icp_index,
                    gate_counts=a.get("gate_counts"), runtime_s=a.get("runtime_s"), realtime_factor=a.get("realtime_factor"),
                    committed=len(a.get("committed_closure_edges", [])), data_duration_s=a.get("data_duration_s"))

# ---- summary table ----
scored = entry.get("scores") or {}
summary = {}
for key, m in methods.items():
    row = scored.get(key, {})
    summary[key] = dict(keyframes=len(m["kf"]), states=len(m["states"]), loops=row.get("loops"),
                        score=(row.get("gt") or {}).get("final") and row["gt"], tag_spread_m=row.get("tags"))
if gsc_meta:
    summary["gsc"].update(committed=gsc_meta["committed"], gate_counts=gsc_meta["gate_counts"], runtime_s=gsc_meta["runtime_s"])

# ---- the robot: base_link from the recording's odometry, decimated ----
step = max(1, round(len(odom) / max(1.0, (odom[-1, 0] - odom[0, 0]) * opts["odom_hz"])))
od = odom[::step]
sensor_rotation = R.from_quat(od[:, 4:])
base = np.concatenate([od[:, 1:4] + sensor_rotation.apply(to_base[1]), (sensor_rotation * to_base[0]).as_quat()], 1)
odom_out = np.round(np.stack([od[:, 0] - t0, base[:, 0], base[:, 1], yaw_of(R.from_quat(base[:, 3:]))], 1), 3).tolist()
gt_odom = None
if gt_found:
    g = gt_poses(gt_found, od[:, 0], base)
    gt_odom = [None if np.isnan(r[0]) else [round(r[0], 3), round(r[1], 3), round(float(y), 3)]
               for r, y in zip(g.tolist(), yaw_of(R.from_quat(np.nan_to_num(g[:, 3:], nan=0.0) + np.array([0, 0, 0, 1e-9]))), strict=True)]

clock = lambda s: f"{int(s // 60)}:{int(s % 60):02d}"  # noqa: E731
side_labels = {"gsc": "A", "ivan": "B", **(entry.get("labels") or {})}
moves = []
for key in meta_methods:
    b = meta_methods[key]["big_moves"]
    moves.append(f"{side_labels[key]}: " + ("none over 1 m" if not b or b[0]["move_m"] < 1.0 else
                 f"{b[0]['move_m']:.1f} m at {clock(b[0]['at_s'])} ({'in the stand-still' if b[0]['after_data'] else 'while driving'})"))
caption = [entry.get("config_name") or "", f"GT (off by default): {gt_found[1] if gt_found else 'none'}", "biggest live-map correction: " + "; ".join(moves)]
meta = dict(name=entry["name"], label=entry.get("label", entry["name"]), config_name=" · ".join(c for c in caption if c), t0=t0, duration_s=round(t1 - t0, 2),
            data_end_s=round(data_end - t0, 2), gt=gt_found[1] if gt_found else None, odom=odom_out, gt_odom=gt_odom, methods=meta_methods,
            summary=summary, loops=gsc_meta or None, plan={}, options=opts)
(out / "meta.json").write_text(json.dumps(meta, separators=(",", ":")))
sizes = {p.name: p.stat().st_size for p in out.glob("*") if p.is_file()}
log("wrote", {k: f"{v / 1e6:.2f} MB" for k, v in sizes.items()})
