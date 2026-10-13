// The far end of `dtk bench`: TCP and UDP load with in-band echo, a UDP echo, and for the
// browser an HTTP page, HTTP download, WebSocket, WebRTC (node-datachannel) and WebTransport (Deno QUIC).
// Every transport sends remote -> local, the direction a robot streams to a viewer.

import { Buffer } from "node:buffer"
import { cpuSampler, linkInfo } from "./link_info.js"
import {
    DATA,
    datagramBytes,
    DONE,
    frame,
    FrameReader,
    json,
    maxQueuedBytes,
    message,
    pace,
    PING,
    PONG,
    START,
    unjson,
} from "./protocol.js"

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const bps = (value) => (value === "max" || value === null ? Infinity : Number(value))

async function writeAll(conn, bytes) {
    let at = 0
    while (at < bytes.byteLength) {
        at += await conn.write(bytes.subarray(at))
    }
}

// One TCP connection: START begins a paced download, PING is answered in the same stream, so
// a pong waits behind whatever the sender has queued, as a real reply would.
async function serveTcp(conn) {
    conn.setNoDelay(true)
    let chain = Promise.resolve()
    const write = (bytes) => (chain = chain.then(() => writeAll(conn, bytes)))
    const reader = new FrameReader()
    const buffer = new Uint8Array(64 * 1024)
    try {
        for (;;) {
            const read = await conn.read(buffer)
            if (read === null) {
                break
            }
            for (const { type, payload } of reader.push(buffer.subarray(0, read))) {
                if (type === PING) {
                    write(frame(PONG, payload.slice()))
                } else if (type === START) {
                    const { bitsPerSecond, seconds } = unjson(payload)
                    pace({
                        bitsPerSecond: bps(bitsPerSecond),
                        seconds,
                        chunk: 64 * 1024,
                        send: (bytes) => write(frame(DATA, bytes)),
                    }).then((sent) => write(frame(DONE, json({ sent }))))
                }
            }
        }
    } catch {
        // the client hung up mid-write
    }
    try {
        conn.close()
    } catch {
        // already closed
    }
}

// UDP load: START from a client makes this socket stream datagrams back to that address;
// PING is echoed on the same socket, behind the stream.
async function serveUdp(socket) {
    for await (const [bytes, from] of socket) {
        if (bytes[0] === PING) {
            socket.send(bytes, from).catch(() => {})
        } else if (bytes[0] === START) {
            const { bitsPerSecond, seconds } = unjson(bytes.subarray(1))
            // an unpaced UDP flood measures nothing but the drops it causes
            if (!(bitsPerSecond > 0) || !Number.isFinite(bitsPerSecond)) {
                continue
            }
            let seq = 0
            const body = new Uint8Array(datagramBytes)
            body[0] = DATA
            const view = new DataView(body.buffer)
            pace({
                bitsPerSecond: bps(bitsPerSecond),
                seconds,
                chunk: datagramBytes,
                send: async (part) => {
                    view.setUint32(1, seq++)
                    await socket.send(
                        part.byteLength === datagramBytes
                            ? body
                            : body.subarray(0, part.byteLength),
                        from,
                    )
                },
            }).then(async () => {
                for (let i = 0; i < 3; i++) {
                    await socket.send(message(DONE, json({ sent: seq })), from).catch(() => {})
                    await sleep(50)
                }
            })
        }
    }
}

// A plain echo on its own socket: the latency beside the load, not inside it.
async function serveEcho(socket) {
    for await (const [bytes, from] of socket) {
        socket.send(bytes, from).catch(() => {})
    }
}

