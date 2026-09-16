# dtk todo

Add to this freely. Checked = done and verified.

## `dtk data <verb>` — one namespace for recordings

Every verb takes a recording and works out for itself whether it is a memory2 `.db` or an
`.mcap` (sqlite header vs `MCAP0` magic, not the extension). Where a verb only makes sense for
one of the two, it says so and stops rather than half-working.

- [ ] `dtk data <verb>` command group, with format sniffing and a shared "wrong format" warning
- [ ] `dtk data summary <db|mcap>` — wire up `db_summary` (already handles both)

### topics

- [ ] `dtk data topic rename <recording> <old> <new>`
    - mcap: `mcap_edit --rename OLD=NEW` (in place, rewrites only the chunks that mention it)
    - db: nothing exists yet — new
- [ ] `dtk data topic delete <recording> <topic>`
    - mcap: `mcap_edit --delete TOPIC`
    - db: `db_delete <db> <stream>`
- [ ] `dtk data topic copy --from A --to B --topic NAME`
    - db: `db_cp --from --to --stream`
    - mcap: nothing exists yet — new, and harder (chunks)

### tf

- [ ] `dtk data tf full_check <recording>` — decide what it actually asserts. Candidates: a frame
      with two parents, a cycle, a disconnected subtree, an edge that stops partway through the
      recording, a static edge that also appears dynamically, a frame referenced by a message but
      never published. `db_tree` prints the tree today but checks nothing.
- [ ] `dtk data tf rename <recording> <old> <new>` — rename a *frame*. `mcap_edit` can drop an edge
      and correct a transform but cannot rename a frame, so this is new for both formats.
- [ ] `dtk data tf add <recording> <json>` — add an edge. Settle the json shape: parent, child,
      translation, rotation, static vs dynamic, and which topic it lands on.
- [ ] `dtk data tf namespace <recording> all --with <prefix> [--except a,b,c]` — prefix every frame
      name, skipping the listed ones. New.

### conversions

- [ ] `dtk data to_mcap <db>` — `db_to_mcap`; warn and stop if handed an mcap
- [ ] `dtk data to_db <mcap>` — `mcap_to_db`; warn and stop if handed a db
- [ ] `dtk data to_video <db> <stream>` — `to_video`
- [ ] `dtk data lcm_to_cdr <mcap>` — `mcap_lcm_to_cdr`; mcap only for now, warn on a db
- [ ] `dtk data heatmap <recording>` — `heatmap` (already handles both)
- [ ] `dtk data to_rrd <recording>`
    - `db_to_rrd` for the conversion
    - cache the result under the dtk cache keyed on the input, so re-running reuses it
    - open it at the end with a globally installed `rerun`
    - if there is no global `rerun`, offer to install one rather than failing

## Tools not yet registered in dtk

Needed by the above: `db_cp`, `db_delete`, `db_tree`, `db_to_rrd`, `mcap_edit`, `mcap_check`,
`mcap_lcm_to_cdr`.

Also in `~/Commands` and not yet asked for: `mcap_recover`, `rrd_summary`, `rrd_thin`,
`replay_map`, `dimos_graph`, `memworld`, `mcap_depth_viewable`.

## Known rough edges

- [ ] `db_to_mcap` probes `~/repos/dimos` first, and that clone has no `memory2`, so it needs
      `DIMOS_REPO` set by hand. Probe for the module, not just the directory.
- [ ] `mcap_lcm_to_cdr`, `mcap_depth_viewable` and `replay_map` hardcode `/Users/jeffhykin/repos/dimos`
      in their shebang, so they only run on this machine.
- [ ] `heatmap` dies on a recording whose `PointCloud2` fingerprint predates `@dimos/msgs@0.1.4`
      (e.g. `spot_small_loop.db`). Same failure from `~/Commands/heatmap`, so it is the tool.
- [ ] Linux `icp_stitch` needs glibc 2.34, so an Ubuntu 20.04 / L4T 35 target is out.
