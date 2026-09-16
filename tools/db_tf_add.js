#!/usr/bin/env -S deno run --allow-read --allow-write --allow-net --allow-env --allow-ffi --unstable-ffi

// db_tf_add — add tf edges to a dimos memory2 .db, in place.
//
// A static edge goes on `tf_static`, the way ROS 2 does it, AND is republished
// on `tf` about every 0.45 s, because dimos does not read tf_static yet. A
// dynamic edge rides along on every `tf` message there already is, so it arrives
// at whatever rate the recording already publishes tf at, without inventing
// messages that were never sent.

import { Database } from "jsr:@db/sqlite@0.12"

const STATIC_REPUBLISH_SECONDS = 0.45

// dimos.msgs.tf2_msgs.TFMessage.TFMessage, taken from a recorded message. Only
// used when a recording has no tf of its own to copy it from.
const DEFAULT_FINGERPRINT = new Uint8Array([0xc2, 0xb8, 0xa1, 0xc3, 0x3a, 0x89, 0x23, 0xec])

const STREAM_CONFIG = JSON.stringify({
    payload_module: "dimos.msgs.tf2_msgs.TFMessage.TFMessage",
    codec_id: "lcm",
    eager_blobs: false,
    page_size: 256,
    blob_store: {
        class: "dimos.memory2.blobstore.sqlite.SqliteBlobStore",
        config: { path: null },
    },
    vector_store: {
        class: "dimos.memory2.vectorstore.sqlite.SqliteVectorStore",
        config: { path: null },
    },
    notifier: {
        class: "dimos.memory2.notifier.subject.SubjectNotifier",
        config: {},
    },
})

const args = [...Deno.args]
let dbPath = null
let json = null
let dryRun = false
let assumeYes = false

for (let index = 0; index < args.length; index++) {
    const argument = args[index]
    if (argument === "-h" || argument === "--help") {
        console.log(`db_tf_add — add tf edges to a dimos memory2 .db, in place

Usage: db_tf_add <recording.db> '<json>' [--dry-run] [-y]

The json is one edge or a list of them:

  [
      {
          "parent": "base_link",
          "child": "lidar_link",
          "translation": [0.1, 0.0, 0.2],
          "rotation": [0.0, 0.0, 0.0, 1.0],
          "static": true
      }
  ]

translation defaults to [0,0,0] and rotation to [0,0,0,1] (x,y,z,w, as ROS 2
orders it). Either may also be given as {"x":..,"y":..,"z":..[,"w":..]}.

A static edge is written to tf_static and republished on tf about every
${STATIC_REPUBLISH_SECONDS}s. A dynamic edge is added to every tf message already in the file.

Options:
  -n, --dry-run   Say what would change, write nothing
  -y, --yes       Skip the confirmation prompt`)
        Deno.exit(0)
    } else if (argument === "-n" || argument === "--dry-run") {
        dryRun = true
    } else if (argument === "-y" || argument === "--yes") {
        assumeYes = true
    } else if (dbPath === null) {
        dbPath = argument
    } else if (json === null) {
        json = argument
    }
}

if (dbPath === null || json === null) {
    console.error("error: need <recording.db> and the json (see --help)")
    Deno.exit(1)
}

const asThree = (value, fallback) => {
    if (value === undefined || value === null) {
        return fallback
    }
    if (Array.isArray(value)) {
        return fallback.map((each, at) => (value[at] === undefined ? each : Number(value[at])))
    }
    const keys = fallback.length === 3 ? ["x", "y", "z"] : ["x", "y", "z", "w"]
    return keys.map((key, at) => (value[key] === undefined ? fallback[at] : Number(value[key])))
}

let edges = null
try {
    const parsed = JSON.parse(json)
    edges = (Array.isArray(parsed) ? parsed : [parsed]).map((each) => {
        if (!each.parent || !each.child) {
            throw new Error("every edge needs a parent and a child")
        }
        return {
            parent: String(each.parent),
            child: String(each.child),
            pose: [
                ...asThree(each.translation, [0, 0, 0]),
                ...asThree(each.rotation, [0, 0, 0, 1]),
            ],
            isStatic: each.static === true,
        }
    })
} catch (error) {
    console.error(`error: could not read the json — ${error.message}`)
    Deno.exit(1)
}
if (edges.length === 0) {
    console.error("error: no edges given")
    Deno.exit(1)
}

// ---------------------------------------------------------------- lcm

const decoder = new TextDecoder()
const encoder = new TextEncoder()

