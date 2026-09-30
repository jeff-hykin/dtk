import { Command } from "jsr:@cliffy/command@1.0.0-rc.7"
import { DtkError } from "../errors.js"
import { dim } from "../style.js"

// dimos_websdk (Rust) serves dimos zenoh topics, RPC and H.264 video to browsers.
// It is built from a local checkout until it has release binaries.
const repo = () => Deno.env.get("DTK_WEBSDK_DIR") ?? `${Deno.env.get("HOME")}/repos/dimos_websdk`

export async function buildServer() {
    const dir = repo()
    try {
        await Deno.stat(`${dir}/Cargo.toml`)
    } catch {
        throw new DtkError(
            `dtk: no dimos_websdk checkout at ${dir} (set DTK_WEBSDK_DIR to point at one)`,
        )
    }
    const build = await new Deno.Command("cargo", {
        args: ["build", "--release", "--quiet"],
        cwd: dir,
        stdout: "inherit",
        stderr: "inherit",
    }).output()
    if (!build.success) {
        throw new DtkError("dtk: building dimos_websdk failed")
    }
    return `${dir}/target/release/dimos_websdk`
}

export function portOf(args) {
    const at = args.findIndex((arg) => arg === "--port" || arg.startsWith("--port="))
    if (at === -1) {
        return 9669
    }
    return Number(args[at].includes("=") ? args[at].split("=")[1] : args[at + 1])
}

export async function isUp(port) {
    try {
        const response = await fetch(`http://127.0.0.1:${port}/status`)
        await response.body?.cancel()
        return response.ok
    } catch {
        return false
    }
}

export const websdk = new Command()
    .name("websdk")
    .description("Start dimos_websdk: dimos zenoh topics, RPC and video for browsers (dimos#2502)")
    .usage(
        "[--port 9669] [--host 0.0.0.0] [--whitelist T]... [--blacklist T]... [--connect tcp/IP:7447]",
    )
    .useRawArgs()
    .action(async (_, ...args) => {
        if (args.includes("--help") || args.includes("-h")) {
            const binary = await buildServer()
            Deno.exit((await new Deno.Command(binary, { args: ["--help"] }).spawn().status).code)
        }
        const binary = await buildServer()
        console.error(dim(`${binary} ${args.join(" ")}`))
        const status = await new Deno.Command(binary, {
            args,
            stdin: "inherit",
            stdout: "inherit",
            stderr: "inherit",
        }).spawn().status
        Deno.exit(status.code)
    })

export const frontend = new Command()
    .name("frontend")
    .description(
        "Open the dimos_websdk test page (every API: subscribe, qos, peek, publish+heartbeat, priority, rpc, video)",
    )
    .usage("[--no-open] [websdk options]")
    .useRawArgs()
    .action(async (_, ...args) => {
        const open = !args.includes("--no-open")
        const serverArgs = args.filter((arg) => arg !== "--no-open")
        const port = portOf(serverArgs)
        let child = null
        if (await isUp(port)) {
            console.error(dim(`using the dimos_websdk already on port ${port}`))
        } else {
            const binary = await buildServer()
            child = new Deno.Command(binary, {
                args: serverArgs,
                stdin: "null",
                stdout: "inherit",
                stderr: "inherit",
            }).spawn()
            for (let i = 0; i < 100 && !(await isUp(port)); i++) {
                await new Promise((resolve) => setTimeout(resolve, 100))
            }
        }
        const url = `http://localhost:${port}/frontend/`
        console.log(url)
        if (open) {
            const opener = Deno.build.os === "darwin" ? "open" : "xdg-open"
            await new Deno.Command(opener, { args: [url], stdout: "null", stderr: "null" }).output()
                .catch(() => {})
        }
        if (child) {
            Deno.exit((await child.status).code)
        }
    })
