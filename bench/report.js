// Turns a `dtk bench` run into plain-language takeaways and a self-contained HTML report, keeps
// every run under the dtk cache for later comparison, and serves a report on localhost.

import { cacheDir } from "../tool_store.js"

export const runsDir = `${cacheDir}/bench`

// Thresholds every verdict uses, stated in the report so nobody has to guess what "good" meant.
export const thresholds = {
    latency: {
        good: 100,
        borderline: 250,
        what:
            "round trip p95: under 100 ms feels instant for remote control; over 250 ms is visibly laggy",
    },
    throughput: {
        good: 20,
        borderline: 5,
        what: "under 5 Mbit/s fits one small video at most; 20 Mbit/s carries several cameras",
    },
    share: { good: 70, borderline: 30, what: "share of what the raw network carries (TCP at max)" },
    signal: {
        good: -60,
        borderline: -70,
        what: "Wi-Fi signal: above -60 dBm is strong, below -70 dBm is weak",
    },
    cpu: { borderline: 70, bad: 90, what: "CPU busy across all cores during the test" },
}

const names = {
    tcp: "a plain TCP connection",
    udp: "UDP",
    http: "HTTP download",
    ws: "WebSocket",
    webrtc: "WebRTC data channel",
    webtransport: "WebTransport",
    zenoh: "the zenoh gateway (what dim-controller uses)",
}

const latencyVerdict = (ms) =>
    ms === null || ms === undefined
        ? "info"
        : ms < thresholds.latency.good
        ? "good"
        : ms <= thresholds.latency.borderline
        ? "borderline"
        : "bad"
const throughputVerdict = (mbps) =>
    mbps >= thresholds.throughput.good
        ? "good"
        : mbps >= thresholds.throughput.borderline
        ? "borderline"
        : "bad"
const shareVerdict = (
    pct,
) => (pct >= thresholds.share.good
    ? "good"
    : pct >= thresholds.share.borderline
    ? "borderline"
    : "bad")
const ms = (value) => (value === null || value === undefined ? "?" : `${Math.round(value)} ms`)
const mbit = (value) => `${value >= 100 ? Math.round(value) : +value.toFixed(1)} Mbit/s`

const runsOf = (report, stage, scope = "link") =>
    report.runs.filter((run) => run.stage === stage && run.scope === scope)
const idleOf = (runs) => runs.find((run) => run.offered === "idle")
const maxOf = (runs) =>
    runs.reduce((best, run) => (run.mbps > (best?.mbps ?? -1) ? run : best), null)
const avg = (
    values,
) => (values.length ? values.reduce((sum, each) => sum + each, 0) / values.length : null)

function describeLink(side) {
    const route = side?.route
    if (!route) {
        return null
    }
    const wifi = route.kind === "wifi"
        ? route
        : side.underlay?.kind === "wifi"
        ? side.underlay
        : null
    const parts = []
    if (route.kind === "tunnel") {
        parts.push(
            `through a tunnel (${route.name}${
                side.tailscale
                    ? `, tailscale ${
                        side.tailscale.direct
                            ? `direct via ${side.tailscale.via}`
                            : side.tailscale.via
                    }`
                    : ""
            })`,
        )
    }
    if (wifi) {
        const bits = [
            wifi.band,
            wifi.channel ? `channel ${wifi.channel}` : null,
            wifi.widthMHz ? `${wifi.widthMHz} MHz wide` : null,
        ]
            .filter(Boolean).join(", ")
        parts.push(
            `on Wi-Fi${wifi.ssid ? ` "${wifi.ssid}"` : ""} (${bits || "details unavailable"})${
                wifi.signalDbm ? `, signal ${wifi.signalDbm} dBm` : ""
            }`,
        )
    } else if (route.kind === "ethernet" || side.underlay?.kind === "ethernet") {
        const eth = route.kind === "ethernet" ? route : side.underlay
        parts.push(
            `on Ethernet (${eth.name}${
                eth.speedMbps ? `, ${eth.speedMbps} Mbit/s` : eth.media ? `, ${eth.media}` : ""
            })`,
        )
    }
    return { text: parts.join(" "), wifi }
}

