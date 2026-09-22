import { Command } from "jsr:@cliffy/command@1.0.0-rc.7"
import { ChatApp } from "../chat/app.js"
import { SpySource } from "../chat/source_spy.js"
import { CompositeSource } from "../chat/source_composite.js"
import { Bridge } from "../chat/bridge.js"
import { toolsByName } from "../registry.js"
import { ensureDownloaded } from "../tool_store.js"
import { runPython } from "../python.js"
import { DtkError } from "../errors.js"

// `dtk chat` -- talk to the agent in a running blueprint.
//
// The dimos equivalent is `dimos humancli`. The differences that matter: it
// attaches to a blueprint that is already up *or* one that starts later, it
// holds a message typed before anything was listening instead of publishing it
// into the void, and it says which of those two situations it is in.
//
// The wire is handled by `tools/chat_bridge.py`, which is the one part that
// has to be python. Two things force that, and both were measured rather than
// assumed:
//
//   publishing   deno has no `setsockopt`, so it cannot set
//                `IP_MULTICAST_IF`. Its multicast sends report success and are
//                dropped by the kernel -- on this mac a raw socket joined to
//                the group saw every python packet and none of deno's, across
//                six different socket setups. Zenoh has no deno client that
//                does not need the router's remote-api plugin.
//   subscribing  `spy`, dtk's rust sniffer, only reports `/resource_stats`;
//                it is built for `dtk constellation`'s topology view, not as a
//                general payload sniffer. With the agent mid-reply a python
//                subscriber saw `/agent`, `/agent_idle`, `/tool_streams` and
//                `/human_input` and spy reported none of them.
//
// `chat/pickle.js` reads langchain messages out of python pickles in pure
// javascript and is verified against real ones, so the moment spy can emit
// raw frames for every channel the reading half needs no python either --
// `chat/source_spy.js` is that reader, waiting on the binary.
//
// `--read-only` refuses to publish -- with `--reader spy` it also means no
// python process is started at all.

function detectTransport() {
    const fromEnvironment = Deno.env.get("DIMOS_TRANSPORT")
    if (fromEnvironment) {
        return { value: fromEnvironment, why: "DIMOS_TRANSPORT" }
    }
    for (const root of [Deno.cwd(), Deno.env.get("DIMOS_REPO")]) {
        if (!root) {
            continue
        }
        try {
            const text = Deno.readTextFileSync(`${root}/.env`)
            const match = text.match(/^\s*DIMOS_TRANSPORT\s*=\s*["']?([a-z]+)/mi)
            if (match) {
                return { value: match[1].toLowerCase(), why: `${root}/.env` }
            }
        } catch (error) {
            continue
        }
    }
    // Matches `GlobalConfig.transport`'s default. If dimos ever changes that,
    // this is the line to change with it.
    return { value: "zenoh", why: "the dimos default" }
}

// Ask the blueprint's own graph whether a module in it takes `/human_input`.
// This is the signal that lets a held message be released before the agent has
// ever spoken; see the deadlock note in `chat/presence.js`.
function wiringLookup() {
    const tool = toolsByName["blueprint_graph"]
    return async (blueprint) => {
        const script = await ensureDownloaded(tool)
        const { code, stdout } = await runPython({
            script,
            args: [blueprint],
            needsDimosModule: tool.needsDimosModule,
            capture: true,
        })
        if (code !== 0) {
            return null
        }
        let graph = null
        try {
            graph = JSON.parse(stdout)
        } catch (error) {
            return null
        }
        const modules = []
        for (const edge of graph.edges ?? []) {
            const topic = String(edge.topic ?? "").replace(/^\//, "")
            if (edge.direction === "in" && topic === "human_input") {
                modules.push(edge.module)
            }
        }
        return { listens: modules.length > 0, modules: [...new Set(modules)] }
    }
}

async function makeBridge({ filter, home, sendOnly }) {
    const tool = toolsByName["chat_bridge"]
    return new Bridge({
        script: await ensureDownloaded(tool),
        dimosModule: tool.needsDimosModule,
        transport: filter ?? detectTransport().value,
        sendOnly,
        logPath: `${home}/.cache/dtk/chat_bridge.log`,
    })
}

export default new Command()
    .name("chat")
    .description("Talk to the agent in a running blueprint, and hold what you type until it is up")
    .option("--transport <backend:string>", "Only show one backend's traffic: lcm or zenoh")
    .option("--read-only", "Never publish; watch the conversation only")
    .option("--reader <which:string>", "bridge (default) or spy — see the note in this file", {
        default: "bridge",
    })
    .option("--no-wiring", "Do not read the running blueprint's graph")
    .example("attach to whatever is running", "dtk chat")
    .example("before the blueprint is up", "dtk chat   # type; it is held until it is")
    .example("just watch", "dtk chat --read-only")
    .action(async (options) => {
        const filter = options.transport ?? null
        if (filter !== null && filter !== "lcm" && filter !== "zenoh") {
            throw new DtkError(`dtk chat: --transport takes lcm or zenoh, not ${filter}`)
        }

        const home = Deno.env.get("HOME") ?? "."
        let source = null
        if (options.reader === "spy") {
            // Opt-in, and only useful once spy emits raw frames for every
            // channel -- see the note above. Left reachable so that change can
            // be tried without touching dtk.
            const spy = toolsByName["spy"]
            const reader = new SpySource({
                path: await ensureDownloaded(spy),
                transport: filter,
            })
            if (options.readOnly === true) {
                source = reader
            } else {
                source = new CompositeSource({
                    reader,
                    writer: await makeBridge({ filter, home, sendOnly: true }),
                })
            }
        } else {
            source = await makeBridge({ filter, home, sendOnly: false })
        }

        const app = new ChatApp({
            source,
            readOnly: options.readOnly === true,
            blueprintWiring: options.wiring === false ? null : wiringLookup(),
        })

        // Every exit path has to put the terminal back: raw mode and the
        // alternate screen outlive the process otherwise, and leave a shell
        // that does not echo what is typed into it.
        const shutdown = async () => {
            await app.stop()
            Deno.exit(0)
        }
        for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
            try {
                Deno.addSignalListener(signal, () => {
                    shutdown().catch(() => Deno.exit(1))
                })
            } catch (error) {
                continue // not every signal exists on every platform
            }
        }

        try {
            await app.start()
        } catch (error) {
            await app.stop()
            if (error instanceof DtkError) {
                throw error
            }
            throw new DtkError(`dtk chat: ${error instanceof Error ? error.message : error}`)
        }
        await app.stop()
    })
