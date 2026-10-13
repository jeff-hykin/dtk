// What this machine's end of the link is: the interface the route to the peer takes, and for
// Wi-Fi its network, band, width, signal and rates; Ethernet its speed; plus CPU load.
// Everything is best effort: a missing tool leaves its field out, it never fails the run.

import { cpus, loadavg } from "node:os"

async function run(program, args, { timeoutMs = 10000 } = {}) {
    try {
        const out = await new Deno.Command(program, {
            args,
            stdout: "piped",
            stderr: "null",
            signal: AbortSignal.timeout(timeoutMs),
        }).output()
        return out.success ? new TextDecoder().decode(out.stdout) : null
    } catch {
        return null
    }
}

const readText = (path) => {
    try {
        return Deno.readTextFileSync(path)
    } catch {
        return null
    }
}

const field = (text, pattern) => text?.match(pattern)?.[1]?.trim() ?? null

// Tailscale hides the physical path; its status says whether the peer is direct or relayed.
async function tailscalePath(peer) {
    const text = await run("tailscale", ["status", "--json"])
    if (!text) {
        return null
    }
    try {
        const status = JSON.parse(text)
        for (const node of Object.values(status.Peer ?? {})) {
            if ((node.TailscaleIPs ?? []).includes(peer)) {
                return node.CurAddr
                    ? { direct: true, via: node.CurAddr }
                    : { direct: false, via: node.Relay ? `DERP relay ${node.Relay}` : "relay" }
            }
        }
    } catch {
        // not json
    }
    return null
}

async function linuxInterface(dev) {
    const info = { name: dev }
    if (
        readText(`/sys/class/net/${dev}/wireless`) !== null ||
        (await run("iw", ["dev", dev, "link"]))?.includes("Connected")
    ) {
        info.kind = "wifi"
        const link = await run("iw", ["dev", dev, "link"])
        const about = await run("iw", ["dev", dev, "info"])
        info.ssid = field(link, /SSID: (.*)/)
        info.bssid = field(link, /Connected to ([0-9a-f:]+)/)
        info.frequencyMHz = Number(field(link, /freq: ([\d.]+)/)) || null
        info.band = info.frequencyMHz
            ? (info.frequencyMHz > 5900 ? "6 GHz" : info.frequencyMHz > 4000 ? "5 GHz" : "2.4 GHz")
            : null
        info.channel = Number(field(about, /channel (\d+)/)) || null
        info.widthMHz = Number(field(about, /width: (\d+)/)) || null
        info.signalDbm = Number(field(link, /signal: (-?\d+)/)) || null
        info.txBitrate = field(link, /tx bitrate: (.*)/)
        info.rxBitrate = field(link, /rx bitrate: (.*)/)
        const station = await run("iw", ["dev", dev, "station", "dump"])
        info.txRetries = Number(field(station, /tx retries:\s*(\d+)/)) || null
        info.txFailed = Number(field(station, /tx failed:\s*(\d+)/)) || null
        info.txPackets = Number(field(station, /tx packets:\s*(\d+)/)) || null
        // Realtek's out-of-tree drivers keep a better signal report in /proc
        try {
            for (const entry of Deno.readDirSync("/proc/net")) {
                if (entry.name.startsWith("rtl")) {
                    const signal = readText(`/proc/net/${entry.name}/${dev}/rx_signal`)
                    if (signal) {
                        info.driver = entry.name
                        info.driverSignal = signal.trim().split("\n").slice(0, 8).join("\n")
                    }
                }
            }
        } catch {
            // no /proc/net listing
        }
    } else if (dev.startsWith("tailscale") || dev.startsWith("wg") || dev.startsWith("tun")) {
        info.kind = "tunnel"
    } else {
        info.kind = "ethernet"
        const speed = Number(readText(`/sys/class/net/${dev}/speed`))
        info.speedMbps = speed > 0 ? speed : null
        info.duplex = readText(`/sys/class/net/${dev}/duplex`)?.trim() ?? null
    }
    return info
}

