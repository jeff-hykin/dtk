import { Command } from "jsr:@cliffy/command@1.0.0-rc.7"
import { DtkError } from "../errors.js"
import { bold, dim, green, pad, red, yellow } from "../style.js"
import { parseRates, rateLabel } from "../bench/protocol.js"
import { cpuSampler, linkInfo } from "../bench/link_info.js"
import {
    findRun,
    listRuns,
    renderHtml,
    saveRun,
    serveReport,
    takeaways,
    thresholds,
} from "../bench/report.js"
import { version } from "../version.js"

// The bench code runs in a deno of its own (UDP and QUIC need --unstable-net), from wherever
// this dtk was installed from, so both machines run the same snapshot of it.
const agentUrl = new URL("../bench/agent.js", import.meta.url).href
const installLine =
    "curl -fsSL https://raw.githubusercontent.com/jeff-hykin/dtk/master/install.sh | sh"
const browserStages = ["http", "ws", "webrtc", "webtransport", "zenoh"]
const allStages = ["loopback", "tcp", "udp", ...browserStages]

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function agent(args, { stdin = "null", stdout = "piped" } = {}) {
    return new Deno.Command(Deno.execPath(), {
        args: ["run", "--allow-all", "--unstable-net", "--quiet", agentUrl, ...args.map(String)],
        stdin,
        stdout,
        stderr: "inherit",
    }).spawn()
}

async function* lines(stream) {
    let rest = ""
    for await (const chunk of stream.pipeThrough(new TextDecoderStream())) {
        const parts = (rest + chunk).split("\n")
        rest = parts.pop()
        for (const part of parts) {
            if (part.trim()) {
                yield part
            }
        }
    }
    if (rest.trim()) {
        yield rest
    }
}

const stageNames = {
    tcp: "TCP",
    udp: "UDP",
    http: "browser HTTP",
    ws: "browser WebSocket",
    webrtc: "browser WebRTC",
    webtransport: "browser WebTransport",
    zenoh: "browser zenoh gateway",
}

// One terse line per run, so a long benchmark shows it is alive; the report has the detail.
function progress(scope, stage, result) {
    const where = scope === "link" ? "" : `${scope.replace("loopback-", "loopback ")} `
    const latency = result.inband.p50 === null
        ? "-"
        : `${result.inband.p50}/${result.inband.p95} ms`
    console.log(
        dim(`  ${pad(`${where}${stageNames[stage]}`, 34)} ${pad(result.offered, 5)} → ${
            pad(`${result.mbps} Mbit/s`, 16)
        } in-band ${latency}`),
    )
}

function sshCommand(host, sshArgs, script) {
    return new Deno.Command("ssh", {
        args: [
            ...sshArgs,
            "-o",
            "BatchMode=yes",
            "-o",
            "ServerAliveInterval=5",
            "-o",
            "ServerAliveCountMax=3",
            host,
            script,
        ],
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
    })
}

// What the far side runs: its own dtk, found on a login PATH, or a clear message when it is missing.
function remoteScript(remoteDtk, args) {
    const quoted = args.map((arg) => `'${String(arg).replaceAll("'", "'\\''")}'`).join(" ")
    if (remoteDtk !== "dtk") {
        return `${remoteDtk} bench ${quoted}`
    }
    return [
        `PATH="$HOME/.deno/bin:$HOME/.local/bin:$HOME/.nix-profile/bin:/usr/local/bin:$PATH"`,
        `if ! command -v dtk >/dev/null 2>&1; then echo DTK_BENCH_NO_DTK; exit 127; fi`,
        `exec dtk bench ${quoted}`,
    ].join("; ")
}

function remoteFailure(host, stdout, stderr) {
    if (stdout.includes("DTK_BENCH_NO_DTK")) {
        return new DtkError(
            `dtk bench: dtk is not installed on ${host}; both ends need it. Install it there with\n    ${installLine}`,
        )
    }
    if (/no such command or tool: bench|Unknown command "bench"/.test(stderr)) {
        return new DtkError(
            `dtk bench: the dtk on ${host} predates \`dtk bench\`; update it there with\n    ${installLine}`,
        )
    }
    return new DtkError(
        `dtk bench: could not start the far side on ${host}\n${stderr.trim() || stdout.trim()}`,
    )
}