function serveWebSocket(socket) {
    socket.binaryType = "arraybuffer"
    let stopped = false
    socket.onclose = () => (stopped = true)
    socket.onmessage = (event) => {
        const bytes = new Uint8Array(event.data)
        if (bytes[0] === PING) {
            socket.send(message(PONG, bytes.subarray(1)))
        } else if (bytes[0] === START) {
            const { bitsPerSecond, seconds } = unjson(bytes.subarray(1))
            pace({
                bitsPerSecond: bps(bitsPerSecond),
                seconds,
                stop: () => stopped,
                send: async (part) => {
                    while (socket.bufferedAmount > maxQueuedBytes && !stopped) {
                        await sleep(1)
                    }
                    if (!stopped) {
                        socket.send(message(DATA, part))
                    }
                },
            }).then((sent) => !stopped && socket.send(message(DONE, json({ sent }))))
        }
    }
}

// GET /download?bps=&seconds=: a paced body, pulled only as fast as the client reads it.
function download(url) {
    const bitsPerSecond = bps(url.searchParams.get("bps"))
    const seconds = Number(url.searchParams.get("seconds") ?? 3)
    let pull = null
    const body = new ReadableStream({
        start(controller) {
            pace({
                bitsPerSecond,
                seconds,
                send: async (part) => {
                    while (controller.desiredSize <= 0) {
                        await new Promise((resolve) => (pull = resolve))
                    }
                    controller.enqueue(part.slice())
                },
            }).then(() => controller.close()).catch(() => {})
        },
        pull() {
            pull?.()
        },
    }, { highWaterMark: 4 })
    return new Response(body, {
        headers: { "content-type": "application/octet-stream", "cache-control": "no-store" },
    })
}

// WebRTC server: node-datachannel (libdatachannel, native) when its prebuilt binary loads, else
// werift (pure JS, much slower; the report says which one served)
let rtc = null
const rtcPeers = new Set()

async function loadWebRtc() {
    try {
        const { loadNodeDatachannel } = await import("./webrtc_native.js")
        const module = await loadNodeDatachannel()
        rtc = { kind: "native", RTCPeerConnection: module.RTCPeerConnection }
        return `node-datachannel ${"0.29.0"} (libdatachannel, native)`
    } catch (error) {
        const werift = await import("npm:werift@0.22.2")
        rtc = { kind: "werift", RTCPeerConnection: werift.RTCPeerConnection }
        return `werift (pure-JS WebRTC; node-datachannel failed: ${String(error).slice(0, 120)})`
    }
}

// node-datachannel calls these from native code, where an escaping exception (a send on a
// channel that just closed) aborts the whole process instead of being an error
const guarded = (fn) => (...args) => {
    try {
        return fn(...args)
    } catch {
        // the channel or connection is already gone
    }
}

// Paces the bulk channel, never letting its own send queue grow past maxQueuedBytes.
function bulkRun(channel, payload, send) {
    const { bitsPerSecond, seconds } = unjson(payload)
    pace({
        bitsPerSecond: bps(bitsPerSecond),
        seconds,
        stop: () => channel.readyState !== "open",
        send: async (part) => {
            while (channel.bufferedAmount > maxQueuedBytes && channel.readyState === "open") {
                await sleep(1)
            }
            if (channel.readyState === "open") {
                send(message(DATA, part))
            }
        },
    }).then((sent) => channel.readyState === "open" && send(message(DONE, json({ sent }))))
}

// The browser offers a "bulk" channel (ordered, reliable) and an "echo" one (unordered, no
// retransmits) on the same association; the echo shares the path but not the bulk's queue.
async function answerWebRtc(offer) {
    if (rtc.kind === "werift") {
        return await answerWerift(offer)
    }
    const pc = new rtc.RTCPeerConnection({ iceServers: [] })
    rtcPeers.add(pc)
    pc.onconnectionstatechange = guarded(() => {
        if (["closed", "failed", "disconnected"].includes(pc.connectionState)) {
            rtcPeers.delete(pc)
            pc.close()
        }
    })
    pc.ondatachannel = guarded(({ channel }) => {
        channel.binaryType = "arraybuffer"
        const send = guarded((data) => channel.send(data))
        channel.onmessage = guarded((event) => {
            const bytes = new Uint8Array(event.data)
            if (channel.label === "echo") {
                send(bytes)
            } else if (bytes[0] === START) {
                bulkRun(channel, bytes.subarray(1), send)
            }
        })
    })
    await pc.setRemoteDescription(offer)
    await pc.setLocalDescription(await pc.createAnswer())
    await new Promise((resolve) => {
        if (pc.iceGatheringState === "complete") {
            return resolve()
        }
        pc.onicegatheringstatechange = guarded(() =>
            pc.iceGatheringState === "complete" && resolve()
        )
        setTimeout(resolve, 3000)
    })
    return { type: "answer", sdp: pc.localDescription.sdp }
}

