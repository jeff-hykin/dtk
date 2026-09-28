// What an image stream becomes when a recording is converted, shared by every
// converter (mcap -> db, db -> db, mcap -> mcap, db -> mcap) so a `--encode` means
// the same thing on each path.
//
// A choice is one of
//   keep          the frame stays in the codec it came in (a jxl stays a jxl)
//   raw           decoded to pixels (rgb8, mono8, or mono16 for 16-bit depth)
//   jpeg[:Q]      jpeg at quality Q (1-100). Without Q a frame that is already jpeg
//                 passes through untouched; with Q it is re-encoded at Q.
// and is decided per stream from its first frame, since a stream has one type.
//
// Depth is never squeezed through jpeg, which holds 8 bits: a 16-bit frame asked for
// jpeg is kept as it came instead.

// Codecs a worker can decode on the way to another encoding.
export const DECODABLE = new Set(["png", "jpeg", "webp", "jxl"])

// Raw encodings a worker can turn into jpeg: [channels, order].
export const RAW_8BIT = {
    rgb8: [3, "rgb"],
    bgr8: [3, "bgr"],
    rgba8: [4, "rgb"],
    bgra8: [4, "bgr"],
    mono8: [1, "grey"],
    "8uc1": [1, "grey"],
    "8uc3": [3, "bgr"],
}

export const DEFAULT_QUALITY = 50 // what dimos's own JpegCodec uses

// "jpeg:70" -> { kind: "jpeg", quality: 70 }. Throws on anything else.
export function parseChoice(text) {
    const [kind, quality] = String(text).toLowerCase().split(":")
    if (kind === "keep" || kind === "raw") {
        if (quality !== undefined) {
            throw new Error(`"${text}": only jpeg takes a quality`)
        }
        return { kind }
    }
    if (kind === "jpeg" || kind === "jpg") {
        if (quality === undefined) {
            return { kind: "jpeg" }
        }
        const number = Number(quality)
        if (!Number.isInteger(number) || number < 1 || number > 100) {
            throw new Error(`"${text}": jpeg quality must be a whole number from 1 to 100`)
        }
        return { kind: "jpeg", quality: number }
    }
    throw new Error(`"${text}" is not an encoding; use keep, raw, jpeg or jpeg:QUALITY`)
}

// The per-stream choices of one conversion: `--encode TOPIC=CHOICE` (repeatable) and a
// default for everything else. A topic matches by its exact name, with or without a
// leading slash, and by its flattened stream name (/a/b -> a_b), so the same flag
// works whichever side of a conversion the name was read from.
export class EncodeChoices {
    constructor(defaultChoice = { kind: "jpeg" }) {
        this.defaultChoice = defaultChoice
        this.byName = new Map()
    }
    // Consumes the flags it knows from an argv, returning the rest.
    static fromArgs(args, defaultChoice) {
        const choices = new EncodeChoices(defaultChoice)
        const rest = []
        let quality = null
        for (let i = 0; i < args.length; i++) {
            const arg = args[i]
            if (arg === "--encode") {
                const spec = args[++i] ?? ""
                const at = spec.lastIndexOf("=")
                if (at <= 0) {
                    throw new Error(`--encode wants TOPIC=CHOICE, not "${spec}"`)
                }
                choices.set(spec.slice(0, at), parseChoice(spec.slice(at + 1)))
            } else if (arg === "--image-encoding") {
                choices.defaultChoice = parseChoice(args[++i])
            } else if (arg === "--jpeg-quality") {
                quality = parseChoice(`jpeg:${args[++i]}`).quality
            } else {
                rest.push(arg)
            }
        }
        if (quality !== null && choices.defaultChoice.kind === "jpeg") {
            choices.defaultChoice = { kind: "jpeg", quality }
        }
        return { choices, rest }
    }
    set(name, choice) {
        this.byName.set(normalName(name), choice)
    }
    // The first explicit match among a stream's names, else the default.
    choiceFor(...names) {
        for (const name of names.filter(Boolean)) {
            for (const key of [normalName(name), flatName(name)]) {
                if (this.byName.has(key)) {
                    return { ...this.byName.get(key), explicit: true }
                }
            }
        }
        return { ...this.defaultChoice, explicit: false }
    }
    // Names given to --encode that matched nothing, so a typo is not silently ignored.
    unmatched(allNames) {
        const known = new Set(allNames.flatMap((name) => [normalName(name), flatName(name)]))
        return [...this.byName.keys()].filter((key) => !known.has(key))
    }
}

