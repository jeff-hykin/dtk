// Every sub-tool dtk knows about. Nothing here is downloaded until it is run.
//
// kind: "deno"   — a self-contained deno script, fetched into the cache and run
// kind: "sh"     — a posix-shell script, fetched into the cache and run
// kind: "binary" — a precompiled executable pulled from a github release

export const tools = [
    {
        name: "db_summary",
        kind: "deno",
        description: "Summarize what is inside a memory2 .db or an .mcap",
        entry: "tools/db_summary.js",
        permissions: ["--allow-read", "--allow-write", "--allow-net", "--allow-env", "--allow-ffi", "--unstable-ffi"],
    },
    {
        name: "urdf_edit",
        kind: "deno",
        description: "View and edit URDF frames in the browser",
        entry: "tools/urdf_edit.js",
        extraFiles: [
            "tools/urdf_edit_files/index.html",
            "tools/urdf_edit_files/main.js",
            "tools/urdf_edit_files/controls.js",
            "tools/urdf_edit_files/editor.js",
            "tools/urdf_edit_files/frames.js",
            "tools/urdf_edit_files/urdf-model.js",
            "tools/urdf_edit_files/viewer.js",
        ],
        permissions: ["--allow-read", "--allow-net", "--allow-run", "--allow-env"],
    },
    {
        name: "heatmap",
        kind: "deno",
        description: "Top-down density heatmap of a recording, with the odometry path over it",
        entry: "tools/heatmap.js",
        permissions: ["--allow-read", "--allow-write", "--allow-net", "--allow-env", "--allow-ffi", "--unstable-ffi"],
    },
    {
        name: "to_video",
        kind: "deno",
        description: "Turn an image stream in a memory2 recording into an mp4",
        entry: "tools/to_video.js",
        permissions: ["--allow-read", "--allow-write", "--allow-net", "--allow-env", "--allow-run", "--allow-ffi", "--unstable-ffi"],
    },
    {
        name: "db_to_mcap",
        kind: "sh",
        description: "Convert a memory2 .db recording into a ROS 2 .mcap (needs a dimos checkout and uv)",
        entry: "tools/db_to_mcap.sh",
    },
    {
        name: "mcap_to_db",
        kind: "deno",
        description: "Copy ROS 2 topics out of an .mcap into a memory2 .db, re-encoded as LCM",
        entry: "tools/mcap_to_db.js",
        permissions: ["--allow-read", "--allow-write", "--allow-net", "--allow-env", "--allow-ffi", "--unstable-ffi"],
    },
    {
        name: "web_ctrl",
        kind: "binary",
        description: "Web control panel and live viewer for a robot over zenoh",
        repo: "jeff-hykin/temp_web_controller",
        assets: {
            "x86_64-unknown-linux-gnu": "web_ctrl-x86_64-linux",
            "aarch64-unknown-linux-gnu": "web_ctrl-aarch64-linux",
            "aarch64-apple-darwin": "web_ctrl-aarch64-macos",
        },
    },
    {
        name: "lite_record",
        kind: "binary",
        description: "Handheld multi-sensor mcap recorder for RealSense, Orbbec and Livox Mid-360",
        repo: "jeff-hykin/lite_record",
        assets: {
            "x86_64-unknown-linux-gnu": "lite_record-x86_64-linux",
            "aarch64-unknown-linux-gnu": "lite_record-aarch64-linux",
            "aarch64-apple-darwin": "lite_record-aarch64-macos",
        },
    },
    {
        name: "icp_stitch",
        kind: "binary",
        description: "Offline loop-closure post-processing for memory2 recordings: tag PGO + ICP stitching",
        repo: "jeff-hykin/icp_stitch",
        assets: {
            "x86_64-unknown-linux-gnu": "icp_stitch-x86_64-linux",
            "aarch64-unknown-linux-gnu": "icp_stitch-aarch64-linux",
            "aarch64-apple-darwin": "icp_stitch-aarch64-macos",
        },
    },
]

export const toolsByName = Object.fromEntries(tools.map((each) => [each.name, each]))
