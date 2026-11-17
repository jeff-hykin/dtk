"""dimos's memory store, under whichever name this checkout gives it, and the pgo-eval dump layouts."""
import numpy as np

try:
    from dimos.memory.store.sqlite import SqliteStore  # noqa: F401
except ImportError:
    from dimos.memory2.store.sqlite import SqliteStore  # noqa: F401

# pgo-eval --event-dump a.kf: ts, raw xyz + xyzw, corrected xyz + xyzw (base_link poses)
KEYFRAME = np.dtype([("ts", "<f8"), ("raw", "<f8", 7), ("corrected", "<f8", 7)])
# a.kf.closures, per published graph state: f64 ts, u32 n, then n of these (post = delta * pre)
CLOSURE_RECORD = np.dtype([("xyz", "<f4", 3), ("id", "<u4"), ("ts", "<f8"), ("q", "<f4", 4), ("dt", "<f4", 3), ("dq", "<f4", 4)])
# a.kf.edges: one record per closure-edge state change
EDGE = np.dtype([("xyz", "<f4", 3), ("target_xyz", "<f4", 3), ("source_id", "<u4"), ("target_id", "<u4"),
                 ("state", "<u4"), ("confidence", "<f4"), ("yank_z", "<f4"), ("ts", "<f8")])


def read_closures(path):
    """[(ts, CLOSURE_RECORD per keyframe)], one per published graph state, in order."""
    raw = path.read_bytes()
    out, at = [], 0
    while at < len(raw):
        ts = float(np.frombuffer(raw, "<f8", 1, at)[0])
        n = int(np.frombuffer(raw, "<u4", 1, at + 8)[0])
        out.append((ts, np.frombuffer(raw, CLOSURE_RECORD, n, at + 12)))
        at += 12 + n * CLOSURE_RECORD.itemsize
    return out
