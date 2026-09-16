#!/usr/bin/env -S deno run --allow-read --allow-write --allow-net --allow-env --allow-ffi --unstable-ffi

// tf_check — report every defect in a recording's tf tree, for a memory2 .db or
// an .mcap. Reads every tf message in the file rather than a window at the
// start, because the defects worth finding are the ones that only show up later:
// an edge that stops halfway, a second parent that appears once.

import { Database } from "jsr:@db/sqlite@0.12"
import { McapIndexedReader } from "https://esm.sh/@mcap/core@2.1.7"
import { decompress as zstdDecompress } from "https://esm.sh/fzstd@0.1.1"
import lz4 from "https://esm.sh/lz4js@0.2.0"

const args = [...Deno.args]
let path = null
let asJson = false
let allStreams = false
for (let index = 0; index < args.length; index++) {
    const argument = args[index]
    if (argument === "-h" || argument === "--help") {
        console.log(`tf_check — report every defect in a recording's tf tree

Usage: tf_check <recording.db|recording.mcap> [--json] [--all-streams]

By default only \`tf\` and \`tf_static\` are read. Another TFMessage stream is a
rival estimate of the same frames rather than more of this tree, so folding it
in would report a second parent for everything; --all-streams does it anyway.

Checks, over the whole recording:
  two parents      a frame published under more than one parent
  cycle            a frame that is its own ancestor
  forest           more than one root, so some frames cannot reach the others
  stops early      an edge that stops being published long before the file ends
  starts late      an edge that only appears long after the file starts
  two answers      an edge published on a static and a dynamic stream, disagreeing
  published once   an edge published exactly once on a dynamic stream

Exits 1 when anything is reported, 0 when the tree is clean.`)
        Deno.exit(0)
    } else if (argument === "--json") {
        asJson = true
    } else if (argument === "--all-streams") {
        allStreams = true
    } else if (path === null) {
        path = argument
    }
}
if (path === null) {
    console.error("usage: tf_check <recording.db|recording.mcap> [--json]")
    Deno.exit(2)
}

// ---------------------------------------------------------------- decoding

const TRANSFORM_STAMP_BYTES = 12
const TRANSFORM_POSE_BYTES = 7 * 8

// LCM TFMessage: fingerprint(8) + count i32, then per transform
// seq + stamp + frame_id + child_frame_id + translation + rotation.
const decodeLcmFrames = (data) => {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    const count = data.length >= 12 ? view.getInt32(8, false) : 0
    let offset = 12
    const readString = () => {
        const length = view.getInt32(offset, false)
        offset += 4
        const bytes = data.slice(offset, offset + length)
        offset += length
        let end = bytes.length
        while (end > 0 && bytes[end - 1] === 0) {
            end--
        }
        return new TextDecoder().decode(bytes.slice(0, end))
    }
    const edges = []
    for (let index = 0; index < count; index++) {
        offset += TRANSFORM_STAMP_BYTES
        if (offset > data.length) {
            break
        }
        const parent = readString()
        const child = readString()
        const pose = []
        for (let at = 0; at < 7; at++) {
            pose.push(view.getFloat64(offset + at * 8, false))
        }
        offset += TRANSFORM_POSE_BYTES
        if (offset > data.length) {
            break
        }
        edges.push({ parent, child, pose })
    }
    return edges
}

// ROS 2 CDR TFMessage. Alignment is measured from the body, after the 4-byte
// encapsulation header; only the frame names are read.
const decodeCdrFrames = (data) => {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    const little = (view.getUint8(1) & 1) === 1
    let at = 4
    const align = (width) => {
        at += (width - ((at - 4) % width)) % width
    }
    const uint32 = () => {
        align(4)
        const value = view.getUint32(at, little)
        at += 4
        return value
    }
    const string = () => {
        const length = uint32()
        const bytes = new Uint8Array(data.buffer, data.byteOffset + at, Math.max(0, length - 1))
        at += length
        return new TextDecoder().decode(bytes)
    }
    const edges = []
    for (let remaining = uint32(); remaining > 0; remaining--) {
        uint32() // stamp.sec
        uint32() // stamp.nanosec
        const parent = string()
        const child = string()
        align(8)
        const pose = []
        for (let index = 0; index < 7; index++) {
            pose.push(view.getFloat64(at + index * 8, little))
        }
        at += TRANSFORM_POSE_BYTES
        if (at > data.byteLength) {
            break
        }
        edges.push({ parent, child, pose })
    }
    return edges
}

// ---------------------------------------------------------------- reading

// edge key -> { parent, child, streams:Set, count, first, last }
const edges = new Map()
let recordingStart = Infinity
let recordingEnd = -Infinity

