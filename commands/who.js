import { Command } from "jsr:@cliffy/command@1.0.0-rc.7"
import { DtkError } from "../errors.js"
import { bold, dim, heading, pad, yellow } from "../style.js"

// `dtk who <host>` — who is connected to a machine and what they are running.
//
// Everything on the far side comes from ONE ssh call running a read-only
// script; nothing there is started, stopped or written. Peer addresses are then
// named here: tailscale's peer list, the LAN endpoints `tailscale ping` reports
// (cached an hour), a hand-kept notes file, and for what is left a quick look
// (AirPlay on :5000 means a Mac, reverse DNS, the ARP entry).

const HOME = Deno.env.get("HOME") ?? ""
const CACHE_DIR = `${Deno.env.get("DTK_CACHE") ?? `${HOME}/.cache/dtk`}/who`
const PING_CACHE = `${CACHE_DIR}/tailscale_lan_endpoints.json`
const PING_CACHE_SECONDS = 60 * 60
const CONFIG_DIR = `${Deno.env.get("XDG_CONFIG_HOME") ?? `${HOME}/.config`}/dtk`
const KNOWN_HOSTS = `${CONFIG_DIR}/known_hosts.json`

// Read-only on purpose: ps, ss, who, journalctl, top, and fingerprinting the
// authorized_keys file. Sections are marked with @@ so the parser below can
// split them without guessing.
function remoteScript(hours) {
    return `
export LC_ALL=C
echo "@@NOW $(date +%s) $(date +%Z) $(date +%z) $(hostname)"
echo "@@SELF $$"
echo "@@SELFCONN $SSH_CONNECTION"
echo "@@ID $(id -un) $(id -Gn)"
echo "@@LOAD $(cat /proc/loadavg 2>/dev/null) $(nproc 2>/dev/null)"
echo "@@SS"
ss -Htn state established '( sport = :22 )' 2>&1
echo "@@PS"
ps -wweo pid=,ppid=,etimes=,tty=,user:32=,args= 2>&1
echo "@@WHO"
who 2>&1
echo "@@AUTHKEYS"
for f in "$HOME/.ssh/authorized_keys" "$HOME/.ssh/authorized_keys2"; do
    if [ -r "$f" ]; then ssh-keygen -lf "$f" 2>/dev/null; fi
done
echo "@@SESSIONS"
pids=$(ps -eo pid=,args= | awk '$2 ~ /^sshd(-session)?:$/ && /\\[priv\\]/ {print "_PID="$1}')
if [ -n "$pids" ]; then journalctl -q --no-pager -o short-unix $pids 2>/dev/null | grep 'Accepted '; fi
echo "@@JOURNAL"
journalctl -q --no-pager -o short-unix --since "-${hours}h" _COMM=sshd _COMM=sshd-session 2>/dev/null | grep 'Accepted '
echo "@@TOP"
top -b -n 2 -d 0.5 2>/dev/null | awk '/^top -/{n++} n==2 && (/^ *PID/ || /^ *[0-9]/)' | head -26
echo "@@END"
`
}

// --- running things --------------------------------------------------------

async function run(program, args, { timeoutMs = 10000, stdin = null } = {}) {
    try {
        const proc = new Deno.Command(program, {
            args,
            stdin: stdin === null ? "null" : "piped",
            stdout: "piped",
            stderr: "piped",
            signal: AbortSignal.timeout(timeoutMs),
        }).spawn()
        if (stdin !== null) {
            const writer = proc.stdin.getWriter()
            await writer.write(new TextEncoder().encode(stdin))
            await writer.close()
        }
        const out = await proc.output()
        const decode = (bytes) => new TextDecoder().decode(bytes)
        return { code: out.code, stdout: decode(out.stdout), stderr: decode(out.stderr) }
    } catch (error) {
        return { code: -1, stdout: "", stderr: String(error?.message ?? error) }
    }
}

let tailscaleBinary = null
async function tailscale(args, timeoutMs) {
    if (tailscaleBinary === null) {
        const onPath = await run("sh", ["-c", "command -v tailscale"], { timeoutMs: 2000 })
        const app = "/Applications/Tailscale.app/Contents/MacOS/Tailscale"
        tailscaleBinary = onPath.code === 0 && onPath.stdout.trim() ? onPath.stdout.trim() : app
    }
    return await run(tailscaleBinary, args, { timeoutMs })
}

function readJson(path, fallback) {
    try {
        return JSON.parse(Deno.readTextFileSync(path))
    } catch (error) {
        return fallback
    }
}

function writeJson(path, value) {
    try {
        Deno.mkdirSync(path.replace(/\/[^/]*$/, ""), { recursive: true })
        Deno.writeTextFileSync(path, JSON.stringify(value, null, 4) + "\n")
    } catch (error) {
        // a cache that cannot be written only costs a slower next run
    }
}

