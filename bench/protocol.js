// What both ends of `dtk bench` agree on: frame types, pacing and the summary of one run.
//
// A byte stream (TCP, a WebTransport stream) carries frames of [type u8][length u32 BE][payload];
// a message transport (WebSocket, a data channel, a UDP datagram) carries [type u8][payload].

export const DATA = 0
export const PING = 1
export const PONG = 2
export const START = 3
export const DONE = 4

// how often the client pings, in and beside the load
export const pingHz = 20
// a ping not answered within this long counts as lost
export const pingTimeoutMs = 2000
// a paced sender never holds more than this queued in its own transport (bufferedAmount);
// above it, it waits, so the achieved rate falls short instead of latency growing without bound
export const maxQueuedBytes = 256 * 1024
export const chunkBytes = 16 * 1024
export const datagramBytes = 1200

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function frame(type, payload = new Uint8Array(0)) {
    const out = new Uint8Array(5 + payload.byteLength)
    out[0] = type
    new DataView(out.buffer).setUint32(1, payload.byteLength)
    out.set(payload, 5)
    return out
}

export function message(type, payload = new Uint8Array(0)) {
    const out = new Uint8Array(1 + payload.byteLength)
    out[0] = type
    out.set(payload, 1)
    return out
}

export const json = (value) => encoder.encode(JSON.stringify(value))
export const unjson = (bytes) => JSON.parse(decoder.decode(bytes))

export function timeBytes(ms) {
    const out = new Uint8Array(8)
    new DataView(out.buffer).setFloat64(0, ms)
    return out
}

export const readTime = (bytes, offset = 0) =>
    new DataView(bytes.buffer, bytes.byteOffset + offset, 8).getFloat64(0)

// Splits a byte stream back into frames, however the reads happen to cut it.
export class FrameReader {
    constructor() {
        this.buffer = new Uint8Array(0)
    }

    *push(chunk) {
        const joined = new Uint8Array(this.buffer.byteLength + chunk.byteLength)
        joined.set(this.buffer)
        joined.set(chunk, this.buffer.byteLength)
        let at = 0
        while (joined.byteLength - at >= 5) {
            const length = new DataView(joined.buffer, at + 1, 4).getUint32(0)
            if (joined.byteLength - at < 5 + length) {
                break
            }
            yield { type: joined[at], payload: joined.subarray(at + 5, at + 5 + length) }
            at += 5 + length
        }
        this.buffer = joined.slice(at)
    }
}

// Sends `bitsPerSecond` (Infinity = as fast as the transport takes it) for `seconds` through
// `send(bytes)`, which resolves once the transport has room again.
export async function pace(
    { bitsPerSecond, seconds, send, chunk = chunkBytes, stop = () => false },
) {
    const payload = new Uint8Array(chunk)
    const started = performance.now()
    let sent = 0
    if (bitsPerSecond <= 0) {
        await new Promise((resolve) => setTimeout(resolve, seconds * 1000))
        return 0
    }
    while (!stop()) {
        const elapsed = (performance.now() - started) / 1000
        if (elapsed >= seconds) {
            break
        }
        const allowed = bitsPerSecond === Infinity ? Infinity : (bitsPerSecond / 8) * elapsed - sent
        if (allowed < Math.min(chunk, 1024)) {
            await new Promise((resolve) => setTimeout(resolve, 2))
            continue
        }
        const size = Math.min(chunk, allowed)
        await send(size === chunk ? payload : payload.subarray(0, size))
        sent += size
    }
    return sent
}

// "0,1,5,max" (Mbit/s) -> bits per second, Infinity for max
export function parseRates(text) {
    return String(text).split(",").map((each) => each.trim()).filter(Boolean).map((each) => {
        if (each === "max") {
            return Infinity
        }
        const value = Number(each)
        if (!Number.isFinite(value) || value < 0) {
            throw new Error(`not a rate: ${each} (Mbit/s, or max)`)
        }
        return value * 1e6
    })
}

export const rateLabel = (bitsPerSecond) =>
    bitsPerSecond === Infinity
        ? "max"
        : bitsPerSecond === 0
        ? "idle"
        : `${+(bitsPerSecond / 1e6).toFixed(2)}`

function percentile(sorted, p) {
    if (sorted.length === 0) {
        return null
    }
    return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
}

const round = (value) => (value === null ? null : Math.round(value * 10) / 10)

// The row a run reports: achieved rate, and both latencies, from its per-second samples.
// `inband` and `side` are RTTs in ms; `pingsSent`/`sideSent` let unanswered ones count as loss.
export function summarize(
    {
        bitsPerSecond,
        seconds,
        bytes,
        inband,
        side,
        pingsSent,
        sideSent,
        dataLoss = null,
        note = null,
    },
) {
    const stats = (rtts, sent) => {
        const sorted = [...rtts].sort((a, b) => a - b)
        return {
            p50: round(percentile(sorted, 0.5)),
            p95: round(percentile(sorted, 0.95)),
            max: round(sorted.at(-1) ?? null),
            n: sorted.length,
            loss: sent ? round((100 * Math.max(0, sent - sorted.length)) / sent) : null,
        }
    }
    return {
        offered: rateLabel(bitsPerSecond),
        offeredBps: bitsPerSecond === Infinity ? "max" : bitsPerSecond,
        mbps: round((bytes * 8) / 1e6 / seconds),
        inband: stats(inband, pingsSent),
        side: stats(side, sideSent),
        dataLoss: dataLoss === null ? null : round(dataLoss),
        // a probe that never came back is a failure to report, not a missing number
        note: note ??
            (pingsSent > 0 && inband.length === 0
                ? "the in-band probe got no replies at all"
                : null),
    }
}
