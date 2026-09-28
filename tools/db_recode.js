#!/usr/bin/env -S deno run --allow-read --allow-write --allow-net --allow-env --allow-ffi --unstable-ffi
// db_recode — copy a memory2 .db with its image streams re-encoded.
//
//   db_recode in.db out.db [--encode STREAM=keep|raw|jpeg[:Q] ...]
//             [--image-encoding keep|raw|jpeg[:Q]] [--jpeg-quality N]
//
// Everything but the image streams is copied byte for byte (VACUUM INTO), and the
// image streams keep their names, rows, timestamps and poses; only each row's blob
// and the stream's registry row (payload type + codec) change. Choices are the ones
// mcap_to_db takes (see image_recode/recode.js):
//   jpeg   -> sensor_msgs.Image under the "jpeg" codec (what dimos itself records).
//             A frame already jpeg passes through unless a quality was asked for.
//   raw    -> sensor_msgs.Image, rgb8 / mono8 / mono16, under lz4+lcm
//   keep   -> the stream is left exactly as it is
// Depth is never put through jpeg: a 16-bit stream asked for jpeg is kept.

import { Database } from "jsr:@db/sqlite@0.12"
import lz4 from "https://esm.sh/lz4js@0.2.0"
import { CompressedImage, Image } from "https://esm.sh/jsr/@dimos/msgs@0.1.4/sensor_msgs"
import {
    codecOf,
    decide,
    EncodeChoices,
    frameSize,
    needsWorker,
    RecodePool,
} from "./image_recode/recode.js"
import { compressFrame } from "./image_recode/lz4_frame.js"

const usage = "usage: db_recode in.db out.db [--encode STREAM=keep|raw|jpeg[:Q] ...]\n" +
    "                 [--image-encoding keep|raw|jpeg[:Q]] [--jpeg-quality N]"
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
    console.error("db_recode: the output must be a different file from the input")
    Deno.exit(2)
}

const IMAGE = "dimos.msgs.sensor_msgs.Image.Image"
const COMPRESSED = "dimos.msgs.sensor_msgs.CompressedImage.CompressedImage"
const LZ4_MAGIC = 0x184d2204

const started = performance.now()
try {
    Deno.removeSync(outPath)
} catch {
    // nothing there yet
}
const source = new Database(inPath, { readonly: true })
source.exec(`VACUUM INTO '${outPath.replaceAll("'", "''")}'`)
source.close()

const db = new Database(outPath)
db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = OFF;")

// A stored blob as a frame: an Image whose encoding is a codec is a compressed frame.
const frameOf = (blob, payloadModule) => {
    let bytes = new Uint8Array(blob)
    if (
        bytes.length >= 4 &&
        new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true) === LZ4_MAGIC
    ) {
        bytes = new Uint8Array(lz4.decompress(bytes))
    }
    if (payloadModule === COMPRESSED) {
        const message = CompressedImage.decode(bytes)
        return {
            message,
            frame: {
                compressed: true,
                codec: codecOf(message.format),
                format: message.format,
                bytes: message.data,
            },
        }
    }
    const message = Image.decode(bytes)
    const encoding = message.encoding.toLowerCase()
    if (["jpeg", "jpg", "png", "webp", "jxl"].includes(encoding)) {
        return {
            message,
            frame: { compressed: true, codec: codecOf(encoding), bytes: message.data },
        }
    }
    return {
        message,
        frame: {
            compressed: false,
            encoding: message.encoding,
            width: message.width,
            height: message.height,
            step: message.step,
            bigEndian: message.is_bigendian,
            bytes: message.data,
        },
    }
}

const imageBlob = (output, header, frame) => {
    const message = new Image()
    message.header = header
    if (output === "jpeg") {
        const size = frameSize("jpeg", frame.bytes)
        message.height = size.height
        message.width = size.width
        message.encoding = "jpeg"
        message.is_bigendian = 0
        message.step = 0
    } else {
        message.height = frame.height
        message.width = frame.width
        message.encoding = frame.encoding
        message.is_bigendian = frame.bigEndian ?? 0
        message.step = frame.step
    }
    message.data = frame.bytes
    message.data_length = frame.bytes.length
    const encoded = message.encode()
    return output === "raw" ? compressFrame(encoded) : encoded
}

