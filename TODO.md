# dtk todo

Add to this freely. Checked = done and verified.

## Next up

- [ ] `dtk fk` — a process killer modelled on `~/Commands/kd`, rewritten in deno and cleaned up.
      `kd` is 81 lines of `ps | grep -E` over six pattern groups (dimos, native modules, Unity,
      gazebo, ROS, orphaned tcpdumps). **Aggressively drop everything dimos-specific** — this one
      is about killing processes, not about dimos.
- [ ] `dtk log` — print the absolute path of the jsonl log and, by default, open it. Uses the
      python side to find it, through the shared `dtk python` project resolution.
- [ ] `dtk update <name>` — make sure one tool is actually up to date. NOTE: `dtk update <tool>`
      already exists and force-re-downloads. What is missing is the *checking*: comparing what is
      cached against what the release/source now offers, and saying "already current" rather than
      downloading regardless.
- [ ] `dtk run <args>` — a wrapper around `dimos run` built for an agent to read:
    1. behaves like `dimos run`
    2. prints the absolute path of the full jsonl log
    3. always enables dtop
    4. builds every native module first, so nothing stale is ever used
    5. checks the blueprint for modules writing to the same topic and warns
       `Warning, possible topic fighting on <topic> with [<module names>]`. Also prints topics that
       look like misspellings: a dangling output on one module and a dangling input on another of
       the same type but a different name, where neither name starts with `_`
    6. hides ordinary module output and lets warnings through. Says when a module needs a full nix
       build (hook `NativeModule` at runtime to notice a build command starting). De-duplicates
       warnings and errors so they do not flood: split on the logger prefix rather than per line,
       and ignore the timestamp when comparing. A module that dies gets a large, unmissable notice
    7. starts a tf listener; if the tree is broken or inconsistent after the first 30 s it warns.
       One warning per KIND of breakage (multiple parents, multiple trees) but it keeps watching
    8. every 60 s prints the Hz of topics above 0.5 Hz, and which modules are using a lot of CPU
       or memory

## `dtk data <verb>` — one namespace for recordings

Every verb takes a recording and works out for itself whether it is a memory2 `.db` or an
`.mcap` (sqlite header vs `MCAP0` magic, not the extension). Where a verb only makes sense for
one of the two, it says so and stops rather than half-working.

- [x] `dtk data <verb>` command group, with format sniffing and a shared "wrong format" warning
- [x] `dtk data summary <db|mcap>` — wire up `db_summary` (already handles both)

### topics

- [x] `dtk data topic rename <recording> <old> <new>` — mcap via `mcap_edit --rename`, db via
      a new `db_rename` (ALTER TABLE on the stream's table family plus the `_streams` row, so it
      costs the same whatever the recording weighs)
    - mcap: `mcap_edit --rename OLD=NEW` (in place, rewrites only the chunks that mention it)
    - db: nothing exists yet — new
- [x] `dtk data topic delete <recording> <topic>`
    - mcap: `mcap_edit --delete TOPIC`
    - db: `db_delete <db> <stream>`
- [x] `dtk data topic copy --from A --to B --topic NAME`
    - db: `db_cp --from --to --stream`
    - mcap: a new `mcap_edit --copy-topic-from OTHER.mcap:TOPIC`. Nothing already in the
      destination moves: the new chunks land where the old summary started and a fresh summary
      is written past them, so it costs the size of what is copied, not of the file it lands in.
      The channel and schema are renumbered on the way in.
    - [ ] copying between a .db and an .mcap still means converting one first

### tf

- [x] `dtk data tf full_check <recording>` — new `tf_check` tool, db and mcap. Reads every tf
      message in the file, not a window at the start, and reports: a frame with two parents, a
      cycle, more than one root, an edge that stops early or starts late relative to the
      recording, an edge published both statically and dynamically, and an edge published exactly
      once on a dynamic stream. Exits 1 when it finds anything. Only `tf` + `tf_static` by
      default; `--all-streams` folds in rival TFMessage streams too.
    - [ ] still missing from it: a frame referenced by a message header but never published
- [x] `dtk data tf rename <recording> <old> <new>` — mcap via a new `mcap_edit --rename-tf-frame`,
      db via a new `db_tf_rename`. Both re-encode the tf message, because a name of a different
      length moves every field after it.
    - [ ] tf only: a message whose own header names the old frame still names it. Rewriting that
          needs the payload's type to re-align the fields after the string. Ask Jeff whether it
          is worth decoding the known sensor/nav types to cover it.
- [ ] `dtk data tf add <recording> <json>` — add an edge. Settle the json shape: parent, child,
      translation, rotation, static vs dynamic, and which topic it lands on.
- [x] `dtk data tf namespace <recording> all --with <prefix> [--except a,b,c]` — both formats,
      through the same rename path. Running it twice prefixes twice; nothing distinguishes an
      already-prefixed name from one that starts that way.

### conversions

