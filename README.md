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

### Benchmarking a link

`dtk bench <ssh-host>` measures what the link to a robot can carry and how much delay it adds,
both at once: every test offers traffic at several rates (idle, 1, 5, 10, 25 Mbit/s and as fast
as it goes) while 20 Hz pings measure the round trip **inside** the load (same connection) and
**beside** it (a separate one). Both machines need dtk; the far one is started over ssh.

```sh
dtk bench r1-pro-0219                              # an ssh config entry, or user@host
dtk bench nvidia@r1 --ssh-args "-F /dev/null"      # extra ssh options
dtk bench robot --stages tcp,udp --seconds 5       # only the raw link
dtk bench robot --json-note "after moving the AP"  # kept with the run and shown in its report
dtk bench history                                  # saved runs
dtk bench open latest                              # serve a saved report again
```

| Stage | What it measures |
| --- | --- |
| `loopback` | each machine to itself over TCP and UDP: what the machine can do with no network |
| `tcp`, `udp` | machine to machine, the far side sending; UDP also counts lost datagrams |
| `http`, `ws` | a headless Chromium here downloading from the far side, and over a WebSocket |
| `webrtc` | a data channel to node-datachannel (libdatachannel, native) on the far side, pings on a second channel |
| `webrtc-js` | the same against werift (pure JS); not run by default, it is there to tell a slow stack from a slow link |
| `webtransport` | a QUIC stream to Deno's QUIC server, pings as datagrams on the same connection |
| `queue` | WebRTC and WebSocket as fast as they go with the sender's queue capped at 16 KB … 4 MB (`--queue-sizes`): the speed-against-delay curve |
| `zenoh` | through the zenoh gateway (dimos Desktop's by default, as `--gateway-app dim-controller`): the far side publishes a test key, the page subscribes; latency is the gateway client's heartbeat round trip |

It ends with an HTML report served on localhost: plain-language takeaways first (with the
thresholds behind each good/so-so/bad), then speed and delay against load, per-second series,
CPU on both machines, and each end's link (route interface; for Wi-Fi the SSID, band, channel,
width, signal and bitrates; for Ethernet the speed; Tailscale direct or relayed). Every run is
saved under `~/.cache/dtk/bench/` (`$DTK_CACHE`) as `result.json` + `report.html`; `--no-serve`
just saves.

The browser page is visible and unthrottled (a background tab clamps timers to 1 Hz and every
latency is then wrong), and is served from localhost here because WebTransport needs a secure
context. Paced senders never queue more than 256 KB in their own transport (high water; they
wait for it to drain to half), so latency under load is the network's and the kernel's, not a
runaway application buffer; the `queue` stage shows what other caps would do. A UDP or zenoh "max"
is skipped: an unpaced flood only measures the drops it causes. Everything the far side starts
stops when the ssh session closes (or after `--max-seconds`).

### Who is on a machine

`dtk who <ssh-host>` answers "who is connected to this robot, and what are they running" with
one read-only ssh call (nothing on the far side is started, stopped or written):

```sh
dtk who AlfredJetson                                # an ssh config entry, or user@host
dtk who nvidia@r1-pro-0219 --ssh-args "-F /dev/null"
dtk who robot --hours 24 --json                     # logins further back, machine-readable
```

It lists each ssh session (from where, which key, and whether it is a shell, VS Code/Cursor,
sftp/scp, a command, or port forwarding only), editor servers with their terminals and agents
(claude, codex, copilot), `who` logins, accepted ssh logins grouped by address (from the
journal; needs `adm`/`systemd-journal`), dimos blueprints and simhub runs, and the busiest
processes. Times are in the far side's zone and in UTC.

Addresses are named here: tailscale's peer list (with the owner), the LAN endpoint each online
peer answers `tailscale ping` on (cached an hour in `~/.cache/dtk/who/`; `--refresh` re-pings),
the notes in `~/.config/dtk/known_hosts.json` (an `"ip": "name"` map you keep), and for the rest
a quick look: `Server: AirTunes` on :5000 means a Mac, reverse DNS, and the ARP entry's MAC.
Key names come from the comments in the far side's `authorized_keys`.

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
dtk data topic frame <recording.db> <stream> [--header OLD=NEW] [--child OLD=NEW]   # the frame its messages name

dtk data tf tree <recording>
dtk data tf full_check <recording>
dtk data tf rename <recording> <old> <new>
dtk data tf namespace <recording> all --with <prefix> [--except a,b,c]
dtk data tf reroot <recording> [--odometry auto|tf|<stream>] [--pose-of <frame>]   # odom -> lidar -> base_link
```

### Running a blueprint

```sh
dtk run <blueprint> [config tokens]     # dimos run, filtered and watched
dtk run --check-only <blueprint>        # just the blueprint check
dtk run-isolated <blueprint>            # dtk run, with zenoh kept on this machine
dtk constellation                       # watch live LCM/zenoh traffic in the browser
dtk log                                 # print the jsonl log's path, and open it
dtk fk                                  # kill everything a run leaves behind
```

`dtk run` checks the blueprint before it starts anything — two modules writing the same topic, and
a dangling output that looks like a typo of a dangling input — then turns dtop and a native rebuild
on, prints the absolute path of the run's jsonl log, and shows only warnings and worse, de-duplicated
so one module in a loop cannot bury the rest.

`dtk run-isolated` is `dtk run` for a robot on a shared network. Every zenoh session becomes a client of a
router on `tcp/127.0.0.1:7447` (started for the run if none is up), so no module listens on the network or
hands its address to other machines' peers. It refuses to start when something on 7447 is open to the network,
and 30 s in it lists any of the run's sockets that still face the network.

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