// --- parsing the far side --------------------------------------------------

function sections(text) {
    const found = { header: {} }
    let current = null
    for (const line of text.split("\n")) {
        const marker = line.match(/^@@(\w+) ?(.*)$/)
        if (marker) {
            const [, name, rest] = marker
            if (["NOW", "SELF", "SELFCONN", "ID", "LOAD"].includes(name)) {
                found.header[name] = rest
                current = null
            } else {
                current = name
                found[name] = []
            }
            continue
        }
        if (current !== null && line.trim() !== "") {
            found[current].push(line)
        }
    }
    return found
}

function splitHostPort(text) {
    const match = text.match(/^\[?(.*?)\]?:(\d+)$/)
    if (!match) {
        return { ip: text, port: null }
    }
    return { ip: match[1].replace(/^::ffff:/, ""), port: Number(match[2]) }
}

function parseProcesses(lines, now) {
    const byPid = new Map()
    for (const line of lines) {
        const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/)
        if (!match) {
            continue
        }
        const [, pid, ppid, elapsed, tty, user, args] = match
        byPid.set(Number(pid), {
            pid: Number(pid),
            ppid: Number(ppid),
            started: now - Number(elapsed),
            tty: tty === "?" ? null : tty,
            user,
            args,
            children: [],
        })
    }
    for (const each of byPid.values()) {
        byPid.get(each.ppid)?.children.push(each)
    }
    return byPid
}

function descendants(proc) {
    const out = []
    const stack = [...proc.children]
    while (stack.length > 0) {
        const next = stack.shift()
        out.push(next)
        stack.push(...next.children)
    }
    return out
}

function ancestors(byPid, proc) {
    const out = []
    let at = byPid.get(proc.ppid)
    while (at && out.length < 64) {
        out.push(at)
        at = byPid.get(at.ppid)
    }
    return out
}

const ACCEPTED =
    /^(\d+(?:\.\d+)?) \S+ sshd(?:-session)?\[(\d+)\]: Accepted (\S+) for (\S+) from (\S+) port (\d+)(?: ssh2)?(?:: (\S+) (\S+))?/

function parseAccepted(lines) {
    const out = []
    for (const line of lines) {
        const match = line.match(ACCEPTED)
        if (!match) {
            continue
        }
        const [, time, pid, method, user, ip, port, keyType, fingerprint] = match
        out.push({
            time: Math.floor(Number(time)),
            pid: Number(pid),
            method,
            user,
            ip: ip.replace(/^::ffff:/, ""),
            port: Number(port),
            keyType: keyType ?? null,
            fingerprint: fingerprint ?? null,
        })
    }
    return out
}

// `who`: user tty YYYY-MM-DD HH:MM (from), in the far side's local time
function parseWho(lines, offsetSeconds, nowEpoch) {
    const out = []
    for (const line of lines) {
        // ISO dates in most locales, "Oct 31 13:23" under LC_ALL=C (assumed this year)
        const match = line.match(
            /^(\S+)\s+(\S+)\s+(\d{4}-\d\d-\d\d \d\d:\d\d|[A-Z][a-z]{2}\s+\d+ \d\d:\d\d)\s*(?:\((.*)\))?/,
        )
        if (!match) {
            continue
        }
        const [, user, tty, local, from] = match
        const iso = /^\d{4}/.test(local)
            ? `${local.replace(" ", "T")}:00Z`
            : `${local.replace(/\s+/g, " ")} ${new Date(nowEpoch * 1000).getUTCFullYear()} UTC`
        const time = Math.floor(Date.parse(iso) / 1000) - offsetSeconds
        out.push({ user, tty, time, from: from ?? null })
    }
    return out
}

function parseTop(lines) {
    if (lines.length === 0) {
        return []
    }
    const columns = lines[0].trim().split(/\s+/)
    const pidAt = columns.indexOf("PID")
    const cpuAt = columns.indexOf("%CPU")
    const memAt = columns.indexOf("%MEM")
    if (pidAt < 0 || cpuAt < 0) {
        return []
    }
    return lines.slice(1).map((line) => {
        const fields = line.trim().split(/\s+/)
        return {
            pid: Number(fields[pidAt]),
            cpu: Number(fields[cpuAt]),
            mem: memAt >= 0 ? Number(fields[memAt]) : null,
        }
    }).filter((each) => Number.isFinite(each.pid) && Number.isFinite(each.cpu))
}

// --- what a process is -------------------------------------------------------

const EDITOR_SERVER = /\/\.(vscode|vscode-insiders|vscode-server-insiders|cursor|windsurf)-server\//

function editorName(args) {
    const match = args.match(EDITOR_SERVER)
    if (!match) {
        return null
    }
    return { cursor: "Cursor", windsurf: "Windsurf" }[match[1]] ?? "VS Code"
}

