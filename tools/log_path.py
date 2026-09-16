#!/usr/bin/env python3
"""Where dimos is writing its jsonl log.

Asks dimos rather than guessing: the directory is `dimos.constants.LOG_DIR`,
which moves with the project root, and a run started with a log directory of its
own overrides it through DIMOS_RUN_LOG_DIR.

Deliberately does NOT call `_get_log_file_path()`: with no run in progress that
invents a fresh timestamped name for a file nobody has written, which is the
opposite of what someone asking for "the log" wants. The newest file that exists
is the answer.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--json", action="store_true", help="print the whole picture as json")
    parser.add_argument("--all", action="store_true", help="list every log, newest first")
    arguments = parser.parse_args()

    run_dir = os.environ.get("DIMOS_RUN_LOG_DIR")
    if run_dir:
        directory = Path(run_dir)
        current = directory / "main.jsonl"
    else:
        from dimos.constants import LOG_DIR

        directory = Path(LOG_DIR)
        current = None

    logs = sorted(
        (each for each in directory.glob("*.jsonl") if each.is_file()),
        key=lambda each: each.stat().st_mtime,
        reverse=True,
    ) if directory.is_dir() else []

    if current is None:
        current = logs[0] if logs else None

    if arguments.json:
        print(json.dumps({
            "directory": str(directory),
            "current": str(current) if current else None,
            "logs": [str(each) for each in logs],
        }, indent=4))
        return

    if arguments.all:
        if not logs:
            print(f"no logs in {directory}", file=sys.stderr)
            sys.exit(1)
        for each in logs:
            print(each)
        return

    if current is None or not current.exists():
        print(f"no jsonl log in {directory} yet", file=sys.stderr)
        sys.exit(1)
    print(current)


if __name__ == "__main__":
    main()