export function takeaways(report) {
    const out = []
    const say = (verdict, text) => out.push({ verdict, text })
    const tcp = runsOf(report, "tcp")
    const tcpTop = maxOf(tcp)
    // the link's capacity is the best any transport managed: Wi-Fi changes minute to minute, so
    // the TCP stage alone can catch a bad moment
    const linkTop = maxOf(
        report.runs.filter((run) => run.scope === "link" && run.stage !== "zenoh"),
    )
    const tcpMax = linkTop
    const tcpIdle = idleOf(tcp)
    const here = report.local?.link?.hostname ?? "this machine"
    const there = report.host

    if (linkTop) {
        say(
            throughputVerdict(linkTop.mbps),
            `The network between ${here} and ${there} carries up to about ${
                mbit(linkTop.mbps)
            } when pushed as hard as it goes (best of every transport tried; ${
                linkTop.stage === "tcp" ? "a plain TCP connection" : names[linkTop.stage]
            }).`,
        )
        if (tcpTop && tcpTop.mbps < 0.6 * linkTop.mbps) {
            say(
                "borderline",
                `The link's speed moved a lot during the test: plain TCP got only ${
                    mbit(tcpTop.mbps)
                } at one point and ${names[linkTop.stage]} ${
                    mbit(linkTop.mbps)
                } at another. Wi-Fi conditions change minute to minute; compare runs, or use a longer --seconds.`,
            )
        }
    }
    if (tcpIdle) {
        say(
            latencyVerdict(tcpIdle.side.p95),
            `With nothing else on the link, a small message takes ${
                ms(tcpIdle.side.p50)
            } there and back (1 in 20 take longer than ${ms(tcpIdle.side.p95)}).`,
        )
    }
    const tcpFull = tcp.find((run) => run.offered === "max")
    if (tcpFull && tcpIdle) {
        say(
            latencyVerdict(tcpFull.side.p95),
            `When the link is full, that same message takes ${ms(tcpFull.side.p50)} (1 in 20: ${
                ms(tcpFull.side.p95)
            }) on a separate connection, and ${ms(tcpFull.inband.p50)} (1 in 20: ${
                ms(tcpFull.inband.p95)
            }) when it waits in line behind the data. That is what a controller feels while video is streaming.`,
        )
        if (tcpFull.inband.p50 > 2 * Math.max(tcpFull.side.p50, 5)) {
            say(
                "info",
                "Latency-sensitive messages should not share a connection with bulk data: in line behind it they wait several times longer.",
            )
        }
    }
    // the highest offered rate where delay stayed acceptable
    const paced = tcp.filter((run) => typeof run.offeredBps === "number" && run.offeredBps > 0)
        .sort((a, b) => a.offeredBps - b.offeredBps)
    const comfortable = paced.filter((run) =>
        run.side.p95 !== null && run.side.p95 < thresholds.latency.good &&
        run.mbps >= 0.9 * run.offeredBps / 1e6
    ).at(-1)
    if (paced.length) {
        say(
            comfortable ? "info" : "bad",
            comfortable
                ? `Up to ${
                    mbit(comfortable.offeredBps / 1e6)
                } of traffic, delay stays under ${thresholds.latency.good} ms; plan streams to fit inside that.`
                : `Even at ${
                    mbit(paced[0].offeredBps / 1e6)
                } the delay goes past ${thresholds.latency.good} ms; the link has no comfortable rate.`,
        )
    }

    // the machines themselves
    for (const [scope, label] of [["loopback-here", here], ["loopback-far", there]]) {
        const loop = maxOf(runsOf(report, "tcp", scope))
        if (loop && tcpMax) {
            say(
                loop.mbps > 10 * tcpMax.mbps ? "good" : "borderline",
                loop.mbps > 10 * tcpMax.mbps
                    ? `${label} itself is not the limit: it moves ${
                        mbit(loop.mbps)
                    } to itself, far more than the network carries.`
                    : `${label} only moves ${mbit(loop.mbps)} to itself, close to the network's ${
                        mbit(tcpMax.mbps)
                    }: the machine may be the limit, not the network.`,
            )
        }
    }
    for (const [key, label] of [["local", here], ["remote", there]]) {
        const busy = avg(
            (report[key]?.cpu ?? []).map((sample) => sample.busyPct).filter((value) =>
                value !== null
            ),
        )
        if (busy === null) {
            continue
        }
        const verdict = busy >= thresholds.cpu.bad
            ? "bad"
            : busy >= thresholds.cpu.borderline
            ? "borderline"
            : "good"
        const load = report[key]?.link?.loadavg?.[0]
        const cores = report[key]?.link?.cpuCount
        say(
            verdict,
            `${label}'s CPU was ${Math.round(busy)}% busy during the test${
                load ? ` (load ${load.toFixed(1)} on ${cores} cores)` : ""
            }.` +
                (verdict === "good"
                    ? ""
                    : " Software that needs CPU to move data (WebRTC, the zenoh gateway) is slowed by that, so its numbers here are lower than the link alone would give."),
        )
    }

    // links on each end
    for (const [key, label] of [["local", here], ["remote", there]]) {
        const link = describeLink(report[key]?.link)
        if (!link?.text) {
            continue
        }
        const signal = link.wifi?.signalDbm
        const verdict = signal
            ? (signal >= thresholds.signal.good
                ? "good"
                : signal >= thresholds.signal.borderline
                ? "borderline"
                : "bad")
            : "info"
        say(verdict, `${label} is ${link.text}.`)
        if (report[key]?.link?.tailscale && !report[key].link.tailscale.direct) {
            say(
                "bad",
                `Tailscale is relaying ${label}'s traffic through a server on the internet instead of going direct; expect extra delay and lower speed.`,
            )
        }
    }

    // each browser transport against the raw link
    const best = []
    for (const stage of ["http", "ws", "webrtc", "webtransport", "zenoh"]) {
        const runs = runsOf(report, stage)
        const top = maxOf(runs)
        // only an idle run says nothing about speed
        if (!top || !tcpMax || !runs.some((run) => run.offeredBps !== 0)) {
            continue
        }
        const share = Math.min(100, (100 * top.mbps) / tcpMax.mbps)
        const loaded = runs.find((run) => run === top)
        const latency = loaded.inband.p95 ?? loaded.side.p95
        let text = `In the browser, ${names[stage]} got ${mbit(top.mbps)}, ${
            Math.round(share)
        }% of the best the network did, with ${ms(latency)} delay (1 in 20) at that load.`
        if (stage === "zenoh") {
            const offered = runs.filter((run) =>
                typeof run.offeredBps === "number" && run.offeredBps > 0
            ).sort((a, b) => b.offeredBps - a.offeredBps)[0]
            if (offered) {
                const delivered = offered.dataLoss === null ? null : 100 - offered.dataLoss
                text = `Through ${names.zenoh} the browser received ${mbit(offered.mbps)} of the ${
                    mbit(offered.offeredBps / 1e6)
                } published${
                    delivered === null ? "" : ` (${Math.round(delivered)}% of messages arrived)`
                }, with the gateway's own round trip at ${
                    ms(offered.inband.p95)
                } (1 in 20). Short runs catch the gateway while its bandwidth estimate is still ramping up; a longer --seconds shows where it settles.`
            }
        }
        // a transport that keeps the speed but turns laggy is not good either
        const order = ["good", "borderline", "bad"]
        const verdict = order[
            Math.max(
                order.indexOf(shareVerdict(share)),
                order.indexOf(
                    latencyVerdict(latency) === "info" ? "good" : latencyVerdict(latency),
                ),
            )
        ]
        say(verdict, text)
        best.push({ stage, share, mbps: top.mbps })
    }
    if (best.length > 1) {
        const worst = best.reduce((a, b) => (b.share < a.share ? b : a))
        const webrtc = best.find((each) => each.stage === "webrtc")
        if (worst.stage === "zenoh" && webrtc && webrtc.mbps > 2 * worst.mbps) {
            say(
                "bad",
                `The bottleneck is the zenoh gateway, not WebRTC or the network: a plain WebRTC channel on the same machines moved ${
                    mbit(webrtc.mbps)
                }, the gateway ${mbit(worst.mbps)}.`,
            )
        } else if (worst.share < thresholds.share.borderline) {
            say(
                "info",
                `The slowest way into the browser was ${names[worst.stage]} (${mbit(worst.mbps)}).`,
            )
        }
    }
    for (const skip of report.skipped ?? []) {
        if (skip.offered === "all") {
            say("info", `${names[skip.stage] ?? skip.stage} was not measured: ${skip.why}`)
        }
    }
    return out
}