const readMessage = (data) => {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    const count = data.length >= 12 ? view.getInt32(8, false) : 0
    let offset = 12
    const transforms = []
    for (let index = 0; index < count; index++) {
        const seq = view.getInt32(offset, false)
        const seconds = view.getInt32(offset + 4, false)
        const nanoseconds = view.getUint32(offset + 8, false)
        offset += 12
        const names = []
        for (let side = 0; side < 2; side++) {
            const length = view.getInt32(offset, false)
            offset += 4
            const bytes = data.slice(offset, offset + length)
            offset += length
            let end = bytes.length
            while (end > 0 && bytes[end - 1] === 0) {
                end--
            }
            names.push(decoder.decode(bytes.slice(0, end)))
        }
        const pose = []
        for (let at = 0; at < 7; at++) {
            pose.push(view.getFloat64(offset, false))
            offset += 8
        }
        transforms.push({ seq, seconds, nanoseconds, parent: names[0], child: names[1], pose })
    }
    return { fingerprint: data.slice(0, 8), transforms }
}

const writeMessage = (fingerprint, transforms) => {
    const encodedNames = transforms.map((each) => [
        encoder.encode(each.parent + "\0"),
        encoder.encode(each.child + "\0"),
    ])
    let size = 12
    for (const pair of encodedNames) {
        size += 12 + 56 + 4 + pair[0].length + 4 + pair[1].length
    }
    const out = new Uint8Array(size)
    const view = new DataView(out.buffer)
    out.set(fingerprint, 0)
    view.setInt32(8, transforms.length, false)
    let at = 12
    for (let index = 0; index < transforms.length; index++) {
        const transform = transforms[index]
        view.setInt32(at, transform.seq, false)
        view.setInt32(at + 4, transform.seconds, false)
        view.setUint32(at + 8, transform.nanoseconds, false)
        at += 12
        for (const raw of encodedNames[index]) {
            view.setInt32(at, raw.length, false)
            at += 4
            out.set(raw, at)
            at += raw.length
        }
        for (const value of transform.pose) {
            view.setFloat64(at, value, false)
            at += 8
        }
    }
    return out
}

const stampFor = (seconds) => ({
    seconds: Math.floor(seconds),
    nanoseconds: Math.round((seconds - Math.floor(seconds)) * 1e9),
})

// ---------------------------------------------------------------- the file

const db = new Database(dbPath)

const streamNames = db.prepare("SELECT name, config FROM _streams").all()
const isTfStream = (row) => {
    let payload = ""
    try {
        payload = JSON.parse(row.config)?.payload_module ?? ""
    } catch (error) {
        payload = ""
    }
    return payload.split(/[./]/).pop() === "TFMessage" || /(^|_)tf(_static)?$/.test(row.name)
}
const tfStreams = streamNames.filter(isTfStream).map((row) => row.name)
const dynamicStream = tfStreams.includes("tf") ? "tf" : tfStreams.find((each) => !each.endsWith("_static")) ?? null
const staticStream = tfStreams.includes("tf_static") ? "tf_static" : null

let recordingStart = Infinity
let recordingEnd = -Infinity
for (const row of streamNames) {
    const range = db.prepare(`SELECT MIN(ts) AS lo, MAX(ts) AS hi FROM "${row.name}"`).get()
    if (range?.lo != null) {
        recordingStart = Math.min(recordingStart, range.lo)
        recordingEnd = Math.max(recordingEnd, range.hi)
    }
}
if (!Number.isFinite(recordingStart)) {
    console.error(`error: ${dbPath} has no messages at all`)
    db.close()
    Deno.exit(1)
}

const dynamicEdges = edges.filter((each) => !each.isStatic)
const staticEdges = edges.filter((each) => each.isStatic)

console.log(`${dbPath}`)
for (const edge of edges) {
    const kind = edge.isStatic ? "static" : "dynamic"
    console.log(`  add ${kind} ${edge.parent} -> ${edge.child}  ${edge.pose.map((n) => n.toFixed(4)).join(", ")}`)
}

const createStream = (name) => {
    db.exec(`CREATE TABLE "${name}" (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        ts      REAL    NOT NULL,
        value   NUMERIC,
        pose_x  REAL, pose_y REAL, pose_z REAL,
        pose_qx REAL, pose_qy REAL, pose_qz REAL, pose_qw REAL,
        tags    BLOB    DEFAULT (jsonb('{}')))`)
    db.exec(`CREATE TABLE "${name}_blob" (id INTEGER PRIMARY KEY, data BLOB NOT NULL)`)
    db.exec(`CREATE VIRTUAL TABLE "${name}_rtree" USING rtree(
        id, x_min, x_max, y_min, y_max, z_min, z_max)`)
    db.prepare("INSERT INTO _streams (name, config) VALUES (?, ?)").run(name, STREAM_CONFIG)
}

