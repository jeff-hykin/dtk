#!/usr/bin/env -S deno run --allow-read --allow-write --allow-net --allow-env --allow-ffi --unstable-ffi

// db_frame_rename — rename the frame one stream's messages name (header.frame_id
// and/or child_frame_id) in a dimos memory2 .db, in place.
//
// The message is decoded and rebuilt, not byte-replaced: an LCM string is an
// int32 big-endian length (counting a trailing NUL) and its bytes, so a new name
// of a different length moves everything after it. LCM writes fields in
// declaration order, and in every dimos_lcm type with a header the only fields
// before it are array lengths (int32 each), so the header's frame_id sits at
// fingerprint(8) + 4 x leading lengths + seq(4) + stamp(8). The two types with a
// child_frame_id put it straight after the header. Only those strings are parsed;
// the rest is carried over untouched.

import { Database } from "jsr:@db/sqlite@0.12"

// int32 array lengths before the header, per dimos_lcm type (read off each
// class's __slots__); a type missing here is refused rather than guessed at
const LENGTHS_BEFORE_HEADER = {
    AccelStamped: 0,
    AccelWithCovarianceStamped: 0,
    BatteryState: 2,
    BoundingBox2DArray: 1,
    BoundingBox3DArray: 1,
    CameraInfo: 1,
    Classification: 1,
    CompressedImage: 1,
    Detection2D: 1,
    Detection2DArray: 1,
    Detection3D: 1,
    Detection3DArray: 1,
    DiagnosticArray: 1,
    DisparityImage: 0,
    FluidPressure: 0,
    GoalStatusArray: 1,
    GridCells: 1,
    Illuminance: 0,
    Image: 1,
    ImageMarker: 2,
    Imu: 0,
    InertiaStamped: 0,
    InteractiveMarker: 2,
    InteractiveMarkerFeedback: 0,
    InteractiveMarkerPose: 0,
    JointState: 4,
    JointTrajectory: 2,
    Joy: 2,
    LabelInfo: 1,
    LaserScan: 2,
    MagneticField: 0,
    Marker: 2,
    MultiDOFJointState: 4,
    MultiDOFJointTrajectory: 2,
    MultiEchoLaserScan: 2,
    NavSatFix: 0,
    OccupancyGrid: 1,
    Odometry: 0,
    Path: 1,
    PointCloud: 2,
    PointCloud2: 2,
    PointStamped: 0,
    PolygonStamped: 0,
    PoseArray: 1,
    PoseStamped: 0,
    PoseWithCovarianceStamped: 0,
    QuaternionStamped: 0,
    Range: 0,
    RelativeHumidity: 0,
    Temperature: 0,
    TimeReference: 0,
    TransformStamped: 0,
    TwistStamped: 0,
    TwistWithCovarianceStamped: 0,
    Vector3Stamped: 0,
    VisionInfo: 0,
    WrenchStamped: 0,
}
// types whose field after the header is child_frame_id
const CHILD_FRAME_TYPES = new Set(["Odometry", "TransformStamped"])

const args = [...Deno.args]
let dbPath = null
let stream = null
let headerRename = null
let childRename = null
let dryRun = false
let assumeYes = false

const parsePair = (flag, text) => {
    const at = text.includes("=") ? text.indexOf("=") : text.indexOf(":")
    if (at <= 0 || at === text.length - 1) {
        console.error(`error: ${flag} wants OLD=NEW (or OLD:NEW), got "${text}"`)
        Deno.exit(1)
    }
    const pair = { from: text.slice(0, at), to: text.slice(at + 1) }
    if (pair.from === pair.to) {
        console.error(`error: ${flag} renames "${pair.from}" to itself`)
        Deno.exit(1)
    }
    return pair
}

for (let index = 0; index < args.length; index++) {
    const argument = args[index]
    if (argument === "-h" || argument === "--help") {
        console.log(
            `db_frame_rename — rename the frame a stream's messages name, in a memory2 .db, in place

Usage: db_frame_rename <recording.db> <stream> [--header OLD=NEW] [--child OLD=NEW] [-n] [-y]

Options:
  --header OLD=NEW   Rename header.frame_id where it is OLD
  --child OLD=NEW    Rename child_frame_id where it is OLD (Odometry, TransformStamped)
  -n, --dry-run      Say what would change, write nothing
  -y, --yes          Skip the confirmation prompt

OLD:NEW is accepted too. The rows it rewrites are first copied to
<recording>.<stream>_blob.pre_frame_rename.db next to the recording (a numbered
name if that exists), so the change can be undone. Refuses when no message names
OLD. tf is not touched; use \`dtk data tf rename\` for that.`,
        )
        Deno.exit(0)
    } else if (argument === "--header") {
        headerRename = parsePair("--header", args[++index] ?? "")
    } else if (argument === "--child") {
        childRename = parsePair("--child", args[++index] ?? "")
    } else if (argument === "-n" || argument === "--dry-run") {
        dryRun = true
    } else if (argument === "-y" || argument === "--yes") {
        assumeYes = true
    } else if (argument.startsWith("-")) {
        console.error(`error: unknown option ${argument} (see --help)`)
        Deno.exit(1)
    } else if (dbPath === null) {
        dbPath = argument
    } else if (stream === null) {
        stream = argument
    } else {
        console.error(`error: unexpected argument "${argument}" (see --help)`)
        Deno.exit(1)
    }
}

