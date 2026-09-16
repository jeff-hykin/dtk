#!/usr/bin/env python3
"""Replay a recording through one or more dimos modules and write the outputs back into it.

The recording is mutated in place. Inputs are replayed at 1x by default, so a module
with timers behaves the way it would live, and whatever its output streams publish is
appended to the same recording.

    dtk data add <recording.db> '[
        {
            "module": "dimos/mapping/voxels/module.py:VoxelGridMapper",
            "inputs": {"lidar": "lidar"},
            "tf_remappings": {},
            "outputs": {"global_map": "global_map"},
            "overwrite": true
        }
    ]'

`inputs` maps the module's stream name to the recording's stream name; `outputs` the
other way round. `overwrite` is what makes a re-run safe: a stream that is about to be
replaced is first renamed out of the way to `_delete_me_<name>`, the replay is pointed at
the renamed copy where it is also an input, and only once the new data exists is the old
stream dropped. Nothing is destroyed before its replacement is written.
"""

from __future__ import annotations

import argparse
import importlib
import importlib.util
import json
import os
import re
import sqlite3
import sys
import threading
import time
import typing
from pathlib import Path

DELETE_PREFIX = "_delete_me_"


# ------------------------------------------------------------------ the spec


def read_specs(text: str) -> list[dict]:
    parsed = json.loads(text)
    if isinstance(parsed, dict):
        parsed = [parsed]
    specs = []
    for each in parsed:
        if "module" not in each:
            sys.exit('every entry needs a "module" of the form path/to/file.py:ClassName')
        if ":" not in each["module"]:
            sys.exit(f'{each["module"]!r} is not path/to/file.py:ClassName')
        specs.append({
            "module": each["module"],
            "inputs": dict(each.get("inputs") or {}),
            "outputs": dict(each.get("outputs") or {}),
            "tf_remappings": dict(each.get("tf_remappings") or {}),
            "overwrite": each.get("overwrite") is True,
        })
    return specs


def dotted_name(path: Path) -> tuple[str, Path]:
    """The importable name for a file, and the directory that has to be on sys.path
    for it. Walks up while there are `__init__.py` files, so a file inside a package
    comes out as `dimos.mapping.voxels.module` rather than as a one-off."""
    parts = [path.stem]
    at = path.parent
    while (at / "__init__.py").is_file():
        parts.append(at.name)
        at = at.parent
    return ".".join(reversed(parts)), at


def load_class(reference: str):
    """`path/to/file.py:ClassName`.

    The class is imported under its real dotted name rather than a synthetic one,
    because the coordinator pickles it over to a worker process and a pickled class
    travels as module-name plus qualname: a name only this process knows about arrives
    there as an import error. The directory that makes the name importable is pushed
    onto PYTHONPATH for the same reason."""
    path_text, class_name = reference.rsplit(":", 1)
    path = Path(path_text).expanduser()
    if not path.is_file():
        sys.exit(f"no such module file: {path}")
    path = path.resolve()
    name, root = dotted_name(path)
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))
    existing = os.environ.get("PYTHONPATH", "")
    if str(root) not in existing.split(os.pathsep):
        os.environ["PYTHONPATH"] = os.pathsep.join([str(root), existing]) if existing else str(root)
    try:
        module = importlib.import_module(name)
    except Exception as error:
        sys.exit(f"could not import {name} (from {path}): {error}")
    if not hasattr(module, class_name):
        sys.exit(f"{path} has no {class_name}")
    return getattr(module, class_name)


def stream_payload_types(module_class) -> dict[str, type]:
    """The payload type behind each `In[...]` / `Out[...]` annotation, which is what a
    transport has to be built with.

    `get_type_hints` rather than raw `__annotations__`, because dimos modules use
    `from __future__ import annotations` and those are strings until they are resolved."""
    try:
        hints = typing.get_type_hints(module_class)
    except Exception:
        hints = {}
        for klass in reversed(getattr(module_class, "__mro__", [module_class])):
            hints.update(getattr(klass, "__annotations__", {}))
    types = {}
    for name, annotation in hints.items():
        arguments = typing.get_args(annotation)
        origin = typing.get_origin(annotation)
        if origin is None or not arguments:
            continue
        if getattr(origin, "__name__", "") in ("In", "Out"):
            types[name] = arguments[0]
    return types


# ------------------------------------------------------------------ renaming out of the way


def stream_tables(connection, name: str) -> list[str]:
    present = {row[0] for row in connection.execute(
        "SELECT name FROM sqlite_master WHERE type='table'")}
    # the r-tree's shadows follow the virtual table on rename
    return [f"{name}{suffix}" for suffix in ("", "_blob", "_vec", "_rtree")
            if f"{name}{suffix}" in present]


def rename_stream(connection, old: str, new: str) -> None:
    for table in stream_tables(connection, old):
        connection.execute(f'ALTER TABLE "{table}" RENAME TO "{new}{table[len(old):]}"')
    connection.execute("UPDATE _streams SET name = ? WHERE name = ?", (new, old))


