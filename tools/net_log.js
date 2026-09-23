#!/usr/bin/env -S deno run --allow-all
// Continuous link + control-path recorder, so that "it stopped responding" has
// an answer next time instead of a theory.
//
// Everything is sampled on the machine it runs on and written as JSONL, one
// object per line, to <dir>/netlog-YYYY-MM-DD.jsonl. Two kinds of line:
//
//   {"t":…,"k":"s", …}   a sample   (1 Hz link / socket / system state)
//   {"t":…,"k":"e", …}   an event   (a kernel or NetworkManager line worth keeping)
//
// The point is that a dropped command shows up in several of these at once — a
// stalled Send-Q on the control socket, a jump in TCP retransmits, a scan, a
// beacon-loss burst — and only the overlap says which one led.
//
// Needs --allow-all, not --allow-read: Deno refuses /proc and /sys under a bare
// read grant ("Requires all access to /proc/net/wireless").

const args = parseArgs(Deno.args)
const IFACE = args.iface || "wlan0"
const PORTS = String(args.ports || "1024,8190").split(",").map((p) => p.trim()).filter(Boolean)
const KEEP_DAYS = Number(args["keep-days"] || 7)
const HOME = Deno.env.get("HOME") || "/root"
const DIR = String(args.dir || `${HOME}/.dimos/logs`).replace(/^~/, HOME)

// The cheap file reads run every second; anything that forks a process runs
// slower, because a fork per second on a Jetson is not free and this has to be
// safe to leave running during a demo.
const SAMPLE_MS = 1000
const IW_EVERY = 5
const PING_EVERY = 5
const EVENT_POLL_MS = 2000

function parseArgs(argv) {
    const out = {}
    for (let i = 0; i < argv.length; i++) {
        if (!argv[i].startsWith("--")) {
            continue
        }
        const key = argv[i].slice(2)
        const next = argv[i + 1]
        if (next !== undefined && !next.startsWith("--")) {
            out[key] = next
            i++
        } else {
            out[key] = true
        }
    }
    return out
}

async function run(cmd, cmdArgs) {
    try {
        const { stdout } = await new Deno.Command(cmd, {
            args: cmdArgs,
            stdout: "piped",
            stderr: "null",
        }).output()
        return new TextDecoder().decode(stdout)
    } catch {
        return ""
    }
}

async function readOr(path, fallback = "") {
    try {
        return await Deno.readTextFile(path)
    } catch {
        return fallback
    }
}

function num(text) {
    const value = Number(String(text).trim())
    return Number.isFinite(value) ? value : null
}

// ── samplers ─────────────────────────────────────────────────────────────────

// The cheapest link read there is: no fork, and it carries the retry and
// missed-beacon counters that a stalling link moves first.
async function sampleProcWireless() {
    const text = await readOr("/proc/net/wireless")
    for (const line of text.split("\n")) {
        if (!line.trim().startsWith(IFACE + ":")) {
            continue
        }
        const f = line.replace(/^.*?:/, "").trim().split(/\s+/)
        return {
            link: num(f[1]),
            level: num(f[2]),
            noise: num(f[3]),
            disc_retry: num(f[7]),
            disc_misc: num(f[8]),
            missed_beacon: num(f[9]),
        }
    }
    return {}
}

const STAT_KEYS = [
    "rx_bytes", "tx_bytes", "rx_packets", "tx_packets",
    "tx_errors", "tx_dropped", "rx_dropped",
]

async function sampleStats() {
    const out = {}
    for (const key of STAT_KEYS) {
        out[key] = num(await readOr(`/sys/class/net/${IFACE}/statistics/${key}`, "0"))
    }
    return out
}

