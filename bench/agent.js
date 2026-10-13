// What `dtk bench` runs in a deno of its own, because UDP and QUIC need --unstable-net, which
// the dtk install itself does not have. Talks JSON lines on stdout.
//
//   agent.js serve --port P [--gateway auto|none|URL] [--gateway-client URL] [--gateway-app NAME] [--zenoh-connect E] [--max-seconds N]
//   agent.js loopback --rates 0,100,max --seconds 2
//   agent.js client --host H --tcp P --udp P --echo P --rates ... --seconds S --stages tcp,udp

import { parseRates } from "./protocol.js"
import { tcpRun, udpRun } from "./net_client.js"
import { linkInfo } from "./link_info.js"
import { serve } from "./server.js"

const [mode, ...rest] = Deno.args
const options = {}
for (let i = 0; i < rest.length; i += 2) {
    options[rest[i].replace(/^--/, "")] = rest[i + 1]
}
const say = (value) => console.log(JSON.stringify(value))

async function runStages({ host, tcp, udp, echo, rates, seconds, stages }) {
    for (const stage of stages) {
        for (const bitsPerSecond of rates) {
            if (stage === "udp" && bitsPerSecond === Infinity) {
                say({
                    stage,
                    skip: "max",
                    why: "an unpaced UDP flood only measures the drops it causes",
                })
                continue
            }
            const run = stage === "tcp" ? tcpRun : udpRun
            try {
                const result = await run({
                    host,
                    port: stage === "tcp" ? tcp : udp,
                    echoPort: echo,
                    bitsPerSecond,
                    seconds,
                })
                say({ stage, result })
            } catch (error) {
                say({ stage, error: String(error), offered: bitsPerSecond })
            }
        }
    }
}

// One connection failing (a QUIC idle timeout rejecting a promise nobody awaits) must not take
// every other transport down with the process
globalThis.addEventListener("unhandledrejection", (event) => {
    event.preventDefault()
    console.error(`dtk bench: ignored: ${event.reason?.message ?? event.reason}`)
})

if (mode === "serve") {
    const maxSeconds = Number(options["max-seconds"] ?? 900)
    const server = await serve({
        port: Number(options.port ?? 47300),
        gateway: options.gateway ?? "auto",
        gatewayClient: options["gateway-client"] || null,
        gatewayApp: options["gateway-app"] || "dim-controller",
        zenohConnect: options["zenoh-connect"] ?? "tcp/127.0.0.1:7447",
    })
    const [sshClient = null, , sshServer = null] = (Deno.env.get("SSH_CONNECTION") ?? "").split(" ")
    const link = sshClient ? await linkInfo(sshClient) : null
    say({
        ready: true,
        deno: Deno.version.deno,
        os: Deno.build.os,
        arch: Deno.build.arch,
        sshServer,
        sshClient,
        link,
        ...server.status,
    })
    // lives as long as whoever started it holds stdin open (an ssh session), and never past maxSeconds
    const stdinClosed = (async () => {
        for await (const _ of Deno.stdin.readable) {
            // nothing to read; this only waits for the end
        }
    })()
    await Promise.race([
        stdinClosed,
        new Promise((resolve) => setTimeout(resolve, maxSeconds * 1000)),
    ])
    server.stop()
    Deno.exit(0)
} else if (mode === "loopback") {
    const server = await serve({ port: 0, browser: false, hostname: "127.0.0.1" })
    const { tcp, udp, echo } = server.status.ports
    await runStages({
        host: "127.0.0.1",
        tcp,
        udp,
        echo,
        rates: parseRates(options.rates ?? "0,100,1000,max"),
        seconds: Number(options.seconds ?? 2),
        stages: ["tcp", "udp"],
    })
    server.stop()
    Deno.exit(0)
} else if (mode === "client") {
    await runStages({
        host: options.host,
        tcp: Number(options.tcp),
        udp: Number(options.udp),
        echo: Number(options.echo),
        rates: parseRates(options.rates),
        seconds: Number(options.seconds),
        stages: options.stages.split(","),
    })
    Deno.exit(0)
} else {
    console.error(`agent.js: unknown mode ${mode}`)
    Deno.exit(2)
}
