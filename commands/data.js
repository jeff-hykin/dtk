// `dtk data <verb> <recording> ...` — one namespace for everything that operates
// on a recording. Each verb works out for itself whether it was handed a memory2
// .db or an .mcap and either picks the right tool or says why it cannot.

import { Command } from "jsr:@cliffy/command@1.0.0-rc.7"
import { toolsByName } from "../registry.js"
import { runTool } from "../tool_store.js"
import { requireFormat } from "../recordings.js"
import { toRrd } from "../rrd.js"
import { asFormat, dbToMcap, mcapToDb, splitEncodeFlags } from "../conversions.js"

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
            const plan = await byFormat[format](recording, args.slice(1))
            if (typeof plan === "string") {
                console.error(plan)
                Deno.exit(2)
            }
            if (typeof plan === "number") {
                Deno.exit(plan) // the plan did the work itself
            }
            Deno.exit(await runTool(toolsByName[plan.tool], plan.args))
        })
}

const flatName = (topic) => topic.replace(/^\//, "").replace(/\//g, "_")
const stem = (path) => path.replace(/\.(db|mcap)$/, "")

// The value after a flag, and the args without either.
function takeFlag(args, ...names) {
    const at = args.findIndex((each) => names.includes(each))
    if (at === -1) {
        return [null, args]
    }
    return [args[at + 1], [...args.slice(0, at), ...args.slice(at + 2)]]
}

// mcap_edit never asks before it writes, so a -y meant for the .db tools is dropped.
const withoutYes = (args) => args.filter((each) => each !== "-y" && each !== "--yes")

const ENCODE_HELP = "--encode TOPIC=keep|raw|jpeg[:Q] (repeatable), --image-encoding keep|raw|jpeg[:Q] for the rest, --jpeg-quality N"

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
            usage: "<recording> <old> <new> [-y]",
            byFormat: {
                mcap: (recording, rest) =>
                    rest.length < 2
                        ? "dtk data topic rename: need <old> <new>"
                        : { tool: "mcap_edit", args: [recording, "--rename", `${rest[0]}=${rest[1]}`, ...withoutYes(rest.slice(2))] },
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
                        : { tool: "mcap_edit", args: [recording, "--delete", rest[0], ...withoutYes(rest.slice(1))] },
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
                    // Across formats the one topic is converted on its own into a
                    // scratch recording of the destination's format, and copied from there.
                    const folder = await Deno.makeTempDir({ prefix: "dtk_topic_copy_" })
                    let code = 1
                    try {
                        let plan
                        if (to === "db") {
                            const stream = flatName(options.topic)
                            await mcapToDb(options.from, `${folder}/one.db`, ["--map", `${options.topic}=${stream}`, "--image-encoding", "keep"])
                            plan = { tool: "db_cp", args: ["--from", `${folder}/one.db`, "--to", options.to, "--stream", stream] }
                        } else {
                            const topic = options.topic.startsWith("/") ? options.topic : `/${options.topic}`
                            await dbToMcap(options.from, `${folder}/one.mcap`, {
                                encode: ["--image-encoding", "keep"],
                                dbToMcapArgs: ["--streams", options.topic, "--topics", JSON.stringify({ [options.topic]: topic })],
                            })
                            plan = { tool: "mcap_edit", args: [options.to, "--copy-topic-from", `${folder}/one.mcap:${topic}`] }
                        }
                        code = await runTool(toolsByName[plan.tool], plan.args)
                    } finally {
                        await Deno.remove(folder, { recursive: true }).catch(() => {})
                    }
                    Deno.exit(code)
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
                // Only the tf channels are converted, so a big recording costs little.
                mcap: async (recording, rest) => ({
                    tool: "db_tree",
                    args: [await asFormat(recording, "db", ["--only-schema", "tf2_msgs/msg/TFMessage"]), ...rest],
                }),
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
                            args: [recording, "--rename-tf-frame", `${rest[0]}=${rest[1]}`, ...withoutYes(rest.slice(2))],
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
                            args: [recording, "--add-tf", rest[0], ...withoutYes(rest.slice(1))],
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
    .command(
        "to_video",
        perFormat({
            name: "to_video",
            description: "Encode an image stream as an mp4",
            usage: "<recording> <stream|topic> [output.mp4] [--fps N] [--crf N] [--scale PX] [--stride N] [--list]",
            byFormat: {
                db: (recording, rest) => ({ tool: "to_video", args: [recording, ...rest] }),
                // Just that topic is converted to a .db, in the cache, and encoded from there.
                mcap: async (recording, rest) => {
                    if (rest.includes("--list")) {
                        return { tool: "to_video", args: [await asFormat(recording, "db", ["--image-encoding", "keep"]), ...rest] }
                    }
                    const [topic, ...more] = rest
                    if (!topic) {
                        return "dtk data to_video: need the topic"
                    }
                    const stream = flatName(topic)
                    const output = more[0] && !more[0].startsWith("-") ? [] : [`${stem(recording)}_${stream}.mp4`]
                    const db = await asFormat(recording, "db", ["--map", `${topic}=${stream}`])
                    return { tool: "to_video", args: [db, stream, ...output, ...more] }
                },
            },
        }),
    )
    .command(
        "to_mcap",
        perFormat({
            name: "to_mcap",
            description: "Write a ROS 2 .mcap: from a .db, or a re-encoded copy of an .mcap",
            usage: `<recording> [-o out.mcap] [${ENCODE_HELP}]`,
            byFormat: {
                db: async (recording, rest) => {
                    const { encode, rest: others } = splitEncodeFlags(rest)
                    const [out, dbToMcapArgs] = takeFlag(others, "-o", "--out")
                    await dbToMcap(recording, out ?? `${stem(recording)}.mcap`, { encode, dbToMcapArgs })
                    console.log(`wrote ${out ?? `${stem(recording)}.mcap`}`)
                    return 0
                },
                mcap: (recording, rest) => {
                    const [out, others] = takeFlag(rest, "-o", "--out")
                    return { tool: "mcap_recode", args: [recording, out ?? `${stem(recording)}.recoded.mcap`, ...others] }
                },
            },
        }),
    )
    .command(
        "to_db",
        perFormat({
            name: "to_db",
            description: "Write a memory2 .db: from an .mcap, or a re-encoded copy of a .db",
            usage: `<recording> [out.db] [${ENCODE_HELP}]`,
            byFormat: {
                mcap: (recording, rest) => {
                    const out = rest[0] && !rest[0].startsWith("-") ? [] : [`${stem(recording)}.db`]
                    return { tool: "mcap_to_db", args: [recording, ...out, ...rest] }
                },
                db: (recording, rest) => {
                    const out = rest[0] && !rest[0].startsWith("-") ? [] : [`${stem(recording)}.recoded.db`]
                    return { tool: "db_recode", args: [recording, ...out, ...rest] }
                },
            },
        }),
    )
    .command(
        "lcm_to_cdr",
        perFormat({
            name: "lcm_to_cdr",
            description: "Write an .mcap whose channels are all CDR (from an .mcap with raw-LCM channels, or from a .db)",
            usage: "<recording> [-o out.mcap]",
            byFormat: {
                mcap: (recording, rest) => ({ tool: "mcap_lcm_to_cdr", args: [recording, ...rest] }),
                // Everything in a .db is LCM, and to_mcap writes it all as CDR.
                db: async (recording, rest) => {
                    const [out, others] = takeFlag(rest, "-o", "--out")
                    const target = out ?? `${stem(recording)}.mcap`
                    await dbToMcap(recording, target, { encode: ["--image-encoding", "keep"], dbToMcapArgs: others })
                    console.log(`wrote ${target}`)
                    return 0
                },
            },
        }),
    )
    .command(
        "check",
        perFormat({
            name: "check",
            description: "Report whether Foxglove can actually draw an .mcap (for a .db: the .mcap to_mcap would write)",
            usage: "<recording>",
            byFormat: {
                mcap: (recording, rest) => ({ tool: "mcap_check", args: [recording, ...rest] }),
                db: async (recording, rest) => ({ tool: "mcap_check", args: [await asFormat(recording, "mcap"), ...rest] }),
            },
        }),
    )
    .command(
        "to_rrd",
        new Command()
            .name("to_rrd")
            .description("Convert to a rerun .rrd, keep it, and open it")
            .usage("<recording> [options]")
            .arguments("<recording:string>")
            .option("--no-open", "Just convert; do not launch rerun")
            .option("--force", "Convert again even if the cached .rrd is still good")
            .option("--camera-hz <hz:number>", "Throttle images to N Hz (0 = all)")
            .option("--voxel <size:number>", "Point size hint")
            .option("--axis <meters:number>", "Axis-arrow length on every transform frame (0 = off)")
            .action(async (options, recording) => {
                // An .mcap is converted to a .db (kept in the cache) and drawn from that.
                if (requireFormat(recording, ["db", "mcap"], "to_rrd") === "mcap") {
                    recording = await asFormat(recording, "db")
                }
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
        accepts: ["db", "mcap"],
        argumentsLine: "<recording.db|.mcap> '<json>' [options]",
    }))
    .command("topic", topic)
    .command("tf", tf)