- [x] `dtk data to_mcap <db>` — `db_to_mcap`; warn and stop if handed an mcap
- [x] `dtk data to_db <mcap>` — `mcap_to_db`; warn and stop if handed a db
- [x] `dtk data to_video <db> <stream>` — `to_video`
- [x] `dtk data lcm_to_cdr <mcap>` — `mcap_lcm_to_cdr`; mcap only for now, warn on a db
- [x] `dtk data heatmap <recording>` — `heatmap` (already handles both)
- [x] `dtk data to_rrd <recording>`
    - `db_to_rrd` for the conversion
    - cache the result under the dtk cache keyed on the input, so re-running reuses it
    - open it at the end with a globally installed `rerun`
    - if there is no global `rerun`, offer to install one rather than failing

## `dtk data add` — replay a module over a recording

Mutates the recording in place: replays the named inputs at 1x speed into the module and writes
the module's outputs back into the same `.db` / `.mcap`.

```sh
dtk data add <db_or_mcap_file> '[
    {
        "module": "<path to module python file>:<ModuleName>",
        "inputs": {"lidar": "pointlio_lidar"},
        "tf_remappings": {},
        "outputs": {"global_map": "global_map"},
        "overwrite": true
    }
]'
```

- [x] parse the json, resolve `path.py:ModuleName`, and run it through the shared `dtk python`
      project resolution. The class is imported under its REAL dotted name, not a synthetic one:
      the coordinator pickles it to a worker and a pickled class travels as module-name plus
      qualname.
- [x] replay the mapped inputs at 1x, through `Store.replay(speed=...)`
- [x] write the mapped outputs back into the recording
- [x] `overwrite`: before the replay, rename each stream that would be overwritten to
      `_delete_me_<name>`, point the replay's inputs at the renamed one where it is also an input,
      and drop the `_delete_me_` streams once the replay finishes. Nothing is destroyed until the
      new data exists — and if a stream produced nothing, the old one is KEPT and said so.
- [x] `--from` and `--duration`, plus `--speed`
- [x] `--namespace`. memory2 only accepts identifier-shaped stream names, so `run1_` works and
      `run1/` does not; that is checked before anything is renamed.
- [x] `tf_remappings` is `{"old": "new"}`, rewriting `header.frame_id` on the way INTO the
      module and leaving the output as the module wrote it.
    - [ ] not exercised by a test yet — the module used for testing has nothing to remap

Answered: the coordinator spins the modules up. **But `ModuleCoordinator.deploy()` kills its
worker on both machines tested** — EOFError on the Mac (dimos3 and dimos6), ConnectionResetError
on CudaLaptop (dimos6) — with a plain script and no dtk involved. So `data add` falls back to
building the module in this process, loudly, and `--in-process` skips the attempt. That fallback
is the path that is actually tested.

- [ ] revisit once `ModuleCoordinator.deploy()` works again, and verify the coordinator path

## Tools registered in dtk

All of the above are registered: `db_cp`, `db_delete`, `db_tree`, `db_to_rrd`, `mcap_edit`,
`mcap_check`, `mcap_lcm_to_cdr`, on top of the original nine.

Also in `~/Commands` and not yet asked for: `mcap_recover`, `rrd_summary`, `rrd_thin`,
`replay_map`, `dimos_graph`, `memworld`, `mcap_depth_viewable`.

## Known rough edges

- [x] Every python tool now goes through one resolver (`python.js`): walk up from the paths in
      the arguments, then from the working directory, for `uv.lock` / `pyproject.toml` / `.venv`,
      and for a tool that names a `needsDimosModule`, fall back to probing the dimos clones for
      that module. `dtk python <script.py>` exposes it directly, `--where` just prints the answer.
      That is what fixed `db_to_mcap` needing `DIMOS_REPO` set by hand.
- [x] `mcap_lcm_to_cdr` hardcoded `/Users/jeffhykin/repos/dimos` in its shebang; no dtk python
      tool carries a shebang any more. `mcap_depth_viewable` and `replay_map` still do, and are
      not registered yet.
- [x] `dimos_graph` imported `dimos.core.blueprints`, which moved to
      `dimos.core.coordination.blueprints` — it could not have run. Fixed in dtk's copy (`dtk
      graph`); `~/Commands/dimos_graph.py` still has the stale import.
- [x] `heatmap` died on `spot_small_loop.db` with an LCM fingerprint mismatch. Root cause was not
      a message version at all: that recording's cloud stream is stored as `lz4+lcm` and heatmap
      was decoding the compressed bytes. It now reads each stream's `codec_id`. The same recording
      renders a full building floorplan.
    - `tf_check` learned the same thing; `db_tf_rename` and `db_tf_add` REFUSE a compressed tf
      stream rather than writing plaintext into one, since they re-encode.
- [ ] Linux `icp_stitch` needs glibc 2.34, so an Ubuntu 20.04 / L4T 35 target is out.

## Later

- [ ] Bring `urdf_edit` up to date with the upgrades in
      https://github.com/jeff-hykin/dim-urdf-editor — dtk's copy is the older `~/Commands/urdf-view`.

- [ ] Turn https://github.com/jeff-hykin/dim-lcm-constellation into a standalone server/cli tool
      and add it to dtk. Needs adaptation and a recompile.
