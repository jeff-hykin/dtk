#!/usr/bin/env -S deno run --allow-read --allow-write --allow-net --allow-env --allow-ffi --unstable-ffi

// db_tf_rename — rename tf frames inside a dimos memory2 .db, in place.
//
// Only tf is touched. A message whose own header names an old frame still names
// it: LCM packs a string as a length and its bytes with nothing after it to
// realign, so rewriting one inside an arbitrary payload would need that
// payload's type, which this does not have.

import { Database } from "jsr:@db/sqlite@0.12"

const args = [...Deno.args]
let dbPath = null
let prefix = null
let dryRun = false
let assumeYes = false
const renames = new Map()
const exceptions = new Set()

for (let index = 0; index < args.length; index++) {
    const argument = args[index]
    if (argument === "-h" || argument === "--help") {
        console.log(`db_tf_rename — rename tf frames in a dimos memory2 .db, in place

Usage: db_tf_rename <recording.db> [--rename OLD=NEW]... [--namespace PREFIX]
                    [--except FRAME]... [--dry-run] [-y]

Options:
  --rename OLD=NEW   Rename one frame, on either side of an edge (repeatable)
  --namespace PREFIX Prefix every frame name with this
  --except FRAME     Leave this frame alone when --namespace prefixes the rest (repeatable)
  -n, --dry-run      Say what would change, write nothing
  -y, --yes          Skip the confirmation prompt

A frame named by --rename is not also prefixed; the new name is taken as final.
Running --namespace twice prefixes twice — nothing distinguishes a name that was
already prefixed from one that happens to start that way.`)
        Deno.exit(0)
    } else if (argument === "--rename") {
        const pair = args[++index] ?? ""
        if (!pair.includes("=")) {
            console.error(`--rename wants OLD=NEW, got "${pair}"`)
            Deno.exit(1)
        }
        const at = pair.indexOf("=")
        renames.set(pair.slice(0, at), pair.slice(at + 1))
    } else if (argument === "--namespace") {
        prefix = args[++index] ?? null
    } else if (argument === "--except") {
        exceptions.add(args[++index] ?? "")
    } else if (argument === "-n" || argument === "--dry-run") {
        dryRun = true
    } else if (argument === "-y" || argument === "--yes") {
        assumeYes = true
    } else if (dbPath === null) {
        dbPath = argument
    }
}

if (dbPath === null) {
    console.error("error: need <recording.db> (see --help)")
    Deno.exit(1)
}
if (renames.size === 0 && prefix === null) {
    console.error("error: nothing to do — pass --rename or --namespace")
    Deno.exit(1)
}

const renamedFrame = (name) => {
    if (renames.has(name)) {
        return renames.get(name)
    }
    if (prefix !== null && !exceptions.has(name)) {
        return prefix + name
    }
    return name
}

// LCM TFMessage: fingerprint(8) + count i32, then per transform
// seq i32 + stamp i64 + frame_id string + child_frame_id string + 7 doubles.
// LCM is big-endian and packed, so re-encoding is a straight rebuild.
const TRANSFORM_POSE_BYTES = 7 * 8

const decoder = new TextDecoder()
const encoder = new TextEncoder()

