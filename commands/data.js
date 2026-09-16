// `dtk data <verb> <recording> ...` — one namespace for everything that operates
// on a recording. Each verb works out for itself whether it was handed a memory2
// .db or an .mcap and either picks the right tool or says why it cannot.

import { Command } from "jsr:@cliffy/command@1.0.0-rc.7"
import { toolsByName } from "../registry.js"
import { runTool } from "../tool_store.js"
import { requireFormat } from "../recordings.js"
import { toRrd } from "../rrd.js"

const wantsHelp = (args) => args.includes("-h") || args.includes("--help")

// A verb that is one tool, handed the recording and everything after it.
function passthrough({ name, description, tool, accepts, argumentsLine }) {
    return new Command()
        .name(name)
        .description(description)
        .usage(argumentsLine || "<recording> [...]")
        .useRawArgs()
        .action(async (...raw) => {
            const args = raw.flat().filter((each) => typeof each === "string")
            if (args.length === 0 || wantsHelp(args)) {
                // the tool's own --help is the useful one; this is a thin wrapper
                Deno.exit(await runTool(toolsByName[tool], ["--help"]))
            }
            requireFormat(args[0], accepts, name)
            Deno.exit(await runTool(toolsByName[tool], args))
        })
}

// A verb whose tool depends on the format, with the arguments rearranged per format.
function perFormat({ name, description, usage, byFormat }) {
    return new Command()
        .name(name)
        .description(description)
        .usage(usage)
        .useRawArgs()
        .action(async (...raw) => {
            const args = raw.flat().filter((each) => typeof each === "string")
            if (args.length === 0 || wantsHelp(args)) {
                console.log(`dtk data ${name} ${usage}\n\n  ${description}`)
                return
            }
            const recording = args[0]
            const format = requireFormat(recording, Object.keys(byFormat), name)
            const plan = byFormat[format](recording, args.slice(1))
            if (typeof plan === "string") {
                console.error(plan)
                Deno.exit(2)
            }
            Deno.exit(await runTool(toolsByName[plan.tool], plan.args))
        })
}

const notYet = (what) =>
    `dtk data: ${what} is not implemented yet — see TODO.md in the dtk repo`

const topic = new Command()
    .name("topic")
    .description("Rename, delete or copy a topic/stream")
    .action(function () {
        this.showHelp()
    })
    .command(
        "rename",
        perFormat({
            name: "topic rename",
            description: "Rename one topic, in place",
            usage: "<recording> <old> <new>",
            byFormat: {
                mcap: (recording, rest) =>
                    rest.length < 2
                        ? "dtk data topic rename: need <old> <new>"
                        : { tool: "mcap_edit", args: [recording, "--rename", `${rest[0]}=${rest[1]}`, ...rest.slice(2)] },
                db: (recording, rest) =>
                    rest.length < 2
                        ? "dtk data topic rename: need <old> <new>"
                        : { tool: "db_rename", args: [recording, ...rest] },
            },
        }),
    )
    .command(
        "delete",
        perFormat({
            name: "topic delete",
            description: "Drop one topic and its messages",
            usage: "<recording> <topic> [tool flags]",
            byFormat: {
                mcap: (recording, rest) =>
                    rest.length < 1
                        ? "dtk data topic delete: need <topic>"
                        : { tool: "mcap_edit", args: [recording, "--delete", rest[0], ...rest.slice(1)] },
                db: (recording, rest) =>
                    rest.length < 1
                        ? "dtk data topic delete: need <stream>"
                        : { tool: "db_delete", args: [recording, ...rest] },
            },
        }),
    )
    .command(
        "copy",
        new Command()
            .name("copy")
            .description("Copy one topic from one recording into another")
            .usage("--from SRC --to DST --topic NAME")
            .option("--from <path:string>", "Recording to read from", { required: true })
            .option("--to <path:string>", "Recording to write into", { required: true })
            .option("--topic <name:string>", "Topic/stream to copy", { required: true })
            .action(async (options) => {
                const from = requireFormat(options.from, ["db", "mcap"], "topic copy")
                const to = requireFormat(options.to, ["db", "mcap"], "topic copy")
                if (from !== to) {
                    console.error(
                        `dtk data topic copy: one is a .db and the other an .mcap. Convert one ` +
                        `first with \`dtk data to_db\` or \`dtk data to_mcap\`.`,
                    )
                    Deno.exit(2)
                }
                const plan = to === "db"
                    ? {
                        tool: "db_cp",
                        args: ["--from", options.from, "--to", options.to, "--stream", options.topic],
                    }
                    : {
                        tool: "mcap_edit",
                        args: [options.to, "--copy-topic-from", `${options.from}:${options.topic}`],
                    }
                Deno.exit(await runTool(toolsByName[plan.tool], plan.args))
            }),
    )