if (dbPath === null || stream === null) {
    console.error("error: need <recording.db> <stream> (see --help)")
    Deno.exit(1)
}
if (headerRename === null && childRename === null) {
    console.error("error: nothing to do — pass --header OLD=NEW and/or --child OLD=NEW")
    Deno.exit(1)
}

const decoder = new TextDecoder()
const encoder = new TextEncoder()
let headerFrameOffset = null // set once the stream's type is known

// [name, end offset] of the LCM string at offset, or null if it isn't one
const readString = (data, view, offset) => {
    if (offset + 4 > data.length) {
        return null
    }
    const length = view.getInt32(offset, false)
    const start = offset + 4
    if (length < 1 || start + length > data.length || data[start + length - 1] !== 0) {
        return null
    }
    return [decoder.decode(data.subarray(start, start + length - 1)), start + length]
}

const encodeString = (name) => {
    const bytes = encoder.encode(name + "\0")
    const out = new Uint8Array(4 + bytes.length)
    new DataView(out.buffer).setInt32(0, bytes.length, false)
    out.set(bytes, 4)
    return out
}

// { data, frame, child } with the renames applied, or null when nothing changed
const rewrite = (data, hasChild) => {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    const header = readString(data, view, headerFrameOffset)
    if (header === null) {
        throw new Error("no frame_id string where the header should be")
    }
    let [frame, end] = header
    const strings = [frame]
    if (hasChild) {
        const child = readString(data, view, end)
        if (child === null) {
            throw new Error("no child_frame_id after the header")
        }
        strings.push(child[0])
        end = child[1]
    }
    const renamed = [...strings]
    if (headerRename !== null && strings[0] === headerRename.from) {
        renamed[0] = headerRename.to
    }
    if (childRename !== null && hasChild && strings[1] === childRename.from) {
        renamed[1] = childRename.to
    }
    if (renamed.every((name, index) => name === strings[index])) {
        return null
    }
    const pieces = [
        data.subarray(0, headerFrameOffset),
        ...renamed.map(encodeString),
        data.subarray(end),
    ]
    const out = new Uint8Array(pieces.reduce((total, piece) => total + piece.length, 0))
    let at = 0
    for (const piece of pieces) {
        out.set(piece, at)
        at += piece.length
    }
    return { data: out, before: strings, after: renamed }
}

const db = new Database(dbPath)
const fail = (message) => {
    console.error(message)
    db.close()
    Deno.exit(1)
}

const streamRow = db.prepare("SELECT name, config FROM _streams WHERE name = ?").get(stream)
if (!streamRow) {
    const names = db.prepare("SELECT name FROM _streams ORDER BY name").all().map((row) => row.name)
    fail(`error: no stream "${stream}" in ${dbPath}\navailable: ${names.join(", ")}`)
}
let config = {}
try {
    config = JSON.parse(streamRow.config) ?? {}
} catch (error) {
    config = {}
}
const codec = config.codec_id ?? "lcm"
if (codec !== "lcm") {
    fail(`error: stream "${stream}" is stored as ${codec}; db_frame_rename only handles plain lcm`)
}
const typeName = (config.payload_module ?? "").split(/[./]/).pop()
const hasChild = CHILD_FRAME_TYPES.has(typeName)
if (childRename !== null && !hasChild) {
    fail(
        `error: "${stream}" holds ${
            typeName || "an unknown type"
        }, which has no child_frame_id (only ${[...CHILD_FRAME_TYPES].join(", ")})`,
    )
}
if (typeName === "TFMessage") {
    fail(`error: "${stream}" is tf; use \`dtk data tf rename\``)
}
if (!(typeName in LENGTHS_BEFORE_HEADER)) {
    fail(
        `error: "${stream}" holds ${
            typeName || "an unknown type"
        }, which has no header this knows the place of`,
    )
}
headerFrameOffset = 8 + 4 * LENGTHS_BEFORE_HEADER[typeName] + 4 + 8

