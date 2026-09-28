#!/usr/bin/env -S deno run --allow-read --allow-write --allow-net --allow-env
// mcap_recode — copy an .mcap with its image topics re-encoded.
//
//   mcap_recode in.mcap out.mcap [--encode TOPIC=keep|raw|jpeg[:Q] ...]
//               [--image-encoding keep|raw|jpeg[:Q]] [--jpeg-quality N]
//
// Every message that is not an image passes through byte for byte, on the same
// topic, with the same log/publish times and sequence numbers; metadata records are
// carried over too. Image topics (CDR sensor_msgs/Image and CompressedImage) keep
// their names and become (see image_recode/recode.js):
//   jpeg   -> CompressedImage, format "jpeg". A frame already jpeg passes through
//             unless a quality was asked for.
//   raw    -> Image, rgb8 / mono8 / mono16
//   keep   -> untouched
// Depth is never put through jpeg: a 16-bit topic asked for jpeg is kept.

import { McapIndexedReader, McapWriter } from "https://esm.sh/@mcap/core@2.1.7"
import { decompress as zstdDecompress } from "https://esm.sh/fzstd@0.1.1"
import lz4 from "https://esm.sh/lz4js@0.2.0"
import { codecOf, decide, EncodeChoices, needsWorker, RecodePool } from "./image_recode/recode.js"
import { compressFrame } from "./image_recode/lz4_frame.js"

const usage = "usage: mcap_recode in.mcap out.mcap [--encode TOPIC=keep|raw|jpeg[:Q] ...]\n" +
    "                   [--image-encoding keep|raw|jpeg[:Q]] [--jpeg-quality N]"
let choices
let positional
try {
    ;({ choices, rest: positional } = EncodeChoices.fromArgs(Deno.args, { kind: "jpeg" }))
} catch (error) {
    console.error(error.message)
    Deno.exit(2)
}
if (positional.includes("-h") || positional.includes("--help")) {
    console.log(usage)
    Deno.exit(0)
}
const [inPath, outPath] = positional
if (!inPath || !outPath || positional.length > 2) {
    console.error(usage)
    Deno.exit(2)
}
if (
    Deno.realPathSync(inPath) === (() => {
        try {
            return Deno.realPathSync(outPath)
        } catch {
            return null
        }
    })()
) {
    console.error("mcap_recode: the output must be a different file from the input")
    Deno.exit(2)
}

// ---- CDR, just the parts an image needs -------------------------------------------
class CdrReader {
    constructor(bytes) {
        this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        this.bytesIn = bytes
        this.little = (this.view.getUint8(1) & 1) === 1
        this.at = 4
    }
    align(width) {
        this.at += (width - ((this.at - 4) % width)) % width
    }
    uint8() {
        return this.view.getUint8(this.at++)
    }
    uint32() {
        this.align(4)
        const value = this.view.getUint32(this.at, this.little)
        this.at += 4
        return value
    }
    int32() {
        this.align(4)
        const value = this.view.getInt32(this.at, this.little)
        this.at += 4
        return value
    }
    string() {
        const length = this.uint32()
        const text = new TextDecoder().decode(
            this.bytesIn.subarray(this.at, this.at + Math.max(0, length - 1)),
        )
        this.at += length
        return text
    }
    bytes(count) {
        const out = this.bytesIn.subarray(this.at, this.at + count)
        this.at += count
        return out
    }
    header() {
        return { sec: this.int32(), nanosec: this.uint32(), frameId: this.string() }
    }
}

class CdrWriter {
    constructor(size) {
        this.buffer = new Uint8Array(size + 64)
        this.view = new DataView(this.buffer.buffer)
        this.buffer.set([0, 1, 0, 0]) // CDR, little-endian
        this.at = 4
    }
    align(width) {
        this.at += (width - ((this.at - 4) % width)) % width
    }
    uint8(value) {
        this.view.setUint8(this.at++, value)
    }
    uint32(value) {
        this.align(4)
        this.view.setUint32(this.at, value, true)
        this.at += 4
    }
    int32(value) {
        this.align(4)
        this.view.setInt32(this.at, value, true)
        this.at += 4
    }
    string(text) {
        const encoded = new TextEncoder().encode(text)
        this.uint32(encoded.length + 1)
        this.buffer.set(encoded, this.at)
        this.at += encoded.length + 1 // the terminating zero is already there
    }
    bytes(data) {
        this.uint32(data.length)
        this.buffer.set(data, this.at)
        this.at += data.length
    }
    header(header) {
        this.int32(header.sec)
        this.uint32(header.nanosec)
        this.string(header.frameId)
    }
    done() {
        return this.buffer.subarray(0, this.at)
    }
}

