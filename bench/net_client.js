// The near end of the TCP and UDP stages: one run per offered rate, with 20 Hz pings inside the
// load (same connection or socket) and beside it (a separate UDP echo), and per-second samples.

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

// Pings `send` at pingHz; an answer is handed to `answer(bytes)` by whoever reads the replies.
function pinger(send) {
    const rtts = []
    const perSecond = []
    let sent = 0
    const timer = setInterval(() => {
        sent++
        send(timeBytes(performance.now()))
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
            return perSecond.splice(0)
        },
        stop() {
            clearInterval(timer)
            return { rtts, sent }
        },
    }
}

// A ping beside the load: its own UDP socket to the server's echo port.
function sidePinger(host, port) {
    const socket = Deno.listenDatagram({ port: 0, hostname: "0.0.0.0", transport: "udp" })
    const target = { transport: "udp", hostname: host, port }
    const ping = pinger((bytes) => socket.send(message(PING, bytes), target).catch(() => {}))
    ;(async () => {
        for await (const [bytes] of socket) {
            ping.answer(bytes.subarray(1))
        }
    })().catch(() => {})
    return {
        ...ping,
        stop() {
            const result = ping.stop()
            socket.close()
            return result
        },
    }
}

// Calls `tick(second)` once a second for `seconds`, on the second rather than drifting.
async function everySecond(seconds, tick) {
    const started = performance.now()
    for (let second = 1; second <= seconds; second++) {
        await sleep(Math.max(0, started + second * 1000 - performance.now()))
        tick(second)
    }
}

export async function tcpRun({ host, port, echoPort, bitsPerSecond, seconds }) {
    const conn = await Deno.connect({ hostname: host, port })
    conn.setNoDelay(true)
    let bytes = 0
    let done = null
    const reader = new FrameReader()
    const ping = pinger((payload) => conn.write(frame(PING, payload)).catch(() => {}))
    const side = sidePinger(host, echoPort)
    const reading = (async () => {
        const buffer = new Uint8Array(256 * 1024)
        for (;;) {
            const read = await conn.read(buffer).catch(() => null)
            if (read === null) {
                break
            }
            for (const { type, payload } of reader.push(buffer.subarray(0, read))) {
                if (type === DATA) {
                    bytes += payload.byteLength
                } else if (type === PONG) {
                    ping.answer(payload)
                } else if (type === DONE) {
                    done = unjson(payload)
                }
            }
        }
    })()
    await conn.write(
        frame(
            START,
            json({ bitsPerSecond: bitsPerSecond === Infinity ? null : bitsPerSecond, seconds }),
        ),
    )
    const samples = []
    let last = 0
    await everySecond(seconds, (t) => {
        samples.push({
            t,
            mbps: Math.round((bytes - last) * 8 / 1e4) / 100,
            inband: ping.take(),
            side: side.take(),
        })
        last = bytes
    })
    const inWindow = bytes
    // the last pings get their answers; anything still in flight after this counts as lost
    await sleep(Math.min(pingTimeoutMs, 1000))
    const inband = ping.stop()
    const sideResult = side.stop()
    conn.close()
    await reading
    return {
        ...summarize({
            bitsPerSecond,
            seconds,
            bytes: inWindow,
            inband: inband.rtts,
            side: sideResult.rtts,
            pingsSent: inband.sent,
            sideSent: sideResult.sent,
            note: done ? null : "server never said done",
        }),
        samples,
    }
}

export async function udpRun({ host, port, echoPort, bitsPerSecond, seconds }) {
    const socket = Deno.listenDatagram({ port: 0, hostname: "0.0.0.0", transport: "udp" })
    const target = { transport: "udp", hostname: host, port }
    let bytes = 0
    let received = 0
    let done = null
    const ping = pinger((payload) => socket.send(message(PING, payload), target).catch(() => {}))
    const side = sidePinger(host, echoPort)
    const reading = (async () => {
        for await (const [data] of socket) {
            if (data[0] === DATA) {
                bytes += data.byteLength
                received++
            } else if (data[0] === PING) {
                ping.answer(data.subarray(1))
            } else if (data[0] === DONE) {
                done = unjson(data.subarray(1))
            }
        }
    })().catch(() => {})
    await socket.send(message(START, json({ bitsPerSecond, seconds })), target)
    const samples = []
    let last = 0
    await everySecond(seconds, (t) => {
        samples.push({
            t,
            mbps: Math.round((bytes - last) * 8 / 1e4) / 100,
            inband: ping.take(),
            side: side.take(),
        })
        last = bytes
    })
    const inWindow = bytes
    await sleep(Math.min(pingTimeoutMs, 1000))
    const inband = ping.stop()
    const sideResult = side.stop()
    socket.close()
    await reading
    const lost = done && done.sent > 0
        ? (100 * Math.max(0, done.sent - received)) / done.sent
        : null
    return {
        ...summarize({
            bitsPerSecond,
            seconds,
            bytes: inWindow,
            inband: inband.rtts,
            side: sideResult.rtts,
            pingsSent: inband.sent,
            sideSent: sideResult.sent,
            dataLoss: lost,
            note: bitsPerSecond > 0 && !done ? "server's count never arrived" : null,
        }),
        samples,
    }
}
