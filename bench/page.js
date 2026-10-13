// The browser end of `dtk bench`, served by the far machine and driven from the near one. Each
// run loads one transport at an offered rate and pings at 20 Hz inside that load and beside it
// (a WebSocket echo on its own connection).

import {
    DATA,
    DONE,
    frame,
    FrameReader,
    json,
    message,
    PING,
    pingHz,
    pingTimeoutMs,
    PONG,
    readTime,
    START,
    summarize,
    timeBytes,
    unjson,
} from "./protocol.js"

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
// the far machine; this page itself is served from localhost here, a secure context
const remote = window.benchRemote ?? location.origin
const wsBase = remote.replace(/^http/, "ws")
const startMessage = (bitsPerSecond, seconds) =>
    json({ bitsPerSecond: bitsPerSecond === Infinity ? null : bitsPerSecond, seconds })

function pinger(send) {
    const rtts = []
    let perSecond = []
    let sent = 0
    const timer = setInterval(() => {
        if (send(timeBytes(performance.now())) !== false) {
            sent++
        }
    }, 1000 / pingHz)
    return {
        answer(bytes) {
            const rtt = Math.round((performance.now() - readTime(bytes)) * 100) / 100
            if (rtt <= pingTimeoutMs) {
                rtts.push(rtt)
                perSecond.push(rtt)
            }
        },
        take() {
            const out = perSecond
            perSecond = []
            return out
        },
        stop() {
            clearInterval(timer)
            return { rtts, sent }
        },
    }
}

function openSocket(path) {
    const socket = new WebSocket(`${wsBase}${path}`)
    socket.binaryType = "arraybuffer"
    return new Promise((resolve, reject) => {
        socket.onopen = () => resolve(socket)
        socket.onerror = () => reject(new Error(`websocket ${path} failed`))
    })
}

async function sidePinger() {
    const socket = await openSocket("/echo")
    const ping = pinger((bytes) => socket.send(bytes))
    socket.onmessage = (event) => ping.answer(new Uint8Array(event.data))
    return {
        ...ping,
        stop() {
            const result = ping.stop()
            socket.close()
            return result
        },
    }
}