function shortArgs(args, width = 70) {
    if (args.startsWith("[")) {
        return args
    }
    const trimmed = args
        .replace(/\/nix\/store\/[a-z0-9]{32}-/g, "/nix/store/…-")
        .replace(/^(\S*\/)?(\.venv\/bin\/)?python3?(\.\d+)? (\S*\/)?\.venv\/bin\//, "")
        .replace(/^\S*\/(?=[^/\s]+(\s|$))/, "")
    return trimmed.length > width ? `${trimmed.slice(0, width - 1)}…` : trimmed
}

function runLabel(args) {
    const blueprint = args.match(/\bdimos(?:\s+--?\S+)*\s+run\s+(?:--?\S+\s+)*([^\s-]\S*)/)
    if (blueprint) {
        return `dimos blueprint ${blueprint[1]}`
    }
    const simhub = args.match(/\b(simhub[\w.-]*)/)
    if (simhub) {
        return simhub[1]
    }
    return null
}

// What one ssh session is for, from what runs under it.
function classifySession(session, selfPid) {
    const under = session.processes
    if (under.some((each) => each.pid === selfPid)) {
        return "this `dtk who` check"
    }
    const editor = under.map((each) => editorName(each.args)).find(Boolean)
    if (editor) {
        return `${editor} remote`
    }
    if (under.some((each) => /sftp-server/.test(each.args))) {
        return "sftp"
    }
    const transfer = under.find((each) => /^(scp|rsync)\s/.test(each.args))
    if (transfer) {
        return transfer.args.split(/\s/)[0]
    }
    if (!session.hasChannel) {
        return "port forwarding only (no shell or command)"
    }
    if (under.length === 0) {
        return "nothing running (forwarding, or a command that ended)"
    }
    const top = under.filter((each) => each.ppid === session.userPid)
    const isShell = (each) => /^-?\S*\b(ba|z|fi|da|k|c|tc)?sh$/.test(each.args.trim())
    if (session.tty && top.some(isShell)) {
        // a login shell; its leaves are what is in the foreground
        const leaves = under.filter((each) => each.children.length === 0 && !isShell(each))
        const doing = leaves.slice(0, 2).map((each) => shortArgs(each.args, 40)).join(", ")
        return doing ? `interactive shell, running ${doing}` : "interactive shell"
    }
    return `command: ${shortArgs(top[0]?.args ?? under[0].args, 60)}`
}

// --- naming addresses --------------------------------------------------------

const isTailscaleIp = (ip) => {
    const match = ip.match(/^100\.(\d+)\./)
    return (match && Number(match[1]) >= 64 && Number(match[1]) < 128) ||
        ip.toLowerCase().startsWith("fd7a:115c:a1e0:")
}
const looksLikeIp = (text) =>
    /^\d+\.\d+\.\d+\.\d+$/.test(text) || /^[0-9a-f]*:[0-9a-f]*:[0-9a-f:.]*$/i.test(text)
const isLoopback = (ip) => ip.startsWith("127.") || ip === "::1"
const isPrivate = (ip) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(ip)

async function tailscaleStatus() {
    const { code, stdout } = await tailscale(["status", "--json"], 5000)
    if (code !== 0) {
        return null
    }
    try {
        const status = JSON.parse(stdout)
        const users = status.User ?? {}
        const describePeer = (peer, self = false) => ({
            name: peer.HostName,
            dns: (peer.DNSName ?? "").split(".")[0],
            ips: peer.TailscaleIPs ?? [],
            owner: users[peer.UserID]?.DisplayName ?? null,
            online: self ? true : peer.Online === true,
            os: peer.OS,
            curAddr: peer.CurAddr ? splitHostPort(peer.CurAddr).ip : null,
            self,
        })
        return {
            self: status.Self ? describePeer(status.Self, true) : null,
            selfLan: (status.Self?.Addrs ?? []).map((each) => splitHostPort(each).ip),
            peers: Object.values(status.Peer ?? {}).map((peer) => describePeer(peer)),
        }
    } catch (error) {
        return null
    }
}

const peerLabel = (peer) => {
    const name = peer.dns || peer.name
    const owner = peer.owner ? `, ${peer.owner}` : ""
    return `${name} (tailscale${owner}${peer.online ? "" : ", offline"})`
}

// `tailscale ping` names the LAN endpoint a peer answers on. Slow, so only for
// online peers, all at once, and remembered for an hour.
async function pingPeers(peers) {
    const found = {}
    const now = Math.floor(Date.now() / 1000)
    await Promise.all(
        peers.filter((peer) => peer.online && !peer.self).map(async (peer) => {
            const ip = peer.ips[0]
            const { stdout } = await tailscale(["ping", "-c", "1", "--timeout", "2s", ip], 4000)
            const via = stdout.match(/via \[?([0-9a-f.:]+?)\]?:\d+ in/)
            if (via && !via[1].startsWith("DERP")) {
                found[via[1]] = { peer: peer.dns || peer.name, tailscaleIp: ip, seen: now }
            }
        }),
    )
    return found
}

async function fingerprint(ip) {
    const notes = []
    const airplay = (async () => {
        try {
            const response = await fetch(`http://${ip}:5000/`, {
                method: "HEAD",
                signal: AbortSignal.timeout(2000),
            })
            await response.body?.cancel()
            const server = response.headers.get("server") ?? ""
            if (/AirTunes/i.test(server)) {
                notes.push("a Mac (AirPlay)")
            } else if (server) {
                notes.push(`:5000 Server: ${server}`)
            }
        } catch (error) {
            // nothing listening, or not http
        }
    })()
    const reverse = (async () => {
        if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
            return
        }
        try {
            const name = `${ip.split(".").reverse().join(".")}.in-addr.arpa`
            const names = await Promise.race([
                Deno.resolveDns(name, "PTR"),
                new Promise((resolve) => setTimeout(() => resolve([]), 1500)),
            ])
            if (names.length > 0) {
                notes.push(`rDNS ${names[0].replace(/\.$/, "")}`)
            }
        } catch (error) {
            // no PTR record
        }
    })()
    const arp = (async () => {
        const { stdout } = await run("arp", ["-n", ip], { timeoutMs: 1500 })
        const mac = stdout.match(/ at ([0-9a-f]{1,2}(?::[0-9a-f]{1,2}){5})/i)
        if (mac) {
            const randomized = (parseInt(mac[1].split(":")[0], 16) & 2) !== 0
            notes.push(`MAC ${mac[1]}${randomized ? " (randomized)" : ""}`)
        }
    })()
    await Promise.all([airplay, reverse, arp])
    const order = (note) => (note.startsWith("a Mac") ? 0 : note.startsWith("rDNS") ? 1 : 2)
    return notes.sort((a, b) => order(a) - order(b)).join(", ")
}