def drop_stream(connection, name: str) -> None:
    for table in reversed(stream_tables(connection, name)):
        connection.execute(f'DROP TABLE IF EXISTS "{table}"')
    connection.execute("DELETE FROM _streams WHERE name = ?", (name,))


def existing_streams(path: Path) -> list[str]:
    with sqlite3.connect(path) as connection:
        return [row[0] for row in connection.execute("SELECT name FROM _streams")]


# ------------------------------------------------------------------ the run


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("recording", type=Path)
    parser.add_argument("spec", help="the json describing the module(s) to run")
    parser.add_argument("--from", dest="seek", type=float, metavar="SECONDS",
                        help="start this many seconds into the recording")
    parser.add_argument("--duration", type=float, metavar="SECONDS",
                        help="replay only this much of it")
    parser.add_argument("--speed", type=float, default=1.0,
                        help="replay speed; 1.0 (the default) is wall-clock")
    parser.add_argument("--namespace", metavar="PREFIX",
                        help="prefix every output stream name, so several runs of the "
                             "same module can live in one recording")
    parser.add_argument("--timeout", type=float, default=30.0, metavar="SECONDS",
                        help="how long to wait after the replay ends for the last "
                             "outputs to arrive")
    parser.add_argument("--in-process", action="store_true",
                        help="build the modules here instead of asking the coordinator to spin "
                             "them up in worker processes. This is what happens anyway when the "
                             "coordinator cannot deploy, and it is the only thing that works "
                             "where its worker dies on startup")
    parser.add_argument("--dry-run", action="store_true",
                        help="say what would happen and touch nothing")
    parser.add_argument("-y", "--yes", action="store_true", help="skip the confirmation")
    arguments = parser.parse_args()

    if not arguments.recording.is_file():
        sys.exit(f"no such recording: {arguments.recording}")
    with open(arguments.recording, "rb") as handle:
        if handle.read(16) != b"SQLite format 3\0":
            sys.exit(f"{arguments.recording} is not a memory2 .db; convert it with `dtk data to_db`")

    specs = read_specs(arguments.spec)
    prefix = arguments.namespace or ""
    present = set(existing_streams(arguments.recording))

    # What each module will actually read from and write to, after the namespace and
    # after anything that has to be moved out of the way.
    plans = []
    to_rename: dict[str, str] = {}
    for spec in specs:
        outputs = {stream: prefix + name for stream, name in spec["outputs"].items()}
        clashes = [name for name in outputs.values() if name in present]
        if clashes and not spec["overwrite"]:
            sys.exit(f"{', '.join(clashes)} already exist; set \"overwrite\": true to replace them")
        for name in clashes:
            to_rename[name] = DELETE_PREFIX + name
        plans.append({"spec": spec, "outputs": outputs})

    # An input that is also being replaced has to come from the moved copy, or the
    # module would read the stream it is in the middle of rewriting.
    for plan in plans:
        plan["inputs"] = {
            stream: to_rename.get(name, name)
            for stream, name in plan["spec"]["inputs"].items()
        }

    print(f"{arguments.recording}")
    for plan in plans:
        print(f"  {plan['spec']['module']}")
        for stream, name in plan["inputs"].items():
            missing = "" if name in present else "   (NOT IN THIS RECORDING)"
            print(f"    in   {stream:<20} <- {name}{missing}")
        for stream, name in plan["outputs"].items():
            note = "  (replacing)" if name in to_rename else ""
            print(f"    out  {stream:<20} -> {name}{note}")
        for old, new in plan["spec"]["tf_remappings"].items():
            print(f"    tf   {old} -> {new}")
    for name, moved in to_rename.items():
        print(f"  {name} -> {moved}, dropped once the replay finishes")

    # Checked before anything is moved: memory2 only accepts identifier-shaped
    # stream names, and finding that out after the renames would leave the
    # recording half-rearranged.
    bad = [name for plan in plans for name in plan["outputs"].values()
           if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name)]
    if bad:
        sys.exit(f"these are not usable stream names: {', '.join(sorted(set(bad)))}\n"
                 f"letters, digits and _ only — a namespace like \"run1_\" works, \"run1/\" does not")

    missing = [name for plan in plans for name in plan["inputs"].values() if name not in present]
    if missing:
        sys.exit(f"these input streams are not in the recording: {', '.join(sorted(set(missing)))}")

    if arguments.dry_run:
        print("dry run: nothing written")
        return
    if not arguments.yes:
        answer = input("Run it? [y/N] ").strip().lower()
        if answer not in ("y", "yes"):
            print("aborted")
            return

    # Imported here rather than at the top so `--help` and `--dry-run` work without a
    # dimos environment behind them.
    from dimos.core.coordination.module_coordinator import ModuleCoordinator
    from dimos.core.global_config import global_config
    from dimos.core.transport import LCMTransport
    from dimos.memory2.store.sqlite import SqliteStore

    with sqlite3.connect(arguments.recording) as connection:
        for name, moved in to_rename.items():
            rename_stream(connection, name, moved)
        connection.commit()
    if to_rename:
        print(f"moved {len(to_rename)} stream(s) out of the way")

    store = SqliteStore(path=str(arguments.recording))
    coordinator = None
    if not arguments.in_process:
        coordinator = ModuleCoordinator()
        coordinator.start()

    def build(module_class):
        """Deployed through the coordinator when it can, built here when it cannot.

        Its worker is a separate process that the class is pickled over to, and
        when that process dies on startup the only thing that comes back is an
        EOF. Falling back keeps the command usable rather than making the whole
        replay depend on a part of dimos that is not this command's job."""
        nonlocal coordinator
        if coordinator is not None:
            try:
                return coordinator.deploy(module_class)
            except Exception as error:
                print(f"the coordinator could not deploy {module_class.__name__}: {error}")
                print("building it here instead; pass --in-process to skip this attempt")
                try:
                    coordinator.stop()
                except Exception:
                    pass
                coordinator = None
        return module_class(g=global_config)
    written = {name: 0 for plan in plans for name in plan["outputs"].values()}
    deployed = []

    def remap_frame(payload, remappings):
        if not remappings:
            return payload
        header = getattr(payload, "header", None)
        frame = getattr(header, "frame_id", None)
        if frame is not None and frame in remappings:
            setattr(header, "frame_id", remappings[frame])
        return payload

    try:
        publishers = {}
        for index, plan in enumerate(plans):
            module_class = load_class(plan["spec"]["module"])
            payload_types = stream_payload_types(module_class)
            module = build(module_class)
            deployed.append(module)
            channel = f"/dtk_add/{index}"

            for stream, source in plan["inputs"].items():
                if stream not in payload_types:
                    sys.exit(f"{module_class.__name__} has no input stream called {stream!r}")
                topic = f"{channel}/in/{stream}"
                transport = LCMTransport(topic, payload_types[stream])
                getattr(module, stream).transport = transport
                publishers[(index, stream)] = (
                    source,
                    LCMTransport(topic, payload_types[stream]),
                    plan["spec"]["tf_remappings"],
                )

            for stream, target in plan["outputs"].items():
                if stream not in payload_types:
                    sys.exit(f"{module_class.__name__} has no output stream called {stream!r}")
                topic = f"{channel}/out/{stream}"
                transport = LCMTransport(topic, payload_types[stream])
                getattr(module, stream).transport = transport
                sink = store.stream(target, payload_types[stream])
                listener = LCMTransport(topic, payload_types[stream])

                def capture(payload, sink=sink, target=target):
                    sink.append(payload, ts=time.time())
                    written[target] += 1

                listener.subscribe(capture)

            module.start()

        replay = store.replay(
            speed=arguments.speed,
            seek=arguments.seek,
            duration=arguments.duration,
        )
        finished = []
        for (index, stream), (source, transport, remappings) in publishers.items():
            done = threading.Event()
            finished.append(done)

            sent = {"count": 0}

            # A ReplayStream's observable emits the decoded payload itself, not an
            # Observation wrapping it.
            def send(payload, transport=transport, remappings=remappings, sent=sent):
                transport.publish(remap_frame(payload, remappings))
                sent["count"] += 1
                if sent["count"] % 50 == 0:
                    print(f"    sent {sent['count']:,}")

            replay.stream(source).observable().subscribe(
                on_next=send,
                on_error=lambda error, done=done: (print(f"replay error: {error}"), done.set()),
                on_completed=done.set,
            )
            print(f"  replaying {source} at {arguments.speed}x")

        # A bounded wait: a replay that never completes -- a source that stalls, a
        # subscription that never fires on_completed -- must not hang the command
        # for ever with a half-rewritten recording behind it.
        ceiling = time.monotonic() + max(arguments.timeout, 60.0)
        for done in finished:
            if not done.wait(max(1.0, ceiling - time.monotonic())):
                print("the replay did not finish in time; stopping with what arrived")
                break
        print(f"replay done; arrivals so far: {written}")
        settled = time.monotonic()
        last = dict(written)
        while time.monotonic() - settled < min(arguments.timeout, 5.0):
            time.sleep(0.5)
            if written != last:
                last = dict(written)
                settled = time.monotonic()
    finally:
        for module in deployed:
            try:
                module.stop()
            except Exception as error:
                print(f"could not stop a module cleanly: {error}")
        if coordinator is not None:
            coordinator.stop()
        store.stop()

    for target, count in written.items():
        print(f"  wrote {count:,} message(s) to {target}")

    if any(count == 0 for count in written.values()):
        print("nothing came out of at least one stream, so the replaced streams are being kept")
        print(f"they are the {DELETE_PREFIX}* ones; drop them by hand once you are happy")
        return

    with sqlite3.connect(arguments.recording) as connection:
        for moved in to_rename.values():
            drop_stream(connection, moved)
        connection.commit()
    if to_rename:
        print(f"dropped {len(to_rename)} replaced stream(s)")


if __name__ == "__main__":
    main()