async function answerWerift(offer) {
    const pc = new rtc.RTCPeerConnection({})
    rtcPeers.add(pc)
    pc.connectionStateChange.subscribe((state) => {
        if (state === "closed" || state === "failed" || state === "disconnected") {
            rtcPeers.delete(pc)
            pc.close().catch(() => {})
        }
    })
    pc.onDataChannel.subscribe((channel) => {
        channel.onMessage.subscribe((data) => {
            const bytes = new Uint8Array(data)
            if (channel.label === "echo") {
                channel.send(Buffer.from(bytes))
            } else if (bytes[0] === START) {
                bulkRun(channel, bytes.subarray(1), (part) => channel.send(Buffer.from(part)))
            }
        })
    })
    await pc.setRemoteDescription(offer)
    await pc.setLocalDescription(await pc.createAnswer())
    return { type: "answer", sdp: pc.localDescription.sdp }
}

// WebTransport: one bidirectional stream per run carries START and the framed data; pings go as
// datagrams on the same connection.
async function serveWebTransport(endpoint, cert, key) {
    const listener = endpoint.listen({ cert, key, alpnProtocols: ["h3"] })
    for await (const incoming of listener) {
        ;(async () => {
            const conn = await incoming.accept()
            const transport = await Deno.upgradeWebTransport(conn)
            transport.closed.catch(() => {})
            await transport.ready
            const datagrams = transport.datagrams.writable.getWriter()
            ;(async () => {
                for await (const bytes of transport.datagrams.readable) {
                    datagrams.write(bytes).catch(() => {})
                }
            })().catch(() => {})
            for await (const stream of transport.incomingBidirectionalStreams) {
                ;(async () => {
                    const writer = stream.writable.getWriter()
                    const reader = new FrameReader()
                    for await (const chunk of stream.readable) {
                        for (const { type, payload } of reader.push(chunk)) {
                            if (type !== START) {
                                continue
                            }
                            const { bitsPerSecond, seconds } = unjson(payload)
                            const sent = await pace({
                                bitsPerSecond: bps(bitsPerSecond),
                                seconds,
                                send: async (part) => {
                                    await writer.ready
                                    await writer.write(frame(DATA, part))
                                },
                            })
                            await writer.write(frame(DONE, json({ sent })))
                        }
                    }
                })().catch(() => {})
            }
        })().catch(() => {})
    }
}

// A throwaway ECDSA cert, under 14 days, which is what a browser accepts by hash alone.
async function makeCert() {
    const dir = await Deno.makeTempDir({ prefix: "dtk_bench_" })
    try {
        const out = await new Deno.Command("openssl", {
            args: [
                "req",
                "-x509",
                "-newkey",
                "ec",
                "-pkeyopt",
                "ec_paramgen_curve:prime256v1",
                "-nodes",
                "-keyout",
                `${dir}/key.pem`,
                "-out",
                `${dir}/cert.pem`,
                "-days",
                "10",
                "-subj",
                "/CN=dtk-bench",
            ],
            stdout: "null",
            stderr: "piped",
        }).output()
        if (!out.success) {
            throw new Error(new TextDecoder().decode(out.stderr).trim())
        }
        const cert = await Deno.readTextFile(`${dir}/cert.pem`)
        const key = await Deno.readTextFile(`${dir}/key.pem`)
        const der = Uint8Array.from(
            atob(cert.replace(/-----[^-]+-----|\s/g, "")),
            (c) => c.charCodeAt(0),
        )
        const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", der))]
        return { cert, key, hash }
    } finally {
        await Deno.remove(dir, { recursive: true }).catch(() => {})
    }
}