async function nameAddresses(ips, { status, refresh }) {
    const known = readJson(KNOWN_HOSTS, {})
    const localIps = new Set([
        ...Deno.networkInterfaces().map((each) => each.address),
        ...(status?.self?.ips ?? []),
        ...(status?.selfLan ?? []),
    ])
    const peers = status?.peers ?? []
    const byTailscaleIp = new Map(peers.flatMap((peer) => peer.ips.map((ip) => [ip, peer])))
    const byCurAddr = new Map(
        peers.filter((peer) => peer.curAddr).map((peer) => [peer.curAddr, peer]),
    )
    const names = {}

    const lan = []
    for (const ip of ips) {
        const note = known[ip] ?? null
        if (isLoopback(ip)) {
            names[ip] = { name: "the machine itself", source: "loopback", note }
        } else if (localIps.has(ip)) {
            const dns = status?.self?.dns ?? Deno.hostname()
            names[ip] = { name: `this Mac (${dns})`, dns, source: "local", note }
        } else if (byTailscaleIp.has(ip)) {
            names[ip] = {
                name: peerLabel(byTailscaleIp.get(ip)),
                dns: byTailscaleIp.get(ip).dns,
                source: "tailscale",
                note,
            }
        } else if (byCurAddr.has(ip)) {
            names[ip] = {
                name: peerLabel(byCurAddr.get(ip)),
                dns: byCurAddr.get(ip).dns,
                source: "tailscale endpoint",
                note,
            }
        } else if (isTailscaleIp(ip)) {
            names[ip] = {
                name: note ?? "a tailscale address not in this Mac's peer list",
                source: "tailscale",
                note: null,
            }
        } else {
            lan.push(ip)
        }
    }

    if (lan.length > 0) {
        const now = Math.floor(Date.now() / 1000)
        let cache = readJson(PING_CACHE, { updated: 0, endpoints: {} })
        const stale = now - cache.updated > PING_CACHE_SECONDS
        const missing = lan.some((ip) => !cache.endpoints[ip])
        if (status && (refresh || (stale && missing))) {
            cache = { updated: now, endpoints: { ...cache.endpoints, ...await pingPeers(peers) } }
            writeJson(PING_CACHE, cache)
        }
        const peerByName = new Map(peers.map((peer) => [peer.dns || peer.name, peer]))
        await Promise.all(lan.map(async (ip) => {
            const note = known[ip] ?? null
            const hit = cache.endpoints[ip]
            if (hit && peerByName.has(hit.peer)) {
                const age = Math.round((now - hit.seen) / 60)
                names[ip] = {
                    name: peerLabel(peerByName.get(hit.peer)),
                    dns: hit.peer,
                    source: `tailscale ping ${age}m ago`,
                    note,
                }
            } else if (note) {
                names[ip] = { name: note, source: "known_hosts.json", note: null }
            } else if (isPrivate(ip)) {
                const guess = await fingerprint(ip)
                names[ip] = {
                    name: guess ? `unknown: ${guess}` : "unknown",
                    source: "fingerprint",
                    note,
                }
            } else {
                names[ip] = { name: "unknown (public address)", source: null, note }
            }
        }))
    }
    return names
}