export function saveRun(report) {
    const stamp = report.when.replace(/[:.]/g, "-").replace(/-\d+Z$/, "Z")
    const dir = `${runsDir}/${stamp}_${report.host.replace(/[^\w.@-]/g, "_")}`
    Deno.mkdirSync(dir, { recursive: true })
    Deno.writeTextFileSync(`${dir}/result.json`, JSON.stringify(report, null, 2))
    Deno.writeTextFileSync(`${dir}/report.html`, renderHtml(report))
    return dir
}

export function listRuns() {
    let entries = []
    try {
        entries = [...Deno.readDirSync(runsDir)].filter((entry) => entry.isDirectory).map((entry) =>
            entry.name
        ).sort()
    } catch {
        return []
    }
    return entries.map((name) => {
        try {
            const report = JSON.parse(Deno.readTextFileSync(`${runsDir}/${name}/result.json`))
            return { name, dir: `${runsDir}/${name}`, report }
        } catch {
            return { name, dir: `${runsDir}/${name}`, report: null }
        }
    })
}

// "latest", a run's folder name, a prefix of one, or a path to one
export function findRun(which = "latest") {
    const runs = listRuns()
    if (which === "latest") {
        return runs.at(-1) ?? null
    }
    try {
        if (Deno.statSync(`${which}/report.html`).isFile) {
            return { name: which, dir: which }
        }
    } catch {
        // not a path
    }
    return runs.filter((run) => run.name.startsWith(which) || run.name.includes(which)).at(-1) ??
        null
}

