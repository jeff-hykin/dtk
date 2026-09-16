#!/usr/bin/env -S deno run --allow-read --allow-env --allow-ffi --unstable-ffi

import { Database } from "jsr:@db/sqlite@0.12"

// --- CLI ---
const args = [...Deno.args]
let dbPath = null
let seconds = 10
let streamName = null

for (let i = 0; i < args.length; i++) {
    if (args[i] === "-h" || args[i] === "--help") {
        console.log(`db_tree — Print the tf frame tree of a dimos memory2 .db recording

Usage: db_tree <recording.db> [--seconds N] [--stream NAME]

Reads the tf stream, accumulates every parent->child transform seen within
the first N seconds of the recording's own timeline (default 10), then prints
an ascii tree of the resulting transform frames.`)
        Deno.exit(0)
    }
    else if (args[i] === "--seconds" || args[i] === "-s") { seconds = Number(args[++i]) }
    else if (args[i] === "--stream") { streamName = args[++i] }
    else if (!dbPath) { dbPath = args[i] }
}

if (!dbPath) { console.error("Usage: db_tree <recording.db> [--seconds N] [--stream NAME]"); Deno.exit(1) }
if (!Number.isFinite(seconds) || seconds <= 0) { console.error("--seconds must be a positive number"); Deno.exit(1) }

// --- Locate the tf stream ---
const db = new Database(dbPath, { readonly: true })

const streamRows = db.prepare("SELECT name, config FROM _streams").all()
if (!streamName) {
    for (const row of streamRows) {
        const config = JSON.parse(row.config)
        const type = config.payload_module?.split(".").pop() ?? ""
        if (type === "TFMessage" || row.name === "tf") { streamName = row.name; break }
    }
}
if (!streamName) { console.error("No TFMessage / tf stream found in this recording"); Deno.exit(1) }

// --- Decode an LCM-encoded TFMessage, which may carry several transforms ---
// Layout: fingerprint(8) + transforms_len i32(4), then per transform:
//         seq i32(4) + stamp i64(8) + frame_id string + child_frame_id string
//         + translation 3xf64 + rotation 4xf64
//         (each string: i32 length incl null terminator, then that many bytes)
const TRANSFORM_STAMP_BYTES = 12
const TRANSFORM_POSE_BYTES = 7 * 8
function decodeFrames(data) {
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength)
    // Empty TFMessages (transforms_len == 0) are only 12 bytes: fingerprint(8) + count(4)
    const transformsLength = data.length >= 12 ? dv.getInt32(8, false) : 0
    let offset = 12
    const readString = () => {
        const length = dv.getInt32(offset, false)
        offset += 4
        const bytes = data.slice(offset, offset + length)
        offset += length
        let end = bytes.length
        while (end > 0 && bytes[end - 1] === 0) { end-- }
        return new TextDecoder().decode(bytes.slice(0, end))
    }
    const edges = []
    for (let index = 0; index < transformsLength; index++) {
        offset += TRANSFORM_STAMP_BYTES
        if (offset > data.length) { break }
        const parent = readString()
        const child = readString()
        offset += TRANSFORM_POSE_BYTES
        if (offset > data.length) { break }
        edges.push({ parent, child })
    }
    return edges
}

// --- Accumulate edges within the time window ---
const range = db.prepare(`SELECT MIN(ts) AS minTs, MAX(ts) AS maxTs FROM "${streamName}"`).get()
if (range.minTs == null) { console.error(`Stream "${streamName}" has no rows`); Deno.exit(1) }
const startTs = range.minTs
const endTs = startTs + seconds

const rows = db.prepare(
    `SELECT b.data AS data
     FROM "${streamName}" AS s
     JOIN "${streamName}_blob" AS b ON b.id = s.id
     WHERE s.ts >= ? AND s.ts <= ?`
).all(startTs, endTs)

db.close()

const childrenOf = new Map()   // parent -> Set(children)
const allFrames = new Set()
const childFrames = new Set()

for (const row of rows) {
    for (const { parent, child } of decodeFrames(row.data)) {
        if (!childrenOf.has(parent)) { childrenOf.set(parent, new Set()) }
        childrenOf.get(parent).add(child)
        allFrames.add(parent)
        allFrames.add(child)
        childFrames.add(child)
    }
}

// --- Determine roots (frames that are never anyone's child) ---
const roots = [...allFrames].filter(frame => !childFrames.has(frame)).sort()

// --- Render ascii tree ---
const lines = []
function renderRoot(root) {
    lines.push(root)
    const kids = [...(childrenOf.get(root) ?? [])].sort()
    kids.forEach((kid, index) => {
        renderChild(kid, "", index === kids.length - 1, new Set([root]))
    })
}
function renderChild(frame, prefix, isLast, onPath) {
    const cycle = onPath.has(frame)
    lines.push(`${prefix}${isLast ? "└── " : "├── "}${frame}${cycle ? "  (cycle)" : ""}`)
    if (cycle) { return }
    const nextOnPath = new Set(onPath).add(frame)
    const kids = [...(childrenOf.get(frame) ?? [])].sort()
    const childPrefix = prefix + (isLast ? "    " : "│   ")
    kids.forEach((kid, index) => {
        renderChild(kid, childPrefix, index === kids.length - 1, nextOnPath)
    })
}

console.log(`${dbPath}`)
console.log(`stream: ${streamName}  |  window: first ${seconds}s (${rows.length} transform msgs)\n`)

if (roots.length === 0) {
    console.log("(no tf frames found in this window)")
} else {
    for (const root of roots) { renderRoot(root) }
    console.log(lines.join("\n"))
}
