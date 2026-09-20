# dtk

The dimos toolkit. One command that is the entrypoint to a collection of dimos tooling.

Sub-tools are **downloaded the first time you run them**, not at install time, so the install
stays tiny and you only pay for what you use.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/jeff-hykin/dtk/master/install.sh | sh
```

That installs [deno](https://deno.land) if you don't already have it, then installs `dtk`.

Re-run it to update dtk. Uninstall with `deno uninstall -g dtk`.

It installs from the current commit sha rather than from `master`, because github's cdn serves
a branch url from a short-lived cache: install straight off `master` and you can get a mix of
old and new files, which deno then caches forever. The sha pins one consistent snapshot.

## Usage

```sh
dtk --help              # what is available
dtk list                # sub-tools, and which are downloaded
dtk <tool> --help       # every sub-tool has its own --help
```

Everything after the tool name is handed to the tool untouched.

### Sub-tools

| Tool | What it does |
| --- | --- |
| `db_summary` | Per-stream counts, rates, gaps and the tf frame tree of a memory2 `.db` or an `.mcap` |
| `urdf_edit` | View and edit URDF frames in the browser |
| `heatmap` | Top-down render of a recording: the finished global_map by default (or a scan stream placed through tf), with the trajectory over it |
| `to_video` | Turn an image stream in a memory2 recording into an mp4 |
| `db_to_mcap` | Convert a memory2 `.db` into a ROS 2 `.mcap` (needs a dimos checkout and `uv`) |
| `mcap_to_db` | Copy ROS 2 topics out of an `.mcap` into a memory2 `.db`, re-encoded as LCM |
| `web_ctrl` | Web control panel and live viewer for a robot over zenoh |
| `lite_record` | Handheld multi-sensor mcap recorder for RealSense, Orbbec and Livox Mid-360 |
| `icp_stitch` | Offline loop-closure post-processing: tag PGO + ICP stitching |

`dtk list` has the full set — `db_cp`, `db_delete`, `db_rename`, `db_tree`, `db_to_rrd`,
`tf_check`, `mcap_edit`, `mcap_check` and `graph` are there too.

The deno and python tools are fetched from this repo; `web_ctrl`, `lite_record` and `icp_stitch`
are precompiled binaries pulled from their own repo's latest release, for `x86_64-linux`,
`aarch64-linux` and `aarch64-macos`. `lite_record`'s linux builds come out of nix and are not
static, so dtk also fetches and imports their runtime closure — which means nix has to be
installed there.

### Working on a recording

`dtk data <verb>` is one namespace for everything that operates on a recording, and every verb
works out for itself whether it was handed a memory2 `.db` or an `.mcap` by looking at the file's
first bytes rather than its name.

```sh
dtk data summary <recording>
dtk data heatmap <recording> [out.png]
dtk data to_rrd <recording>              # cached, and opened in rerun
dtk data to_mcap <recording.db>
dtk data to_db <recording.mcap>
dtk data to_video <recording.db> <stream>
dtk data lcm_to_cdr <recording.mcap>
dtk data check <recording.mcap>

dtk data topic rename <recording> <old> <new>
dtk data topic delete <recording> <topic>
dtk data topic copy --from A --to B --topic NAME

dtk data tf tree <recording>
dtk data tf full_check <recording>
dtk data tf rename <recording> <old> <new>
dtk data tf namespace <recording> all --with <prefix> [--except a,b,c]
```

### Running a blueprint

```sh
dtk run <blueprint> [config tokens]     # dimos run, filtered and watched
dtk run --check-only <blueprint>        # just the blueprint check
dtk constellation                       # watch live LCM/zenoh traffic in the browser
dtk log                                 # print the jsonl log's path, and open it
dtk fk                                  # kill everything a run leaves behind
```

`dtk run` checks the blueprint before it starts anything — two modules writing the same topic, and
a dangling output that looks like a typo of a dangling input — then turns dtop and a native rebuild
on, prints the absolute path of the run's jsonl log, and shows only warnings and worse, de-duplicated
so one module in a loop cannot bury the rest.

### Python

Every python tool runs through one resolver, and `dtk python` exposes it:

```sh
dtk python <script.py> [args...]     # uv run, under the project that owns the script
dtk python --where <script.py>       # just say which project that is
```

The project is found by walking up from the script, then from the working directory, for
`uv.lock`, `pyproject.toml` or `.venv`. A tool that needs dimos says which module it imports, and
dtk finds the checkout that has it — so `db_to_mcap` works without `DIMOS_REPO` set by hand.

```sh
dtk graph <blueprints.py>   # render a file's DimOS Blueprints in the browser
dtk gen_blue                # regenerate all_blueprints.py; only inside a dimos checkout
```

### Managing what is downloaded

```sh
dtk list                # what is downloaded
dtk update [tool]       # re-download one, or everything already downloaded
dtk remove <tool>       # delete one from the cache
dtk where <tool>        # print its path
dtk doctor              # platform, cache location, where dtk itself came from
```

The cache is `$XDG_CACHE_HOME/dtk`, or `~/.cache/dtk`. Override it with `DTK_CACHE`.

A downloaded tool belongs to the dtk snapshot that fetched it, so re-running the install line
picks up tool changes along with everything else. `dtk update` re-downloads without reinstalling.

## Adding a tool

**A script tool:** drop it in `tools/`, then add an entry to `registry.js`:

```js
{
    name: "my_tool",
    kind: "deno",
    description: "What it does",
    entry: "tools/my_tool.js",
    permissions: ["--allow-read", "--allow-net"],
}
```

**A precompiled tool:** have its repo publish release assets, then:

```js
{
    name: "my_tool",
    kind: "binary",
    description: "What it does",
    repo: "owner/repo",
    assets: {
        "x86_64-unknown-linux-gnu": "my_tool-x86_64-linux",
        "aarch64-unknown-linux-gnu": "my_tool-aarch64-linux",
        "aarch64-apple-darwin": "my_tool-aarch64-macos",
    },
}
```

**A command of dtk itself** (not a downloaded tool): add a file to `commands/` that
default-exports a [cliffy](https://jsr.io/@cliffy/command) `Command`, and list it in
`commands/mod.js`.

## Development

Run from a checkout and nothing is downloaded — the tools in `tools/` are used in place.

```sh
deno task dtk --help
deno task dtk db_summary some.db
deno task install        # install this checkout as `dtk`
```