const streams = db.prepare("SELECT name, config FROM _streams").all()
const imageStreams = streams.filter((row) =>
    [IMAGE, COMPRESSED].includes(JSON.parse(row.config).payload_module)
)
const unmatched = choices.unmatched(imageStreams.map((row) => row.name))
if (unmatched.length > 0) {
    console.error(`--encode names no image stream in this recording: ${unmatched.join(", ")}`)
    Deno.exit(2)
}

const pool = new RecodePool()
for (const stream of imageStreams) {
    const config = JSON.parse(stream.config)
    const blobs = `"${stream.name}_blob"`
    const firstRow = db.prepare(`SELECT data FROM ${blobs} ORDER BY id LIMIT 1`).get()
    if (!firstRow) {
        continue
    }
    const first = frameOf(firstRow.data, config.payload_module).frame
    const choice = choices.choiceFor(stream.name)
    const action = decide(first, choice)
    if (action.reason && choice.explicit) {
        console.warn(`warning: ${stream.name}: keeping it as it is (${action.reason})`)
    }
    // Already what was asked for: a jpeg stream asked for jpeg with no quality, or raw for raw.
    const alreadyJpeg = action.kind === "jpeg" && action.passJpeg &&
        config.payload_module === IMAGE && first.compressed && first.codec === "jpeg"
    if (action.kind === "keep" || alreadyJpeg) {
        console.log(`${stream.name}: kept`)
        continue
    }
    const output = action.kind
    const update = db.prepare(`UPDATE ${blobs} SET data = ? WHERE id = ?`)
    const count = db.prepare(`SELECT count(*) AS n FROM ${blobs}`).get().n
    let written = 0
    // Paged by id so a stream never has to fit in memory at once.
    let lastId = -1
    const page = db.prepare(`SELECT id, data FROM ${blobs} WHERE id > ? ORDER BY id LIMIT ?`)
    while (true) {
        const rows = page.all(lastId, pool.capacity)
        if (rows.length === 0) {
            break
        }
        lastId = rows[rows.length - 1].id
        const decoded = rows.map((row) => ({
            id: row.id,
            ...frameOf(row.data, config.payload_module),
        }))
        const jobs = decoded.filter((row) => needsWorker(row.frame, action)).map((row) => ({
            frame: row.frame,
            target: output,
            quality: action.quality,
        }))
        const results = await pool.run(jobs)
        let at = 0
        db.exec("BEGIN")
        for (const row of decoded) {
            let frame = row.frame
            if (needsWorker(row.frame, action)) {
                const out = results[at++]
                if (out.error) {
                    throw new Error(`${stream.name} row ${row.id}: ${out.error}`)
                }
                frame = out.encoding === "jpeg"
                    ? { compressed: true, codec: "jpeg", bytes: out.bytes }
                    : out
            }
            update.run(imageBlob(output, row.message.header, frame), row.id)
        }
        db.exec("COMMIT")
        written += rows.length
    }
    config.payload_module = IMAGE
    config.codec_id = output === "jpeg" ? "jpeg" : "lz4+lcm"
    db.prepare("UPDATE _streams SET config = ? WHERE name = ?").run(
        JSON.stringify(config),
        stream.name,
    )
    console.log(
        `${stream.name}: ${written}/${count} rows -> ${
            output === "jpeg"
                ? `jpeg q${action.quality}${action.passJpeg ? " (jpeg frames passed through)" : ""}`
                : "raw"
        }`,
    )
}
pool.close()
db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
db.exec("VACUUM")
db.close()
console.log(`wrote ${outPath} in ${((performance.now() - started) / 1000).toFixed(0)} s`)