// Serves a run's report on localhost until interrupted.
export async function serveReport(dir, { open = true } = {}) {
    const server = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, (request) => {
        const path = new URL(request.url).pathname
        const file = path === "/" ? "report.html" : path === "/result.json" ? "result.json" : null
        if (!file) {
            return new Response("not found", { status: 404 })
        }
        return new Response(Deno.readFileSync(`${dir}/${file}`), {
            headers: {
                "content-type": file.endsWith(".html")
                    ? "text/html; charset=utf-8"
                    : "application/json",
            },
        })
    })
    const url = `http://127.0.0.1:${server.addr.port}/`
    console.log(`report: ${url}  (Ctrl-C to stop serving; the file is ${dir}/report.html)`)
    if (open) {
        const opener = Deno.build.os === "darwin" ? "open" : "xdg-open"
        await new Deno.Command(opener, { args: [url], stdout: "null", stderr: "null" }).output()
            .catch(() => {})
    }
    await server.finished
}

const escapeHtml = (text) =>
    String(text ?? "").replace(
        /[&<>"]/g,
        (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char],
    )

export function renderHtml(report) {
    const data = JSON.stringify(report).replace(/</g, "\\u003c")
    const title = `dtk bench: ${report.host}`
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js"></script>
<style>
:root {
    --bg: #fbfbfa; --panel: #ffffff; --text: #1d1d1f; --muted: #6b6b70; --line: #e3e3e0;
    --good: #1f8a4c; --borderline: #b7791f; --bad: #c0392b; --info: #3d6fb6;
    --s1: #3d6fb6; --s2: #d0743c; --s3: #2e9a6b; --s4: #9a4fb5; --s5: #c4a21b; --s6: #6b6b70; --s7: #c0392b;
}
@media (prefers-color-scheme: dark) {
    :root {
        --bg: #161618; --panel: #1f1f22; --text: #ececee; --muted: #9a9aa2; --line: #333338;
        --good: #4cc488; --borderline: #e0b04f; --bad: #ef6f62; --info: #7aa7e8;
        --s1: #7aa7e8; --s2: #ef9a62; --s3: #4cc488; --s4: #c48ae0; --s5: #e8cf5c; --s6: #a8a8b0; --s7: #ef6f62;
    }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
main { max-width: 1100px; margin: 0 auto; padding: 24px 16px 64px; }
h1 { font-size: 24px; margin: 0 0 4px; }
h2 { font-size: 18px; margin: 32px 0 8px; }
.meta { color: var(--muted); font-size: 13px; }
.note { border-left: 3px solid var(--info); padding: 8px 12px; background: var(--panel); margin: 12px 0; white-space: pre-wrap; }
.takeaways { list-style: none; padding: 0; margin: 12px 0; }
.takeaways li { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px 10px 12px; margin: 8px 0; display: flex; gap: 10px; align-items: baseline; }
.badge { flex: none; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; padding: 2px 8px; border-radius: 99px; color: var(--bg); }
.badge.good { background: var(--good); } .badge.borderline { background: var(--borderline); } .badge.bad { background: var(--bad); } .badge.info { background: var(--info); }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 12px; min-width: 0; }
.card h3 { margin: 0 0 8px; font-size: 15px; }
.chart { position: relative; height: 280px; }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--line); white-space: nowrap; }
td:last-child { white-space: normal; min-width: 240px; }
th { color: var(--muted); font-weight: 500; }
.scroll { overflow-x: auto; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px; margin: 0; font-size: 13px; }
dt { color: var(--muted); } dd { margin: 0; overflow-wrap: anywhere; }
pre { font-size: 12px; white-space: pre-wrap; margin: 4px 0 0; color: var(--muted); }
select { font: inherit; background: var(--panel); color: var(--text); border: 1px solid var(--line); border-radius: 6px; padding: 2px 6px; }
.thresholds { font-size: 13px; color: var(--muted); }
</style>
</head>
<body>
<main>
<h1>${escapeHtml(title)}</h1>
<div class="meta" id="meta"></div>
<div id="note"></div>
<h2>What this means</h2>
<ul class="takeaways" id="takeaways"></ul>
<details class="thresholds"><summary>How the verdicts are decided</summary><ul id="thresholds"></ul></details>