const tf = new Command()
    .name("tf")
    .description("Inspect and edit the tf tree of a recording")
    .action(function () {
        this.showHelp()
    })
    .command(
        "tree",
        perFormat({
            name: "tf tree",
            description: "Print the tf frame tree",
            usage: "<recording> [--seconds N]",
            byFormat: {
                db: (recording, rest) => ({ tool: "db_tree", args: [recording, ...rest] }),
            },
        }),
    )
    .command("full_check", passthrough({
        name: "full_check",
        description: "Report every defect in the tf tree",
        tool: "tf_check",
        accepts: ["db", "mcap"],
        argumentsLine: "<recording> [--json]",
    }))
    .command(
        "rename",
        perFormat({
            name: "tf rename",
            description: "Rename one tf frame, on either side of every edge it appears on",
            usage: "<recording> <old> <new> [-y]",
            byFormat: {
                db: (recording, rest) =>
                    rest.length < 2
                        ? "dtk data tf rename: need <old> <new>"
                        : {
                            tool: "db_tf_rename",
                            args: [recording, "--rename", `${rest[0]}=${rest[1]}`, ...rest.slice(2)],
                        },
                mcap: (recording, rest) =>
                    rest.length < 2
                        ? "dtk data tf rename: need <old> <new>"
                        : {
                            tool: "mcap_edit",
                            args: [recording, "--rename-tf-frame", `${rest[0]}=${rest[1]}`, ...rest.slice(2)],
                        },
            },
        }),
    )
    .command(
        "add",
        perFormat({
            name: "tf add",
            description: "Add tf edges, given as json: {parent, child, translation, rotation, static}",
            usage: "<recording> '<json>' [-y]",
            byFormat: {
                db: (recording, rest) =>
                    rest.length < 1
                        ? "dtk data tf add: need the json"
                        : { tool: "db_tf_add", args: [recording, ...rest] },
                mcap: (recording, rest) =>
                    rest.length < 1
                        ? "dtk data tf add: need the json"
                        : {
                            tool: "mcap_edit",
                            args: [recording, "--add-tf", rest[0], ...rest.slice(1)],
                        },
            },
        }),
    )
    .command(
        "namespace",
        new Command()
            .name("namespace")
            .description("Prefix every tf frame name")
            .usage("<recording> all --with <prefix> [--except a,b,c]")
            // `all` is the only scope there is so far; it is spelled out so a
            // later `--only` cannot silently change what a saved command does
            .arguments("<recording:string> <scope:string>")
            .option("--with <prefix:string>", "The prefix to add", { required: true })
            .option("--except <frames:string>", "Comma-separated frames to leave alone")
            .option("-y, --yes", "Skip the confirmation prompt")
            .action(async (options, recording, scope) => {
                if (scope !== "all") {
                    console.error(`dtk data tf namespace: the only scope is \`all\`, not "${scope}"`)
                    Deno.exit(2)
                }
                const format = requireFormat(recording, ["db", "mcap"], "tf namespace")
                const exceptions = (options.except ?? "")
                    .split(",")
                    .map((each) => each.trim())
                    .filter((each) => each.length > 0)
                const plan = format === "db"
                    ? {
                        tool: "db_tf_rename",
                        args: [
                            recording,
                            "--namespace", options.with,
                            ...exceptions.flatMap((frame) => ["--except", frame]),
                            ...(options.yes ? ["-y"] : []),
                        ],
                    }
                    : {
                        tool: "mcap_edit",
                        args: [
                            recording,
                            "--namespace-tf", options.with,
                            ...exceptions.flatMap((frame) => ["--except-tf-frame", frame]),
                        ],
                    }
                Deno.exit(await runTool(toolsByName[plan.tool], plan.args))
            }),
    )