// --- time ------------------------------------------------------------------

function timeFormatter(nowEpoch, offsetSeconds, zone) {
    const two = (n) => String(n).padStart(2, "0")
    const parts = (epoch, shift) => {
        const date = new Date((epoch + shift) * 1000)
        return {
            day: `${two(date.getUTCMonth() + 1)}-${two(date.getUTCDate())}`,
            clock: `${two(date.getUTCHours())}:${two(date.getUTCMinutes())}`,
        }
    }
    const age = (epoch) => {
        const seconds = Math.max(0, nowEpoch - epoch)
        if (seconds < 3600) {
            return `${Math.round(seconds / 60)}m ago`
        }
        if (seconds < 86400 * 2) {
            return `${Math.floor(seconds / 3600)}h${two(Math.floor((seconds % 3600) / 60))}m ago`
        }
        return `${Math.floor(seconds / 86400)}d ago`
    }
    return (epoch) => {
        if (epoch === null || epoch === undefined) {
            return "?"
        }
        const local = parts(epoch, offsetSeconds)
        const utc = parts(epoch, 0)
        const localDay = local.day === parts(nowEpoch, offsetSeconds).day ? "" : `${local.day} `
        const utcDay = utc.day === parts(nowEpoch, 0).day ? "" : `${utc.day} `
        return `${localDay}${local.clock} ${zone} / ${utcDay}${utc.clock}Z (${age(epoch)})`
    }
}

// --- putting it together -------------------------------------------------------