const readFrame = (schemaName, data) => {
    const reader = new CdrReader(data)
    const header = reader.header()
    if (schemaName === "sensor_msgs/msg/CompressedImage") {
        const format = reader.string()
        const bytes = reader.bytes(reader.uint32())
        return { header, frame: { compressed: true, codec: codecOf(format), format, bytes } }
    }
    const height = reader.uint32()
    const width = reader.uint32()
    const encoding = reader.string()
    const bigEndian = reader.uint8()
    const step = reader.uint32()
    const bytes = reader.bytes(reader.uint32())
    return { header, frame: { compressed: false, encoding, width, height, step, bigEndian, bytes } }
}

const writeCompressed = (header, format, bytes) => {
    const writer = new CdrWriter(bytes.length + header.frameId.length + format.length + 32)
    writer.header(header)
    writer.string(format)
    writer.bytes(bytes)
    return writer.done()
}
const writeImage = (header, image) => {
    const writer = new CdrWriter(
        image.bytes.length + header.frameId.length + image.encoding.length + 48,
    )
    writer.header(header)
    writer.uint32(image.height)
    writer.uint32(image.width)
    writer.string(image.encoding)
    writer.uint8(image.bigEndian ?? 0)
    writer.uint32(image.step)
    writer.bytes(image.bytes)
    return writer.done()
}

const HEADER_DEFINITION =
    `================================================================================
MSG: std_msgs/Header
builtin_interfaces/Time stamp
string frame_id
================================================================================
MSG: builtin_interfaces/Time
int32 sec
uint32 nanosec
`
const DEFINITIONS = {
    "sensor_msgs/msg/Image":
        "std_msgs/Header header\nuint32 height\nuint32 width\nstring encoding\nuint8 is_bigendian\nuint32 step\nuint8[] data\n" +
        HEADER_DEFINITION,
    "sensor_msgs/msg/CompressedImage": "std_msgs/Header header\nstring format\nuint8[] data\n" +
        HEADER_DEFINITION,
}
const IMAGE_SCHEMAS = new Set(Object.keys(DEFINITIONS))

// ---- read -------------------------------------------------------------------------
const file = await Deno.open(inPath, { read: true })
const size = (await file.stat()).size
const reader = await McapIndexedReader.Initialize({
    readable: {
        size: async () => BigInt(size),
        read: async (offset, length) => {
            const buffer = new Uint8Array(Number(length))
            await file.seek(Number(offset), Deno.SeekMode.Start)
            let filled = 0
            while (filled < buffer.length) {
                const read = await file.read(buffer.subarray(filled))
                if (read === null) {
                    break
                }
                filled += read
            }
            return buffer
        },
    },
    decompressHandlers: {
        zstd: (bytes, expected) => zstdDecompress(bytes, new Uint8Array(Number(expected))),
        lz4: (bytes) => new Uint8Array(lz4.decompress(bytes)),
    },
})

// ---- write ------------------------------------------------------------------------
const out = await Deno.open(outPath, { write: true, create: true, truncate: true })
let position = 0n
const writer = new McapWriter({
    writable: {
        position: () => position,
        write: async (buffer) => {
            let written = 0
            while (written < buffer.length) {
                written += await out.write(buffer.subarray(written))
            }
            position += BigInt(buffer.length)
        },
    },
    chunkSize: 4 * 1024 * 1024,
    compressChunk: (data) => ({
        compression: "lz4",
        compressedData: compressFrame(data),
    }),
})
await writer.start({ profile: reader.header.profile, library: "dtk mcap_recode" })

const schemaIds = new Map() // source schema id -> output schema id
for (const schema of reader.schemasById.values()) {
    schemaIds.set(
        schema.id,
        await writer.registerSchema({
            name: schema.name,
            encoding: schema.encoding,
            data: schema.data,
        }),
    )
}
const schemaIdByName = new Map(
    [...reader.schemasById.values()].map((schema) => [schema.name, schemaIds.get(schema.id)]),
)
const imageSchemaId = async (name) => {
    if (!schemaIdByName.has(name)) {
        schemaIdByName.set(
            name,
            await writer.registerSchema({
                name,
                encoding: "ros2msg",
                data: new TextEncoder().encode(DEFINITIONS[name]),
            }),
        )
    }
    return schemaIdByName.get(name)
}