// Reads an agent's JSON lines into the report.
async function collect(stream, scope, report) {
    for await (const line of lines(stream)) {
        let item
        try {
            item = JSON.parse(line)
        } catch {
            continue
        }
        if (item.skip || item.error) {
            report.skipped.push({
                scope,
                stage: item.stage,
                offered: item.skip ?? rateLabel(item.offered ?? 0),
                why: item.why ?? item.error,
            })
        } else if (item.result) {
            report.runs.push({ scope, stage: item.stage, ...item.result })
            progress(scope, item.stage, item.result)
        }
    }
}

async function runBench(options, host) {
    const sshArgs = options.sshArgs ? options.sshArgs.split(/\s+/).filter(Boolean) : []
    const rates = parseRates(options.rates)
    const seconds = options.seconds
    const stages = options.stages.split(",").map((each) => each.trim())
    for (const stage of stages) {
        if (!allStages.includes(stage)) {
            throw new DtkError(`dtk bench: no stage ${stage}; stages are ${allStages.join(",")}`)
        }
    }
    const report = {
        when: new Date().toISOString(),
        dtkVersion: version,
        host,
        note: options.jsonNote ?? null,
        options: { ...options, rates: options.rates, seconds },
        thresholds,
        local: {},
        remote: {},
        runs: [],
        skipped: [],
    }
    const children = []
    const localCpu = cpuSampler()
    let browser = null
    let remote = null
    let cleaned = false
    const cleanup = async () => {
        if (cleaned) {
            return
        }
        cleaned = true
        localCpu.stop()
        for (const child of children) {
            try {
                child.kill("SIGTERM")
            } catch {
                // already gone
            }
        }
        if (remote) {
            // closing its stdin is what ends the far side; the kill is for an ssh that hangs
            remote.stdin.close().catch(() => {})
            await Promise.race([remote.status, sleep(3000)])
            try {
                remote.kill("SIGTERM")
            } catch {
                // already gone
            }
        }
        await Promise.race([browser?.close(), sleep(3000)])
    }
    const onSignal = () => {
        console.error(dim("\ninterrupted, stopping both ends"))
        // never hang on the way out, whatever the cleanup is waiting for
        setTimeout(() => Deno.exit(130), 6000)
        cleanup().finally(() => Deno.exit(130))
    }
    Deno.addSignalListener("SIGINT", onSignal)
    Deno.addSignalListener("SIGTERM", onSignal)

    try {
        if (stages.includes("loopback")) {
            console.log(
                bold("loopback") + dim(" (each machine to itself: what it can do with no network)"),
            )
            const local = agent([
                "loopback",
                "--rates",
                options.loopbackRates,
                "--seconds",
                options.loopbackSeconds,
            ])
            children.push(local)
            await collect(local.stdout, "loopback-here", report)
            await local.status
            const far = sshCommand(
                host,
                sshArgs,
                remoteScript(options.remoteDtk, [
                    "loopback",
                    "--raw",
                    "--rates",
                    options.loopbackRates,
                    "--seconds",
                    options.loopbackSeconds,
                ]),
            ).spawn()
            children.push(far)
            far.stdin.close()
            const errText = new Response(far.stderr).text()
            const [forReport, forError] = far.stdout.tee()
            const outText = new Response(forError).text()
            await collect(forReport, "loopback-far", report)
            if (!(await far.status).success) {
                throw remoteFailure(host, await outText, await errText)
            }
        }

        const networkStages = stages.filter((stage) => stage !== "loopback")
        if (networkStages.length === 0) {
            return report
        }
        // the far side: every server, for as long as this ssh session holds its stdin open
        const longest = (networkStages.length * rates.length * (seconds + 4)) + 300
        remote = sshCommand(
            host,
            sshArgs,
            remoteScript(options.remoteDtk, [
                "serve",
                "--port",
                options.port,
                "--gateway",
                options.gateway,
                "--gateway-app",
                options.gatewayApp,
                "--zenoh-connect",
                options.zenohConnect,
                "--max-seconds",
                longest,
                ...(options.gatewayClient ? ["--gateway-client", options.gatewayClient] : []),
            ]),
        ).spawn()
        const remoteErr = new Response(remote.stderr).text()
        let status = null
        let firstLines = ""
        for await (const line of lines(remote.stdout)) {
            firstLines += line + "\n"
            try {
                const parsed = JSON.parse(line)
                if (parsed.ready) {
                    status = parsed
                    break
                }
            } catch {
                // a line of something else
            }
        }
        if (!status) {
            throw remoteFailure(
                host,
                firstLines,
                await Promise.race([remoteErr, sleep(2000).then(() => "")]),
            )
        }
        const addr = options.addr ?? status.sshServer
        if (!addr) {
            throw new DtkError(
                "dtk bench: could not tell the far side's address from ssh; pass --addr",
            )
        }
        const remoteBase = `http://${addr}:${status.ports.http}`
        report.addr = addr
        report.transports = status.transports
        report.remote.link = status.link
        report.remote.status = {
            deno: status.deno,
            os: status.os,
            arch: status.arch,
            ports: status.ports,
        }
        // system_profiler takes seconds on a Mac, so the near side's link is read while tests run
        const localLink = linkInfo(addr).then((link) => (report.local.link = link))
        console.log(
            `${bold("far side")} ${host} at ${addr} ${
                dim(`(deno ${status.deno}, ${status.os}/${status.arch}; --addr picks another path)`)
            }`,
        )
        for (const [name, transport] of Object.entries(status.transports)) {
            console.log(
                `  ${pad(name, 13)} ${
                    transport.ok
                        ? dim(transport.how ?? "ok")
                        : yellow(`unavailable: ${transport.why}`)
                }`,
            )
        }

        const net = networkStages.filter((stage) => stage === "tcp" || stage === "udp")
        if (net.length > 0) {
            const client = agent([
                "client",
                "--host",
                addr,
                "--tcp",
                status.ports.tcp,
                "--udp",
                status.ports.udp,
                "--echo",
                status.ports.echo,
                "--rates",
                options.rates,
                "--seconds",
                seconds,
                "--stages",
                net.join(","),
            ])
            children.push(client)
            await collect(client.stdout, "link", report)
        }

        const inBrowser = networkStages.filter((stage) => browserStages.includes(stage))
        if (inBrowser.length > 0) {
            const { openPage } = await import("../bench/browser.js")
            browser = await openPage({ remote: remoteBase, chrome: options.chrome })
            for (const stage of inBrowser) {
                const transport = status.transports[stage]
                if (!transport?.ok) {
                    report.skipped.push({
                        scope: "link",
                        stage,
                        offered: "all",
                        why: transport?.why ?? "the far side did not offer it",
                    })
                    continue
                }
                const extra = stage === "webtransport"
                    ? { port: status.ports.webtransport, certHash: transport.certHash }
                    : stage === "zenoh"
                    ? {
                        gatewayPath: new URL(transport.gateway).pathname.replace(/\/+$/, ""),
                        client: transport.client,
                    }
                    : {}
                for (const bitsPerSecond of rates) {
                    if (stage === "zenoh" && bitsPerSecond === Infinity) {
                        report.skipped.push({
                            scope: "link",
                            stage,
                            offered: "max",
                            why: "an unpaced publisher would flood the far side's own zenoh router",
                        })
                        continue
                    }
                    const startedAt = Date.now()
                    try {
                        const result = await browser.run(stage, bitsPerSecond, seconds, extra)
                        report.runs.push({ scope: "link", stage, startedAt, ...result })
                        progress("link", stage, result)
                    } catch (error) {
                        const why = String(error.message ?? error).split("\n")[0].replace(
                            /^page\.evaluate: /,
                            "",
                        )
                        console.log(
                            yellow(
                                `  ${pad(stageNames[stage], 34)} ${
                                    pad(rateLabel(bitsPerSecond), 5)
                                } failed: ${why}`,
                            ),
                        )
                        // one failure to connect means every rate will fail the same way
                        const fatal = ["webtransport", "zenoh", "webrtc"].includes(stage)
                        report.skipped.push({
                            scope: "link",
                            stage,
                            offered: fatal ? "all" : rateLabel(bitsPerSecond),
                            why,
                        })
                        if (fatal) {
                            break
                        }
                    }
                    await sleep(500)
                }
            }
        }
        try {
            const after = await (await fetch(
                `${remoteBase}/cpu?peer=${encodeURIComponent(status.sshClient ?? "")}`,
            )).json()
            report.remote.cpu = after.cpu
            report.remote.linkAfter = after.linkAfter
        } catch {
            // the far side's CPU record is a nice-to-have
        }
        await localLink
        return report
    } finally {
        report.local.cpu = localCpu.samples
        await cleanup()
        Deno.removeSignalListener("SIGINT", onSignal)
        Deno.removeSignalListener("SIGTERM", onSignal)
    }
}

