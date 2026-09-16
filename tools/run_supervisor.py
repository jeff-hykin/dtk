#!/usr/bin/env python3
"""dtk run — `dimos run`, made readable.

Ordinary module chatter is hidden and only warnings and errors come through,
de-duplicated so one module in a loop cannot bury the rest. Before anything
starts, the blueprint is checked for two mistakes that are invisible at runtime:
two modules writing the same topic, and a pair of dangling streams that look like
one of them is a typo of the other. While it runs, the tf tree is watched and the
topic rates and per-module resource use are printed once a minute.

    dtk run <blueprint> [config tokens]
    dtk run --check-only <blueprint>
"""

from __future__ import annotations

import argparse
import os
import re
import signal
import subprocess
import sys
import threading
import time
from collections import defaultdict, deque
from pathlib import Path

TF_GRACE_SECONDS = 30.0
STATS_EVERY_SECONDS = 60.0
HZ_FLOOR = 0.5
# A repeated warning is counted rather than reprinted, and the count is flushed
# on this interval so a loop shows up as "x420" instead of 420 lines.
DEDUP_FLUSH_SECONDS = 15.0

# `HH:MM:SS.mmm [lvl][logger name       ] message key=value`
CONSOLE_LINE = re.compile(r"^\d\d:\d\d:\d\d\.\d+\s+\[(?P<level>\w+)\]\[(?P<logger>[^\]]*)\]\s?(?P<message>.*)$")
INTERESTING_LEVELS = {"war", "err", "cri", "exc"}


def say(text: str = "") -> None:
    print(text, flush=True)


def banner(text: str) -> None:
    line = "=" * max(30, min(78, len(text) + 4))
    say("")
    say(line)
    say(f"  {text}")
    say(line)
    say("")


# ------------------------------------------------------------------ the blueprint


def load_blueprint(names: list[str]):
    """The same two lines `dimos run` uses, so what is checked is what will run:
    the config tokens are split off the blueprint names, and several blueprints
    are joined by autoconnect rather than by concatenation."""
    from dimos.core.coordination.blueprints import autoconnect
    from dimos.robot.get_all_blueprints import get_by_name_or_exit

    try:
        from dimos.core.coordination.blueprint_config.parser import split_run_arguments

        blueprint_names, _ = split_run_arguments(names)
    except ImportError:
        # Older branches have no config tokens at all, so everything that is not
        # a flag and not a key=value is a blueprint name.
        blueprint_names = [
            each for each in names
            if not each.startswith("-") and "=" not in each
        ]
    if not blueprint_names:
        raise ValueError("no blueprint named")
    return autoconnect(*map(get_by_name_or_exit, blueprint_names))


def atom_name(atom) -> str:
    """What a blueprint calls this module instance. `.name` is a property on
    newer branches and absent on older ones, so it is reconstructed the same way
    the property does."""
    name = getattr(atom, "name", None)
    if isinstance(name, str):
        return name
    instance = getattr(atom, "instance_name", None)
    if isinstance(instance, str):
        return instance
    module = getattr(atom, "module", None)
    return getattr(module, "name", None) or getattr(module, "__name__", "?")


def wiring(blueprint):
    """(topic, direction) -> the module instances on it, after remapping."""
    produced = defaultdict(list)
    consumed = defaultdict(list)
    types = {}
    # Both of these moved between branches, so neither is assumed.
    atoms = getattr(blueprint, "active_blueprints", None) or getattr(blueprint, "blueprints", ())
    remapping = getattr(blueprint, "remapping_map", {}) or {}
    for atom in atoms:
        name = atom_name(atom)
        for stream in getattr(atom, "streams", ()):
            topic = remapping.get((name, stream.name), stream.name)
            if not isinstance(topic, str):
                continue
            types[topic] = stream.type
            if stream.direction in ("out", "inout"):
                produced[topic].append(name)
            if stream.direction in ("in", "inout"):
                consumed[topic].append(name)
    return produced, consumed, types


def check_blueprint(blueprint) -> int:
    """Two mistakes that a running system will not tell you about."""
    produced, consumed, types = wiring(blueprint)
    complaints = 0

    for topic, writers in sorted(produced.items()):
        if len(writers) > 1:
            say(f"Warning, possible topic fighting on {topic} with {sorted(writers)}")
            complaints += 1

    # A dangling output and a dangling input of the same type, under different
    # names, is what a misspelling looks like from here. A name starting with _
    # is deliberately unwired, so it is not a candidate.
    def danglers(side, other):
        return [
            topic for topic in side
            if topic not in other and not topic.startswith("_")
        ]

    loose_outputs = danglers(produced, consumed)
    loose_inputs = danglers(consumed, produced)
    for output in sorted(loose_outputs):
        for input_topic in sorted(loose_inputs):
            if types.get(output) is not types.get(input_topic):
                continue
            say(
                f"Warning, possible misspelling: {output} "
                f"(written by {sorted(produced[output])}, nothing reads it) and "
                f"{input_topic} (read by {sorted(consumed[input_topic])}, nothing writes it) "
                f"are both {getattr(types.get(output), '__name__', types.get(output))}"
            )
            complaints += 1

    if complaints == 0:
        say(f"blueprint check: {len(produced)} topics written, {len(consumed)} read, nothing suspicious")
    return complaints