// zenoh: a python publisher (eclipse-zenoh through uv), fed "run <bps> <seconds> <bytes> <key>" lines.
const zenohPublisher = `
import sys, time, zenoh
connect = sys.argv[1]
config = zenoh.Config()
config.insert_json5("mode", '"client"')
config.insert_json5("connect/endpoints", '["%s"]' % connect)
config.insert_json5("scouting/multicast/enabled", "false")
session = zenoh.open(config)
publishers = {}
print("ready", flush=True)
for line in sys.stdin:
    _, rate, seconds, size, key = line.split()
    rate, seconds, size = float(rate), float(seconds), int(size)
    publisher = publishers.get(key) or session.declare_publisher(key)
    publishers[key] = publisher
    payload = bytearray(size)
    sent = 0
    start = time.monotonic()
    while True:
        elapsed = time.monotonic() - start
        if elapsed >= seconds:
            break
        if rate <= 0 or (rate / 8) * elapsed - sent * size < size:
            time.sleep(0.001)
            continue
        payload[0:4] = sent.to_bytes(4, "big")
        payload[4:12] = int(time.time() * 1000).to_bytes(8, "big")
        publisher.put(bytes(payload))
        sent += 1
    print("done %d" % sent, flush=True)
`

class Zenoh {
    constructor(connect) {
        this.connect = connect
        this.child = null
        this.lines = null
    }

    async start() {
        const home = Deno.env.get("HOME")
        const path = `${home}/.local/bin:${home}/.cargo/bin:${Deno.env.get("PATH")}`
        this.child = new Deno.Command("uv", {
            args: [
                "run",
                "--quiet",
                "--no-project",
                "--with",
                "eclipse-zenoh>=1.0,<2",
                "python",
                "-u",
                "-c",
                zenohPublisher,
                this.connect,
            ],
            env: { PATH: path },
            stdin: "piped",
            stdout: "piped",
            stderr: "piped",
        }).spawn()
        this.writer = this.child.stdin.getWriter()
        this.lines = this.child.stdout.pipeThrough(new TextDecoderStream()).pipeThrough(
            splitLines(),
        ).getReader()
        const errors = new Response(this.child.stderr).text()
        const first = await Promise.race([
            this.lines.read(),
            sleep(60000).then(() => ({ value: "timeout" })),
        ])
        if (first.value !== "ready") {
            this.stop()
            throw new Error(
                `zenoh publisher did not start: ${
                    (await Promise.race([
                        errors,
                        sleep(500).then(() => ""),
                    ])).trim().split("\n").slice(-3).join(" | ") || first.value
                }`,
            )
        }
    }

    async run({ bitsPerSecond, seconds, size, key }) {
        const rate = bitsPerSecond === Infinity ? 0 : bitsPerSecond
        await this.writer.write(new TextEncoder().encode(`run ${rate} ${seconds} ${size} ${key}\n`))
        const { value } = await this.lines.read()
        return { sent: Number(String(value).split(" ")[1]) }
    }

    stop() {
        try {
            this.child?.kill("SIGTERM")
        } catch {
            // already gone
        }
    }
}

function splitLines() {
    let rest = ""
    return new TransformStream({
        transform(chunk, controller) {
            const parts = (rest + chunk).split("\n")
            rest = parts.pop()
            for (const part of parts) {
                controller.enqueue(part.trim())
            }
        },
    })
}

const defaultClient = "https://esm.sh/gh/jeff-hykin/zenoh-gateway@v0.6.5/client/zenoh_gateway.ts"