const rewrite = (data) => {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    if (data.length < 12) {
        return null
    }
    const count = view.getInt32(8, false)
    let offset = 12
    const pieces = []
    let changed = false
    for (let index = 0; index < count; index++) {
        const headStart = offset
        offset += 12 // seq + stamp
        if (offset > data.length) {
            return null
        }
        const head = data.slice(headStart, offset)
        const names = []
        for (let side = 0; side < 2; side++) {
            const length = view.getInt32(offset, false)
            offset += 4
            if (length < 0 || offset + length > data.length) {
                return null
            }
            const bytes = data.slice(offset, offset + length)
            offset += length
            let end = bytes.length
            while (end > 0 && bytes[end - 1] === 0) {
                end--
            }
            names.push(decoder.decode(bytes.slice(0, end)))
        }
        const poseStart = offset
        offset += TRANSFORM_POSE_BYTES
        if (offset > data.length) {
            return null
        }
        const renamedNames = names.map(renamedFrame)
        if (renamedNames[0] !== names[0] || renamedNames[1] !== names[1]) {
            changed = true
        }
        pieces.push({ head, names: renamedNames, pose: data.slice(poseStart, offset) })
    }
    if (!changed) {
        return null
    }
    const encodedNames = pieces.map((piece) => piece.names.map((name) => encoder.encode(name + "\0")))
    let size = 12
    for (let index = 0; index < pieces.length; index++) {
        size += pieces[index].head.length + TRANSFORM_POSE_BYTES
        for (const raw of encodedNames[index]) {
            size += 4 + raw.length
        }
    }
    const out = new Uint8Array(size)
    const outView = new DataView(out.buffer)
    out.set(data.slice(0, 12), 0)
    let at = 12
    for (let index = 0; index < pieces.length; index++) {
        out.set(pieces[index].head, at)
        at += pieces[index].head.length
        for (const raw of encodedNames[index]) {
            outView.setInt32(at, raw.length, false)
            at += 4
            out.set(raw, at)
            at += raw.length
        }
        out.set(pieces[index].pose, at)
        at += TRANSFORM_POSE_BYTES
    }
    return out
}

const db = new Database(dbPath)

const streamRows = db.prepare("SELECT name, config FROM _streams").all()
const tfStreams = streamRows.filter((row) => {
    let payload = ""
    try {
        payload = JSON.parse(row.config)?.payload_module ?? ""
    } catch (error) {
        payload = ""
    }
    return payload.split(/[./]/).pop() === "TFMessage" || /(^|_)tf(_static)?$/.test(row.name)
}).map((row) => row.name)

if (tfStreams.length === 0) {
    console.error(`error: no TFMessage stream in ${dbPath}`)
    db.close()
    Deno.exit(1)
}

console.log(`${dbPath}: tf streams ${tfStreams.join(", ")}`)
for (const [from, to] of renames) {
    console.log(`  rename tf frame ${from} -> ${to}`)
}
if (prefix !== null) {
    const skipped = [...exceptions].sort().join(", ") || "nothing"
    console.log(`  prefix every tf frame with "${prefix}", except ${skipped}`)
}

const updates = []
const seenFrames = new Set()
for (const stream of tfStreams) {
    const rows = db.prepare(
        `SELECT s.id AS id, b.data AS data FROM "${stream}" AS s
         JOIN "${stream}_blob" AS b ON b.id = s.id`,
    ).all()
    for (const row of rows) {
        const rewritten = rewrite(row.data)
        if (rewritten !== null) {
            updates.push({ stream, id: row.id, data: rewritten })
        }
    }
}

console.log(`  ${updates.length} message(s) to rewrite`)
if (updates.length === 0) {
    console.log("nothing named those frames — the file is unchanged")
    db.close()
    Deno.exit(0)
}

if (dryRun) {
    console.log("dry run — nothing changed")
    db.close()
    Deno.exit(0)
}
if (!assumeYes && !confirm("Rewrite those messages?")) {
    console.log("aborted")
    db.close()
    Deno.exit(0)
}

db.exec("BEGIN")
try {
    for (const update of updates) {
        db.prepare(`UPDATE "${update.stream}_blob" SET data = ? WHERE id = ?`).run(update.data, update.id)
    }
    db.exec("COMMIT")
} catch (error) {
    db.exec("ROLLBACK")
    console.error("failed, rolled back:", error.message)
    db.close()
    Deno.exit(1)
}
db.close()
console.log(`rewrote ${updates.length} message(s)`)
console.log(
    "note: only tf was renamed. A message whose own header names an old frame still names it, " +
    "so check the tree afterwards",
)
