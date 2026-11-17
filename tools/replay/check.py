"""Render PNG frames of an exported replay at its biggest GNC events, from the exported files themselves (what the page
will draw), so an agent can look before publishing.
usage: check.py <replay out dir> [--maps NAME ...] [--frames N]
For each map in <out>/maps: the largest map moves, the kept-closure drops and the heat spikes from each run's
solve.jsonl, plus the end of the data and the end of the run -> <out>/check/<map>/NN_<when>_<why>.png, both runs side
by side with the robot arrow (base_link), the trajectory, the closures by state and the GT path (grey) when there is one."""
import argparse
import base64
import json
import struct
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402

parser = argparse.ArgumentParser()
parser.add_argument("out", type=Path)
parser.add_argument("--maps", nargs="*", default=None)
parser.add_argument("--frames", type=int, default=8, help="most frames per map")
args = parser.parse_args()
COLORS = {"gsc": "#d9480f", "ivan": "#1971c2"}
EDGE_COLORS = {6: "#2b8a3e", 5: "#c92a2a"}
clock = lambda s: f"{int(s // 60)}:{int(s % 60):02d}"  # noqa: E731


def b64(path):
    return base64.b64decode(path.read_bytes())


def decode_states(buf, scale):
    states, at = [], 0
    while at < len(buf):
        ts, n = struct.unpack_from("<dI", buf, at)
        raw = np.frombuffer(buf, "<i2", 3 * n, at + 12).reshape(-1, 3).astype(float)
        states.append((ts, np.stack([raw[:, 0] * scale, raw[:, 1] * scale, raw[:, 2] / 32767 * np.pi], 1)))
        at += 12 + 6 * n
    return states


def decode_points(buf, n):
    counts = np.frombuffer(buf, "<u4", n)
    xy = np.frombuffer(buf, "<i2", offset=4 * n).reshape(-1, 2) / 100
    return np.concatenate([[0], np.cumsum(counts)]).astype(np.int64), xy


def compose(a, b):
    c, s = np.cos(a[..., 2]), np.sin(a[..., 2])
    return np.stack([a[..., 0] + c * b[..., 0] - s * b[..., 1], a[..., 1] + s * b[..., 0] + c * b[..., 1], a[..., 2] + b[..., 2]], -1)


def invert(a):
    c, s = np.cos(a[2]), np.sin(a[2])
    return np.array([-c * a[0] - s * a[1], s * a[0] - c * a[1], -a[2]])


class Side:
    def __init__(self, folder, key, m):
        self.key, self.m = key, m
        self.kf_ts, self.raw = np.array(m["kf_ts"]), np.array(m["raw"])
        self.states = decode_states(b64(folder / m["states"]), m["xy_scale"])
        self.state_ts = np.array([s[0] for s in self.states])
        self.start, self.xy = decode_points(b64(folder / m["points"]), m["keyframes"])

    def belief(self, t):
        """As viewer.html Method.belief: the newest state's poses, then raw odometry carried by its last correction."""
        n = int(np.searchsorted(self.kf_ts, t, "right"))
        si = int(np.searchsorted(self.state_ts, t, "right")) - 1
        poses, correction, m = np.zeros((n, 3)), np.zeros(3), 0
        if si >= 0:
            s = self.states[si][1]
            m = min(n, len(s))
            poses[:m] = s[:m]
            correction = compose(s[-1], invert(self.raw[len(s) - 1]))
        if n > m:
            poses[m:] = compose(correction[None], self.raw[m:n])
        return poses, correction, si

    def cloud(self, poses):
        out = []
        for i, p in enumerate(poses):
            local = self.xy[self.start[i]:self.start[i + 1]]
            c, s = np.cos(p[2]), np.sin(p[2])
            out.append(np.stack([p[0] + c * local[:, 0] - s * local[:, 1], p[1] + s * local[:, 0] + c * local[:, 1]], 1))
        return np.concatenate(out) if out else np.zeros((0, 2))


