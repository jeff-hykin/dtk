#!/usr/bin/env -S deno run --allow-read --allow-write --allow-net --allow-env --allow-ffi --unstable-ffi

// db_tf_reroot — make the lidar the odometry child in a dimos memory2 .db, in place.
//
//   before: odom -> base_link -> ... -> lidar        after: odom -> lidar -> base_link -> ...
//
// The static chain base_link -> ... -> lidar is composed into one mount. The
// edge that hung the lidar off that chain becomes lidar -> base_link (the
// mount's inverse), published wherever and however often the old edge was, so
// every other frame keeps its place under base_link. odom -> lidar comes from
// one odometry source: pointlio_odometry when it has messages, else the
// odom -> base_link edge already on tf. A stream's poses are written at that
// stream's own timestamps, and the old odom -> base_link messages are dropped.
//
// What a pose describes is taken from the stream's child_frame_id unless
// --pose-of says otherwise, because recordings exist whose odometry calls the
// lidar's pose base_link.

import { Database } from "jsr:@db/sqlite@0.12"

const args = [...Deno.args]
let dbPath = null
let lidarFrame = "mid360_link"
let baseFrame = "base_link"
let source = "auto"
let poseOf = null
let dryRun = false
let assumeYes = false

for (let index = 0; index < args.length; index++) {
    const argument = args[index]
    if (argument === "-h" || argument === "--help") {
        console.log(`db_tf_reroot — make the lidar the odometry child in a dimos memory2 .db, in place

Usage: db_tf_reroot <recording.db> [--lidar FRAME] [--base FRAME]
                    [--odometry auto|tf|STREAM] [--pose-of FRAME] [--dry-run] [-y]

  odom -> base_link -> ... -> lidar   becomes   odom -> lidar -> base_link -> ...

Options:
  --lidar FRAME       The lidar frame (default mid360_link)
  --base FRAME        The body frame (default base_link)
  --odometry SOURCE   What drives odom -> lidar. auto (default) is pointlio_odometry when
                      it has messages, else tf: the odom -> base_link edge already there.
                      A stream's poses are written at its own row timestamps.
  --pose-of FRAME     The frame the source's poses really are: the lidar or the base.
                      Defaults to the stream's child_frame_id (base for tf). A pose of the
                      base is composed with the base -> lidar mount; a lidar pose is used as is.
  -n, --dry-run       Say what would change, write nothing
  -y, --yes           Skip the confirmation prompt

Every edge on the base -> lidar chain has to be constant, or nothing is written.
A tree already rooted this way is left alone.`)
        Deno.exit(0)
    } else if (argument === "--lidar") {
        lidarFrame = args[++index]
    } else if (argument === "--base") {
        baseFrame = args[++index]
    } else if (argument === "--odometry") {
        source = args[++index]
    } else if (argument === "--pose-of") {
        poseOf = args[++index]
    } else if (argument === "-n" || argument === "--dry-run") {
        dryRun = true
    } else if (argument === "-y" || argument === "--yes") {
        assumeYes = true
    } else if (dbPath === null) {
        dbPath = argument
    } else {
        console.error(`error: unexpected argument "${argument}" (see --help)`)
        Deno.exit(1)
    }
}

if (dbPath === null) {
    console.error("error: need <recording.db> (see --help)")
    Deno.exit(1)
}

const fail = (message) => {
    console.error(`error: ${message}`)
    Deno.exit(1)
}

// ---------------------------------------------------------------- poses
// A pose is [x, y, z, qx, qy, qz, qw]: the child's place in the parent.

const quaternionMultiply = ([ax, ay, az, aw], [bx, by, bz, bw]) => [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
]

const conjugate = ([x, y, z, w]) => [-x, -y, -z, w]

const rotate = (quaternion, [x, y, z]) => {
    const [rx, ry, rz] = quaternionMultiply(quaternionMultiply(quaternion, [x, y, z, 0]), conjugate(quaternion))
    return [rx, ry, rz]
}

const normalize = (quaternion) => {
    const length = Math.hypot(...quaternion)
    return quaternion.map((each) => each / length)
}

/** parent->middle composed with middle->child gives parent->child */
const compose = (outer, inner) => {
    const outerRotation = outer.slice(3)
    const moved = rotate(outerRotation, inner.slice(0, 3))
    return [
        outer[0] + moved[0],
        outer[1] + moved[1],
        outer[2] + moved[2],
        ...normalize(quaternionMultiply(outerRotation, inner.slice(3))),
    ]
}

const invert = (pose) => {
    const inverseRotation = conjugate(pose.slice(3))
    const back = rotate(inverseRotation, pose.slice(0, 3))
    return [-back[0], -back[1], -back[2], ...inverseRotation]
}