// "auto" is the gateway inside dimos Desktop, asked on loopback so it wants no password.
async function resolveGateway(option, client, app) {
    if (!option || option === "none") {
        return { ok: false, why: "--gateway none" }
    }
    const reach = async (url) => {
        try {
            const response = await fetch(url, { signal: AbortSignal.timeout(2000) })
            return { response, body: await response.text() }
        } catch (error) {
            return { error: String(error) }
        }
    }
    if (option === "auto") {
        const { response, body } = await reach("http://127.0.0.1:5555/api/desktop/zenoh")
        let info = null
        try {
            info = response?.ok ? JSON.parse(body) : null
        } catch {
            // not Desktop
        }
        if (!info?.zenohGatewayUrl) {
            return {
                ok: false,
                why: "no dimos Desktop gateway on 127.0.0.1:5555 (pass --gateway <url as seen from that machine>)",
            }
        }
        const gateway = new URL(info.zenohGatewayUrl, "http://127.0.0.1:5555").href.replace(
            /\/+$/,
            "",
        )
        // Desktop gives a gateway connection the grants of the app whose page it came from
        const referer = `http://127.0.0.1:5555/apps/${app}/`
        return {
            ok: true,
            gateway,
            referer,
            client: client ?? info.client ?? defaultClient,
            how: `dimos Desktop's gateway, as the ${app} app`,
        }
    }
    const { error } = await reach(option)
    if (error) {
        return { ok: false, why: `gateway ${option} unreachable from this machine: ${error}` }
    }
    return {
        ok: true,
        gateway: option.replace(/\/+$/, ""),
        client: client ?? defaultClient,
        how: "--gateway",
    }
}

