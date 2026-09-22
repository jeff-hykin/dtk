#!/usr/bin/env python3
"""The part of `dtk chat` that has to be python, and nothing more than that.

`/human_input` carries a plain `str`, but `/agent` carries a langchain
`BaseMessage` over a *pickled* transport (`pLCMTransport` / `pZenohTransport`),
and `/tool_streams` carries a dict the same way. Pickle of arbitrary langchain
objects is not something the deno side can read, so this process sits on the
wire and speaks newline-delimited json to the TUI instead.

It is deliberately dumb: no formatting decisions, no state machine, no
reconnect logic, no opinion about whether anyone is listening. Every one of
those lives in the deno side, which is the thing that can redraw.

    stdout  one json event per line, nothing else, ever
    stdin   one json command per line
    stderr  logs, tracebacks, and whatever dimos decides to print

stdout is guarded rather than trusted: dimos and its dependencies print on
import (the banner, logging handlers, zenoh's own chatter), and one stray line
in the event stream desynchronizes the reader. So the real stdout is dup'd to a
private fd before dimos is imported and `sys.stdout` is pointed at stderr.

Events out:
    {"t": "hello",     "backend": "zenoh", "pid": 123, "topics": {...}}
    {"t": "ready"}                                  subscriptions are up
    {"t": "agent",     "role": "ai"|"system"|"tool"|"human", "text": ...,
                       "tool_calls": [{"name","args","id"}],
                       "tool_call_id": ..., "tool": ..., "at": 1.23}
    {"t": "idle",      "value": true}
    {"t": "tool",      "tool": "x", "text": "...", "method": "...", "at": ...}
    {"t": "stats",     "workers": [{"modules": [...], "cpu": 1.0, "mem": 2.0}]}
    {"t": "sent",      "id": "..."}                 publish returned
    {"t": "problem",   "where": "...", "message": "...", "fatal": false}

Commands in:
    {"t": "send", "id": "...", "text": "..."}
    {"t": "ping"}
    {"t": "quit"}
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
import traceback

# ---------------------------------------------------------------- stdout guard

# Take the real stdout before anything else can write to it, then point the
# ordinary one at stderr so a library's `print` cannot corrupt the stream.
_EVENTS = os.fdopen(os.dup(1), "w", buffering=1, encoding="utf-8", errors="replace")
os.dup2(2, 1)
sys.stdout = sys.stderr

_write_lock = threading.Lock()
_started_at = time.monotonic()


def emit(**event) -> None:
    """Write one event. Callable from any thread."""
    event.setdefault("at", round(time.monotonic() - _started_at, 3))
    line = json.dumps(event, default=str)
    with _write_lock:
        try:
            _EVENTS.write(line + "\n")
            _EVENTS.flush()
        except (BrokenPipeError, ValueError):
            # The TUI is gone. Nothing useful left to do; let the main loop exit.
            os._exit(0)


def problem(where: str, error: BaseException, fatal: bool = False) -> None:
    emit(t="problem", where=where, message=f"{type(error).__name__}: {error}", fatal=fatal)
    traceback.print_exc()


# -------------------------------------------------------------- message shapes

# `McpClient` re-emits tool-stream updates onto `/agent` with this prefix, so a
# reply about a tool can be filed under that tool instead of the transcript.
TOOL_MSG_PREFIX = "[tool:"


def split_tool_message(content: str):
    """Parse `[tool:NAME] text` into (name, text), or None if it is not one."""
    if not content.startswith(TOOL_MSG_PREFIX):
        return None
    end = content.find("]")
    if end == -1:
        return None
    return content[len(TOOL_MSG_PREFIX) : end], content[end + 1 :].lstrip()


def message_text(message) -> str:
    """The text of a langchain message, across versions.

    `.text` is a property on new versions and a method on some older ones, and
    `.content` is a list of content blocks for a multimodal reply.
    """
    text = getattr(message, "text", None)
    if callable(text):
        try:
            text = text()
        except Exception:
            text = None
    if isinstance(text, str):
        return text
    content = getattr(message, "content", "")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict) and isinstance(block.get("text"), str):
                parts.append(block["text"])
        return "".join(parts)
    return str(content)


def role_of(message) -> str:
    """`ai` / `human` / `system` / `tool`, without importing langchain to ask.

    The bridge should still forward something sensible when a message arrives
    from a dimos whose langchain differs from the one this env resolved.
    """
    kind = getattr(message, "type", None)
    if isinstance(kind, str) and kind:
        return {"assistant": "ai"}.get(kind, kind)
    name = type(message).__name__.lower()
    for candidate in ("ai", "human", "system", "tool", "chat", "function"):
        if name.startswith(candidate):
            return candidate
    return "unknown"


def tool_calls_of(message):
    """Normalize tool calls from either the typed field or `additional_kwargs`."""
    raw = getattr(message, "tool_calls", None)
    if not raw:
        raw = (getattr(message, "additional_kwargs", None) or {}).get("tool_calls") or []
    out = []
    for call in raw:
        if isinstance(call, dict):
            # The OpenAI wire shape nests name/arguments under "function".
            function = call.get("function") if isinstance(call.get("function"), dict) else {}
            name = call.get("name") or function.get("name") or "?"
            args = call.get("args")
            if args is None:
                args = function.get("arguments")
            identifier = call.get("id") or call.get("tool_call_id")
        else:
            name = getattr(call, "name", "?")
            args = getattr(call, "args", None)
            identifier = getattr(call, "id", None)
        if isinstance(args, str):
            try:
                args = json.loads(args)
            except Exception:
                pass  # a half-streamed argument string is still worth showing
        out.append({"name": name, "args": args, "id": identifier})
    return out


def describe(message) -> dict:
    """One `/agent` message as an event payload."""
    role = role_of(message)
    text = message_text(message)
    event: dict[str, object] = {"t": "agent", "role": role, "text": text}

    split = split_tool_message(text)
    if split is not None:
        event["tool"], event["text"] = split
        event["about_tool"] = True

    calls = tool_calls_of(message)
    if calls:
        event["tool_calls"] = calls
    identifier = getattr(message, "tool_call_id", None)
    if identifier:
        event["tool_call_id"] = identifier
    name = getattr(message, "name", None)
    if name:
        event["name"] = name
    status = getattr(message, "status", None)
    if status:
        event["status"] = status
    return event


# ------------------------------------------------------------------- the bridge

TOPICS = {
    "human_input": "/human_input",
    "agent": "/agent",
    "agent_idle": "/agent_idle",
    "tool_streams": "/tool_streams",
    "resource_stats": "/resource_stats",
}


class Bridge:
    def __init__(self, make_transport) -> None:
        self._make = make_transport
        self._human = None
        self._transports = []
        self._publish_lock = threading.Lock()

    def open(self, send_only: bool = False) -> None:
        # `/human_input` is opened first and eagerly: a held message being
        # released must not also be waiting on a transport handshake.
        self._human = self._open("human_input", eager=True)
        if send_only:
            # `dtk chat` normally reads through the `spy` binary, which needs no
            # python at all; this process is then only here to publish. Opening
            # the subscriptions anyway would deliver every message twice.
            emit(t="ready", publishing=self._human is not None, send_only=True)
            return
        self._subscribe("agent", self._on_agent)
        self._subscribe("agent_idle", self._on_idle)
        self._subscribe("tool_streams", self._on_tool_stream)
        self._subscribe("resource_stats", self._on_stats)
        emit(t="ready", publishing=self._human is not None)

    def _open(self, key: str, eager: bool = False):
        try:
            transport = self._make(TOPICS[key])
            if eager and hasattr(transport, "start"):
                transport.start()
            self._transports.append(transport)
            return transport
        except Exception as error:
            problem(f"open {TOPICS[key]}", error)
            return None

    def _subscribe(self, key: str, callback) -> None:
        transport = self._open(key)
        if transport is None:
            return

        def guarded(message, _callback=callback, _key=key):
            # A raise inside a transport callback is swallowed by the backend on
            # some versions and kills the receive thread on others. Neither is
            # something the TUI should have to guess at.
            try:
                _callback(message)
            except Exception as error:
                problem(f"decode {TOPICS[_key]}", error)

        try:
            transport.subscribe(guarded)
            if hasattr(transport, "start"):
                transport.start()
        except Exception as error:
            problem(f"subscribe {TOPICS[key]}", error)

    # ------------------------------------------------------------ subscriptions

    def _on_agent(self, message) -> None:
        emit(**describe(message))

    def _on_idle(self, value) -> None:
        emit(t="idle", value=bool(value))

    def _on_tool_stream(self, frame) -> None:
        if not isinstance(frame, dict):
            emit(t="tool", tool="?", text=str(frame))
            return
        method = frame.get("method") or ""
        raw_params = frame.get("params")
        params: dict = raw_params if isinstance(raw_params, dict) else {}
        tool = params.get("logger") or params.get("toolName") or params.get("tool") or "?"
        text = params.get("data")
        if text is None:
            text = params.get("message")
        if text is None and "progress" in params:
            total = params.get("total")
            text = f"{params['progress']}" + (f"/{total}" if total is not None else "")
        event: dict[str, object] = {"t": "tool", "tool": tool, "method": method}
        if text is not None:
            event["text"] = text if isinstance(text, str) else json.dumps(text, default=str)
        if "progress" in params:
            event["progress"] = params.get("progress")
            event["total"] = params.get("total")
        emit(**event)

    def _on_stats(self, stats) -> None:
        if not isinstance(stats, dict):
            return
        workers = []
        for worker in stats.get("workers", []) or []:
            if not isinstance(worker, dict):
                continue
            workers.append(
                {
                    "modules": list(worker.get("modules", []) or []),
                    "pid": worker.get("pid"),
                    "cpu": worker.get("cpu_percent", 0) or 0,
                    "mem": worker.get("mem_mb", 0) or 0,
                }
            )
        emit(t="stats", workers=workers)

    # ----------------------------------------------------------------- sending

    def send(self, identifier, text: str) -> None:
        if self._human is None:
            self._human = self._open("human_input", eager=True)
        if self._human is None:
            emit(t="problem", where="send", message="no /human_input transport", id=identifier)
            return
        try:
            with self._publish_lock:
                self._human.publish(text)
            emit(t="sent", id=identifier)
        except Exception as error:
            emit(
                t="problem",
                where="send",
                message=f"{type(error).__name__}: {error}",
                id=identifier,
            )
            traceback.print_exc()

    def close(self) -> None:
        for transport in self._transports:
            try:
                transport.stop()
            except Exception:
                pass  # shutting down; a backend that objects is not interesting


# `make_transport` has moved between modules across dimos branches, so it is
# looked up the way `run_supervisor.py` looks it up rather than imported from
# one place.
MAKE_TRANSPORT_MODULES = (
    "dimos.core.transport_factory",
    "dimos.core.transport",
    "dimos.robot.core.transport_factory",
)


def find_make_transport():
    import importlib

    for module_name in MAKE_TRANSPORT_MODULES:
        try:
            module = importlib.import_module(module_name)
        except Exception:
            continue
        found = getattr(module, "make_transport", None)
        if found is not None:
            return found, module_name
    return None, None


def apply_transport(argv) -> str:
    """Honour `--transport`, and report which backend ended up active."""
    try:
        from dimos.core.transport_factory import apply_transport_arg
        from dimos.core.global_config import global_config

        apply_transport_arg(["dtk-chat", *argv])
        return str(global_config.transport)
    except Exception:
        return os.environ.get("DIMOS_TRANSPORT", "unknown")


def watch_parent(parent_pid: int, stop: threading.Event) -> None:
    """Exit when the TUI that started this bridge is gone.

    Closed stdin is the usual signal and handles a clean exit, but it is not
    enough: killed with SIGKILL, or wrapped in `uv run`, the pipe can outlive
    the process that owned it and this bridge is left holding a live transport.
    An orphan publisher is not harmless -- it is a second thing on
    `/human_input` that nobody can see.
    """
    while not stop.wait(1.0):
        try:
            os.kill(parent_pid, 0)
        except ProcessLookupError:
            os._exit(0)
        except PermissionError:
            continue  # exists but is not ours to signal


def read_commands(bridge: Bridge, stop: threading.Event) -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            command = json.loads(line)
        except Exception as error:
            problem("command", error)
            continue
        kind = command.get("t")
        if kind == "send":
            bridge.send(command.get("id"), str(command.get("text", "")))
        elif kind == "ping":
            emit(t="pong", id=command.get("id"))
        elif kind == "quit":
            break
        else:
            emit(t="problem", where="command", message=f"unknown command {kind!r}")
    stop.set()


def main() -> None:
    parser = argparse.ArgumentParser(prog="dtk chat (bridge)", add_help=True)
    parser.add_argument("--transport", choices=["lcm", "zenoh"], default=None)
    parser.add_argument(
        "--parent-pid",
        type=int,
        default=None,
        help="exit when this pid goes away (the TUI that started this bridge)",
    )
    parser.add_argument(
        "--send-only",
        action="store_true",
        help="only publish /human_input; do not subscribe to anything",
    )
    arguments, _unknown = parser.parse_known_args()

    argv = [] if arguments.transport is None else ["--transport", arguments.transport]
    backend = apply_transport(argv)

    make_transport, where = find_make_transport()
    if make_transport is None:
        emit(
            t="problem",
            where="import",
            message=(
                "this dimos has no make_transport (looked in "
                + ", ".join(MAKE_TRANSPORT_MODULES)
                + ")"
            ),
            fatal=True,
        )
        sys.exit(1)

    emit(t="hello", backend=backend, pid=os.getpid(), topics=TOPICS, make_transport=where)

    bridge = Bridge(make_transport)
    bridge.open(send_only=arguments.send_only)

    stop = threading.Event()
    reader = threading.Thread(target=read_commands, args=(bridge, stop), daemon=True)
    reader.start()
    if arguments.parent_pid is not None:
        threading.Thread(
            target=watch_parent, args=(arguments.parent_pid, stop), daemon=True
        ).start()
    try:
        stop.wait()
    except KeyboardInterrupt:
        pass
    bridge.close()


if __name__ == "__main__":
    main()
