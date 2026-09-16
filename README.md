# dtk

The dimos toolkit. One command that is the entrypoint to a collection of dimos tooling.

Sub-tools are **downloaded the first time you run them**, not at install time, so the install
stays tiny and you only pay for what you use.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/jeff-hykin/dtk/master/install.sh | sh
```

That installs [deno](https://deno.land) if you don't already have it, then installs `dtk`.

Already have deno? This is the whole install:

```sh
deno install -gfA --reload -n dtk https://raw.githubusercontent.com/jeff-hykin/dtk/master/main.js
```

Re-run either line to update dtk itself. Uninstall with `deno uninstall -g dtk`.

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
| `heatmap` | Top-down density heatmap of a recording, with the odometry path over it |
| `to_video` | Turn an image stream in a memory2 recording into an mp4 |
| `db_to_mcap` | Convert a memory2 `.db` into a ROS 2 `.mcap` (needs a dimos checkout and `uv`) |
| `mcap_to_db` | Copy ROS 2 topics out of an `.mcap` into a memory2 `.db`, re-encoded as LCM |
| `web_ctrl` | Web control panel and live viewer for a robot over zenoh |
| `lite_record` | Handheld multi-sensor mcap recorder for RealSense, Orbbec and Livox Mid-360 |
| `icp_stitch` | Offline loop-closure post-processing: tag PGO + ICP stitching |

The first six are deno scripts fetched from this repo. The last three are precompiled binaries
pulled from their own repo's latest release, for `x86_64-linux`, `aarch64-linux` and
`aarch64-macos`.

### Managing what is downloaded

```sh
dtk list                # what is downloaded
dtk update [tool]       # re-download one, or everything already downloaded
dtk remove <tool>       # delete one from the cache
dtk where <tool>        # print its path
dtk doctor              # platform, cache location, where dtk itself came from
```

The cache is `$XDG_CACHE_HOME/dtk`, or `~/.cache/dtk`. Override it with `DTK_CACHE`.

A downloaded tool is kept until something says otherwise, so **bump `version` in `version.js`
when you change anything under `tools/`** — that is what tells an existing install its copy is
stale. `dtk update` forces a re-download either way.

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