def events(source_dir, t0, key, label):
    """[(t since t0, why)] from a run's solve.jsonl: biggest moves, kept drops, heat spikes."""
    path = Path(source_dir) / "solve.jsonl"
    if not path.exists():
        return []
    rows = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    rows = [r for r in rows if r.get("adopt_time")]
    found = []
    for r in sorted(rows, key=lambda r: -(r.get("largest_move_m") or 0))[:3]:
        if (r.get("largest_move_m") or 0) >= 0.5:
            found.append((r["adopt_time"] - t0, f"{label} moves {r['largest_move_m']:.1f} m (kf {r.get('largest_move_keyframe')})", r["largest_move_m"]))
    drops = []
    for a, b in zip(rows, rows[1:]):
        if b.get("kept") is not None and a.get("kept") is not None and b["kept"] < a["kept"]:
            drops.append((b["adopt_time"] - t0, f"{label} kept {a['kept']} -> {b['kept']}", a["kept"] - b["kept"]))
    found += sorted(drops, key=lambda e: -e[2])[:2]
    heat = sorted((r for r in rows if (r.get("heat_after") or 0) > 0), key=lambda r: -r["heat_after"])[:2]
    found += [(r["adopt_time"] - t0, f"{label} heat {r['heat_after']:.1f}", r["heat_after"]) for r in heat]
    return found


def arrow_vs_travel(odom):
    """Median angle (deg) between the arrow (base_link heading) and the direction of travel, over samples moving faster
    than 0.2 m/s: near 0 for a robot that walks forward, near 90 or 180 when the arrow is the wrong frame."""
    o = np.array(odom, float)
    if len(o) < 3:
        return None, 0
    d = o[2:, 1:3] - o[:-2, 1:3]
    dt = np.maximum(o[2:, 0] - o[:-2, 0], 1e-6)
    moving = np.linalg.norm(d, axis=1) / dt > 0.2
    if moving.sum() < 5:
        return None, int(moving.sum())
    travel = np.arctan2(d[moving, 1], d[moving, 0])
    diff = np.degrees(np.abs((o[1:-1][moving, 3] - travel + np.pi) % (2 * np.pi) - np.pi))
    return float(np.median(diff)), int(moving.sum())


def render(folder, meta, sides, labels, t, why, path):
    fig, axes = plt.subplots(1, len(sides), figsize=(7.5 * len(sides), 7.5), squeeze=False)
    odom_ts = np.array([o[0] for o in meta["odom"]])
    oi = max(0, min(len(odom_ts) - 1, int(np.searchsorted(odom_ts, t, "right")) - 1))
    bounds = []
    for ax, side in zip(axes[0], sides):
        poses, correction, si = side.belief(t)
        cloud = side.cloud(poses)
        ax.scatter(cloud[:, 0], cloud[:, 1], s=0.3, c=COLORS[side.key], alpha=0.35, linewidths=0)
        gt = side.m.get("gt")
        if gt:
            g = np.array([p[:2] if p else [np.nan, np.nan] for p in gt[:len(poses)]])
            ax.plot(g[:, 0], g[:, 1], color="#868e96", lw=0.8, label="GT")
        ax.plot(poses[:, 0], poses[:, 1], color="#212529", lw=0.7, label="trajectory")
        for s_, t_, _, final, _, ev, *_ in side.m.get("edges") or []:
            if s_ >= len(poses) or t_ >= len(poses):
                continue
            state = None
            for when, value in ev or []:
                if when <= t:
                    state = value
            if state is None:
                continue
            ax.plot(poses[[s_, t_], 0], poses[[s_, t_], 1], color=EDGE_COLORS.get(state, "#e8a317"), lw=1.2)
        robot = compose(correction, np.array(meta["odom"][oi][1:]))
        span = max(np.ptp(poses[:, 0]) if len(poses) else 1, np.ptp(poses[:, 1]) if len(poses) else 1, 10)
        ax.arrow(robot[0], robot[1], np.cos(robot[2]) * span * 0.04, np.sin(robot[2]) * span * 0.04, width=span * 0.006,
                 color="#f08c00", length_includes_head=True, zorder=5)
        # inset: 10 m around the robot, so the arrow can be compared with the way the trajectory runs
        inset = ax.inset_axes([0.0, 0.0, 0.36, 0.36])
        near = np.abs(cloud - robot[:2]).max(1) < 5 if len(cloud) else np.zeros(0, bool)
        inset.scatter(cloud[near, 0], cloud[near, 1], s=1, c=COLORS[side.key], alpha=0.4, linewidths=0)
        inset.plot(poses[:, 0], poses[:, 1], color="#212529", lw=1)
        inset.arrow(robot[0], robot[1], np.cos(robot[2]) * 1.5, np.sin(robot[2]) * 1.5, width=0.15, color="#f08c00", length_includes_head=True, zorder=5)
        if len(poses) > 1:
            k = max(0, len(poses) - 4)
            inset.annotate("", xy=poses[-1, :2], xytext=poses[k, :2], arrowprops=dict(arrowstyle="->", color="#5c940d", lw=2), zorder=4)
        inset.set_xlim(robot[0] - 5, robot[0] + 5)
        inset.set_ylim(robot[1] - 5, robot[1] + 5)
        inset.set_xticks([])
        inset.set_yticks([])
        inset.set_aspect("equal")
        kept = sum(1 for e in side.m.get("edges") or [] if any(w <= t for w, _ in (e[5] or [])) and
                   [v for w, v in (e[5] or []) if w <= t][-1] == 6)
        ax.set_title(f"{labels[side.key]}: {len(poses)} kf, state {si + 1}/{len(side.states)}, {kept} applied", fontsize=10)
        ax.set_aspect("equal")
        if len(cloud):
            lo_hi = np.percentile(cloud, [1, 99], axis=0)
            # the trajectory and the robot always in view, whatever the cloud's outliers
            track = np.vstack([poses[:, :2], robot[None, :2]])
            bounds.append(np.stack([np.minimum(lo_hi[0], track.min(0)), np.maximum(lo_hi[1], track.max(0))]))
    if bounds:
        lo, hi = np.min([b[0] for b in bounds], 0), np.max([b[1] for b in bounds], 0)
        for ax in axes[0]:
            ax.set_xlim(lo[0] - 3, hi[0] + 3)
            ax.set_ylim(lo[1] - 3, hi[1] + 3)
    fig.suptitle(f"{meta['label']} at {clock(t)} (data ends {clock(meta.get('data_end_s', meta['duration_s']))}): {why}\n"
                 "orange arrow = robot (base_link); green arrow = last few keyframes' direction; green/red edges = applied/rejected; grey = GT",
                 fontsize=10)
    fig.tight_layout()
    fig.savefig(path, dpi=90)
    plt.close(fig)