const icons = {
    good: green("good"),
    borderline: yellow("so-so"),
    bad: red("bad "),
    info: dim("info"),
}

function printTakeaways(report) {
    console.log("")
    for (const item of report.takeaways) {
        console.log(`${icons[item.verdict]}  ${item.text}`)
    }
}

const serve = new Command()
    .name("serve")
    .description("The far side of `dtk bench`, started over ssh; runs until its stdin closes")
    .option("--port <port:integer>", "First of the four ports it listens on", { default: 47300 })
    .option(
        "--gateway <url:string>",
        "zenoh gateway as seen from here: auto (dimos Desktop's), none, or a url",
        { default: "auto" },
    )
    .option("--gateway-client <url:string>", "zenoh-gateway client module the page imports")
    .option("--gateway-app <name:string>", "Desktop app whose gateway grants the test uses", {
        default: "dim-controller",
    })
    .option("--zenoh-connect <endpoint:string>", "zenoh router the test publisher connects to", {
        default: "tcp/127.0.0.1:7447",
    })
    .option("--max-seconds <n:integer>", "Stop after this long even if stdin stays open", {
        default: 900,
    })
    .action(async (options) => {
        const child = agent([
            "serve",
            "--port",
            options.port,
            "--gateway",
            options.gateway,
            "--gateway-app",
            options.gatewayApp,
            "--zenoh-connect",
            options.zenohConnect,
            "--max-seconds",
            options.maxSeconds,
            ...(options.gatewayClient ? ["--gateway-client", options.gatewayClient] : []),
        ], { stdin: "inherit", stdout: "inherit" })
        Deno.exit((await child.status).code)
    })