function analyse(text, hours) {
    const parts = sections(text)
    const [nowText, zone, offsetText, hostname] = (parts.header.NOW ?? "").split(" ")
    const now = Number(nowText)
    if (!Number.isFinite(now)) {
        throw new DtkError(
            `dtk who: the far side did not answer as expected:\n${text.slice(0, 400)}`,
        )
    }
    const offsetMatch = (offsetText ?? "+0000").match(/^([+-])(\d\d)(\d\d)$/)
    const offsetSeconds = offsetMatch
        ? (offsetMatch[1] === "-" ? -1 : 1) *
            (Number(offsetMatch[2]) * 3600 + Number(offsetMatch[3]) * 60)
        : 0
    const selfPid = Number(parts.header.SELF)
    const [selfIp, selfPort] = (parts.header.SELFCONN ?? "").split(" ")
    const [account, ...groups] = (parts.header.ID ?? "").split(" ")
    const load = (parts.header.LOAD ?? "").split(" ")

    const byPid = parseProcesses(parts.PS ?? [], now)
    const journalReadable = account === "root" ||
        groups.some((group) => ["adm", "systemd-journal", "wheel", "root"].includes(group))

    // authorized_keys: fingerprint -> the comment on that key
    const keyNames = {}
    for (const line of parts.AUTHKEYS ?? []) {
        const match = line.match(/^\d+ (\S+) (.*?) \(\w+\)$/)
        if (match && match[2] && match[2] !== "no comment") {
            keyNames[match[1]] = match[2]
        }
    }

    const sessionAccepts = new Map(
        parseAccepted(parts.SESSIONS ?? []).map((each) => [each.pid, each]),
    )
    const connections = (parts.SS ?? []).map((line) => {
        const fields = line.trim().split(/\s+/)
        return splitHostPort(fields[fields.length - 1])
    }).filter((each) => each.port !== null)
    const whoLines = parseWho(parts.WHO ?? [], offsetSeconds, now)

    // one entry per sshd [priv] process: that is one ssh connection
    const sessions = []
    for (const proc of byPid.values()) {
        const priv = proc.args.match(/^sshd(?:-session)?: (\S+) \[priv\]$/)
        if (!priv) {
            continue
        }
        const userProc = proc.children.find((each) => /^sshd(?:-session)?: /.test(each.args))
        const title = userProc?.args.match(/^sshd(?:-session)?: ([^@\s]+)(?:@(\S+))?/)
        const tty = title?.[2] && title[2] !== "notty" ? title[2] : null
        const accepted = sessionAccepts.get(proc.pid) ?? null
        let ip = accepted?.ip ?? null
        const port = accepted?.port ?? null
        if (ip === null && tty) {
            const login = whoLines.find((each) => each.tty === tty)
            ip = login?.from ?? null
        }
        const processes = userProc ? descendants(userProc) : []
        const session = {
            pid: proc.pid,
            userPid: userProc?.pid ?? null,
            user: priv[1],
            started: proc.started,
            tty,
            hasChannel: Boolean(title?.[2]),
            ip,
            port,
            fingerprint: accepted?.fingerprint ?? null,
            keyName: accepted?.fingerprint ? keyNames[accepted.fingerprint] ?? null : null,
            processes,
        }
        if (!accepted && selfIp && processes.some((each) => each.pid === selfPid)) {
            session.ip = selfIp
            session.port = Number(selfPort)
        }
        session.what = classifySession(session, selfPid)
        sessions.push(session)
    }
    sessions.sort((a, b) => a.started - b.started)

    const matched = new Set(sessions.map((each) => `${each.ip}:${each.port}`))
    const looseConnections = connections.filter((each) => !matched.has(`${each.ip}:${each.port}`))

    const sessionOf = (proc) => {
        const chain = [proc, ...ancestors(byPid, proc)]
        return sessions.find((session) => chain.some((each) => each.pid === session.userPid)) ??
            null
    }
    const owner = (proc) => {
        const session = sessionOf(proc)
        if (session) {
            return { session: session.pid, via: `ssh from ${session.ip ?? "?"}` }
        }
        const chain = ancestors(byPid, proc)
        if (chain.some((each) => /^tmux|^screen/i.test(each.args))) {
            return { session: null, via: "tmux/screen" }
        }
        if (chain.some((each) => /systemd --user/.test(each.args))) {
            return { session: null, via: "systemd user service" }
        }
        const editorParent = chain.find((each) =>
            editorName(each.args) && / agent host\b|command-shell/.test(each.args)
        )
        if (editorParent) {
            return {
                session: null,
                via: `under ${editorName(editorParent.args)} pid ${editorParent.pid}`,
            }
        }
        if (proc.ppid === 1) {
            return { session: null, via: "detached (parent is init)" }
        }
        return { session: null, via: shortArgs(byPid.get(proc.ppid)?.args ?? "?", 30) }
    }

    // editor servers: each process tree root, plus each server instance under it
    const editors = []
    for (const proc of byPid.values()) {
        const editor = editorName(proc.args)
        if (!editor) {
            continue
        }
        const parentIsEditor = editorName(byPid.get(proc.ppid)?.args ?? "") !== null
        const isServer = /server\/bin\/(code|cursor)-server/.test(proc.args)
        if (parentIsEditor && !isServer) {
            continue
        }
        const commit = proc.args.match(/(?:Stable-|code-|commit[=/])([0-9a-f]{7})[0-9a-f]*/)?.[1] ??
            null
        const role = / agent host\b/.test(proc.args)
            ? "agent host"
            : / command-shell\b/.test(proc.args)
            ? "command-shell"
            : isServer
            ? "server"
            : shortArgs(proc.args, 40)
        const under = descendants(proc)
        const agents = [
            ...new Set(
                under.map((each) => each.args.match(/\/(claude|codex|copilot)[\w-]*(?:\s|$)/)?.[1])
                    .filter(Boolean),
            ),
        ]
        const terminals = under.filter((each) =>
            /shellIntegration|--init-file .*terminal/.test(each.args)
        ).length
        editors.push({
            pid: proc.pid,
            editor,
            role,
            commit,
            user: proc.user,
            started: proc.started,
            terminals,
            agents,
            ...owner(proc),
        })
    }
    editors.sort((a, b) => a.started - b.started)

    // dimos blueprints and simhub runs: the outermost process of each
    const runs = []
    for (const proc of byPid.values()) {
        const label = runLabel(proc.args)
        if (!label) {
            continue
        }
        if (ancestors(byPid, proc).some((each) => runLabel(each.args) !== null)) {
            continue
        }
        const under = descendants(proc)
        runs.push({
            pid: proc.pid,
            label,
            user: proc.user,
            started: proc.started,
            processes: under.length + 1,
            ...owner(proc),
        })
    }
    runs.sort((a, b) => a.started - b.started)

    const ours = new Set([
        selfPid,
        ...descendants(byPid.get(selfPid) ?? { children: [] }).map((each) => each.pid),
    ])
    const top = parseTop(parts.TOP ?? []).filter((each) =>
        each.cpu > 0 && byPid.has(each.pid) && !ours.has(each.pid)
    ).slice(0, 10).map((each) => {
        const proc = byPid.get(each.pid)
        // the outermost run names it; a worker's own args can mention simhub too
        const flagged = proc
            ? [proc, ...ancestors(byPid, proc)].map((at) => runLabel(at.args)).filter(Boolean).pop()
            : null
        return {
            ...each,
            user: proc?.user ?? null,
            started: proc?.started ?? null,
            args: proc?.args ?? "",
            run: flagged ?? null,
        }
    })

    const accepted = parseAccepted(parts.JOURNAL ?? [])
    const groupsByIp = new Map()
    for (const each of accepted) {
        if (!groupsByIp.has(each.ip)) {
            groupsByIp.set(each.ip, {
                ip: each.ip,
                count: 0,
                first: each.time,
                last: each.time,
                users: new Set(),
                keys: new Map(),
            })
        }
        const group = groupsByIp.get(each.ip)
        group.count += 1
        group.first = Math.min(group.first, each.time)
        group.last = Math.max(group.last, each.time)
        group.users.add(each.user)
        const key = each.fingerprint ?? each.method
        group.keys.set(key, keyNames[key] ?? null)
    }
    const logins = [...groupsByIp.values()].sort((a, b) => b.last - a.last).map((group) => ({
        ip: group.ip,
        count: group.count,
        first: group.first,
        last: group.last,
        users: [...group.users],
        keys: [...group.keys].map(([fingerprint, name]) => ({ fingerprint, name })),
    }))

    return {
        host: hostname,
        account,
        now,
        zone,
        offset: offsetText,
        offsetSeconds,
        load: load.length >= 3
            ? { avg: load.slice(0, 3).map(Number), cpus: Number(load[load.length - 1]) }
            : null,
        journalReadable,
        hours,
        connections: connections.length,
        sessions: sessions.map(({ processes, userPid, ...rest }) => ({
            ...rest,
            userPid,
            processes: processes.length,
        })),
        looseConnections,
        editors,
        desktop: whoLines,
        logins,
        runs,
        top,
    }
}