<h2>Speed and delay at each load</h2>
<p class="meta">Each transport was offered traffic at several rates (idle, then more, then as fast as it goes) while small pings measured the delay at the same time. "In-band" pings travel with the data; "beside" pings use a separate connection.</p>
<div class="grid">
    <div class="card"><h3>Achieved speed vs offered</h3><div class="chart"><canvas id="throughput"></canvas></div></div>
    <div class="card"><h3>Delay (p95 round trip) vs offered</h3><div class="chart"><canvas id="latency"></canvas></div></div>
</div>

<h2>Second by second</h2>
<div class="card">
    <label>Transport <select id="series-pick"></select></label>
    <div class="chart" style="height:320px"><canvas id="series"></canvas></div>
</div>

<h2>CPU during the test</h2>
<div class="card"><div class="chart" style="height:220px"><canvas id="cpu"></canvas></div></div>

<h2>The two ends</h2>
<div class="grid" id="links"></div>

<h2>Every run</h2>
<div class="card scroll"><table id="runs"></table></div>
<p class="meta">Raw data: <a href="result.json">result.json</a> (every per-second sample).</p>
</main>
<script id="data" type="application/json">${data}</script>
<script>
const report = JSON.parse(document.getElementById("data").textContent)
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim()
const palette = ["--s1", "--s2", "--s3", "--s4", "--s5", "--s6", "--s7"].map(css)
const el = (tag, attrs = {}, text = "") => Object.assign(document.createElement(tag), attrs, text ? { textContent: text } : {})
Chart.defaults.color = css("--muted")
Chart.defaults.borderColor = css("--line")
Chart.defaults.font.family = getComputedStyle(document.body).fontFamily

document.getElementById("meta").textContent =
    report.when.replace("T", " ").slice(0, 19) + " UTC · " + (report.local?.link?.hostname ?? "here") + " → " + report.host +
    " at " + (report.addr ?? "?") + " · " + report.options.seconds + " s per rate · dtk " + (report.dtkVersion ?? "")
if (report.note) {
    document.getElementById("note").append(el("div", { className: "note" }, "Note: " + report.note))
}
for (const item of report.takeaways) {
    const li = el("li")
    li.append(el("span", { className: "badge " + item.verdict }, item.verdict), el("span", {}, item.text))
    document.getElementById("takeaways").append(li)
}
for (const [name, rule] of Object.entries(report.thresholds)) {
    document.getElementById("thresholds").append(el("li", {}, name + ": " + rule.what))
}