// Starts every listener on consecutive ports from `port` and says what came up.
export async function serve(
    {
        port,
        gateway,
        gatewayClient,
        gatewayApp = "dim-controller",
        zenohConnect,
        browser = true,
        hostname = "0.0.0.0",
    },
) {
    const status = { ports: {}, transports: {} }
    const at = (offset) => (port ? port + offset : 0)
    const tcp = Deno.listen({ port: at(0), hostname })
    status.ports.tcp = tcp.addr.port
    ;(async () => {
        for await (const conn of tcp) {
            serveTcp(conn)
        }
    })()
    const udp = Deno.listenDatagram({ port: at(1), hostname, transport: "udp" })
    status.ports.udp = udp.addr.port
    serveUdp(udp)
    const echo = Deno.listenDatagram({ port: at(2), hostname, transport: "udp" })
    status.ports.echo = echo.addr.port
    serveEcho(echo)
    const stoppers = [() => tcp.close(), () => udp.close(), () => echo.close()]
    if (!browser) {
        return { status, stop: () => stoppers.forEach((each) => each()) }
    }

    const cpu = cpuSampler()
    stoppers.push(() => cpu.stop())
    const httpPort = at(3)
    let zenoh = null
    let referer = null
    // the page is served on the near machine's localhost (WebTransport needs a secure context,
    // and plain http on an IP is not one), so everything here answers cross-origin
    const http = Deno.serve(
        { port: httpPort, hostname: "0.0.0.0", onListen() {} },
        async (request) => {
            if (request.method === "OPTIONS") {
                return new Response(null, {
                    status: 204,
                    headers: {
                        "access-control-allow-origin": "*",
                        "access-control-allow-methods": "*",
                        "access-control-allow-headers": "*",
                        "access-control-allow-private-network": "true",
                    },
                })
            }
            const response = await route(request)
            if (response.status !== 101) {
                response.headers.set("access-control-allow-origin", "*")
            }
            return response
        },
    )
    const route = async (request) => {
        const url = new URL(request.url)
        if (url.pathname === "/status") {
            return Response.json(status)
        }
        // CPU busy over the run, and the link again so counters (Wi-Fi retries) can be diffed
        if (url.pathname === "/cpu") {
            return Response.json({
                cpu: cpu.samples,
                linkAfter: url.searchParams.get("peer")
                    ? await linkInfo(url.searchParams.get("peer"))
                    : null,
            })
        }
        if (url.pathname === "/ping") {
            return new Response("", { headers: { "cache-control": "no-store" } })
        }
        if (url.pathname === "/download") {
            return download(url)
        }
        if (url.pathname === "/ws" || url.pathname === "/echo") {
            const { socket, response } = Deno.upgradeWebSocket(request)
            if (url.pathname === "/ws") {
                serveWebSocket(socket)
            } else {
                socket.onmessage = (event) => socket.send(event.data)
            }
            return response
        }
        if (url.pathname === "/rtc/offer") {
            try {
                return Response.json(await answerWebRtc(await request.json()))
            } catch (error) {
                return Response.json({ error: String(error) }, { status: 500 })
            }
        }
        if (url.pathname === "/zenoh/run") {
            try {
                if (!zenoh) {
                    zenoh = new Zenoh(zenohConnect)
                    await zenoh.start()
                }
                const body = await request.json()
                return Response.json(
                    await zenoh.run({ ...body, bitsPerSecond: bps(body.bitsPerSecond) }),
                )
            } catch (error) {
                zenoh = null
                return Response.json({ error: String(error) }, { status: 500 })
            }
        }
        // the gateway's signalling, proxied so the page needs no CORS and the gateway sees a
        // loopback client (Desktop only asks loopback clients for no password)
        if (url.pathname.startsWith("/zgw/") && gateway) {
            const target = new URL(gateway)
            const upstream = `${target.origin}${url.pathname.slice(4)}${url.search}`
            const headers = new Headers(request.headers)
            headers.delete("host")
            headers.delete("origin")
            headers.delete("referer")
            if (referer) {
                headers.set("referer", referer)
            }
            try {
                const response = await fetch(upstream, {
                    method: request.method,
                    headers,
                    body: request.method === "GET" || request.method === "HEAD"
                        ? undefined
                        : await request.arrayBuffer(),
                })
                return new Response(response.body, {
                    status: response.status,
                    headers: new Headers(response.headers),
                })
            } catch (error) {
                return Response.json({ error: `gateway unreachable: ${error}` }, { status: 502 })
            }
        }
        return new Response("not found", { status: 404 })
    }
    status.ports.http = httpPort
    stoppers.push(
        () => http.shutdown(),
        () => zenoh?.stop(),
        () => rtcPeers.forEach((pc) => Promise.resolve().then(() => pc.close()).catch(() => {})),
    )

    status.transports.http = { ok: true }
    status.transports.ws = { ok: true }
    try {
        status.transports.webrtc = { ok: true, how: await loadWebRtc() }
    } catch (error) {
        status.transports.webrtc = { ok: false, why: `no WebRTC stack loaded: ${error}` }
    }
    if (typeof Deno.QuicEndpoint !== "function" || typeof Deno.upgradeWebTransport !== "function") {
        status.transports.webtransport = {
            ok: false,
            why: `deno ${Deno.version.deno} has no QuicEndpoint/upgradeWebTransport`,
        }
    } else {
        try {
            const { cert, key, hash } = await makeCert()
            const endpoint = new Deno.QuicEndpoint({ hostname: "0.0.0.0", port: httpPort })
            serveWebTransport(endpoint, cert, key).catch(() => {})
            stoppers.push(() => endpoint.close())
            status.ports.webtransport = httpPort
            status.transports.webtransport = {
                ok: true,
                how: `Deno.QuicEndpoint (deno ${Deno.version.deno})`,
                certHash: hash,
            }
        } catch (error) {
            status.transports.webtransport = { ok: false, why: String(error) }
        }
    }
    status.transports.zenoh = await resolveGateway(gateway, gatewayClient, gatewayApp)
    if (status.transports.zenoh.ok) {
        status.transports.zenoh.connect = zenohConnect
        gateway = status.transports.zenoh.gateway
        referer = status.transports.zenoh.referer ?? null
    } else {
        gateway = null
    }
    return {
        status,
        stop: () => {
            for (const each of stoppers) {
                try {
                    each()
                } catch {
                    // already stopped
                }
            }
        },
    }
}