const IDENTITY = [0, 0, 0, 0, 0, 0, 1]

const describe = (pose) => {
    const [x, y, z, qx, qy, qz, qw] = pose
    const roll = Math.atan2(2 * (qw * qx + qy * qz), 1 - 2 * (qx * qx + qy * qy))
    const pitch = Math.asin(Math.max(-1, Math.min(1, 2 * (qw * qy - qz * qx))))
    const yaw = Math.atan2(2 * (qw * qz + qx * qy), 1 - 2 * (qy * qy + qz * qz))
    const degrees = (radians) => (radians * 180 / Math.PI).toFixed(2)
    return `xyz [${[x, y, z].map((n) => n.toFixed(4)).join(", ")}] rpy [${degrees(roll)}, ${degrees(pitch)}, ${degrees(yaw)}] deg`
}

// ---------------------------------------------------------------- lcm

const decoder = new TextDecoder()
const encoder = new TextEncoder()

const readString = (view, data, offset) => {
    const length = view.getInt32(offset, false)
    let end = offset + 4 + length
    while (end > offset + 4 && data[end - 1] === 0) {
        end--
    }
    return [decoder.decode(data.slice(offset + 4, end)), offset + 4 + length]
}

const readTfMessage = (data) => {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    const count = data.length >= 12 ? view.getInt32(8, false) : 0
    let offset = 12
    const transforms = []
    for (let index = 0; index < count; index++) {
        const seq = view.getInt32(offset, false)
        const seconds = view.getInt32(offset + 4, false)
        const nanoseconds = view.getUint32(offset + 8, false)
        offset += 12
        let parent = null
        let child = null
        ;[parent, offset] = readString(view, data, offset)
        ;[child, offset] = readString(view, data, offset)
        const pose = []
        for (let at = 0; at < 7; at++) {
            pose.push(view.getFloat64(offset, false))
            offset += 8
        }
        transforms.push({ seq, seconds, nanoseconds, parent, child, pose })
    }
    return { fingerprint: data.slice(0, 8), transforms }
}