# ------------------------------------------------------------------ the log


def wait_for_log(started_at: float, timeout: float = 30.0) -> Path | None:
    """`dimos run` makes a directory per run and registers it; this waits for the
    entry belonging to the run just started rather than an older one."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            from dimos.core.run_registry import list_runs

            for entry in list_runs(alive_only=False):
                log_dir = Path(entry.log_dir)
                main = log_dir / "main.jsonl"
                if main.exists() and main.stat().st_mtime >= started_at - 1:
                    return main
        except Exception:
            pass
        time.sleep(0.5)
    return None


# ------------------------------------------------------------------ the output


class Filter:
    """Only warnings and worse, de-duplicated by (logger, level) with the
    timestamp and the varying tail ignored, so a module repeating itself is one
    line with a count rather than a flood."""

    def __init__(self) -> None:
        self.counts: dict[tuple, int] = defaultdict(int)
        self.shown: set[tuple] = set()
        self.last_flush = time.monotonic()
        self.building: set[str] = set()

    def feed(self, line: str) -> None:
        match = CONSOLE_LINE.match(line)
        if match is None:
            # Anything that is not a dimos log line -- a traceback, a build's own
            # output -- goes straight through; hiding those is how a crash
            # becomes a mystery.
            if line.strip():
                say(line)
            return

        level = match.group("level").lower()
        logger = match.group("logger").strip()
        message = match.group("message")

        if "Building native module" in message:
            module = re.search(r"module=(\S+)", message)
            name = module.group(1) if module else logger
            if name not in self.building:
                self.building.add(name)
                say(f"[build] {name} is doing a full build — this is the slow part")
            return

        if level not in INTERESTING_LEVELS:
            return

        key = (logger, level, message.split("=")[0][:60])
        self.counts[key] += 1
        if key not in self.shown:
            self.shown.add(key)
            say(f"[{level}] {logger}: {message}")
        self.maybe_flush()

    def maybe_flush(self) -> None:
        now = time.monotonic()
        if now - self.last_flush < DEDUP_FLUSH_SECONDS:
            return
        self.last_flush = now
        repeats = {key: count for key, count in self.counts.items() if count > 1}
        for key, count in sorted(repeats.items(), key=lambda each: -each[1])[:5]:
            say(f"[{key[1]}] {key[0]}: x{count} since the last summary")
        self.counts.clear()


# ------------------------------------------------------------------ watching


# `make_transport` has lived in more than one module across branches, so it is
# looked up rather than imported from one place: watching the tree is a nicety
# and must never be the reason a run does not start.
def find_make_transport():
    import importlib

    for module_name in (
        "dimos.core.transport_factory",
        "dimos.core.transport",
        "dimos.protocol.transport_factory",
    ):
        try:
            module = importlib.import_module(module_name)
        except Exception:
            continue
        found = getattr(module, "make_transport", None)
        if found is not None:
            return found
    return None


def watch_tf(stop: threading.Event) -> None:
    """After a grace period, complain once per KIND of broken tree and keep
    watching: a tree that heals and breaks again is worth knowing about, a tree
    that stays broken is not worth repeating."""
    make_transport = find_make_transport()
    if make_transport is None:
        say("[tf] not watching the tree: no make_transport on this dimos")
        return
    try:
        from dimos.msgs.tf2_msgs.TFMessage import TFMessage
    except Exception as error:
        say(f"[tf] not watching the tree: {error}")
        return

    parents: dict[str, set[str]] = defaultdict(set)
    lock = threading.Lock()

    def on_message(message) -> None:
        with lock:
            for transform in getattr(message, "transforms", []):
                child = getattr(transform, "child_frame_id", None)
                parent = getattr(getattr(transform, "header", None), "frame_id", None)
                if child and parent:
                    parents[child].add(parent)

    try:
        transport = make_transport("/tf", TFMessage)
        transport.subscribe(on_message)
        transport.start()
    except Exception as error:
        say(f"[tf] not watching the tree: {error}")
        return

    stop.wait(TF_GRACE_SECONDS)
    complained: set[str] = set()
    while not stop.is_set():
        with lock:
            snapshot = {child: set(found) for child, found in parents.items()}
        if snapshot:
            multi = [child for child, found in snapshot.items() if len(found) > 1]
            if multi and "multiple parents" not in complained:
                complained.add("multiple parents")
                say(f"[tf] these frames have more than one parent: {sorted(multi)}")
            roots = {
                next(iter(found)) for child, found in snapshot.items()
                if next(iter(found)) not in snapshot
            }
            if len(roots) > 1 and "multiple trees" not in complained:
                complained.add("multiple trees")
                say(f"[tf] {len(roots)} separate trees, rooted at {sorted(roots)}")
        stop.wait(10.0)
    try:
        transport.stop()
    except Exception:
        pass


def watch_stats(stop: threading.Event, topics: dict) -> None:
    """Per-module CPU and memory from the stats dtop already publishes, and the
    rate of every wired topic that is actually moving."""
    make_transport = find_make_transport()
    if make_transport is None:
        say("[stats] not watching: no make_transport on this dimos")
        return

    latest = {"stats": None}
    counts: dict[str, int] = defaultdict(int)
    subscriptions = []

    try:
        stats_transport = make_transport("/resource_stats")
        stats_transport.subscribe(lambda message: latest.__setitem__("stats", message))
        stats_transport.start()
        subscriptions.append(stats_transport)
    except Exception as error:
        say(f"[stats] no resource stats: {error}")

    for topic, payload_type in topics.items():
        try:
            transport = make_transport(f"/{topic}", payload_type)
            transport.subscribe(lambda _message, topic=topic: counts.__setitem__(topic, counts[topic] + 1))
            transport.start()
            subscriptions.append(transport)
        except Exception:
            continue  # a topic this process cannot subscribe to is not worth a line

    window_started = time.monotonic()
    while not stop.is_set():
        stop.wait(STATS_EVERY_SECONDS)
        if stop.is_set():
            break
        elapsed = max(1e-6, time.monotonic() - window_started)
        window_started = time.monotonic()
        rates = sorted(
            ((topic, count / elapsed) for topic, count in counts.items() if count / elapsed > HZ_FLOOR),
            key=lambda each: -each[1],
        )
        counts.clear()
        if rates:
            say("[rates] " + ", ".join(f"{topic} {hz:.1f}Hz" for topic, hz in rates[:12]))
        stats = latest["stats"]
        if isinstance(stats, dict):
            busy = []
            for worker in stats.get("workers", []):
                cpu = worker.get("cpu_percent", 0) or 0
                memory = worker.get("mem_mb", 0) or 0
                if cpu > 50 or memory > 1000:
                    modules = ",".join(worker.get("modules", [])) or worker.get("pid", "?")
                    busy.append(f"{modules} {cpu:.0f}% {memory:.0f}MB")
            if busy:
                say("[load] " + "; ".join(busy))
    for transport in subscriptions:
        try:
            transport.stop()
        except Exception:
            pass


# ------------------------------------------------------------------ the run


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("args", nargs=argparse.REMAINDER,
                        help="the blueprint(s) and config tokens, exactly as `dimos run` takes them")
    parser.add_argument("--check-only", action="store_true",
                        help="check the blueprint and stop, without running anything")
    parser.add_argument("--no-dtop", action="store_true", help="do not turn dtop on")
    parser.add_argument("--no-build", action="store_true",
                        help="do not force a native rebuild; a stale binary may be used")
    arguments = parser.parse_args()

    if not arguments.args:
        parser.error("need a blueprint")

    say("checking the blueprint")
    try:
        blueprint = load_blueprint(arguments.args)
        check_blueprint(blueprint)
        _, _, topic_types = wiring(blueprint)
    except SystemExit:
        raise
    except Exception as error:
        say(f"could not check the blueprint ({error}); running it anyway")
        topic_types = {}

    if arguments.check_only:
        return

    command = ["dimos"]
    if not arguments.no_dtop:
        command.append("--dtop")
    if not arguments.no_build:
        command.append("--build-native")
    command += ["run", *arguments.args]
    say(f"$ {' '.join(command)}")

    started_at = time.time()
    child = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        env={**os.environ, "PYTHONUNBUFFERED": "1"},
    )

    stop = threading.Event()

    def find_log() -> None:
        log = wait_for_log(started_at)
        say(f"log: {log}" if log else "log: could not find this run's log directory")

    threading.Thread(target=find_log, daemon=True).start()
    threading.Thread(target=watch_tf, args=(stop,), daemon=True).start()
    threading.Thread(target=watch_stats, args=(stop, topic_types), daemon=True).start()

    def forward(signal_number, _frame):
        child.send_signal(signal_number)

    signal.signal(signal.SIGINT, forward)
    signal.signal(signal.SIGTERM, forward)

    output = Filter()
    recent = deque(maxlen=40)
    assert child.stdout is not None
    try:
        for line in child.stdout:
            line = line.rstrip()
            recent.append(line)
            output.feed(line)
    finally:
        stop.set()
        code = child.wait()

    if code != 0:
        banner(f"the run exited {code}")
        say("the last lines before it went:")
        for line in recent:
            say(f"  {line}")
    sys.exit(code)


if __name__ == "__main__":
    main()
