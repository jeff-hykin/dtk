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
| `g1_cmd` | Drive a Unitree G1's loco service over DDS: damp, stiffen, self-balance, get up |

`dtk list` has the full set — `db_cp`, `db_delete`, `db_rename`, `db_tree`, `db_to_rrd`,
`tf_check`, `mcap_edit`, `mcap_check` and `graph` are there too.

The deno and python tools are fetched from this repo; `web_ctrl`, `lite_record` and `icp_stitch`
are precompiled binaries pulled from their own repo's latest release, for `x86_64-linux`,
`aarch64-linux` and `aarch64-macos`. `lite_record`'s linux builds come out of nix and are not
static, so dtk also fetches and imports their runtime closure — which means nix has to be
installed there.

### Driving a G1

`dtk g1_cmd` talks straight to a Unitree G1's loco service over DDS with `unitree_sdk2py`. No
dimos blueprint has to be running and nothing gets compiled. Run it onboard the Jetson, or from a
machine plugged into the robot's own `192.168.123.x` LAN (`--iface` picks the interface, default
`eth0`).

```sh
dtk g1_cmd                 # status — reads the mode, changes nothing (the default)
dtk g1_cmd damp            # joints compliant
dtk g1_cmd getup           # from flat on its back
dtk g1_cmd stiffen         # joints locked, legs straight, not balancing yet
dtk g1_cmd balance         # into the advanced controller (needs it stiffened first)
dtk g1_cmd stand           # stiffen then balance
dtk g1_cmd limp            # motors off
```

The advanced controller — the one that walks naturally rather than stomping — cannot be entered
with `SetFsmId(801)`; the loco service silently refuses it. The only way in is to emulate a held
`R2`+`A` on `rt/wirelesscontroller` exactly as the physical remote sends it, which `balance` does.

Every action but `status` puts a humanoid under torque control, so `status` is what you get when
you name none of them.

### Watching the network

When a robot "stops listening", the question is whether the commands were refused or never
arrived — and after the fact there is usually nothing left to tell you which. `dtk net` records
the link continuously so the next occurrence has an answer instead of a theory.

```sh
dtk net install --host G1Wifi   # install + start the recorder there (omit --host for here)
dtk net status --host G1Wifi    # is it running, how much has it collected
dtk net log --host G1Wifi -f    # watch the raw lines go by
dtk net log --host G1Wifi --events   # just the wifi/NetworkManager events
dtk net report --host G1Wifi    # pull the log down and summarise it
dtk net uninstall --host G1Wifi # stop it (the logs are kept)
```

It runs as a `--user` systemd service at `Nice=15` and writes JSONL to
`~/.dimos/logs/netlog-<date>.jsonl`, one sample a second plus an aggregated line per batch of
kernel/NetworkManager events, pruned after `--keep-days` (7).

Each sample carries the things that move together during an outage: signal and the
`/proc/net/wireless` retry counters, per-interface byte deltas, and for every socket on the
watched ports its **Send-Q**, RTT, congestion window and cumulative retransmits — a control
socket backing up is the most direct evidence there is that the robot tried to talk and the
bytes did not leave. Ping to the default gateway runs alongside ping to whoever is connected, so
"the air is bad" and "the path past the AP is bad" stay distinguishable.

Two things worth knowing, both measured on a G1's Realtek adapter: `iw dev wlan0 station dump`
returns nothing at all there, so the retry counters come from `/proc/net/wireless` instead; and
`journalctl -f` block-buffers into a pipe, delivering one chunk and then silence, so events are
polled with `--cursor-file` rather than followed.

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