const normalName = (name) => name.replace(/^\//, "")
export const flatName = (name) => name.replace(/^\//, "").replace(/\//g, "_")

// ---- what a frame is ------------------------------------------------------------
// A source frame is either
//   { compressed: true, codec, bytes }
//   { compressed: false, encoding, width, height, step, bigEndian, bytes }

// The codec named by a CompressedImage `format` ("bgr8; jpeg compressed bgr8", "png").
export function codecOf(format) {
    const lower = String(format).toLowerCase()
    for (const codec of ["jpeg", "png", "webp", "jxl"]) {
        if (lower.includes(codec)) {
            return codec
        }
    }
    if (lower.includes("jpg")) {
        return "jpeg"
    }
    return lower.split(/[;, ]/)[0]
}

// Whether a frame holds more than 8 bits a sample: jpeg cannot carry it.
export function isDeep(frame) {
    if (!frame.compressed) {
        return !(frame.encoding.toLowerCase() in RAW_8BIT)
    }
    if (frame.codec === "png") {
        return frame.bytes[24] === 16
    }
    if (frame.codec === "jxl") {
        return jxlBitDepth(frame.bytes) !== 8 // unreadable header counts as deep
    }
    return false
}

// Whether a worker can decode this frame to pixels losslessly for `raw`: 8-bit
// anything it can decode, and 16-bit greyscale png (the jxl decoder gives 8 bits).
function canDecodeToRaw(frame) {
    if (!frame.compressed) {
        return true
    }
    if (!DECODABLE.has(frame.codec) || !hasSignature(frame.codec, frame.bytes)) {
        return false
    }
    if (isDeep(frame)) {
        return frame.codec === "png" && frame.bytes[25] === 0
    }
    return true
}

// What to do with a stream, decided from its first frame and a choice:
//   { kind: "keep" }                          leave every frame as it is
//   { kind: "jpeg", quality, passJpeg }       jpeg; passJpeg lets a jpeg frame through as is
//   { kind: "raw" }                           decoded pixels
// plus `reason` when the choice could not be honoured.
export function decide(firstFrame, choice) {
    if (choice.kind === "keep") {
        return { kind: "keep" }
    }
    if (firstFrame.compressed && !hasSignature(firstFrame.codec, firstFrame.bytes)) {
        return { kind: "keep", reason: `frames say ${firstFrame.codec} but are not` }
    }
    if (choice.kind === "raw") {
        if (!firstFrame.compressed) {
            return { kind: "keep" } // already raw
        }
        return canDecodeToRaw(firstFrame) ? { kind: "raw" } : {
            kind: "keep",
            reason: `a ${
                isDeep(firstFrame) ? "16-bit " : ""
            }${firstFrame.codec} cannot be decoded without loss here`,
        }
    }
    // jpeg
    if (isDeep(firstFrame)) {
        return { kind: "keep", reason: "16-bit depth; jpeg holds 8 bits" }
    }
    if (firstFrame.compressed && !DECODABLE.has(firstFrame.codec)) {
        return { kind: "keep", reason: `${firstFrame.codec} cannot be decoded here` }
    }
    return {
        kind: "jpeg",
        quality: choice.quality ?? DEFAULT_QUALITY,
        passJpeg: choice.quality === undefined,
    }
}

// Whether one frame of a stream decided as `action` still needs a worker.
export function needsWorker(frame, action) {
    if (action.kind === "keep") {
        return false
    }
    if (action.kind === "raw") {
        return frame.compressed
    }
    return !(frame.compressed && frame.codec === "jpeg" && action.passJpeg)
}

// ---- frame headers -----------------------------------------------------------

// A compressed frame's pixel size, read out of the frame itself; `null` when the bytes
// are not the codec they claim.
export const frameSize = (codec, data) => {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    if (codec === "png") {
        // 8-byte signature, then an IHDR chunk whose width and height lead its body.
        if (
            data.length < 24 || view.getUint32(0) !== 0x89504e47 ||
            view.getUint32(12) !== 0x49484452
        ) {
            return null
        }
        return { width: view.getUint32(16), height: view.getUint32(20) }
    }
    if (codec === "jpeg") {
        if (data.length < 4 || view.getUint16(0) !== 0xffd8) {
            return null
        }
        // Walk the marker segments to the frame header; only SOFn carries the size,
        // and SOF4/SOF8/SOF12 are not frame headers despite sitting in that range.
        for (let at = 2; at + 4 <= data.length;) {
            if (view.getUint8(at) !== 0xff) {
                return null
            }
            const marker = view.getUint8(at + 1)
            if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
                at += 2
                continue
            }
            const length = view.getUint16(at + 2)
            if (
                marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 &&
                marker !== 0xcc
            ) {
                if (at + 9 > data.length) {
                    return null
                }
                return { width: view.getUint16(at + 7), height: view.getUint16(at + 5) }
            }
            at += 2 + length
        }
        return null
    }
    return null
}

// Whether a frame's bytes are the codec it claims.
export const hasSignature = (codec, data) => {
    if (codec === "webp") {
        return data.length >= 12 && String.fromCharCode(...data.subarray(0, 4)) === "RIFF" &&
            String.fromCharCode(...data.subarray(8, 12)) === "WEBP"
    }
    if (codec === "jxl") {
        return (data[0] === 0xff && data[1] === 0x0a) ||
            (data.length >= 8 && String.fromCharCode(...data.subarray(4, 8)) === "JXL ")
    }
    return frameSize(codec, data) !== null
}

// Bits per sample in a jxl frame, from its image metadata, or `null` when the header
// holds something this does not walk (a preview or animation header) — a caller then
// treats the frame as possibly deep. A bare codestream starts ff0a; the container
// form carries it in a jxlc box, or split over jxlp boxes whose first holds the header.
export const jxlBitDepth = (data) => {
    let stream = data
    if (data[0] !== 0xff) {
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
        stream = null
        for (let at = 0; at + 8 <= data.length;) {
            let size = view.getUint32(at)
            const type = String.fromCharCode(...data.subarray(at + 4, at + 8))
            let header = 8
            if (size === 1) {
                size = Number(view.getBigUint64(at + 8))
                header = 16
            } else if (size === 0) {
                size = data.length - at
            }
            if (type === "jxlc" || type === "jxlp") {
                stream = data.subarray(at + header + (type === "jxlp" ? 4 : 0), at + size)
                break
            }
            if (size < header) {
                return null
            }
            at += size
        }
    }
    if (!stream || stream[0] !== 0xff || stream[1] !== 0x0a) {
        return null
    }
    let bit = 16
    const u = (count) => {
        let value = 0
        for (let i = 0; i < count; i++, bit++) {
            value |= ((stream[bit >> 3] >> (bit & 7)) & 1) << i
        }
        return value
    }
    const u32 = (...choices) => {
        const [bits, offset] = choices[u(2)]
        return u(bits) + offset
    }
    const sizeHeader = () => {
        const small = u(1)
        const dimension = () => (small ? u(5) : u32([9, 1], [13, 1], [18, 1], [30, 1]))
        dimension()
        if (u(3) === 0) {
            dimension()
        }
    }
    sizeHeader()
    if (u(1)) {
        return 8 // all_default metadata
    }
    if (u(1)) {
        u(3) // orientation
        if (u(1)) {
            sizeHeader() // intrinsic size
        }
        if (u(1) || u(1)) {
            return null // preview or animation header
        }
    }
    return u(1) ? u32([0, 32], [0, 16], [0, 24], [6, 1]) : u32([0, 8], [0, 10], [0, 12], [6, 1])
}

// ---- the worker pool ---------------------------------------------------------

// Decoding and encoding run on every core but two, in batches, because they cost far
// more than the rest of a conversion and would otherwise idle the machine one frame at
// a time. `run` returns results in the order the jobs were given, so a caller writes
// rows in time order even though the work finishes out of order.
//
// A job is { frame, target: "jpeg" | "raw", quality }; a result is
// { encoding, width, height, step, bytes } (encoding "jpeg" and step 0 for jpeg), or
// { error }.
export class RecodePool {
    constructor(count = Math.max(1, (navigator.hardwareConcurrency || 4) - 2)) {
        this.count = count
        this.workers = []
    }
    #start() {
        while (this.workers.length < this.count) {
            this.workers.push(new Worker(import.meta.resolve("./worker.js"), { type: "module" }))
        }
    }
    static BATCH = 24
    get capacity() {
        return RecodePool.BATCH * this.count
    }
    async run(jobs) {
        if (jobs.length === 0) {
            return []
        }
        this.#start()
        const slices = []
        for (let at = 0; at < jobs.length; at += RecodePool.BATCH) {
            slices.push(jobs.slice(at, at + RecodePool.BATCH))
        }
        const results = await Promise.all(
            slices.map((slice, index) =>
                runBatch(this.workers[index % this.workers.length], slice)
            ),
        )
        return results.flat()
    }
    close() {
        for (const worker of this.workers) {
            worker.terminate()
        }
        this.workers = []
    }
}

// One worker handles one batch at a time, so batches for the same worker queue here.
const queues = new WeakMap()
function runBatch(worker, jobs) {
    const previous = queues.get(worker) ?? Promise.resolve()
    const next = previous.then(() =>
        new Promise((resolve, reject) => {
            worker.onmessage = (event) => resolve(event.data)
            worker.onerror = (event) => reject(new Error(event.message))
            // Copied, not transferred: a frame is often a view into a larger buffer the
            // caller still needs.
            worker.postMessage({
                jobs: jobs.map(({ frame, target, quality }) => ({
                    frame: { ...frame, bytes: frame.bytes.slice() },
                    target,
                    quality,
                })),
            })
        })
    )
    queues.set(worker, next.catch(() => {}))
    return next
}