// Each opener returns { ping, count(): bytes so far, done(): server's DONE or null, close(), note }
const openers = {
    async http(bitsPerSecond, seconds) {
        let bytes = 0
        let finished = null
        let busy = false
        // no in-band path over HTTP/1.1: a GET /ping on its own keep-alive connection instead
        const ping = pinger((payload) => {
            if (busy) {
                return false
            }
            busy = true
            fetch(`${remote}/ping?r=${Math.random()}`, { cache: "no-store" }).then(
                async (response) => {
                    await response.arrayBuffer()
                    ping.answer(payload)
                },
            ).catch(() => {}).finally(() => (busy = false))
        })
        const controller = new AbortController()
        const response = await fetch(
            `${remote}/download?bps=${
                bitsPerSecond === Infinity ? "max" : bitsPerSecond
            }&seconds=${seconds}&r=${Math.random()}`,
            {
                cache: "no-store",
                signal: controller.signal,
            },
        )
        const reader = response.body.getReader()
        ;(async () => {
            for (;;) {
                const { done, value } = await reader.read()
                if (done) {
                    finished = { sent: bytes }
                    break
                }
                bytes += value.byteLength
            }
        })().catch(() => {})
        return {
            ping,
            count: () => bytes,
            done: () => finished,
            close: () => controller.abort(),
            note: "in-band = GET /ping on its own connection",
        }
    },

    async ws(bitsPerSecond, seconds) {
        const socket = await openSocket("/ws")
        let bytes = 0
        let finished = null
        const ping = pinger((payload) => socket.send(message(PING, payload)))
        socket.onmessage = (event) => {
            const data = new Uint8Array(event.data)
            if (data[0] === DATA) {
                bytes += data.byteLength - 1
            } else if (data[0] === PONG) {
                ping.answer(data.subarray(1))
            } else if (data[0] === DONE) {
                finished = unjson(data.subarray(1))
            }
        }
        socket.send(message(START, startMessage(bitsPerSecond, seconds)))
        return { ping, count: () => bytes, done: () => finished, close: () => socket.close() }
    },

    async webrtc(bitsPerSecond, seconds) {
        const pc = new RTCPeerConnection()
        const bulk = pc.createDataChannel("bulk", { ordered: true })
        const echo = pc.createDataChannel("echo", { ordered: false, maxRetransmits: 0 })
        bulk.binaryType = "arraybuffer"
        echo.binaryType = "arraybuffer"
        await pc.setLocalDescription(await pc.createOffer())
        await new Promise((resolve) => {
            if (pc.iceGatheringState === "complete") {
                return resolve()
            }
            pc.addEventListener(
                "icegatheringstatechange",
                () => pc.iceGatheringState === "complete" && resolve(),
            )
            setTimeout(resolve, 3000)
        })
        const answer = await (await fetch(`${remote}/rtc/offer`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(pc.localDescription),
        })).json()
        if (answer.error) {
            pc.close()
            throw new Error(answer.error)
        }
        await pc.setRemoteDescription(answer)
        const opened = (channel) =>
            new Promise((resolve, reject) => {
                if (channel.readyState === "open") {
                    return resolve()
                }
                channel.onopen = resolve
                setTimeout(() =>
                    reject(
                        new Error(
                            `data channel ${channel.label} never opened (ICE ${pc.iceConnectionState})`,
                        ),
                    ), 10000)
            })
        await Promise.all([opened(bulk), opened(echo)])
        let bytes = 0
        let finished = null
        // in-band = the echo channel on the same SCTP association, not behind the bulk channel's queue
        const ping = pinger((payload) => echo.send(payload))
        echo.onmessage = (event) => ping.answer(new Uint8Array(event.data))
        bulk.onmessage = (event) => {
            const data = new Uint8Array(event.data)
            if (data[0] === DATA) {
                bytes += data.byteLength - 1
            } else if (data[0] === DONE) {
                finished = unjson(data.subarray(1))
            }
        }
        bulk.send(message(START, startMessage(bitsPerSecond, seconds)))
        return { ping, count: () => bytes, done: () => finished, close: () => pc.close() }
    },

    async webtransport(bitsPerSecond, seconds, { port, certHash }) {
        const transport = new WebTransport(`https://${new URL(remote).hostname}:${port}/bench`, {
            serverCertificateHashes: [{ algorithm: "sha-256", value: new Uint8Array(certHash) }],
        })
        await transport.ready
        const datagrams = transport.datagrams.writable.getWriter()
        // in-band = datagrams on the same QUIC connection
        const ping = pinger((payload) => {
            datagrams.write(message(PING, payload)).catch(() => {})
        })
        ;(async () => {
            for await (const data of transport.datagrams.readable) {
                if (data[0] === PING) {
                    ping.answer(data.subarray(1))
                }
            }
        })().catch(() => {})
        const stream = await transport.createBidirectionalStream()
        const writer = stream.writable.getWriter()
        await writer.write(frame(START, startMessage(bitsPerSecond, seconds)))
        let bytes = 0
        let finished = null
        const reader = new FrameReader()
        ;(async () => {
            for await (const chunk of stream.readable) {
                for (const { type, payload } of reader.push(chunk)) {
                    if (type === DATA) {
                        bytes += payload.byteLength
                    } else if (type === DONE) {
                        finished = unjson(payload)
                    }
                }
            }
        })().catch(() => {})
        return { ping, count: () => bytes, done: () => finished, close: () => transport.close() }
    },

    async zenoh(bitsPerSecond, seconds, { gatewayPath, client }) {
        zenohState ??= await openZenoh(gatewayPath, client)
        const { gateway, key } = zenohState
        let received = 0
        let bytes = 0
        const delays = []
        zenohState.onMessage = (payload) => {
            received++
            bytes += payload.byteLength
            const sentAt = Number(
                new DataView(payload.buffer, payload.byteOffset + 4, 8).getBigUint64(0),
            )
            delays.push(Date.now() + (gateway.clockOffsetMs ?? 0) - sentAt)
        }
        // in-band = the gateway client's own round trips (heartbeat), on the same WebRTC association
        let last = gateway.rttMs
        const rtts = []
        let perSecond = []
        const watch = setInterval(() => {
            if (gateway.rttMs !== last && gateway.rttMs !== null) {
                last = gateway.rttMs
                rtts.push(Math.round(last * 100) / 100)
                perSecond.push(Math.round(last * 100) / 100)
            }
        }, 5)
        const ping = {
            take() {
                const out = perSecond
                perSecond = []
                return out
            },
            stop() {
                clearInterval(watch)
                // the client's own timer sets the heartbeat's pace, so there is no count to lose from
                return { rtts, sent: null }
            },
        }
        let finished = null
        fetch(`${remote}/zenoh/run`, {
            method: "POST",
            body: JSON.stringify({ bitsPerSecond, seconds, size: 8192, key }),
        }).then((response) => response.json()).then((reply) => (finished = reply))
        return {
            ping,
            count: () => bytes,
            done: () => finished,
            close() {},
            dataLoss:
                () => (finished?.sent
                    ? (100 * Math.max(0, finished.sent - received)) / finished.sent
                    : null),
            note: () => {
                const sorted = [...delays].sort((a, b) => a - b)
                return sorted.length
                    ? `one-way p50 ${Math.round(sorted[Math.floor(sorted.length / 2)])} ms, p95 ${
                        Math.round(sorted[Math.floor(sorted.length * 0.95)])
                    } ms`
                    : null
            },
        }
    },
}