const loopbackCommand = new Command()
    .name("loopback")
    .description(
        "TCP and UDP through loopback on this machine only: what it can do with no network",
    )
    .option("--rates <list:string>", "Offered rates, Mbit/s (or max)", {
        default: "0,100,1000,max",
    })
    .option("--seconds <n:number>", "Seconds per rate", { default: 2 })
    .option("--raw", "Print the agent's JSON lines")
    .action(async (options) => {
        const child = agent(["loopback", "--rates", options.rates, "--seconds", options.seconds], {
            stdout: options.raw ? "inherit" : "piped",
        })
        if (!options.raw) {
            await collect(child.stdout, "loopback-here", { runs: [], skipped: [] })
        }
        Deno.exit((await child.status).code)
    })

const history = new Command()
    .name("history")
    .description("List saved runs, oldest first")
    .action(() => {
        const runs = listRuns()
        if (runs.length === 0) {
            console.log(dim("no saved runs yet"))
            return
        }
        for (const { name, report } of runs) {
            const tcp = report?.runs?.filter((run) =>
                run.stage === "tcp" && run.scope === "link"
            ) ?? []
            const top = tcp.reduce((best, run) => Math.max(best, run.mbps ?? 0), 0)
            const idle = tcp.find((run) => run.offered === "idle")
            const summary = report
                ? `${top ? `${top} Mbit/s` : "-"}, idle ${idle?.side?.p50 ?? "-"} ms`
                : "unreadable"
            console.log(`${pad(name, 48)} ${dim(summary)}${report?.note ? `  ${report.note}` : ""}`)
        }
    })