async function sampleIw() {
    // On the G1's Realtek driver `iw dev wlan0 station dump` returns EMPTY
    // (exit 0, no output), so tx_retries/tx_failed are not available from it and
    // the /proc/net/wireless counters above are the substitute. Kept anyway
    // because it does work on other adapters.
    const dump = await run("iw", ["dev", IFACE, "station", "dump"])
    const pick = (label) => {
        const m = dump.match(new RegExp(label + ":\\s*([-0-9.]+)"))
        return m ? Number(m[1]) : null
    }
    const link = await run("iw", ["dev", IFACE, "link"])
    return {
        bssid: (link.match(/Connected to ([0-9a-f:]{17})/i) || [])[1] || null,
        freq: num((link.match(/freq:\s*(\d+)/) || [])[1]),
        signal: pick("signal") ?? num((link.match(/signal:\s*(-?\d+)/) || [])[1]),
        tx_retries: pick("tx retries"),
        tx_failed: pick("tx failed"),
        beacon_loss: pick("beacon loss"),
        tx_mbit: num((link.match(/tx bitrate:\s*([\d.]+)/) || [])[1]),
        rx_mbit: num((link.match(/rx bitrate:\s*([\d.]+)/) || [])[1]),
    }
}

// Send-Q is the most direct evidence that the machine tried to talk and the
// bytes did not leave: the control socket backs up here before anything else
// notices. rtt and retrans come off the same row with `-i`.
async function sampleSockets() {
    const out = []
    for (const port of PORTS) {
        const text = await run("ss", ["-tinH", "state", "established", `( sport = :${port} )`])
        const lines = text.split("\n")
        for (let i = 0; i < lines.length; i++) {
            // Continuation lines start with whitespace and belong to the row above.
            if (!lines[i] || /^\s/.test(lines[i])) {
                continue
            }
            const f = lines[i].trim().split(/\s+/)
            if (f.length < 4 || !f[3].includes(":")) {
                continue
            }
            const detail = (lines[i + 1] && /^\s/.test(lines[i + 1])) ? lines[i + 1] : ""
            out.push({
                port: Number(port),
                peer: f[3],
                recvq: num(f[0]),
                sendq: num(f[1]),
                rtt: num((detail.match(/rtt:([\d.]+)/) || [])[1]),
                retrans: num((detail.match(/retrans:\d+\/(\d+)/) || [])[1]),
                cwnd: num((detail.match(/cwnd:(\d+)/) || [])[1]),
            })
        }
    }
    return out
}

async function sampleSystem() {
    const load = (await readOr("/proc/loadavg", "")).split(/\s+/)
    const meminfo = await readOr("/proc/meminfo", "")
    let maxTemp = null
    for (let zone = 0; zone < 12; zone++) {
        const raw = num(await readOr(`/sys/class/thermal/thermal_zone${zone}/temp`, ""))
        if (raw === null) {
            continue
        }
        const celsius = raw > 1000 ? raw / 1000 : raw
        maxTemp = maxTemp === null ? celsius : Math.max(maxTemp, celsius)
    }
    return {
        load1: num(load[0]),
        mem_avail_kb: num((meminfo.match(/MemAvailable:\s*(\d+)/) || [])[1]),
        temp_c: maxTemp,
    }
}

// Reachability to whoever is actually connected, plus the gateway as a control:
// if the gateway is clean and the client is not, the problem is past the AP.
async function samplePing(targets) {
    const out = {}
    for (const target of targets) {
        const text = await run("ping", ["-n", "-c", "1", "-W", "1", target])
        const rtt = num((text.match(/time=([\d.]+)/) || [])[1])
        out[target] = rtt === null ? { loss: 1 } : { rtt }
    }
    return out
}

async function gateway() {
    const text = await run("ip", ["route", "show", "default"])
    return (text.match(/default via ([\d.]+)/) || [])[1] || null
}

// ── event tail ───────────────────────────────────────────────────────────────

const EVENT_RE =
    /RTW:.*(scan_ch_ready_cb|assoc|disconnect|deauth|roam|skb total frag|beacon)|NetworkManager.*(state is now|policy:|device state)|wpa_supplicant.*(CTRL-EVENT|reason)/i

function classify(line) {
    if (/skb total frag/i.test(line)) {
        return "tx_frag_drop"
    }
    if (/scan_ch_ready_cb/i.test(line)) {
        return "scan"
    }
    if (/deauth|disconnect/i.test(line)) {
        return "disconnect"
    }
    if (/assoc/i.test(line)) {
        return "assoc"
    }
    if (/roam/i.test(line)) {
        return "roam"
    }
    if (/beacon/i.test(line)) {
        return "beacon"
    }
    if (/state is now/i.test(line)) {
        return "nm_state"
    }
    return "other"
}