const labels = { tcp: "TCP", udp: "UDP", http: "HTTP", ws: "WebSocket", webrtc: "WebRTC", webtransport: "WebTransport", zenoh: "zenoh gateway" }
const linkRuns = report.runs.filter((run) => run.scope === "link")
const stages = [...new Set(linkRuns.map((run) => run.stage))]
const offered = [...new Set(report.runs.filter((run) => run.scope === "link").map((run) => run.offered))]
    .sort((a, b) => (a === "idle" ? -1 : b === "idle" ? 1 : a === "max" ? 1 : b === "max" ? -1 : Number(a) - Number(b)))
const pick = (stage, label, get) => offered.map((each) => {
    const run = linkRuns.find((r) => r.stage === stage && r.offered === each)
    return run ? get(run) : null
})
const axisTitle = (text) => ({ display: true, text })
new Chart(document.getElementById("throughput"), {
    type: "line",
    data: {
        labels: offered.map((each) => (each === "idle" || each === "max" ? each : each + " Mbit/s")),
        datasets: stages.map((stage, i) => ({ label: labels[stage], data: pick(stage, "mbps", (run) => run.mbps), borderColor: palette[i], backgroundColor: palette[i], spanGaps: true })),
    },
    options: { maintainAspectRatio: false, scales: { y: { beginAtZero: true, title: axisTitle("achieved Mbit/s") }, x: { title: axisTitle("offered") } } },
})
new Chart(document.getElementById("latency"), {
    type: "line",
    data: {
        labels: offered.map((each) => (each === "idle" || each === "max" ? each : each + " Mbit/s")),
        datasets: [
            ...stages.map((stage, i) => ({ label: labels[stage], data: pick(stage, "", (run) => run.inband.p95), borderColor: palette[i], backgroundColor: palette[i], spanGaps: true })),
            ...(stages.includes("tcp") ? [{ label: "TCP, separate connection", data: pick("tcp", "", (run) => run.side.p95), borderColor: palette[0], backgroundColor: palette[0], borderDash: [4, 4], spanGaps: true }] : []),
        ],
    },
    options: { maintainAspectRatio: false, scales: { y: { type: "logarithmic", title: axisTitle("ms (log scale)") }, x: { title: axisTitle("offered") } } },
})

// per-second: every rate of one transport back to back
const seriesPick = document.getElementById("series-pick")
const scopes = [...new Set(report.runs.map((run) => run.scope + "|" + run.stage))].sort((a, b) => b.startsWith("link") - a.startsWith("link"))
for (const key of scopes) {
    const [scope, stage] = key.split("|")
    seriesPick.append(el("option", { value: key }, (scope === "link" ? "" : scope.replace("loopback-", "loopback ") + ": ") + labels[stage]))
}
let seriesChart = null
function drawSeries() {
    const [scope, stage] = seriesPick.value.split("|")
    const runs = report.runs.filter((run) => run.scope === scope && run.stage === stage)
    const x = [], mbps = [], inband = [], side = [], bands = []
    let t = 0
    for (const run of runs) {
        for (const sample of run.samples) {
            const at = t + sample.t
            x.push(at)
            mbps.push({ x: at, y: sample.mbps })
            for (const value of sample.inband) inband.push({ x: at - 1 + Math.random(), y: value })
            for (const value of sample.side) side.push({ x: at - 1 + Math.random(), y: value })
        }
        bands.push({ from: t, to: t + run.samples.length, label: run.offered })
        t += run.samples.length + 1
    }
    seriesChart?.destroy()
    seriesChart = new Chart(document.getElementById("series"), {
        data: {
            datasets: [
                { type: "line", label: "Mbit/s", data: mbps, yAxisID: "y", borderColor: palette[0], backgroundColor: palette[0], stepped: "before" },
                { type: "scatter", label: "in-band ping ms", data: inband, yAxisID: "ms", backgroundColor: palette[1], pointRadius: 2 },
                { type: "scatter", label: "beside ping ms", data: side, yAxisID: "ms", backgroundColor: palette[2], pointRadius: 2 },
            ],
        },
        options: {
            maintainAspectRatio: false,
            scales: {
                x: { type: "linear", title: axisTitle("seconds, runs back to back: " + bands.map((b) => b.label).join(" → ")) },
                y: { position: "left", beginAtZero: true, title: axisTitle("Mbit/s") },
                ms: { position: "right", type: "logarithmic", title: axisTitle("ping ms (log)"), grid: { drawOnChartArea: false } },
            },
        },
    })
}
seriesPick.onchange = drawSeries
if (scopes.length) drawSeries()

