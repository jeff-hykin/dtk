// Every sub-tool dtk knows about. Nothing here is downloaded until it is run.
//
// kind: "deno"   — a self-contained deno script, fetched into the cache and run
// kind: "python" — run through `uv run`, with the project resolved by python.js
// kind: "binary" — a precompiled executable pulled from a github release
//
// A python tool says what it imports rather than where it lives:
// `needsDimosModule` is the module path that decides which dimos checkout can
// host it, and `withPackages` are the pypi packages uv should add on top.
//
// `formats` says which recording formats the tool accepts, and is what `dtk data`
// checks before handing a file over.

const denoRecordingPermissions = [
    "--allow-read",
    "--allow-write",
    "--allow-net",
    "--allow-env",
    "--allow-ffi",
    "--unstable-ffi",
]

export const tools = [
    {
        name: "db_summary",
        kind: "deno",
        description: "Summarize what is inside a memory2 .db or an .mcap",
        entry: "tools/db_summary.js",
        formats: ["db", "mcap"],
        permissions: denoRecordingPermissions,
    },
    {
        name: "db_tree",
        kind: "deno",
        description: "Print the tf frame tree of a memory2 .db",
        entry: "tools/db_tree.js",
        formats: ["db"],
        permissions: ["--allow-read", "--allow-env", "--allow-ffi", "--unstable-ffi"],
    },
    {
        name: "tf_check",
        kind: "deno",
        description: "Report every defect in a recording's tf tree",
        entry: "tools/tf_check.js",
        formats: ["db", "mcap"],
        permissions: denoRecordingPermissions,
    },
    {
        name: "db_tf_rename",
        kind: "deno",
        description: "Rename tf frames inside a memory2 .db, in place",
        entry: "tools/db_tf_rename.js",
        formats: ["db"],
        permissions: denoRecordingPermissions,
    },
    {
        name: "db_tf_add",
        kind: "deno",
        description: "Add tf edges to a memory2 .db, in place",
        entry: "tools/db_tf_add.js",
        formats: ["db"],
        permissions: denoRecordingPermissions,
    },
    {
        name: "db_cp",
        kind: "deno",
        description: "Copy one stream from one memory2 .db into another",
        entry: "tools/db_cp.js",
        formats: ["db"],
        permissions: denoRecordingPermissions,
    },
    {
        name: "db_rename",
        kind: "deno",
        description: "Rename a stream in a memory2 .db, in place",
        entry: "tools/db_rename.js",
        formats: ["db"],
        permissions: denoRecordingPermissions,
    },
    {
        name: "db_delete",
        kind: "deno",
        description: "Drop a stream from a memory2 .db",
        entry: "tools/db_delete.js",
        formats: ["db"],
        permissions: denoRecordingPermissions,
    },
    {
        name: "urdf_edit",
        kind: "deno",
        description: "View and edit URDF frames in the browser",
        entry: "tools/urdf_edit.js",
        extraFiles: [
            "tools/urdf_edit_files/index.html",
            "tools/urdf_edit_files/app.js",
            "tools/urdf_edit_files/controls.js",
            "tools/urdf_edit_files/editor.js",
            "tools/urdf_edit_files/frames.js",
            "tools/urdf_edit_files/icon.svg",
            "tools/urdf_edit_files/theme.css",
            "tools/urdf_edit_files/urdf-model.js",
            "tools/urdf_edit_files/viewer.js",
        ],
        // --allow-write because Save puts the edited URDF on disk
        permissions: ["--allow-read", "--allow-write", "--allow-net", "--allow-run", "--allow-env"],
    },
    {
        name: "heatmap",
        kind: "deno",
        description: "Top-down density heatmap of a recording, with the odometry path over it",
        entry: "tools/heatmap.js",
        formats: ["db", "mcap"],
        permissions: denoRecordingPermissions,
    },
    {
        name: "to_video",
        kind: "deno",
        description: "Turn an image stream in a memory2 recording into an mp4",
        entry: "tools/to_video.js",
        formats: ["db"],
        permissions: [...denoRecordingPermissions, "--allow-run"],
    },
    {
        name: "db_to_mcap",
        kind: "python",
        description: "Convert a memory2 .db recording into a ROS 2 .mcap (needs a dimos checkout and uv)",
        entry: "tools/db_to_mcap.py",
        formats: ["db"],
        needsDimosModule: "dimos/memory2/store/sqlite.py",
        withPackages: ["mcap", "rosbags"],
    },
    {
        name: "mcap_to_db",
        kind: "deno",
        description: "Copy ROS 2 topics out of an .mcap into a memory2 .db, re-encoded as LCM",
        entry: "tools/mcap_to_db.js",
        formats: ["mcap"],
        permissions: denoRecordingPermissions,
    },
    {
        name: "db_to_rrd",
        kind: "deno",
        description: "Convert a memory2 .db recording into a rerun .rrd",
        entry: "tools/db_to_rrd.js",
        formats: ["db"],
        permissions: [...denoRecordingPermissions, "--allow-run"],
    },
    {
        name: "mcap_edit",
        kind: "python",
        description: "Rename or delete topics and tf edges in an .mcap without copying it (needs uv)",
        entry: "tools/mcap_edit.py",
        formats: ["mcap"],
        withPackages: ["zstandard", "lz4"],
    },
    {
        name: "mcap_check",
        kind: "deno",
        description: "Report whether Foxglove will actually be able to draw a ROS 2 .mcap",
        entry: "tools/mcap_check.js",
        formats: ["mcap"],
        permissions: ["--allow-read", "--allow-net", "--allow-env"],
    },
    {
        name: "mcap_lcm_to_cdr",
        kind: "python",
        description: "Re-encode the raw-LCM channels of an .mcap as CDR, so Foxglove can read them (needs a dimos checkout and uv)",
        entry: "tools/mcap_lcm_to_cdr.py",
        formats: ["mcap"],
        needsDimosModule: "dimos/msgs/geometry_msgs/PointStamped.py",
        withPackages: ["mcap", "rosbags"],
    },
    {
        name: "data_add",
        kind: "python",
        description: "Replay a recording through dimos modules and write their outputs back into it",
        entry: "tools/data_add.py",
        formats: ["db"],
        needsDimosModule: "dimos/memory2/store/sqlite.py",
    },
    {
        name: "graph",
        kind: "python",
        description: "Render the DimOS Blueprints in a python file as a diagram in the browser",
        entry: "tools/graph.py",
        needsDimosModule: "dimos/core/coordination/blueprints.py",
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
        // Its linux builds are nix's, and they are not static: the camera SDKs
        // are dynamic libraries living in /nix/store. The release carries a
        // tarball of exactly those store paths beside each binary; dtk unpacks
        // it and runs the binary through the loader inside it, so the target
        // needs neither nix nor root. The mac build is plain cargo and needs
        // nothing.
        runtime: {
            "x86_64-unknown-linux-gnu": "lite_record-x86_64-linux.runtime.tar.gz",
            "aarch64-unknown-linux-gnu": "lite_record-aarch64-linux.runtime.tar.gz",
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