// The driver logs the same warning thousands of times; keeping every copy is how
// the G1's syslog reached 699 MB. Count them per interval and write one line.
//
// POLLED, not `journalctl -f`: follow mode block-buffers when stdout is a pipe,
// so it delivers one chunk and then nothing (measured — 12 s of silence while
// 41 scan events were landing in the journal). `--cursor-file` makes each poll
// pick up exactly where the last one stopped, so nothing is missed or counted
// twice.
function startEventPoll(write) {
    const cursor = `${DIR}/.netlog-cursor`
    const poll = async () => {
        // NOT `-k`: that is kernel-only, and half of what matters here
        // (NetworkManager state changes, wpa_supplicant events) is logged by
        // those units instead. EVENT_RE does the filtering.
        const text = await run("journalctl", [
            `--cursor-file=${cursor}`,
            "-o", "short-iso",
            "--no-pager",
            "-q",
        ])
        const pending = new Map()
        for (const line of text.split("\n")) {
            if (!EVENT_RE.test(line)) {
                continue
            }
            const kind = classify(line)
            const prev = pending.get(kind) || { n: 0, sample: line.slice(-200) }
            prev.n++
            pending.set(kind, prev)
        }
        for (const [kind, info] of pending) {
            await write({ k: "e", kind, n: info.n, line: info.sample })
        }
    }
    // Seed the cursor at "now" so the first poll does not replay the whole boot.
    run("journalctl", ["-n", "0", `--cursor-file=${cursor}`, "-o", "cat", "--no-pager", "-q"])
        .then(() => setInterval(() => poll().catch(() => {}), EVENT_POLL_MS))
}

// ── output ───────────────────────────────────────────────────────────────────

let currentDay = ""
let file = null

async function writer() {
    await Deno.mkdir(DIR, { recursive: true })
    return async (obj) => {
        const now = new Date()
        const day = now.toISOString().slice(0, 10)
        if (day !== currentDay) {
            if (file) {
                file.close()
            }
            currentDay = day
            file = await Deno.open(`${DIR}/netlog-${day}.jsonl`, {
                create: true,
                append: true,
                write: true,
            })
            prune().catch(() => {})
        }
        const line = JSON.stringify({ t: now.toISOString(), ...obj }) + "\n"
        await file.write(new TextEncoder().encode(line))
    }
}

async function prune() {
    const cutoff = Date.now() - KEEP_DAYS * 86400_000
    for await (const entry of Deno.readDir(DIR)) {
        if (!entry.isFile || !entry.name.startsWith("netlog-")) {
            continue
        }
        const day = entry.name.slice("netlog-".length, -".jsonl".length)
        if (Date.parse(day) < cutoff) {
            await Deno.remove(`${DIR}/${entry.name}`).catch(() => {})
        }
    }
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
    const write = await writer()
    const gw = await gateway()
    await write({ k: "start", iface: IFACE, ports: PORTS, gateway: gw, pid: Deno.pid })
    startEventPoll((obj) => write(obj).catch(() => {}))

    let tick = 0
    let lastIw = {}
    let lastPing = {}
    // Deltas are what you read during an incident; cumulative counters hide the spike.
    let prevStats = null

    while (true) {
        const started = Date.now()
        tick++
        const [wireless, stats, socks, sys] = await Promise.all([
            sampleProcWireless(),
            sampleStats(),
            sampleSockets(),
            sampleSystem(),
        ])
        if (tick % IW_EVERY === 1) {
            lastIw = await sampleIw()
        }
        if (tick % PING_EVERY === 1) {
            const peers = [...new Set(socks.map((s) => (s.peer || "").split(":")[0]))]
                .filter((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip) && ip !== "127.0.0.1")
            lastPing = await samplePing([...new Set([gw, ...peers].filter(Boolean))].slice(0, 4))
        }
        const delta = {}
        if (prevStats) {
            for (const key of STAT_KEYS) {
                delta[key] = (stats[key] ?? 0) - (prevStats[key] ?? 0)
            }
        }
        prevStats = stats
        await write({ k: "s", w: wireless, d: delta, iw: lastIw, socks, sys, ping: lastPing })
        await new Promise((r) => setTimeout(r, Math.max(50, SAMPLE_MS - (Date.now() - started))))
    }
}

main()