// Rounded, because the same transform written by two publishers differs in the
// last bits and that is not what this is looking for.
const poseKey = (pose) => pose.map((value) => value.toFixed(6)).join(",")

const note = (parent, child, stream, seconds, pose) => {
    const key = `${parent} -> ${child}`
    let edge = edges.get(key)
    if (edge === undefined) {
        edge = {
            parent,
            child,
            streams: new Set(),
            poses: new Map(),
            count: 0,
            first: Infinity,
            last: -Infinity,
        }
        edges.set(key, edge)
    }
    if (pose !== undefined) {
        edge.poses.set(stream, poseKey(pose))
    }
    edge.streams.add(stream)
    edge.count++
    edge.first = Math.min(edge.first, seconds)
    edge.last = Math.max(edge.last, seconds)
}

const MCAP_MAGIC = new Uint8Array([0x89, 0x4d, 0x43, 0x41, 0x50, 0x30, 0x0d, 0x0a])
const head = new Uint8Array(16)
const probe = Deno.openSync(path, { read: true })
probe.readSync(head)
probe.close()
const isMcap = MCAP_MAGIC.every((byte, at) => head[at] === byte)

const staticStreams = new Set()

// `tf` and `tf_static` are two halves of one tree. Any other TFMessage stream
// (rtab_tf, say) is a rival estimate of the same frames, and folding it in would
// hand every frame a second parent, so it is only used when there is no
// canonical pair at all. --all-streams asks for the merge anyway.
const onlyCanonical = (candidates, nameOf) => {
    if (allStreams) {
        return candidates
    }
    const canonical = candidates.filter((each) => ["tf", "tf_static"].includes(nameOf(each)))
    return canonical.length > 0 ? canonical : candidates
}

