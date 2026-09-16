import { Command } from "jsr:@cliffy/command@1.0.0-rc.7"
import { DtkError } from "../errors.js"
import { toolsByName } from "../registry.js"
import { runPython } from "../python.js"
import { ensureDownloaded, sourceBase } from "../tool_store.js"

// `dtk constellation` — the LCM Constellation app, without the dim desktop.
//
// The app is a browser frontend plus two things it cannot do itself: sniff the
// wire, and know what the running blueprint looks like. The sniffing is the
// `spy` binary from dim-lcm-constellation's own release; the blueprint comes
// from `blueprint_graph.py`, which reads it the same way `dtk run` does instead
// of asking a desktop that is not running.
//
// The frontend talks the dim-app websocket bus, so this serves that bus the way
// `urdf_edit` does: `{data: [kind, payload]}` in both directions.

const GRAPH_RESCAN_MS = 4000

const RUNS_DIR = `${Deno.env.get("HOME") ?? "."}/.local/state/dimos/runs`

function alivePids() {
    try {
        const { stdout } = new Deno.Command("ps", {
            args: ["-eo", "pid="],
            stdout: "piped",
            stderr: "null",
        }).outputSync()
        return new Set(
            new TextDecoder().decode(stdout)
                .split("\n")
                .map((each) => Number(each.trim()))
                .filter(Boolean),
        )
    } catch (error) {
        return new Set()
    }
}

// The dimos run registry is the canonical record of what is running -- the same
// files `dimos stop` reads -- so the blueprint on screen is the one on the wire.
function runningBlueprint() {
    const live = alivePids()
    const entries = []
    let names = []
    try {
        names = [...Deno.readDirSync(RUNS_DIR)].map((each) => each.name).filter((each) => each.endsWith(".json"))
    } catch (error) {
        return null
    }
    for (const name of names) {
        try {
            const record = JSON.parse(Deno.readTextFileSync(`${RUNS_DIR}/${name}`))
            if (typeof record?.blueprint !== "string" || !record?.pid) {
                continue
            }
            if (!live.has(Number(record.pid))) {
                continue
            }
            entries.push({ name: record.blueprint, started: record.started_at ?? "" })
        } catch (error) {
            continue // stale or half-written entry
        }
    }
    entries.sort((left, right) => left.started.localeCompare(right.started))
    return entries.length > 0 ? entries[entries.length - 1].name : null
}

async function graphFor(name) {
    if (name === null) {
        return { blueprint: "", modules: {}, edges: [] }
    }
    const tool = toolsByName["blueprint_graph"]
    const script = await ensureDownloaded(tool)
    const { code, stdout } = await runPython({
        script,
        args: [name],
        needsDimosModule: tool.needsDimosModule,
        capture: true,
    })
    if (code !== 0) {
        return { blueprint: name, modules: {}, edges: [], unknown: true }
    }
    try {
        return JSON.parse(stdout)
    } catch (error) {
        return { blueprint: name, modules: {}, edges: [], unknown: true }
    }
}

export default new Command()
    .name("constellation")
    .description("Watch live LCM and zenoh traffic flow through the running blueprint")
    .option("--port <port:number>", "Port to serve on", { default: 8730 })
    .option("--no-open", "Do not open a browser")
    .action(async (options) => {
        const spy = toolsByName["spy"]
        const spyPath = await ensureDownloaded(spy)

        const webDirectory = new URL("../tools/constellation_files/", sourceBase).href
        const readWebFile = async (name) => {
            const target = new URL(name.replace(/^\//, ""), webDirectory)
            if (target.protocol === "file:") {
                return await Deno.readFile(target.pathname)
            }
            const response = await fetch(target)
            if (!response.ok) {
                throw new Deno.errors.NotFound(name)
            }
            return new Uint8Array(await response.arrayBuffer())
        }

        const clients = new Set()
        const broadcast = (payload) => {
            const text = JSON.stringify({ data: ["lcmflow", payload] })
            for (const socket of clients) {
                try {
                    socket.send(text)
                } catch (error) {
                    clients.delete(socket)
                }
            }
        }

        let graph = { blueprint: "", modules: {}, edges: [] }
        let lastSeen = null
        const rescan = async () => {
            const name = runningBlueprint()
            if (name === lastSeen) {
                return
            }
            lastSeen = name
            graph = await graphFor(name)
            broadcast({ kind: "graph", ...graph })
            console.error(
                name === null
                    ? "dtk: no blueprint is running"
                    : `dtk: ${name} — ${Object.keys(graph.modules).length} modules, ${graph.edges.length} edges`,
            )
        }
        await rescan()
        const rescanTimer = setInterval(rescan, GRAPH_RESCAN_MS)

        const types = {
            ".html": "text/html",
            ".js": "text/javascript",
            ".css": "text/css",
            ".svg": "image/svg+xml",
            ".ico": "image/svg+xml",
        }

        const server = Deno.serve({ port: options.port, onListen: () => {} }, async (request) => {
            const url = new URL(request.url)
            let path = url.pathname
            if (path === "/ws" && request.headers.get("upgrade")?.toLowerCase() === "websocket") {
                const { socket, response } = Deno.upgradeWebSocket(request)
                socket.onopen = () => {
                    clients.add(socket)
                    try {
                        socket.send(JSON.stringify({ __dimHost: { v: "0.3.0" } }))
                    } catch (error) {
                        return
                    }
                    broadcast({ kind: "graph", ...graph })
                }
                socket.onclose = () => clients.delete(socket)
                socket.onmessage = (event) => {
                    let message = null
                    try {
                        message = JSON.parse(event.data)
                    } catch (error) {
                        return
                    }
                    if (message?.data?.[0] === "hello") {
                        broadcast({ kind: "graph", ...graph })
                    }
                }
                return response
            }
            if (path === "/") {
                path = "/index.html"
            }
            if (path === "/assets/theme.css") {
                path = "/theme.css"
            }
            if (path === "/favicon.ico") {
                path = "/icon.svg"
            }
            try {
                const body = await readWebFile(path)
                const dot = path.lastIndexOf(".")
                return new Response(body, {
                    headers: { "content-type": types[path.slice(dot)] ?? "application/octet-stream" },
                })
            } catch (error) {
                return new Response("not found", { status: 404 })
            }
        })

        // The spy prints newline-delimited json and never stops on its own, so it
        // is read until it dies and then left dead: restarting it in a loop would
        // hide a binary that cannot run here at all.
        const child = new Deno.Command(spyPath, {
            stdout: "piped",
            stderr: "inherit",
        }).spawn()
        const reader = (async () => {
            const decoder = new TextDecoder()
            let pending = ""
            for await (const chunk of child.stdout) {
                pending += decoder.decode(chunk, { stream: true })
                const lines = pending.split("\n")
                pending = lines.pop() ?? ""
                for (const line of lines) {
                    if (!line.trim()) {
                        continue
                    }
                    try {
                        broadcast(JSON.parse(line))
                    } catch (error) {
                        continue // a partial or non-json line
                    }
                }
            }
        })()

        const address = `http://localhost:${options.port}/`
        console.error(`dtk constellation: ${address}`)
        if (options.open !== false) {
            const opener = Deno.build.os === "darwin" ? "open" : "xdg-open"
            try {
                await new Deno.Command(opener, { args: [address], stdout: "null", stderr: "null" }).output()
            } catch (error) {
                console.error("  (could not open a browser; the url above works)")
            }
        }

        const status = await child.status
        clearInterval(rescanTimer)
        await reader
        server.shutdown()
        if (!status.success) {
            throw new DtkError(`dtk: the spy exited ${status.code}`)
        }
    })
