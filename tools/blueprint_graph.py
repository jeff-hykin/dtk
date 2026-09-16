#!/usr/bin/env python3
"""The module/topic graph of a blueprint, as json.

The constellation app normally asks a running dim desktop (`dimos-helm`) for this
over HTTP. Standalone there is no desktop, so the same picture is built straight
from the blueprint the way `dtk run` reads it: every module's `In[...]`/`Out[...]`
annotation, with the blueprint's remappings applied, which is exactly what
decides the topic a stream rides on.

    blueprint_graph.py <blueprint name>
"""

from __future__ import annotations

import argparse
import json
import sys


def atom_name(atom) -> str:
    """`.name` is a property on newer branches and absent on older ones."""
    name = getattr(atom, "name", None)
    if isinstance(name, str):
        return name
    instance = getattr(atom, "instance_name", None)
    if isinstance(instance, str):
        return instance
    module = getattr(atom, "module", None)
    return getattr(module, "name", None) or getattr(module, "__name__", "?")


def type_name(value) -> str:
    return getattr(value, "__name__", None) or str(value)


def build(blueprint, name: str) -> dict:
    modules: dict[str, dict] = {}
    edges: list[dict] = []
    seen: set[tuple] = set()

    atoms = getattr(blueprint, "active_blueprints", None) or getattr(blueprint, "blueprints", ())
    remapping = getattr(blueprint, "remapping_map", {}) or {}

    for atom in atoms:
        module_id = atom_name(atom)
        module_class = getattr(atom, "module", None)
        entry = {
            "id": module_id,
            "label": getattr(module_class, "__name__", module_id),
            "doc": (getattr(module_class, "__doc__", "") or "").strip().split("\n")[0],
            "inputs": [],
            "outputs": [],
            "rpcs": [],
            "skills": [],
        }
        for stream in getattr(atom, "streams", ()):
            topic = remapping.get((module_id, stream.name), stream.name)
            if not isinstance(topic, str):
                continue
            # A renamed stream keeps its declared name and gains `wire`; the
            # frontend draws the pair on the edge so the rename is visible.
            described = {"name": stream.name, "type": type_name(stream.type)}
            if topic != stream.name:
                described["wire"] = topic
            for direction, bucket in (("out", "outputs"), ("in", "inputs")):
                if stream.direction not in (direction, "inout"):
                    continue
                entry[bucket].append(described)
                key = (module_id, topic, direction)
                if key in seen:
                    continue
                seen.add(key)
                edges.append({
                    "module": module_id,
                    "topic": topic,
                    "type": type_name(stream.type),
                    "direction": direction,
                    "declared": stream.name if topic != stream.name else None,
                })
        modules[module_id] = entry

    return {"blueprint": name, "modules": modules, "edges": edges}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("blueprint")
    arguments = parser.parse_args()

    from dimos.core.coordination.blueprints import autoconnect
    from dimos.robot.get_all_blueprints import get_by_name_or_exit

    try:
        blueprint = autoconnect(get_by_name_or_exit(arguments.blueprint))
    except SystemExit:
        # get_by_name_or_exit already said why; report it as data rather than
        # letting the exit code be the only thing the caller sees.
        print(json.dumps({
            "blueprint": arguments.blueprint,
            "modules": {},
            "edges": [],
            "unknown": True,
        }))
        return
    except Exception as error:
        print(f"blueprint_graph: {error}", file=sys.stderr)
        print(json.dumps({
            "blueprint": arguments.blueprint,
            "modules": {},
            "edges": [],
            "unknown": True,
        }))
        return

    print(json.dumps(build(blueprint, arguments.blueprint)))


if __name__ == "__main__":
    main()
