import { Command } from "jsr:@cliffy/command@1.0.0-rc.7"
import { DtkError } from "../errors.js"
import { dim } from "../style.js"
import { buildServer, isUp, portOf } from "./websdk.js"

// A thin web_ctrl: this only serves the page in ../drive/. Every robot byte (cmd_vel,
// cameras, topic discovery) goes browser <-> dimos_websdk directly.
const pageFiles = {
    "/": ["index.html", "text/html; charset=utf-8"],
    "/app.js": ["app.js", "text/javascript; charset=utf-8"],
    "/style.css": ["style.css", "text/css; charset=utf-8"],
}

function takeOption(args, name, fallback) {
    const at = args.findIndex((arg) => arg === name || arg.startsWith(`${name}=`))
    if (at === -1) {
        return [fallback, args]
    }
    const value = args[at].includes("=") ? args[at].split("=")[1] : args[at + 1]
    const width = args[at].includes("=") ? 1 : 2
    return [value, [...args.slice(0, at), ...args.slice(at + width)]]
}

async function pageFile(name) {
    // fetch reads file: and https: alike, so this works from a checkout or a remote install
    const response = await fetch(new URL(`../drive/${name}`, import.meta.url))
    return await response.arrayBuffer()
}

export default new Command()
    .name("drive")
    .description("Drive a robot from a phone or browser (a thin web_ctrl on top of dimos_websdk)")
    .usage(
        "[--port 8099] [--no-open] [websdk options: --port-websdk 9669 --connect tcp/IP:7447 ...]",
    )
    .useRawArgs()
    .action(async (_, ...args) => {
        if (args.includes("--help") || args.includes("-h")) {
            console.log(
                [
                    "dtk drive: serve the drive page and start dimos_websdk if it is not running",
                    "",
                    "  --port <n>          page port (default 8099)",
                    "  --port-websdk <n>   dimos_websdk port (default 9669)",
                    "  --bind <addr>       page bind address (default 0.0.0.0)",
                    "  --no-open           do not open a browser",
                    "  anything else is passed to dimos_websdk (--connect, --whitelist, --blacklist, --host)",
                ].join("\n"),
            )
            return
        }
        const open = !args.includes("--no-open")
        let rest = args.filter((arg) => arg !== "--no-open")
        let port, bind, websdkPort
        ;[port, rest] = takeOption(rest, "--port", "8099")
        ;[bind, rest] = takeOption(rest, "--bind", "0.0.0.0")
        ;[websdkPort, rest] = takeOption(rest, "--port-websdk", String(portOf(rest)))
        websdkPort = Number(websdkPort)

        let child = null
        if (await isUp(websdkPort)) {
            console.error(dim(`using the dimos_websdk already on port ${websdkPort}`))
        } else {
            const binary = await buildServer()
            child = new Deno.Command(binary, {
                args: [
                    ...rest.filter((arg) => !arg.startsWith("--port")),
                    "--port",
                    String(websdkPort),
                ],
                stdin: "null",
                stdout: "inherit",
                stderr: "inherit",
            }).spawn()
            for (let i = 0; i < 100 && !(await isUp(websdkPort)); i++) {
                await new Promise((resolve) => setTimeout(resolve, 100))
            }
            if (!(await isUp(websdkPort))) {
                throw new DtkError(`dtk: dimos_websdk did not come up on port ${websdkPort}`)
            }
        }

        const server = Deno.serve(
            { port: Number(port), hostname: bind, onListen() {} },
            async (request) => {
                const path = new URL(request.url).pathname
                if (path === "/config.json") {
                    return Response.json({ websdkPort })
                }
                if (path === "/dimos.js") {
                    // same origin, so the page can import it as a module without CORS
                    const upstream = await fetch(`http://127.0.0.1:${websdkPort}/dimos.js`)
                    return new Response(upstream.body, {
                        headers: {
                            "content-type": "text/javascript; charset=utf-8",
                            "cache-control": "no-cache",
                        },
                    })
                }
                const file = pageFiles[path]
                if (!file) {
                    return new Response("not found", { status: 404 })
                }
                return new Response(await pageFile(file[0]), {
                    headers: { "content-type": file[1], "cache-control": "no-cache" },
                })
            },
        )
        const url = `http://localhost:${port}/`
        console.log(url)
        if (open) {
            const opener = Deno.build.os === "darwin" ? "open" : "xdg-open"
            await new Deno.Command(opener, { args: [url], stdout: "null", stderr: "null" }).output()
                .catch(() => {})
        }
        if (child) {
            const status = await child.status
            await server.shutdown()
            Deno.exit(status.code)
        }
        await server.finished
    })