const openCommand = new Command()
    .name("open")
    .description("Serve a saved run's report again (latest, or a name from `dtk bench history`)")
    .arguments("[run:string]")
    .option("--no-open", "Only print the url")
    .option("--rebuild", "Re-render the HTML from its result.json (picks up a newer report layout)")
    .action(async (options, which = "latest") => {
        const run = findRun(which)
        if (!run) {
            throw new DtkError(
                `dtk bench open: no saved run matches ${which}; see dtk bench history`,
            )
        }
        if (options.rebuild) {
            const report = JSON.parse(Deno.readTextFileSync(`${run.dir}/result.json`))
            report.takeaways = takeaways(report)
            Deno.writeTextFileSync(`${run.dir}/report.html`, renderHtml(report))
        }
        await serveReport(run.dir, { open: options.open })
    })

export default new Command()
    .name("bench")
    .description(
        "Benchmark the link to <ssh-host>: loopback on each end, TCP/UDP machine to machine, then a " +
            "browser here over HTTP, WebSocket, WebRTC, WebTransport and the zenoh gateway; " +
            "throughput and latency measured together at each offered rate. Needs dtk on both machines. " +
            "Ends with an HTML report (plain-language takeaways, charts, both ends' link and CPU), saved under the dtk cache.",
    )
    .arguments("[ssh-host:string]")
    .option("--ssh-args <args:string>", 'Extra ssh options, e.g. "-F /dev/null"')
    .option("--addr <ip:string>", "Address to test against (default: the one ssh reached)")
    .option("--rates <list:string>", "Offered rates in Mbit/s, 0 = idle, max = unpaced", {
        default: "0,1,5,10,25,max",
    })
    .option("--seconds <n:integer>", "Seconds per rate", { default: 3 })
    .option("--stages <list:string>", `Which stages: ${allStages.join(",")}`, {
        default: allStages.join(","),
    })
    .option("--loopback-rates <list:string>", "Offered rates for the loopback stage", {
        default: "0,100,1000,max",
    })
    .option("--loopback-seconds <n:integer>", "Seconds per loopback rate", { default: 2 })
    .option(
        "--gateway <url:string>",
        "zenoh gateway as the far side sees it: auto (dimos Desktop's), none, or a url",
        { default: "auto" },
    )
    .option(
        "--gateway-client <url:string>",
        "zenoh-gateway client module for the page (default: Desktop's, else v0.6.5)",
    )
    .option(
        "--gateway-app <name:string>",
        "With Desktop's gateway: the app whose grants the test uses",
        { default: "dim-controller" },
    )
    .option(
        "--zenoh-connect <endpoint:string>",
        "zenoh router the far side's test publisher joins",
        { default: "tcp/127.0.0.1:7447" },
    )
    .option("--port <port:integer>", "First of four ports the far side listens on", {
        default: 47300,
    })
    .option(
        "--chrome <path:string>",
        "Chromium for the browser stages (default: playwright's headless shell)",
    )
    .option("--remote-dtk <command:string>", "How to run dtk on the far side", { default: "dtk" })
    .option("--json <file:string>", "Also write every result with its per-second samples here")
    .option("--json-note <text:string>", "A note kept with the run, shown at the top of its report")
    .option("--no-serve", "Save the report but do not serve it (for scripts and agents)")
    .option("--no-open", "Serve the report without opening a browser")
    .example("a robot", "dtk bench r1-pro-0219")
    .example("bypassing ~/.ssh/config", 'dtk bench nvidia@r1-pro-0219 --ssh-args "-F /dev/null"')
    .example("only the raw link", "dtk bench robot --stages tcp,udp --seconds 5")
    .example("past runs", "dtk bench history; dtk bench open latest")
    .action(async (options, host) => {
        if (!host) {
            throw new DtkError(
                "dtk bench: which machine? `dtk bench <ssh-host>` (an ssh config entry or user@host)",
            )
        }
        if (options.seconds > 30) {
            console.error(
                yellow(
                    `dtk bench: ${options.seconds} s per rate keeps the link loaded that long at every rate`,
                ),
            )
        }
        const report = await runBench(options, host)
        report.takeaways = takeaways(report)
        const dir = saveRun(report)
        if (options.json) {
            await Deno.writeTextFile(options.json, JSON.stringify(report, null, 2))
        }
        printTakeaways(report)
        console.log(dim(`\nsaved → ${dir}`))
        if (options.serve) {
            await serveReport(dir, { open: options.open })
        }
    })
    .command("serve", serve)
    .command("loopback", loopbackCommand)
    .command("history", history)
    .command("open", openCommand)