let zenohState = null

async function openZenoh(gatewayPath, clientUrl) {
    const { connect } = await import(clientUrl)
    const gateway = await connect(`${remote}/zgw${gatewayPath}`, {
        heartbeatHz: pingHz,
        heartbeatMisses: 20,
    })
    const key = `dtk/bench/${Math.random().toString(36).slice(2, 10)}`
    const state = { gateway, key, onMessage: null }
    gateway.subscribe(key, {}, (sample) => state.onMessage?.(sample.bytes))
    await sleep(1000)
    return state
}

// One run: `transport` at `bitsPerSecond` (Infinity = max) for `seconds`.
export async function run(transport, bitsPerSecond, seconds, extra = {}) {
    const side = await sidePinger()
    const load = await openers[transport](bitsPerSecond, seconds, extra)
    const samples = []
    let last = 0
    const started = performance.now()
    for (let t = 1; t <= seconds; t++) {
        await sleep(Math.max(0, started + t * 1000 - performance.now()))
        const now = load.count()
        samples.push({
            t,
            mbps: Math.round(((now - last) * 8) / 1e4) / 100,
            inband: load.ping.take(),
            side: side.take(),
        })
        last = now
    }
    const inWindow = load.count()
    await sleep(1000)
    const inband = load.ping.stop()
    const sideResult = side.stop()
    for (let i = 0; i < 50 && !load.done(); i++) {
        await sleep(100)
    }
    load.close()
    const note = typeof load.note === "function" ? load.note() : load.note
    return {
        ...summarize({
            bitsPerSecond,
            seconds,
            bytes: inWindow,
            inband: inband.rtts,
            side: sideResult.rtts,
            pingsSent: inband.sent,
            sideSent: sideResult.sent,
            dataLoss: load.dataLoss ? load.dataLoss() : null,
            note: note ?? (load.done() ? null : "server never said done"),
        }),
        samples,
        visibility: document.visibilityState,
    }
}