if (isMcap) {
    const file = await Deno.open(path, { read: true })
    const size = (await file.stat()).size
    const reader = await McapIndexedReader.Initialize({
        readable: {
            size: async () => BigInt(size),
            read: async (offset, length) => {
                const into = new Uint8Array(Number(length))
                await file.seek(Number(offset), Deno.SeekMode.Start)
                let filled = 0
                while (filled < into.length) {
                    const got = await file.read(into.subarray(filled))
                    if (got === null) {
                        break
                    }
                    filled += got
                }
                return into
            },
        },
        decompressHandlers: {
            zstd: (data, size) => zstdDecompress(data, new Uint8Array(Number(size))),
            lz4: (data, size) => new Uint8Array(lz4.decompress(data, Number(size))),
        },
    })
    const statistics = reader.statistics
    if (statistics) {
        recordingStart = Number(statistics.messageStartTime) / 1e9
        recordingEnd = Number(statistics.messageEndTime) / 1e9
    }
    let tfChannels = []
    for (const channel of reader.channelsById.values()) {
        const schema = reader.schemasById.get(channel.schemaId)
        const name = channel.topic.replace(/^\//, "")
        if ((schema?.name ?? "").includes("TFMessage") || /(^|_)tf(_static)?$/.test(name)) {
            tfChannels.push({ channel, name, cdr: channel.messageEncoding === "cdr" })
        }
    }
    tfChannels = onlyCanonical(tfChannels, (each) => each.name)
    for (const { channel, name, cdr } of tfChannels) {
        if (name.endsWith("_static")) {
            staticStreams.add(name)
        }
        const decode = cdr ? decodeCdrFrames : decodeLcmFrames
        for await (const message of reader.readMessages({ topics: [channel.topic] })) {
            const seconds = Number(message.logTime) / 1e9
            for (const { parent, child, pose } of decode(new Uint8Array(message.data))) {
                note(parent, child, name, seconds, pose)
            }
        }
    }
    file.close()
} else {
    const db = new Database(path, { readonly: true })
    const streamRows = db.prepare("SELECT name, config FROM _streams").all()
    for (const row of streamRows) {
        const range = db.prepare(`SELECT MIN(ts) AS lo, MAX(ts) AS hi FROM "${row.name}"`).get()
        if (range?.lo != null) {
            recordingStart = Math.min(recordingStart, range.lo)
            recordingEnd = Math.max(recordingEnd, range.hi)
        }
    }
    const tfRows = onlyCanonical(
        streamRows.filter((row) => {
            let payload = ""
            try {
                payload = JSON.parse(row.config)?.payload_module ?? ""
            } catch (error) {
                payload = ""
            }
            return payload.split(/[./]/).pop() === "TFMessage" || /(^|_)tf(_static)?$/.test(row.name)
        }),
        (row) => row.name,
    )
    for (const row of tfRows) {
        if (row.name.endsWith("_static")) {
            staticStreams.add(row.name)
        }
        const messages = db.prepare(
            `SELECT s.ts AS ts, b.data AS data FROM "${row.name}" AS s
             JOIN "${row.name}_blob" AS b ON b.id = s.id ORDER BY s.ts`,
        ).all()
        for (const message of messages) {
            for (const { parent, child, pose } of decodeLcmFrames(message.data)) {
                note(parent, child, row.name, message.ts, pose)
            }
        }
    }
    db.close()
}

if (edges.size === 0) {
    console.error(`tf_check: ${path} has no tf messages`)
    Deno.exit(2)
}

// ---------------------------------------------------------------- checks

const span = (recordingEnd > recordingStart) ? (recordingEnd - recordingStart) : 0
const findings = []
const report = (kind, message, detail) => findings.push({ kind, message, ...detail })

const parentsOf = new Map()
const frames = new Set()
for (const edge of edges.values()) {
    frames.add(edge.parent)
    frames.add(edge.child)
    if (!parentsOf.has(edge.child)) {
        parentsOf.set(edge.child, new Set())
    }
    parentsOf.get(edge.child).add(edge.parent)
}

for (const [child, parents] of parentsOf) {
    if (parents.size > 1) {
        report(
            "two parents",
            `"${child}" is published under ${parents.size} parents: ${[...parents].join(", ")}`,
            { frame: child },
        )
    }
}

// a frame that can reach itself by following parents
const inACycle = new Set()
for (const frame of frames) {
    let at = frame
    const seen = new Set([frame])
    for (let step = 0; step < frames.size + 1; step++) {
        const parents = parentsOf.get(at)
        if (parents === undefined || parents.size === 0) {
            break
        }
        at = [...parents][0]
        if (seen.has(at)) {
            if (!inACycle.has(frame)) {
                inACycle.add(frame)
                report("cycle", `"${frame}" is its own ancestor, through "${at}"`, { frame })
            }
            break
        }
        seen.add(at)
    }
}

const roots = [...frames].filter((frame) => !parentsOf.has(frame))
if (roots.length > 1) {
    report("forest", `${roots.length} roots, so these trees never meet: ${roots.join(", ")}`, { roots })
}

for (const [name, edge] of edges) {
    const onlyStatic = [...edge.streams].every((stream) => staticStreams.has(stream))
    const anyStatic = [...edge.streams].some((stream) => staticStreams.has(stream))
    if (anyStatic && !onlyStatic) {
        // Publishing a static edge dynamically as well is deliberate here: dimos
        // does not read tf_static yet, so `dtk data tf add` republishes it on tf.
        // What is worth reporting is the two streams DISAGREEING, which is the
        // case a consumer's tf tree slerps between.
        const answers = new Set(edge.poses.values())
        if (answers.size > 1) {
            report(
                "two answers",
                `${name} is published on ${[...edge.streams].join(" and ")} with different transforms`,
                { edge: name },
            )
        }
        continue
    }
    if (onlyStatic) {
        continue
    }
    if (edge.count === 1) {
        report(
            "published once",
            `${name} is published exactly once, on a dynamic stream — did it mean to be static?`,
            { edge: name },
        )
        continue
    }
    // an edge is published at its own rate; ten missed turns, and at least a
    // second, is a stop rather than jitter
    const interval = (edge.last - edge.first) / (edge.count - 1)
    const tolerance = Math.max(10 * interval, 1)
    if (span > 0 && (recordingEnd - edge.last) > tolerance) {
        report(
            "stops early",
            `${name} stops ${(recordingEnd - edge.last).toFixed(1)}s before the recording ends ` +
            `(it ran at ${(1 / interval).toFixed(1)} Hz)`,
            { edge: name },
        )
    }
    if (span > 0 && (edge.first - recordingStart) > tolerance) {
        report(
            "starts late",
            `${name} only starts ${(edge.first - recordingStart).toFixed(1)}s into the recording`,
            { edge: name },
        )
    }
}

// ---------------------------------------------------------------- output

if (asJson) {
    console.log(JSON.stringify({ path, frames: frames.size, edges: edges.size, findings }, null, 4))
    Deno.exit(findings.length > 0 ? 1 : 0)
}

console.log(`${frames.size} frames, ${edges.size} edges, ${span.toFixed(1)}s of recording`)
if (findings.length === 0) {
    console.log("no problems found")
    Deno.exit(0)
}
console.log("")
const width = Math.max(...findings.map((each) => each.kind.length))
for (const finding of findings) {
    console.log(`${finding.kind.padEnd(width)}  ${finding.message}`)
}
Deno.exit(1)