// Each image channel's action, from its first frame.
const plan = new Map() // source channel id -> { channelId, topic, action, output }
const imageTopics = []
for (const channel of reader.channelsById.values()) {
    const schema = reader.schemasById.get(channel.schemaId)
    const entry = { topic: channel.topic, action: { kind: "keep" } }
    if (schema && IMAGE_SCHEMAS.has(schema.name) && channel.messageEncoding === "cdr") {
        imageTopics.push(channel.topic)
        entry.schemaName = schema.name
        let first = null
        for await (const message of reader.readMessages({ topics: [channel.topic] })) {
            first = readFrame(schema.name, message.data).frame
            break
        }
        const choice = choices.choiceFor(channel.topic)
        entry.action = first ? decide(first, choice) : { kind: "keep" }
        if (entry.action.reason && choice.explicit) {
            console.warn(`warning: ${channel.topic}: keeping it as it is (${entry.action.reason})`)
        }
    }
    let schemaId = channel.schemaId === 0 ? 0 : schemaIds.get(channel.schemaId)
    if (entry.action.kind === "jpeg") {
        schemaId = await imageSchemaId("sensor_msgs/msg/CompressedImage")
    } else if (entry.action.kind === "raw") {
        schemaId = await imageSchemaId("sensor_msgs/msg/Image")
    }
    entry.channelId = await writer.registerChannel({
        topic: channel.topic,
        schemaId,
        messageEncoding: channel.messageEncoding,
        metadata: channel.metadata,
    })
    plan.set(channel.id, entry)
}
const unmatched = choices.unmatched(imageTopics)
if (unmatched.length > 0) {
    console.error(`--encode names no image topic in this recording: ${unmatched.join(", ")}`)
    await Deno.remove(outPath)
    Deno.exit(2)
}
for (const entry of plan.values()) {
    if (entry.schemaName) {
        const { kind, quality, passJpeg } = entry.action
        console.log(
            `${entry.topic}: ${
                kind === "jpeg"
                    ? `jpeg q${quality}${passJpeg ? " (jpeg frames passed through)" : ""}`
                    : kind
            }`,
        )
    }
}

const pool = new RecodePool()
let pending = [] // messages in read order, some waiting on a job
let pendingJobs = 0
const flush = async () => {
    const results = await pool.run(pending.filter((row) => row.job).map((row) => row.job))
    let at = 0
    for (const row of pending) {
        let data = row.message.data
        if (row.job) {
            const result = results[at++]
            if (result.error) {
                throw new Error(`${row.entry.topic}: ${result.error}`)
            }
            data = result.encoding === "jpeg"
                ? writeCompressed(row.header, "jpeg", result.bytes)
                : writeImage(row.header, result)
        } else if (row.rewrap) {
            data = row.rewrap()
        }
        await writer.addMessage({
            channelId: row.entry.channelId,
            sequence: row.message.sequence,
            logTime: row.message.logTime,
            publishTime: row.message.publishTime,
            data,
        })
    }
    pending = []
    pendingJobs = 0
}

const started = performance.now()
let count = 0
for await (const message of reader.readMessages()) {
    const entry = plan.get(message.channelId)
    const row = { entry, message }
    if (entry.action.kind !== "keep") {
        const { header, frame } = readFrame(entry.schemaName, message.data)
        row.header = header
        if (needsWorker(frame, entry.action)) {
            row.job = { frame, target: entry.action.kind, quality: entry.action.quality }
            pendingJobs++
        } else if (entry.action.kind === "jpeg" && frame.format !== "jpeg") {
            // a jpeg passed through, but its format string says more than "jpeg"
            row.rewrap = () => writeCompressed(header, "jpeg", frame.bytes)
        }
    }
    pending.push(row)
    if (pendingJobs >= pool.capacity || pending.length >= 4096) {
        await flush()
    }
    if (++count % 20000 === 0) {
        console.log(`  ${count} messages, ${((performance.now() - started) / 1000).toFixed(0)} s`)
    }
}
await flush()
pool.close()

for (const name of new Set(reader.metadataIndexes.map((index) => index.name))) {
    for await (const metadata of reader.readMetadata({ name })) {
        await writer.addMetadata(metadata)
    }
}
await writer.end()
out.close()
file.close()
console.log(
    `wrote ${count} messages to ${outPath} in ${
        ((performance.now() - started) / 1000).toFixed(0)
    } s`,
)