// CPU, both machines, on one clock
const t0 = Math.min(...[...(report.local?.cpu ?? []), ...(report.remote?.cpu ?? [])].map((s) => s.at))
const cpuSet = (samples, label, color) => ({ label, data: (samples ?? []).map((s) => ({ x: (s.at - t0) / 1000, y: s.busyPct })), borderColor: color, backgroundColor: color, pointRadius: 0 })
new Chart(document.getElementById("cpu"), {
    type: "line",
    data: { datasets: [cpuSet(report.local?.cpu, (report.local?.link?.hostname ?? "here") + " (here)", palette[0]), cpuSet(report.remote?.cpu, report.host, palette[1])] },
    options: { maintainAspectRatio: false, scales: { x: { type: "linear", title: axisTitle("seconds") }, y: { min: 0, max: 100, title: axisTitle("% busy, all cores") } } },
})

// link details, both ends
function linkCard(title, side) {
    const card = el("div", { className: "card" })
    card.append(el("h3", {}, title))
    const dl = el("dl")
    const add = (k, v) => { if (v !== null && v !== undefined && v !== "") { dl.append(el("dt", {}, k), el("dd", {}, String(v))) } }
    const link = side?.link ?? {}
    add("host", link.hostname)
    add("CPU", link.cpuCount ? link.cpuCount + " cores, load " + (link.loadavg ?? []).map((v) => v.toFixed(1)).join(" / ") : null)
    for (const [label, iface] of [["route", link.route], ["tunnel rides on", link.underlay]]) {
        if (!iface) continue
        add(label, iface.name + " (" + iface.kind + ")")
        for (const [k, v] of Object.entries(iface)) {
            if (["name", "kind", "driverSignal"].includes(k)) continue
            add("  " + k, v)
        }
        if (iface.driverSignal) { const pre = el("pre", {}, iface.driverSignal); dl.append(el("dt", {}, "  driver signal"), Object.assign(el("dd"), { }).appendChild(pre).parentNode) }
    }
    if (link.tailscale) add("tailscale", link.tailscale.direct ? "direct, " + link.tailscale.via : link.tailscale.via)
    for (const key of ["route", "underlay"]) {
        if (side?.linkAfter?.[key]?.txRetries != null && link[key]?.txRetries != null) {
            add("Wi-Fi tx retries during test", side.linkAfter[key].txRetries - link[key].txRetries)
        }
    }
    card.append(dl)
    return card
}
document.getElementById("links").append(linkCard("Here: " + (report.local?.link?.hostname ?? ""), report.local), linkCard("Far: " + report.host, report.remote))

// every run, as a table
const table = document.getElementById("runs")
const head = el("tr")
for (const h of ["where", "transport", "offered", "Mbit/s", "in-band p50", "p95", "max", "beside p50", "p95", "ping loss", "data loss", "note"]) head.append(el("th", {}, h))
table.append(head)
const fmt = (v, unit = "") => (v === null || v === undefined ? "-" : v + unit)
for (const run of report.runs) {
    const tr = el("tr")
    for (const v of [run.scope.replace("loopback-", "loopback "), labels[run.stage], run.offered, fmt(run.mbps), fmt(run.inband.p50), fmt(run.inband.p95), fmt(run.inband.max), fmt(run.side.p50), fmt(run.side.p95), fmt(run.inband.loss, "%"), fmt(run.dataLoss, "%"), run.note ?? ""]) tr.append(el("td", {}, String(v)))
    table.append(tr)
}
for (const skip of report.skipped ?? []) {
    const tr = el("tr")
    for (const v of [skip.scope ?? "link", labels[skip.stage] ?? skip.stage, skip.offered, "skipped", "", "", "", "", "", "", "", skip.why]) tr.append(el("td", {}, String(v)))
    table.append(tr)
}
</script>
</body>
</html>
`
}