async function macInterface(dev, airport) {
    const info = { name: dev }
    const ports = await run("networksetup", ["-listallhardwareports"])
    const port = ports?.split("\n\n").find((block) => block.includes(`Device: ${dev}`))
    const portName = field(port, /Hardware Port: (.*)/)
    if (portName === "Wi-Fi" || portName === "AirPort") {
        info.kind = "wifi"
        const current = (await airport)?.SPAirPortDataType?.[0]?.spairport_airport_interfaces
            ?.find((each) => each._name === dev)?.spairport_current_network_information
        if (current) {
            info.ssid = current._name === "<redacted>" ? null : current._name
            const channel = String(current.spairport_network_channel ?? "")
            info.channel = Number(field(channel, /^(\d+)/)) || null
            info.band = field(channel, /\((\d+)GHz/)
                ? `${field(channel, /\((\d+)GHz/).replace("2", "2.4")} GHz`
                : null
            info.widthMHz = Number(field(channel, /(\d+)MHz/)) || null
            info.phyMode = current.spairport_network_phymode ?? null
            info.signalDbm =
                Number(field(String(current.spairport_signal_noise ?? ""), /(-?\d+) dBm/)) || null
            info.noiseDbm =
                Number(field(String(current.spairport_signal_noise ?? ""), /\/\s*(-?\d+) dBm/)) ||
                null
            info.txBitrate = current.spairport_network_rate
                ? `${current.spairport_network_rate} Mbit/s`
                : null
            info.mcs = current.spairport_network_mcs ?? null
        }
        // wdutil has the BSSID and the rest, but only as root
        const wdutil = await run("sudo", ["-n", "wdutil", "info"], { timeoutMs: 5000 })
        if (wdutil) {
            info.bssid = field(wdutil, /BSSID\s*:\s*(.*)/)
            info.ssid ??= field(wdutil, /SSID\s*:\s*(.*)/)
            info.txBitrate = field(wdutil, /Tx Rate\s*:\s*(.*)/) ?? info.txBitrate
        }
    } else if (dev.startsWith("utun")) {
        info.kind = "tunnel"
    } else {
        info.kind = "ethernet"
        info.media = field(await run("ifconfig", [dev]), /media: (.*)/)
        info.adapter = portName
    }
    return info
}

async function routeDevice(peer) {
    if (Deno.build.os === "linux") {
        return field(await run("ip", ["route", "get", peer]), /dev (\S+)/)
    }
    return field(await run("route", ["-n", "get", peer]), /interface: (\S+)/)
}

// The interface towards `peer`, and when that is a tunnel, the one the tunnel rides on.
export async function linkInfo(peer) {
    const os = Deno.build.os
    // system_profiler takes seconds, so it starts first and is awaited only if needed
    const airport = os === "darwin"
        ? run("system_profiler", ["SPAirPortDataType", "-json"], { timeoutMs: 20000 }).then(
            (text) => {
                try {
                    return JSON.parse(text)
                } catch {
                    return null
                }
            },
        )
        : null
    const describe = (dev) => (os === "linux" ? linuxInterface(dev) : macInterface(dev, airport))
    const out = { hostname: Deno.hostname(), os, peer, cpuCount: cpus().length, loadavg: loadavg() }
    const dev = await routeDevice(peer)
    if (!dev) {
        return out
    }
    out.route = await describe(dev)
    if (out.route.kind === "tunnel") {
        out.tailscale = await tailscalePath(peer)
        const underlay = await routeDevice("1.1.1.1")
        if (underlay && underlay !== dev) {
            out.underlay = await describe(underlay)
        }
    }
    return out
}

// CPU busy share over time, from the kernel's per-core counters (works on Linux and macOS).
export function cpuSampler() {
    const totals = () =>
        cpus().reduce((sum, cpu) => {
            const busy = cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.irq
            return { busy: sum.busy + busy, all: sum.all + busy + cpu.times.idle }
        }, { busy: 0, all: 0 })
    const samples = []
    let last = totals()
    const timer = setInterval(() => {
        const now = totals()
        const all = now.all - last.all
        samples.push({
            at: Date.now(),
            busyPct: all > 0 ? Math.round((100 * (now.busy - last.busy)) / all) : null,
        })
        last = now
    }, 1000)
    return {
        samples,
        stop() {
            clearInterval(timer)
            return samples
        },
    }
}