const writeTfMessage = (fingerprint, transforms) => {
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

// nav_msgs/Odometry: fingerprint, header{seq, stamp, frame_id}, child_frame_id, pose.pose, ...
const readOdometry = (data) => {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    let offset = 8 + 12
    let frame = null
    let child = null
    ;[frame, offset] = readString(view, data, offset)
    ;[child, offset] = readString(view, data, offset)
    const pose = []
    for (let at = 0; at < 7; at++) {
        pose.push(view.getFloat64(offset, false))
        offset += 8
    }
    return { frame, child, pose }
}

const stampFor = (seconds) => ({
    seconds: Math.floor(seconds),
    nanoseconds: Math.round((seconds - Math.floor(seconds)) * 1e9),
})

// ---------------------------------------------------------------- the file

const db = new Database(dbPath)
const streamRows = db.prepare("SELECT name, config FROM _streams").all()
const configOf = (row) => {
    try {
        return JSON.parse(row.config) ?? {}
    } catch (error) {
        return {}
    }
}
const tfRows = streamRows.filter((row) => {
    const payload = configOf(row).payload_module ?? ""
    return payload.split(/[./]/).pop() === "TFMessage" || /(^|_)tf(_static)?$/.test(row.name)
})
for (const row of tfRows) {
    if ((configOf(row).codec_id ?? "lcm") !== "lcm") {
        fail(`stream "${row.name}" is stored as ${configOf(row).codec_id}; db_tf_reroot only handles plain lcm`)
    }
}
const tfStreams = tfRows.map((row) => row.name)
const dynamicStream = tfStreams.includes("tf") ? "tf" : tfStreams.find((each) => !each.endsWith("_static")) ?? null
if (dynamicStream === null) {
    fail(`${dbPath} has no tf stream`)
}

const messages = []
for (const stream of tfStreams) {
    const rows = db.prepare(
        `SELECT s.id AS id, s.ts AS ts, b.data AS data FROM "${stream}" AS s
         JOIN "${stream}_blob" AS b ON b.id = s.id ORDER BY s.ts`,
    ).all()
    for (const row of rows) {
        messages.push({ stream, id: row.id, ts: row.ts, ...readTfMessage(row.data) })
    }
}

/** child -> {parent -> [poses]} */
const edges = new Map()
for (const message of messages) {
    for (const transform of message.transforms) {
        const parents = edges.get(transform.child) ?? new Map()
        edges.set(transform.child, parents)
        const poses = parents.get(transform.parent) ?? []
        parents.set(transform.parent, poses)
        poses.push(transform.pose)
    }
}
const parentsOf = (frame) => [...(edges.get(frame)?.keys() ?? [])]

for (const frame of [lidarFrame, baseFrame]) {
    if (parentsOf(frame).length === 0 && ![...edges.values()].some((parents) => parents.has(frame))) {
        fail(`no tf edge names ${frame}`)
    }
}
if (parentsOf(baseFrame).length === 1 && parentsOf(baseFrame)[0] === lidarFrame) {
    console.log(`${dbPath}: already ${parentsOf(lidarFrame).join("|")} -> ${lidarFrame} -> ${baseFrame}, nothing to do`)
    db.close()
    Deno.exit(0)
}
if (parentsOf(baseFrame).length !== 1) {
    fail(`${baseFrame} should have one parent, it has ${parentsOf(baseFrame).length}: ${parentsOf(baseFrame).join(", ")}`)
}
const odomFrame = parentsOf(baseFrame)[0]

// Walk up from the lidar to the base, and insist every edge on the way never moves.
let mount = IDENTITY
let walking = lidarFrame
const chain = [lidarFrame]
while (walking !== baseFrame) {
    const parents = parentsOf(walking)
    if (parents.length !== 1) {
        fail(`${walking} should have one parent on the way to ${baseFrame}, it has ${parents.length}: ${parents.join(", ")}`)
    }
    const parent = parents[0]
    if (parent === odomFrame || chain.includes(parent)) {
        fail(`${lidarFrame} is not under ${baseFrame} (the walk up reached ${parent})`)
    }
    const poses = edges.get(walking).get(parent)
    for (const pose of poses) {
        if (pose.some((value, at) => Math.abs(value - poses[0][at]) > 1e-9)) {
            fail(`${parent} -> ${walking} changes over time, so the mount is not static; nothing written`)
        }
    }
    mount = compose(poses[0], mount)
    chain.push(parent)
    walking = parent
}
const lidarParent = chain[1]

// ---------------------------------------------------------------- the source

const countOf = (name) => db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n
const streamNames = new Set(streamRows.map((row) => row.name))
if (source === "auto") {
    source = streamNames.has("pointlio_odometry") && countOf("pointlio_odometry") > 0 ? "pointlio_odometry" : "tf"
} else if (source !== "tf" && !streamNames.has(source)) {
    fail(`no stream named ${source}`)
}

let sourcePoses = null
let declaredFrame = baseFrame
let sourceFrame = odomFrame
if (source !== "tf") {
    const rows = db.prepare(
        `SELECT s.ts AS ts, b.data AS data FROM "${source}" AS s
         JOIN "${source}_blob" AS b ON b.id = s.id ORDER BY s.ts`,
    ).all()
    if (rows.length === 0) {
        fail(`${source} has no messages`)
    }
    sourcePoses = rows.map((row) => ({ ts: row.ts, ...readOdometry(row.data) }))
    declaredFrame = sourcePoses[0].child
    sourceFrame = sourcePoses[0].frame
    // A stream regenerated later can carry the replay's wall clock instead of the recording's.
    const oldStamps = messages.filter((message) =>
        message.transforms.some((each) => each.parent === odomFrame && each.child === baseFrame)
    ).map((message) => message.ts)
    if (oldStamps.length > 0) {
        const oldStart = Math.min(...oldStamps)
        const oldEnd = Math.max(...oldStamps)
        const newStart = sourcePoses[0].ts
        const newEnd = sourcePoses[sourcePoses.length - 1].ts
        const overlap = Math.max(0, Math.min(oldEnd, newEnd) - Math.max(oldStart, newStart))
        if (overlap < 0.9 * (oldEnd - oldStart)) {
            fail(`${source} spans ${newStart.toFixed(1)}..${newEnd.toFixed(1)} but ${odomFrame} -> ${baseFrame} spans ${oldStart.toFixed(1)}..${oldEnd.toFixed(1)} (${(overlap / Math.max(1e-9, oldEnd - oldStart) * 100).toFixed(0)}% overlap) — a different clock? nothing written; --odometry tf keeps the existing edge`)
        }
    }
}
const describedFrame = poseOf ?? declaredFrame
let sourceToLidar = null
if (describedFrame === lidarFrame) {
    sourceToLidar = IDENTITY
} else if (describedFrame === baseFrame) {
    sourceToLidar = mount
} else {
    fail(`${source}'s poses are of ${describedFrame}; pass --pose-of ${lidarFrame} or --pose-of ${baseFrame}`)
}

const mountInverse = invert(mount)
console.log(dbPath)
console.log(`  before  ${odomFrame} -> ${[...chain].reverse().join(" -> ")}`)
console.log(`  after   ${odomFrame} -> ${lidarFrame} -> ${baseFrame}`)
console.log(`  mount   ${baseFrame} -> ${lidarFrame}  ${describe(mount)}`)
console.log(`  ${lidarParent} -> ${lidarFrame} becomes ${lidarFrame} -> ${baseFrame}  ${describe(mountInverse)}`)
const labelled = describedFrame === declaredFrame ? "" : ` (labelled ${declaredFrame})`
const sourceName = source === "tf" ? `the ${odomFrame} -> ${baseFrame} edge on tf` : `${source} (${sourceFrame} -> ${declaredFrame}, ${sourcePoses.length} poses)`
console.log(`  ${odomFrame} -> ${lidarFrame} from ${sourceName}, as poses of ${describedFrame}${labelled}`)

// ---------------------------------------------------------------- the plan

const plan = []
let dropped = 0
let converted = 0
let flipped = 0
for (const message of messages) {
    let changed = false
    const transforms = []
    for (const transform of message.transforms) {
        if (transform.parent === odomFrame && transform.child === baseFrame) {
            changed = true
            if (source === "tf") {
                transforms.push({ ...transform, child: lidarFrame, pose: compose(transform.pose, sourceToLidar) })
                converted++
            } else {
                dropped++
            }
        } else if (transform.parent === lidarParent && transform.child === lidarFrame) {
            changed = true
            transforms.push({ ...transform, parent: lidarFrame, child: baseFrame, pose: mountInverse })
            flipped++
        } else {
            transforms.push(transform)
        }
    }
    if (!changed) {
        continue
    }
    if (transforms.length === 0) {
        plan.push({ kind: "delete", stream: message.stream, id: message.id })
    } else {
        plan.push({
            kind: "update",
            stream: message.stream,
            id: message.id,
            data: writeTfMessage(message.fingerprint, transforms),
            childFrame: transforms[0].child,
        })
    }
}
if (sourcePoses !== null) {
    const fingerprint = messages.find((each) => each.stream === dynamicStream)?.fingerprint ?? messages[0].fingerprint
    for (const each of sourcePoses) {
        const stamp = stampFor(each.ts)
        plan.push({
            kind: "insert",
            stream: dynamicStream,
            ts: each.ts,
            data: writeTfMessage(fingerprint, [{
                seq: 0,
                seconds: stamp.seconds,
                nanoseconds: stamp.nanoseconds,
                parent: odomFrame,
                child: lidarFrame,
                pose: compose(each.pose, sourceToLidar),
            }]),
        })
    }
}
const kinds = (kind) => plan.filter((each) => each.kind === kind).length
console.log(`  ${flipped} mount edge(s) flipped, ${converted} ${odomFrame} -> ${baseFrame} converted, ${dropped} dropped`)
console.log(`  ${kinds("update")} message(s) rewritten, ${kinds("delete")} deleted (left empty), ${kinds("insert")} inserted`)

if (dryRun) {
    console.log("dry run — nothing changed")
    db.close()
    Deno.exit(0)
}
if (!assumeYes && !confirm("Rewrite the tf tree?")) {
    console.error("aborted: nothing was changed (pass -y to skip the question)")
    db.close()
    Deno.exit(1)
}

const hasTags = (stream) => db.prepare(`PRAGMA table_info("${stream}")`).all().some((column) => column.name === "tags")
const tagged = new Map(tfStreams.map((stream) => [stream, hasTags(stream)]))
db.exec("BEGIN")
try {
    for (const step of plan) {
        if (step.kind === "update") {
            db.prepare(`UPDATE "${step.stream}_blob" SET data = ? WHERE id = ?`).run(step.data, step.id)
            if (tagged.get(step.stream)) {
                db.prepare(`UPDATE "${step.stream}" SET tags = jsonb_set(tags, '$.child_frame', ?) WHERE id = ?`)
                    .run(step.childFrame, step.id)
            }
        } else if (step.kind === "delete") {
            db.prepare(`DELETE FROM "${step.stream}_blob" WHERE id = ?`).run(step.id)
            db.prepare(`DELETE FROM "${step.stream}" WHERE id = ?`).run(step.id)
        } else {
            const row = tagged.get(step.stream)
                ? db.prepare(`INSERT INTO "${step.stream}" (ts, tags) VALUES (?, jsonb(?)) RETURNING id`)
                    .get(step.ts, JSON.stringify({ child_frame: lidarFrame }))
                : db.prepare(`INSERT INTO "${step.stream}" (ts) VALUES (?) RETURNING id`).get(step.ts)
            db.prepare(`INSERT INTO "${step.stream}_blob" (id, data) VALUES (?, ?)`).run(row.id, step.data)
        }
    }
    db.exec("COMMIT")
} catch (error) {
    db.exec("ROLLBACK")
    db.close()
    fail(`failed, rolled back: ${error.message}`)
}
db.close()
console.log(`wrote ${plan.length} change(s)`)