const blobTable = `${stream}_blob`
const ids = db.prepare(`SELECT id FROM "${blobTable}" ORDER BY id`).all().map((row) => row.id)
const readBlob = db.prepare(`SELECT data FROM "${blobTable}" WHERE id = ?`)

// first pass only counts, so a refusal or a dry run holds no rewritten blobs
const seen = new Map()
let changing = 0
for (const id of ids) {
    let result
    try {
        result = rewrite(readBlob.get(id).data, hasChild)
    } catch (error) {
        fail(`error: message ${id} of "${stream}" (${typeName}): ${error.message}; nothing changed`)
    }
    if (result !== null) {
        changing++
        const key = `${result.before.join(" / ")}  ->  ${result.after.join(" / ")}`
        seen.set(key, (seen.get(key) ?? 0) + 1)
    }
}

const label = hasChild ? "frame_id / child_frame_id" : "frame_id"
console.log(`${dbPath}: stream "${stream}" (${typeName}), ${ids.length} message(s)`)
if (headerRename !== null) {
    console.log(`  header.frame_id  ${headerRename.from} -> ${headerRename.to}`)
}
if (childRename !== null) {
    console.log(`  child_frame_id   ${childRename.from} -> ${childRename.to}`)
}
for (const [key, count] of seen) {
    console.log(`  ${count} x ${label}: ${key}`)
}
if (changing === 0) {
    const names = new Set()
    for (const id of ids.slice(0, 50)) {
        const view = readBlob.get(id).data
        const dataView = new DataView(view.buffer, view.byteOffset, view.byteLength)
        const header = readString(view, dataView, headerFrameOffset)
        const child = hasChild ? readString(view, dataView, header[1]) : null
        names.add(child ? `${header[0]} / ${child[0]}` : header[0])
    }
    fail(
        `error: no message names the old frame; nothing changed\n  ${label} seen: ${
            [...names].join(", ") || "(no messages)"
        }`,
    )
}
console.log(`  ${changing} message(s) to rewrite`)

if (dryRun) {
    console.log("dry run — nothing changed")
    db.close()
    Deno.exit(0)
}
if (!assumeYes && !confirm("Rewrite those messages?")) {
    fail("aborted: nothing was changed (pass -y to skip the question)")
}

const base = dbPath.replace(/\.db$/, "")
let backupPath = `${base}.${blobTable}.pre_frame_rename.db`
for (let number = 2; await Deno.stat(backupPath).then(() => true, () => false); number++) {
    backupPath = `${base}.${blobTable}.pre_frame_rename.${number}.db`
}
const backup = new Database(backupPath)
backup.exec(`CREATE TABLE "${blobTable}" (id INTEGER PRIMARY KEY, data BLOB NOT NULL)`)
backup.exec("CREATE TABLE _about (key TEXT PRIMARY KEY, value TEXT)")
const about = backup.prepare("INSERT INTO _about (key, value) VALUES (?, ?)")
about.run("recording", dbPath)
about.run("stream", stream)
about.run("header", headerRename ? `${headerRename.from}=${headerRename.to}` : "")
about.run("child", childRename ? `${childRename.from}=${childRename.to}` : "")
about.run("at", new Date().toISOString())
about.run(
    "restore",
    `ATTACH '${backupPath}' AS b; UPDATE "${blobTable}" SET data = (SELECT data FROM b."${blobTable}" AS o WHERE o.id = "${blobTable}".id) WHERE id IN (SELECT id FROM b."${blobTable}")`,
)

const keep = backup.prepare(`INSERT INTO "${blobTable}" (id, data) VALUES (?, ?)`)
const write = db.prepare(`UPDATE "${blobTable}" SET data = ? WHERE id = ?`)
backup.exec("BEGIN")
db.exec("BEGIN")
let rewritten = 0
try {
    for (const id of ids) {
        const original = readBlob.get(id).data
        const result = rewrite(original, hasChild)
        if (result === null) {
            continue
        }
        keep.run(id, original)
        write.run(result.data, id)
        rewritten++
    }
    backup.exec("COMMIT")
    db.exec("COMMIT")
} catch (error) {
    db.exec("ROLLBACK")
    backup.exec("ROLLBACK")
    backup.close()
    await Deno.remove(backupPath).catch(() => {})
    fail(`failed, rolled back: ${error.message}`)
}
backup.close()
db.close()
console.log(`rewrote ${rewritten} message(s) of "${stream}"`)
console.log(`backup of the original rows: ${backupPath}`)
console.log("note: tf is unchanged; check it still agrees (`dtk data tf full_check`)")