export default new Command()
    .name("data")
    .description("Work on a recording — a memory2 .db or an .mcap")
    .action(function () {
        this.showHelp()
    })
    .command("summary", passthrough({
        name: "summary",
        description: "Per-stream counts, rates and gaps, plus the tf frame tree",
        tool: "db_summary",
        accepts: ["db", "mcap"],
    }))
    .command("heatmap", passthrough({
        name: "heatmap",
        description: "Top-down density heatmap, with the odometry path over it",
        tool: "heatmap",
        accepts: ["db", "mcap"],
        argumentsLine: "<recording> [output.png]",
    }))
    .command("to_video", passthrough({
        name: "to_video",
        description: "Encode an image stream as an mp4",
        tool: "to_video",
        accepts: ["db"],
        argumentsLine: "<recording> <stream> [output.mp4]",
    }))
    .command("to_mcap", passthrough({
        name: "to_mcap",
        description: "Convert a memory2 .db into a ROS 2 .mcap",
        tool: "db_to_mcap",
        accepts: ["db"],
        argumentsLine: "<recording.db> [-o out.mcap]",
    }))
    .command("to_db", passthrough({
        name: "to_db",
        description: "Convert an .mcap into a memory2 .db",
        tool: "mcap_to_db",
        accepts: ["mcap"],
        argumentsLine: "<recording.mcap> <out.db>",
    }))
    .command("lcm_to_cdr", passthrough({
        name: "lcm_to_cdr",
        description: "Re-encode the raw-LCM channels of an .mcap as CDR",
        tool: "mcap_lcm_to_cdr",
        accepts: ["mcap"],
        argumentsLine: "<recording.mcap> [-o out.mcap]",
    }))
    .command("check", passthrough({
        name: "check",
        description: "Report whether Foxglove can actually draw an .mcap",
        tool: "mcap_check",
        accepts: ["mcap"],
    }))
    .command(
        "to_rrd",
        new Command()
            .name("to_rrd")
            .description("Convert to a rerun .rrd, keep it, and open it")
            .usage("<recording.db> [options]")
            .arguments("<recording:string>")
            .option("--no-open", "Just convert; do not launch rerun")
            .option("--force", "Convert again even if the cached .rrd is still good")
            .option("--camera-hz <hz:number>", "Throttle images to N Hz (0 = all)")
            .option("--voxel <size:number>", "Point size hint")
            .option("--axis <meters:number>", "Axis-arrow length on every transform frame (0 = off)")
            .action(async (options, recording) => {
                requireFormat(recording, ["db"], "to_rrd")
                const conversion = []
                if (options.cameraHz !== undefined) {
                    conversion.push("--camera-hz", String(options.cameraHz))
                }
                if (options.voxel !== undefined) {
                    conversion.push("--voxel", String(options.voxel))
                }
                if (options.axis !== undefined) {
                    conversion.push("--axis", String(options.axis))
                }
                Deno.exit(await toRrd(recording, {
                    force: options.force === true,
                    open: options.open !== false,
                    conversion,
                }))
            }),
    )
    .command("add", passthrough({
        name: "add",
        description: "Replay the recording through dimos modules and write their outputs back in",
        tool: "data_add",
        accepts: ["db"],
        argumentsLine: "<recording.db> '<json>' [options]",
    }))
    .command("topic", topic)
    .command("tf", tf)
