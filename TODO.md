# dtk todo

Add to this freely. Checked = done and verified.

## `dtk data <verb>` — one namespace for recordings

Every verb takes a recording and works out for itself whether it is a memory2 `.db` or an
`.mcap` (sqlite header vs `MCAP0` magic, not the extension). Where a verb only makes sense for
one of the two, it says so and stops rather than half-working.

- [x] `dtk data <verb>` command group, with format sniffing and a shared "wrong format" warning
- [x] `dtk data summary <db|mcap>` — wire up `db_summary` (already handles both)

### topics

- [~] `dtk data topic rename <recording> <old> <new>` — mcap done, db not
    - mcap: `mcap_edit --rename OLD=NEW` (in place, rewrites only the chunks that mention it)
    - db: nothing exists yet — new
- [x] `dtk data topic delete <recording> <topic>`
    - mcap: `mcap_edit --delete TOPIC`
    - db: `db_delete <db> <stream>`
- [~] `dtk data topic copy --from A --to B --topic NAME` — db done, mcap not
    - db: `db_cp --from --to --stream`
    - mcap: nothing exists yet — new, and harder (chunks)

### tf

- [x] `dtk data tf full_check <recording>` — new `tf_check` tool, db and mcap. Reads every tf
      message in the file, not a window at the start, and reports: a frame with two parents, a
      cycle, more than one root, an edge that stops early or starts late relative to the
      recording, an edge published both statically and dynamically, and an edge published exactly
      once on a dynamic stream. Exits 1 when it finds anything. Only `tf` + `tf_static` by
      default; `--all-streams` folds in rival TFMessage streams too.
    - [ ] still missing from it: a frame referenced by a message header but never published
- [ ] `dtk data tf rename <recording> <old> <new>` — rename a *frame*. `mcap_edit` can drop an edge
      and correct a transform but cannot rename a frame, so this is new for both formats.
- [ ] `dtk data tf add <recording> <json>` — add an edge. Settle the json shape: parent, child,
      translation, rotation, static vs dynamic, and which topic it lands on.
- [ ] `dtk data tf namespace <recording> all --with <prefix> [--except a,b,c]` — prefix every frame
      name, skipping the listed ones. New.

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

## Tools registered in dtk

All of the above are registered: `db_cp`, `db_delete`, `db_tree`, `db_to_rrd`, `mcap_edit`,
`mcap_check`, `mcap_lcm_to_cdr`, on top of the original nine.

Also in `~/Commands` and not yet asked for: `mcap_recover`, `rrd_summary`, `rrd_thin`,
`replay_map`, `dimos_graph`, `memworld`, `mcap_depth_viewable`.

## Known rough edges

- [x] `db_to_mcap` probes `~/repos/dimos` first, and that clone has no `memory2`, so it needs
      `DIMOS_REPO` set by hand. Probe for the module, not just the directory.
- [x] `mcap_lcm_to_cdr` hardcoded `/Users/jeffhykin/repos/dimos` in its shebang; dtk's copy probes
      for the module instead. `mcap_depth_viewable` and `replay_map` still do, and are not
      registered yet.
- [ ] `heatmap` dies on a recording whose `PointCloud2` fingerprint predates `@dimos/msgs@0.1.4`
      (e.g. `spot_small_loop.db`). Same failure from `~/Commands/heatmap`, so it is the tool.
- [ ] Linux `icp_stitch` needs glibc 2.34, so an Ubuntu 20.04 / L4T 35 target is out.