report = json.loads((args.out / "report.json").read_text()) if (args.out / "report.json").exists() else {}
labels = {"gsc": "A", "ivan": "B", **report.get("labels", {})}
maps_dir = args.out / "maps"
for folder in sorted(p for p in maps_dir.iterdir() if (p / "meta.json").exists()):
    if args.maps and folder.name not in args.maps:
        continue
    meta = json.loads((folder / "meta.json").read_text())
    source = json.loads((args.out / "sources" / f"{folder.name}.json").read_text())
    sides = [Side(folder, key, m) for key, m in meta["methods"].items()]
    found = []
    for side in sides:
        for t, why, weight in events(source["runs"][side.key], meta["t0"], side.key, labels[side.key]):
            # a solve is adopted a moment before its graph is published: show the first published state after it
            j = int(np.searchsorted(side.state_ts, t - 1e-6))
            if j < len(side.state_ts) and side.state_ts[j] - t < 10:
                t = float(side.state_ts[j])
            found.append((t, why, weight))
    found.sort(key=lambda e: -e[2])
    picked = []
    for e in found:
        if all(abs(e[0] - p[0]) > 2 for p in picked):
            picked.append(e)
    picked = picked[:max(0, args.frames - 5)]
    data_end = meta.get("data_end_s", meta["duration_s"])
    # mid-drive frames whatever the events, so the arrow can be checked against the direction of travel
    picked += [(data_end * f, f"driving, {int(f * 100)}% of the data", 0) for f in (0.25, 0.5, 0.75)]
    picked.append((data_end, "end of the data", 0))
    if meta["duration_s"] - data_end > 5:
        picked.append((meta["duration_s"], "end of the run (after the stand-still)", 0))
    angle, samples = arrow_vs_travel(meta["odom"])
    if angle is None:
        print(f"{folder.name}: arrow vs travel: too few moving samples ({samples}) to say", flush=True)
    else:
        verdict = "OK" if angle < 30 else "WRONG? the arrow does not point along the travel (sensor frame instead of base_link, or a sideways mount)"
        print(f"{folder.name}: arrow vs travel: median {angle:.0f} deg over {samples} moving samples: {verdict}", flush=True)
    target = args.out / "check" / folder.name
    if target.exists():
        for old in target.glob("*.png"):
            old.unlink()
    target.mkdir(parents=True, exist_ok=True)
    picked.sort(key=lambda e: e[0])
    for i, (t, why, _) in enumerate(picked):
        t = min(max(0.0, t + 0.05), meta["duration_s"])
        name = f"{i:02d}_{clock(t).replace(':', 'm')}s_{''.join(c if c.isalnum() else '_' for c in why)[:40]}.png"
        render(folder, meta, sides, labels, t, why, target / name)
        print(target / name, flush=True)