const appendMessage = (name, seconds, data) => {
    const row = db.prepare(`INSERT INTO "${name}" (ts) VALUES (?) RETURNING id`).get(seconds)
    db.prepare(`INSERT INTO "${name}_blob" (id, data) VALUES (?, ?)`).run(row.id, data)
}

// The fingerprint has to match what the rest of the file uses, so it is copied
// from a message already there; the constant is only for a file with no tf yet.
let fingerprint = DEFAULT_FINGERPRINT
let borrowedFrom = "the built-in TFMessage fingerprint"
for (const stream of tfStreams) {
    const row = db.prepare(
        `SELECT b.data AS data FROM "${stream}" AS s JOIN "${stream}_blob" AS b ON b.id = s.id LIMIT 1`,
    ).get()
    if (row) {
        fingerprint = row.data.slice(0, 8)
        borrowedFrom = `${stream}`
        break
    }
}
console.log(`  fingerprint from ${borrowedFrom}`)

const plan = []

if (dynamicEdges.length > 0 || staticEdges.length > 0) {
    if (dynamicStream !== null) {
        const rows = db.prepare(
            `SELECT s.id AS id, s.ts AS ts, b.data AS data FROM "${dynamicStream}" AS s
             JOIN "${dynamicStream}_blob" AS b ON b.id = s.id ORDER BY s.ts`,
        ).all()
        let lastStaticAt = -Infinity
        for (const row of rows) {
            const message = readMessage(row.data)
            const stamp = stampFor(row.ts)
            const adding = [...dynamicEdges]
            if (staticEdges.length > 0 && (row.ts - lastStaticAt) >= STATIC_REPUBLISH_SECONDS) {
                adding.push(...staticEdges)
                lastStaticAt = row.ts
            }
            if (adding.length === 0) {
                continue
            }
            const transforms = [
                ...message.transforms,
                ...adding.map((edge) => ({
                    seq: 0,
                    seconds: stamp.seconds,
                    nanoseconds: stamp.nanoseconds,
                    parent: edge.parent,
                    child: edge.child,
                    pose: edge.pose,
                })),
            ]
            plan.push({
                kind: "update",
                stream: dynamicStream,
                id: row.id,
                data: writeMessage(message.fingerprint, transforms),
            })
        }
        console.log(`  ${plan.length} message(s) on "${dynamicStream}" gain a transform`)
    } else {
        // Nothing to ride along on, so the messages have to be made.
        const step = STATIC_REPUBLISH_SECONDS
        const all = [...dynamicEdges, ...staticEdges]
        let count = 0
        for (let seconds = recordingStart; seconds <= recordingEnd; seconds += step) {
            const stamp = stampFor(seconds)
            plan.push({
                kind: "insert",
                stream: "tf",
                createStream: count === 0,
                ts: seconds,
                data: writeMessage(fingerprint, all.map((edge) => ({
                    seq: 0,
                    seconds: stamp.seconds,
                    nanoseconds: stamp.nanoseconds,
                    parent: edge.parent,
                    child: edge.child,
                    pose: edge.pose,
                }))),
            })
            count++
        }
        console.log(`  no tf stream here, so "tf" is created with ${count} message(s) at ${step}s`)
    }
}

if (staticEdges.length > 0) {
    const stamp = stampFor(recordingStart)
    plan.push({
        kind: "insert",
        stream: "tf_static",
        createStream: staticStream === null,
        ts: recordingStart,
        data: writeMessage(fingerprint, staticEdges.map((edge) => ({
            seq: 0,
            seconds: stamp.seconds,
            nanoseconds: stamp.nanoseconds,
            parent: edge.parent,
            child: edge.child,
            pose: edge.pose,
        }))),
    })
    console.log(`  1 message on "tf_static"${staticStream === null ? " (created)" : ""}`)
}

if (dryRun) {
    console.log("dry run — nothing changed")
    db.close()
    Deno.exit(0)
}
if (!assumeYes && !confirm("Write these edges?")) {
    console.log("aborted")
    db.close()
    Deno.exit(0)
}

db.exec("BEGIN")
try {
    for (const step of plan) {
        if (step.kind === "update") {
            db.prepare(`UPDATE "${step.stream}_blob" SET data = ? WHERE id = ?`).run(step.data, step.id)
        } else {
            if (step.createStream) {
                createStream(step.stream)
            }
            appendMessage(step.stream, step.ts, step.data)
        }
    }
    db.exec("COMMIT")
} catch (error) {
    db.exec("ROLLBACK")
    console.error("failed, rolled back:", error.message)
    db.close()
    Deno.exit(1)
}
db.close()
console.log(`wrote ${plan.length} change(s)`)