function render(report, names, destination) {
    const when = timeFormatter(report.now, report.offsetSeconds, report.zone)
    const who = (ip, port = null) => {
        if (!ip) {
            return "?"
        }
        const address = port ? `${ip}${dim(`:${port}`)}` : ip
        const entry = names[ip]
        if (!entry) {
            return address
        }
        // a note that only repeats the tailscale name adds nothing
        const repeats = entry.note && entry.dns && entry.note.includes(entry.dns)
        const note = entry.note && !repeats && !entry.name.includes(entry.note)
            ? ` [${entry.note}]`
            : ""
        return `${address} ${dim("·")} ${entry.name}${note}`
    }
    const lines = []
    const load = report.load
        ? `  load ${report.load.avg.join(" ")} on ${report.load.cpus} cpus`
        : ""
    lines.push(
        `${bold(destination)} ${
            dim(`(${report.host}, as ${report.account})`)
        }  clock ${report.zone} ${report.offset}, ` +
            `now ${when(report.now).replace(/ \(.*\)$/, "")}${dim(load)}`,
    )

    lines.push(
        "",
        heading(
            `ssh sessions (${report.sessions.length}, ${report.connections} established on :22)`,
        ),
    )
    for (const session of report.sessions) {
        const key = session.keyName ? ` key "${session.keyName}"` : ""
        lines.push(
            `  ${pad(session.tty ?? "notty", 6)} ${pad(session.user, 10)} ${when(session.started)}`,
            `         from ${who(session.ip, session.port)}${dim(key)}`,
            `         ${
                session.what.startsWith("this ") ? dim(session.what) : yellow(session.what)
            }`,
        )
    }
    for (const each of report.looseConnections) {
        lines.push(`  ${dim("(no session matched)")} ${who(each.ip, each.port)}`)
    }
    if (report.sessions.length === 0 && report.looseConnections.length === 0) {
        lines.push(dim("  none"))
    }

    lines.push("", heading("editor servers"))
    for (const each of report.editors) {
        const extras = [
            each.terminals ? `${each.terminals} terminal${each.terminals === 1 ? "" : "s"}` : null,
            each.agents.length ? `agents: ${each.agents.join(", ")}` : null,
        ].filter(Boolean).join(", ")
        lines.push(
            `  ${pad(`${each.editor} ${each.role}`, 24)} ${dim(each.commit ?? "")} ${
                pad(each.user, 10)
            } ${when(each.started)}`,
            `         ${dim(each.via)}${extras ? `  ${extras}` : ""}`,
        )
    }
    if (report.editors.length === 0) {
        lines.push(dim("  none"))
    }

    lines.push("", heading("console / desktop logins (who)"))
    // tmux registers every pane as a login; one line per tmux server is enough
    const tmuxServers = new Map()
    for (const each of report.desktop) {
        const tmux = (each.from ?? "").match(/^tmux\((\d+)\)/)
        if (tmux) {
            const server = tmuxServers.get(tmux[1]) ?? { ...each, panes: 0 }
            server.panes += 1
            server.time = Math.min(server.time, each.time)
            tmuxServers.set(tmux[1], server)
            continue
        }
        const from = each.from && looksLikeIp(each.from) ? who(each.from) : each.from ?? ""
        lines.push(`  ${pad(each.tty, 7)} ${pad(each.user, 10)} ${when(each.time)}  ${dim(from)}`)
    }
    for (const [pid, server] of tmuxServers) {
        lines.push(
            `  ${pad("tmux", 7)} ${pad(server.user, 10)} ${when(server.time)}  ${
                dim(`server pid ${pid}, ${server.panes} panes`)
            }`,
        )
    }
    if (report.desktop.length === 0) {
        lines.push(dim("  none"))
    }

    lines.push("", heading(`accepted ssh logins, last ${report.hours}h`))
    if (!report.journalReadable) {
        lines.push(
            dim(`  journal not readable as ${report.account} (needs root, adm or systemd-journal)`),
        )
    }
    for (const each of report.logins) {
        const keys = each.keys.map((key) =>
            key.name
                ? `key "${key.name}"`
                : key.fingerprint.startsWith("SHA256:")
                ? `key ${key.fingerprint.slice(7, 17)}`
                : key.fingerprint
        ).join(", ")
        lines.push(
            `  ${pad(`${each.count}x`, 5)} ${who(each.ip)}`,
            `        ${dim(`first ${when(each.first)}`)}`,
            `        ${dim(`last  ${when(each.last)}`)}  ${
                dim(`as ${each.users.join(",")}, ${keys}`)
            }`,
        )
    }
    if (report.journalReadable && report.logins.length === 0) {
        lines.push(dim("  none"))
    }

    lines.push("", heading("dimos blueprints / simhub runs"))
    for (const each of report.runs) {
        lines.push(
            `  ${pad(each.pid, 8)} ${yellow(each.label)}  ${
                dim(`${each.processes} process${each.processes === 1 ? "" : "es"}, ${each.user}`)
            }`,
            `           ${when(each.started)}  ${dim(each.via)}`,
        )
    }
    if (report.runs.length === 0) {
        lines.push(dim("  none"))
    }

    lines.push("", heading("top cpu"))
    for (const each of report.top) {
        const run = each.run ? yellow(` [${each.run}]`) : ""
        lines.push(
            `  ${pad(`${each.cpu.toFixed(0)}%`, 5)} ${pad(each.pid, 8)} ${
                pad(each.user ?? "?", 10)
            } ${shortArgs(each.args, 60)}${run}`,
        )
    }
    if (report.top.length === 0) {
        lines.push(dim("  nothing busy"))
    }
    return lines.join("\n")
}

export default new Command()
    .name("who")
    .description(
        "Who is connected to <ssh-host> and what they are running: ssh sessions (shell, VS Code, " +
            "scp, a command), editor servers, desktop logins, recent accepted logins by address, " +
            "dimos/simhub runs and the busiest processes. One read-only ssh call; addresses are " +
            `named here from tailscale, \`tailscale ping\` (cached 1h) and ${
                KNOWN_HOSTS.replace(HOME, "~")
            }.`,
    )
    .arguments("<ssh-host:string>")
    .option("--ssh-args <args:string>", 'Extra ssh options, e.g. "-F /dev/null"')
    .option("--hours <n:number>", "How far back to list accepted logins", { default: 12 })
    .option("--refresh", "Re-run `tailscale ping` even when the cached LAN endpoints are fresh")
    .option("--json", "Print everything as JSON")
    .example("an ssh config entry", "dtk who AlfredJetson")
    .example("bypassing ~/.ssh/config", 'dtk who nvidia@r1-pro-0219 --ssh-args "-F /dev/null"')
    .action(async (options, host) => {
        const sshArgs = options.sshArgs ? options.sshArgs.split(/\s+/).filter(Boolean) : []
        const statusPromise = tailscaleStatus()
        const remote = await run(
            "ssh",
            ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", ...sshArgs, host, "bash -s"],
            { timeoutMs: 30000, stdin: remoteScript(options.hours) },
        )
        if (!remote.stdout.includes("@@END")) {
            throw new DtkError(
                `dtk who: ssh ${host} failed — ${remote.stderr.trim() || `exit ${remote.code}`}`,
            )
        }
        const report = analyse(remote.stdout, options.hours)
        const ips = new Set([
            ...report.sessions.map((each) => each.ip),
            ...report.looseConnections.map((each) => each.ip),
            ...report.logins.map((each) => each.ip),
            ...report.desktop.map((each) => each.from).filter((from) => from && looksLikeIp(from)),
        ].filter(Boolean))
        const names = await nameAddresses([...ips], {
            status: await statusPromise,
            refresh: options.refresh,
        })
        if (options.json) {
            console.log(JSON.stringify({ destination: host, ...report, names }, null, 4))
            return
        }
        console.log(render(report, names, host))
    })
