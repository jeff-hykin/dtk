#!/usr/bin/env -S deno run --allow-read --allow-write --allow-net --allow-env --allow-ffi --unstable-ffi

// heatmap — top-down dark render of a recording: a point cloud stream as a
// density heatmap, with the trajectory over it coloured start-to-end.
//
// Everything is placed through tf and nothing else. The tf tree's root is the
// world; the root's moving child edge (odom -> base_link) is the trajectory;
// a per-scan cloud is carried into the world through the chain from the frame
// its own header names, interpolated to the scan's time. A finished map
// (global_map) already sits in the world frame and is drawn as it is.
// Reads either a memory2 .db or an .mcap.

import { Database } from "jsr:@db/sqlite@0.12"
import { McapIndexedReader } from "https://esm.sh/@mcap/core@2.1.7"
import { decompress as zstdDecompress } from "https://esm.sh/fzstd@0.1.1"
import lz4 from "https://esm.sh/lz4js@0.2.0"
import { Command } from "https://esm.sh/jsr/@cliffy/command@1.2.1"
import { Odometry } from "https://esm.sh/jsr/@dimos/msgs@0.1.4/nav_msgs"
import { PointCloud2 } from "https://esm.sh/jsr/@dimos/msgs@0.1.4/sensor_msgs"
import { TFMessage } from "https://esm.sh/jsr/@dimos/msgs@0.1.4/tf2_msgs"

// --- CDR ---------------------------------------------------------------
// mcaps written against ROS2 carry CDR rather than LCM, so the three types
// this tool reads need a second decoder. Only these three, and only the
// fields actually used below.

class CdrReader {
    constructor(bytes) {
        this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        // Byte 1 of the encapsulation header picks the endianness; the body
        // starts after those 4 bytes, and all alignment is measured from there.
        this.little = (this.view.getUint8(1) & 1) === 1
        this.at = 4
    }

    align(width) {
        this.at += (width - ((this.at - 4) % width)) % width
    }

    uint8() {
        return this.view.getUint8(this.at++)
    }

    int32() {
        this.align(4)
        const value = this.view.getInt32(this.at, this.little)
        this.at += 4
        return value
    }

    uint32() {
        this.align(4)
        const value = this.view.getUint32(this.at, this.little)
        this.at += 4
        return value
    }

    float64() {
        this.align(8)
        const value = this.view.getFloat64(this.at, this.little)
        this.at += 8
        return value
    }

    string() {
        const length = this.uint32()
        const bytes = new Uint8Array(this.view.buffer, this.view.byteOffset + this.at, length - 1)
        this.at += length
        return new TextDecoder().decode(bytes)
    }

    bytes(count) {
        const out = new Uint8Array(
            this.view.buffer.slice(this.view.byteOffset + this.at, this.view.byteOffset + this.at + count),
        )
        this.at += count
        return out
    }

    header() {
        return { stamp: { sec: this.int32(), nanosec: this.uint32() }, frame_id: this.string() }
    }

    vector3() {
        return { x: this.float64(), y: this.float64(), z: this.float64() }
    }

    quaternion() {
        return { x: this.float64(), y: this.float64(), z: this.float64(), w: this.float64() }
    }
}

const CDR_DECODERS = {
    Odometry: (bytes) => {
        const reader = new CdrReader(bytes)
        const header = reader.header()
        reader.string() // child_frame_id
        const pose = { position: reader.vector3(), orientation: reader.quaternion() }
        return { header, pose: { pose } }
    },
    TFMessage: (bytes) => {
        const reader = new CdrReader(bytes)
        const transforms = []
        for (let i = reader.uint32(); i > 0; i--) {
            transforms.push({
                header: reader.header(),
                child_frame_id: reader.string(),
                transform: { translation: reader.vector3(), rotation: reader.quaternion() },
            })
        }
        return { transforms }
    },
    PointCloud2: (bytes) => {
        const reader = new CdrReader(bytes)
        const header = reader.header()
        const height = reader.uint32()
        const width = reader.uint32()
        const fields = []
        for (let i = reader.uint32(); i > 0; i--) {
            fields.push({
                name: reader.string(),
                offset: reader.uint32(),
                datatype: reader.uint8(),
                count: reader.uint32(),
            })
        }
        reader.uint8() // is_bigendian
        const point_step = reader.uint32()
        reader.uint32() // row_step
        const data = reader.bytes(reader.uint32())
        return { header, height, width, fields, point_step, data }
    },
}

const LCM_DECODERS = {
    Odometry: (bytes) => Odometry.decode(bytes),
    TFMessage: (bytes) => TFMessage.decode(bytes),
    PointCloud2: (bytes) => PointCloud2.decode(bytes),
}

// --- sources ---------------------------------------------------------------
// Both kinds of recording expose the same thing: `read(stream, kind)` giving
// timestamped, decoded messages in time order.

function sqliteSource(path) {
    const db = new Database(path, { readonly: true })
    // A stream says how its blobs are encoded, and a cloud stream is very often
    // "lz4+lcm" rather than plain "lcm". Decoding the compressed bytes as LCM
    // fails as a fingerprint mismatch, which reads like a message-version problem
    // and is not one.
    const codecs = new Map()
    for (const [name, config] of db.prepare("SELECT name, config FROM _streams").values()) {
        codecs.set(name, JSON.parse(config).codec_id ?? "lcm")
    }
    const uncompress = (stream, bytes) => {
        const codec = codecs.get(stream) ?? "lcm"
        if (codec.startsWith("lz4")) {
            return new Uint8Array(lz4.decompress(bytes))
        }
        if (codec !== "lcm") {
            throw new Error(`stream "${stream}" is stored as ${codec}, which heatmap cannot read`)
        }
        return bytes
    }
    return {
        kinds() {
            const kinds = new Map()
            for (const [name, config] of db.prepare("SELECT name, config FROM _streams").values()) {
                kinds.set(name, JSON.parse(config).payload_module.split(".").pop())
            }
            return kinds
        },
        count(stream) {
            return db.prepare(`SELECT COUNT(*) FROM ${stream}`).values()[0][0]
        },
        read(stream, kind, stride = 1, { last = false } = {}) {
            const rows = db.prepare(
                `SELECT o.ts, b.data FROM ${stream}_blob b JOIN ${stream} o ON o.id = b.id ORDER BY o.ts` +
                    (last ? " DESC LIMIT 1" : ""),
            ).values()
            const out = []
            for (let index = 0; index < rows.length; index += stride) {
                const bytes = uncompress(stream, new Uint8Array(rows[index][1]))
                out.push({ ts: rows[index][0], message: LCM_DECODERS[kind](bytes) })
            }
            return out
        },
        each(stream, kind, stride, visit) {
            const ids = db.prepare(`SELECT id FROM ${stream} ORDER BY ts`).values()
            const one = db.prepare(`SELECT o.ts, b.data FROM ${stream}_blob b JOIN ${stream} o ON o.id = b.id WHERE o.id = ?`)
            for (let index = 0; index < ids.length; index += stride) {
                const [ts, data] = one.values(ids[index][0])[0]
                visit({ ts, message: LCM_DECODERS[kind](uncompress(stream, new Uint8Array(data))) })
            }
        },
        close: () => db.close(),
    }
}

async function mcapSource(path) {
    const file = await Deno.open(path, { read: true })
    const size = (await file.stat()).size
    const readable = {
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
    }
    // @mcap/core ships no codecs of its own, and every writer we use compresses:
    // db_to_mcap defaults to zstd, web_ctrl offers both.
    const decompressHandlers = {
        zstd: (bytes, size) => zstdDecompress(bytes, new Uint8Array(Number(size))),
        lz4: (bytes) => new Uint8Array(lz4.decompress(bytes)),
    }
    const reader = await McapIndexedReader.Initialize({ readable, decompressHandlers })
    const topics = new Map()
    for (const channel of reader.channelsById.values()) {
        topics.set(channel.topic.replace(/^\//, ""), channel)
    }
    const channelFor = (stream) => {
        const channel = topics.get(stream.replace(/^\//, ""))
        if (channel === undefined) {
            throw new Error(`no topic ${stream}; have ${[...topics.keys()].sort().join(", ")}`)
        }
        return channel
    }
    return {
        kinds() {
            const kinds = new Map()
            for (const [name, channel] of topics) {
                kinds.set(name, reader.schemasById.get(channel.schemaId)?.name.split("/").pop())
            }
            return kinds
        },
        count(stream) {
            return Number(reader.statistics?.channelMessageCounts.get(channelFor(stream).id) ?? 0)
        },
        async read(stream, kind, stride = 1, { last = false } = {}) {
            const channel = channelFor(stream)
            const decode = channel.messageEncoding === "cdr" ? CDR_DECODERS[kind] : LCM_DECODERS[kind]
            if (channel.messageEncoding !== "cdr" && channel.messageEncoding !== "lcm") {
                throw new Error(`topic ${stream} is ${channel.messageEncoding}, which heatmap cannot decode`)
            }
            if (last) {
                // Only the newest message is wanted, so nothing before it is decoded:
                // a map's snapshots are each tens of megabytes, and there are hundreds.
                // Only the chunks that end last are opened: the summary says which
                // chunks hold the channel and when each one ends.
                let lastChunk
                for (const chunk of reader.chunkIndexes) {
                    if (chunk.messageIndexOffsets.has(channel.id) && (lastChunk === undefined || chunk.messageEndTime > lastChunk.messageEndTime)) {
                        lastChunk = chunk
                    }
                }
                const startTime = lastChunk?.messageStartTime
                let newest
                for await (const message of reader.readMessages({ topics: [channel.topic], startTime })) {
                    if (newest === undefined || message.logTime > newest.logTime) {
                        newest = message
                    }
                }
                return newest ? [{ ts: Number(newest.logTime) / 1e9, message: decode(newest.data) }] : []
            }
            const out = []
            let index = 0
            for await (const message of reader.readMessages({ topics: [channel.topic] })) {
                // Skipping before decoding is what makes an hour-long recording fit:
                // a decoded scan keeps its bytes alive until the whole stream is read,
                // so dropping them afterwards is too late.
                if (index++ % stride !== 0) {
                    continue
                }
                out.push({ ts: Number(message.logTime) / 1e9, message: decode(message.data) })
            }
            out.sort((a, b) => a.ts - b.ts)
            return out
        },
        /** Like read, but hands over each message as it is decoded, so a stream bigger than memory still fits. */
        async each(stream, kind, stride, visit) {
            const channel = channelFor(stream)
            const decode = channel.messageEncoding === "cdr" ? CDR_DECODERS[kind] : LCM_DECODERS[kind]
            let index = 0
            for await (const message of reader.readMessages({ topics: [channel.topic] })) {
                if (index++ % stride !== 0) {
                    continue
                }
                visit({ ts: Number(message.logTime) / 1e9, message: decode(message.data) })
            }
        },
        close: () => file.close(),
    }
}

// --- decoding ----------------------------------------------------------

/** Point-LIO's odometry is world->body: position plus an xyzw quaternion. */
function odometryPose(message) {
    const pose = message.pose.pose
    return {
        x: pose.position.x,
        y: pose.position.y,
        z: pose.position.z,
        q: [pose.orientation.x, pose.orientation.y, pose.orientation.z, pose.orientation.w],
    }
}

/** v + 2u x (u x v + wv) -- the quaternion sandwich without building a matrix. */
function rotate(q, x, y, z) {
    const [qx, qy, qz, qw] = q
    const ix = qy * z - qz * y + qw * x
    const iy = qz * x - qx * z + qw * y
    const iz = qx * y - qy * x + qw * z
    return [
        x + 2 * (qy * iz - qz * iy),
        y + 2 * (qz * ix - qx * iz),
        z + 2 * (qx * iy - qy * ix),
    ]
}

/** Rigid transforms are {t: [x,y,z], q: [x,y,z,w]}; compose is parent ∘ child. */
const IDENTITY = { t: [0, 0, 0], q: [0, 0, 0, 1] }

function compose(parent, child) {
    const [ax, ay, az, aw] = parent.q
    const [bx, by, bz, bw] = child.q
    return {
        t: rotate(parent.q, child.t[0], child.t[1], child.t[2]).map((v, i) => v + parent.t[i]),
        q: [
            aw * bx + ax * bw + ay * bz - az * by,
            aw * by - ax * bz + ay * bw + az * bx,
            aw * bz + ax * by - ay * bx + az * bw,
            aw * bw - ax * bx - ay * by - az * bz,
        ],
    }
}

/** A header's stamp in seconds, whichever decoder shaped it; 0 when it has none.
 *
 * The stamp is the instant a message describes; the log time is when the
 * recorder got it. For a lidar scan those differ by the sweep plus transport,
 * ~100 ms on a Mid-360, and a deskewed cloud is referenced to its stamp, as
 * are the odometry's tf edges. Placing a scan at its log time puts it a tenth
 * of a second down the path and a few degrees round the corner, which smears
 * every wall into offset copies of itself. */
function headerSeconds(header) {
    const stamp = header?.stamp
    if (stamp === undefined || stamp === null) {
        return 0
    }
    const sec = Number(stamp.sec ?? 0)
    const nanos = Number(stamp.nanosec ?? stamp.nsec ?? 0)
    return sec + nanos / 1e9
}

/** TFMessage -> {child_frame -> {ts, parent, transform}}, so a frame can be walked to the root.
 * Each edge keeps its own stamp; `fallbackTs` (the message's log time) stands in for an unstamped one. */
function tfEdges(message, fallbackTs) {
    const edges = {}
    for (const stamped of message.transforms) {
        edges[stamped.child_frame_id] = {
            ts: headerSeconds(stamped.header) || fallbackTs,
            parent: stamped.header.frame_id,
            transform: {
                t: [
                    stamped.transform.translation.x,
                    stamped.transform.translation.y,
                    stamped.transform.translation.z,
                ],
                q: [
                    stamped.transform.rotation.x,
                    stamped.transform.rotation.y,
                    stamped.transform.rotation.z,
                    stamped.transform.rotation.w,
                ],
            },
        }
    }
    return edges
}

/** child_frame -> its parent edge over time, so a tree split across publishers still resolves.
 *
 * A single tf message rarely holds the whole tree: dimos publishes the static mount frames
 * from one module and the moving odom->base_link from another, so picking the one message
 * nearest a scan truncates the chain at base_link and stacks every scan in one spot.
 */
function tfTimeline(samples) {
    const timeline = {}
    for (const { ts, edges } of samples) {
        for (const [child, edge] of Object.entries(edges)) {
            timeline[child] ??= []
            timeline[child].push({ ts: edge.ts ?? ts, parent: edge.parent, transform: edge.transform })
        }
    }
    for (const samplesForChild of Object.values(timeline)) {
        samplesForChild.sort((a, b) => a.ts - b.ts)
    }
    return timeline
}

/** Index of the first sample at or after `ts` (binary search on a ts-sorted list). */
function lowerBound(list, ts) {
    let lo = 0
    let hi = list.length
    while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (list[mid].ts < ts) { lo = mid + 1 } else { hi = mid }
    }
    return lo
}

/** Spherical interpolation between xyzw quaternions, along the short way round. */
function slerp(a, b, f) {
    let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]
    let bb = b
    if (dot < 0) {
        dot = -dot
        bb = b.map((v) => -v)
    }
    if (dot > 0.9995) {
        const out = a.map((v, i) => v + (bb[i] - v) * f)
        const n = Math.hypot(...out)
        return out.map((v) => v / n)
    }
    const theta = Math.acos(dot)
    const wa = Math.sin((1 - f) * theta) / Math.sin(theta)
    const wb = Math.sin(f * theta) / Math.sin(theta)
    return a.map((v, i) => v * wa + bb[i] * wb)
}

/** The edge's transform at `ts`: interpolated between the samples around it,
 * the nearest end outside them. A scan at 10 Hz between two tf samples is
 * placed with an orientation up to 50 ms stale by a nearest lookup, which on
 * a fast turn fans the scan into rings around the corner. */
function edgeAt(samples, ts) {
    const at = lowerBound(samples, ts)
    const after = samples[Math.min(at, samples.length - 1)]
    const before = samples[Math.max(at - 1, 0)]
    if (after === before || after.parent !== before.parent || after.ts === before.ts) {
        return Math.abs(before.ts - ts) <= Math.abs(after.ts - ts) ? before : after
    }
    const f = Math.min(1, Math.max(0, (ts - before.ts) / (after.ts - before.ts)))
    return {
        parent: before.parent,
        transform: {
            t: before.transform.t.map((v, i) => v + (after.transform.t[i] - v) * f),
            q: slerp(before.transform.q, after.transform.q, f),
        },
    }
}

/** Walk `frame` up to the root of the tf tree at time `ts`, giving {transform, root}. */
function chainToRoot(timeline, frame, ts) {
    let out = IDENTITY
    const seen = new Set()
    while (timeline[frame] && !seen.has(frame)) {
        seen.add(frame)
        const edge = edgeAt(timeline[frame], ts)
        out = compose(edge.transform, out)
        frame = edge.parent
    }
    return { transform: out, root: frame }
}

/** The frames that are only ever parents: the world frame, or several if the tree is split. */
function tfRoots(timeline) {
    const children = new Set(Object.keys(timeline))
    const parents = new Set()
    for (const samples of Object.values(timeline)) {
        for (const sample of samples) {
            parents.add(sample.parent)
        }
    }
    return [...parents].filter((frame) => !children.has(frame)).sort()
}

/** The trajectory: `body`'s pose in the world at each time its own edge was
 * published, chained up through whatever sits above it (a fixed world -> odom
 * included). Falls back to the root's child edge that moves the most when the
 * recording has no such frame, since the static mount edges are republished
 * too, at a constant transform. */
function trajectory(timeline, root, body) {
    if (timeline[body]) {
        return {
            child: body,
            poses: timeline[body].map((sample) => {
                const chain = chainToRoot(timeline, body, sample.ts)
                return { ts: sample.ts, x: chain.transform.t[0], y: chain.transform.t[1], z: chain.transform.t[2], q: chain.transform.q }
            }),
        }
    }
    console.error(`heatmap: no frame ${body} in tf; using the moving edge under ${root} instead`)
    let best
    for (const [child, samples] of Object.entries(timeline)) {
        const under = samples.filter((sample) => sample.parent === root)
        if (under.length < 2) {
            continue
        }
        const spread = [0, 1, 2].reduce((acc, i) => {
            const values = under.map((sample) => sample.transform.t[i])
            return acc + Math.max(...values) - Math.min(...values)
        }, 0)
        if (best === undefined || spread > best.spread) {
            best = { child, spread, samples: under }
        }
    }
    if (best === undefined) {
        return { child: undefined, poses: [] }
    }
    return {
        child: best.child,
        poses: best.samples.map((sample) => ({ ts: sample.ts, x: sample.transform.t[0], y: sample.transform.t[1], z: sample.transform.t[2], q: sample.transform.q })),
    }
}

/** PointCloud2 -> Float32Array of xyz triples, in whatever frame it was stored. */
function cloudXyz(cloud) {
    const offsets = {}
    for (const field of cloud.fields) {
        offsets[field.name] = field.offset
    }
    if (offsets.x === undefined || offsets.y === undefined || offsets.z === undefined) {
        return new Float32Array(0)
    }
    const data = cloud.data instanceof Uint8Array ? cloud.data : new Uint8Array(cloud.data)
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    const step = cloud.point_step
    const count = Math.min(cloud.width * Math.max(1, cloud.height), Math.floor(data.byteLength / step))
    const out = new Float32Array(count * 3)
    for (let i = 0; i < count; i++) {
        const base = i * step
        out[i * 3 + 0] = view.getFloat32(base + offsets.x, true)
        out[i * 3 + 1] = view.getFloat32(base + offsets.y, true)
        out[i * 3 + 2] = view.getFloat32(base + offsets.z, true)
    }
    return out
}

// --- alignment -------------------------------------------------------------

/** Horn's absolute orientation: the rigid transform carrying `source` onto `target`. */
function alignRigid(source, target) {
    const mean = (points) => points.reduce(
        (acc, p) => [acc[0] + p[0] / points.length, acc[1] + p[1] / points.length, acc[2] + p[2] / points.length],
        [0, 0, 0],
    )
    const sourceCentre = mean(source)
    const targetCentre = mean(target)
    const s = Array.from({ length: 3 }, () => [0, 0, 0])
    for (let i = 0; i < source.length; i++) {
        for (let a = 0; a < 3; a++) {
            for (let b = 0; b < 3; b++) {
                s[a][b] += (source[i][a] - sourceCentre[a]) * (target[i][b] - targetCentre[b])
            }
        }
    }
    const [[xx, xy, xz], [yx, yy, yz], [zx, zy, zz]] = s
    const n = [
        [xx + yy + zz, yz - zy, zx - xz, xy - yx],
        [yz - zy, xx - yy - zz, xy + yx, zx + xz],
        [zx - xz, xy + yx, -xx + yy - zz, yz + zy],
        [xy - yx, zx + xz, yz + zy, -xx - yy + zz],
    ]
    // Shifted power iteration: the shift makes the wanted (largest algebraic)
    // eigenvalue also the largest in magnitude, which is what iteration finds.
    const shift = 3 * Math.max(...n.flat().map(Math.abs), 1)
    let vector = [1, 0, 0, 0]
    for (let step = 0; step < 400; step++) {
        const next = n.map((row, i) => row.reduce((acc, value, j) => acc + value * vector[j], 0) + shift * vector[i])
        const norm = Math.hypot(...next)
        vector = next.map((value) => value / norm)
    }
    const [qw, qx, qy, qz] = vector
    const q = [qx, qy, qz, qw]
    const rotated = rotate(q, sourceCentre[0], sourceCentre[1], sourceCentre[2])
    return { t: targetCentre.map((value, i) => value - rotated[i]), q }
}

/** Nearest-in-time pairs, dropped when nothing lands within `tolerance` seconds. */
function timeMatched(source, target, tolerance) {
    const stamps = target.map((p) => p.ts)
    const pairs = { source: [], target: [] }
    for (const point of source) {
        let lo = 0
        let hi = stamps.length - 1
        while (lo < hi) {
            const mid = (lo + hi) >> 1
            if (stamps[mid] < point.ts) { lo = mid + 1 } else { hi = mid }
        }
        for (const index of [lo, lo - 1]) {
            const other = target[index]
            if (other && Math.abs(other.ts - point.ts) <= tolerance) {
                pairs.source.push([point.x, point.y, point.z])
                pairs.target.push([other.x, other.y, other.z])
                break
            }
        }
    }
    return pairs
}

// --- PNG -------------------------------------------------------------------
// Written by hand rather than pulled in: the only hard part is deflate, and
// CompressionStream is already in the runtime.

const CRC_TABLE = (() => {
    const table = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
        let c = n
        for (let k = 0; k < 8; k++) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
        }
        table[n] = c >>> 0
    }
    return table
})()

function crc32(bytes) {
    let c = 0xffffffff
    for (const byte of bytes) {
        c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
    }
    return (c ^ 0xffffffff) >>> 0
}

async function deflate(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"))
    return new Uint8Array(await new Response(stream).arrayBuffer())
}

function chunk(type, body) {
    const out = new Uint8Array(12 + body.length)
    const view = new DataView(out.buffer)
    view.setUint32(0, body.length, false)
    out.set(new TextEncoder().encode(type), 4)
    out.set(body, 8)
    view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)), false)
    return out
}

/** rgb is a Uint8Array of width*height*3. */
async function encodePng(rgb, width, height) {
    const raw = new Uint8Array(height * (width * 3 + 1))
    for (let y = 0; y < height; y++) {
        raw[y * (width * 3 + 1)] = 0 // filter: none
        raw.set(rgb.subarray(y * width * 3, (y + 1) * width * 3), y * (width * 3 + 1) + 1)
    }
    const ihdr = new Uint8Array(13)
    const view = new DataView(ihdr.buffer)
    view.setUint32(0, width, false)
    view.setUint32(4, height, false)
    ihdr[8] = 8 // bit depth
    ihdr[9] = 2 // truecolour
    const parts = [
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk("IHDR", ihdr),
        chunk("IDAT", await deflate(raw)),
        chunk("IEND", new Uint8Array(0)),
    ]
    const total = parts.reduce((n, p) => n + p.length, 0)
    const png = new Uint8Array(total)
    let at = 0
    for (const part of parts) {
        png.set(part, at)
        at += part.length
    }
    return png
}

// --- labels ----------------------------------------------------------------
// A 5x7 bitmap font, just enough for measurements and a title: each glyph is
// seven rows, each row five bits, most significant on the left.

const GLYPHS = {
    "0": [14, 17, 19, 21, 25, 17, 14], "1": [4, 12, 4, 4, 4, 4, 14], "2": [14, 17, 1, 2, 4, 8, 31],
    "3": [31, 2, 4, 2, 1, 17, 14], "4": [2, 6, 10, 18, 31, 2, 2], "5": [31, 16, 30, 1, 1, 17, 14],
    "6": [6, 8, 16, 30, 17, 17, 14], "7": [31, 1, 2, 4, 8, 8, 8], "8": [14, 17, 17, 14, 17, 17, 14],
    "9": [14, 17, 17, 15, 1, 2, 12], "A": [14, 17, 17, 31, 17, 17, 17], "B": [30, 17, 17, 30, 17, 17, 30],
    "C": [14, 17, 16, 16, 16, 17, 14], "D": [28, 18, 17, 17, 17, 18, 28], "E": [31, 16, 16, 30, 16, 16, 31],
    "F": [31, 16, 16, 30, 16, 16, 16], "G": [14, 17, 16, 23, 17, 17, 15], "H": [17, 17, 17, 31, 17, 17, 17],
    "I": [14, 4, 4, 4, 4, 4, 14], "J": [7, 2, 2, 2, 2, 18, 12], "K": [17, 18, 20, 24, 20, 18, 17],
    "L": [16, 16, 16, 16, 16, 16, 31], "M": [17, 27, 21, 21, 17, 17, 17], "N": [17, 17, 25, 21, 19, 17, 17],
    "O": [14, 17, 17, 17, 17, 17, 14], "P": [30, 17, 17, 30, 16, 16, 16], "Q": [14, 17, 17, 17, 21, 18, 13],
    "R": [30, 17, 17, 30, 20, 18, 17], "S": [15, 16, 16, 14, 1, 1, 30], "T": [31, 4, 4, 4, 4, 4, 4],
    "U": [17, 17, 17, 17, 17, 17, 14], "V": [17, 17, 17, 17, 17, 10, 4], "W": [17, 17, 17, 21, 21, 21, 10],
    "X": [17, 17, 10, 4, 10, 17, 17], "Y": [17, 17, 10, 4, 4, 4, 4], "Z": [31, 1, 2, 4, 8, 16, 31],
    "-": [0, 0, 0, 31, 0, 0, 0], ".": [0, 0, 0, 0, 0, 12, 12], ",": [0, 0, 0, 0, 12, 4, 8],
    "(": [2, 4, 8, 8, 8, 4, 2], ")": [8, 4, 2, 2, 2, 4, 8], ":": [0, 12, 12, 0, 12, 12, 0],
    "/": [1, 1, 2, 4, 8, 16, 16], "_": [0, 0, 0, 0, 0, 0, 31], "+": [0, 4, 4, 31, 4, 4, 0],
    "=": [0, 0, 31, 0, 31, 0, 0], " ": [0, 0, 0, 0, 0, 0, 0],
}

/** Pixel width of `text` at `size` (pixels per font dot). */
function textWidth(text, size) {
    return text.length * 6 * size - size
}

/** Draw `text` with its top-left at (x, y); anchor "center"/"right" shifts it left. */
function drawText(image, text, x, y, size, colour, anchor = "left") {
    const start = anchor === "center" ? x - textWidth(text, size) / 2 : anchor === "right" ? x - textWidth(text, size) : x
    let penX = Math.round(start)
    for (const character of text.toUpperCase()) {
        const rows = GLYPHS[character] ?? GLYPHS[" "]
        for (let row = 0; row < 7; row++) {
            for (let col = 0; col < 5; col++) {
                if (rows[row] & (16 >> col)) {
                    fillRect(image, penX + col * size, y + row * size, size, size, colour)
                }
            }
        }
        penX += 6 * size
    }
}

function fillRect(image, x, y, w, h, [r, g, b]) {
    for (let py = Math.max(0, y); py < Math.min(image.height, y + h); py++) {
        for (let px = Math.max(0, x); px < Math.min(image.width, x + w); px++) {
            const at = (py * image.width + px) * 3
            image.rgb[at] = r
            image.rgb[at + 1] = g
            image.rgb[at + 2] = b
        }
    }
}

/** Grid spacing: the smallest "nice" metre step that leaves at least `minPx` between lines. */
function niceStep(pixelsPerMetre, minPx) {
    for (const step of [0.5, 1, 2, 5, 10, 20, 50, 100]) {
        if (step * pixelsPerMetre >= minPx) {
            return step
        }
    }
    return 100
}

/** "12" rather than "12.0", "2.5" rather than "2.50". */
function metres(value) {
    return String(Math.round(value * 100) / 100)
}

// --- colour ----------------------------------------------------------------

/** Turbo-ish ramp: blue at the start of the run, red at the end. */
function pathColour(t) {
    const stops = [
        [0.0, [64, 110, 255]],
        [0.25, [0, 220, 220]],
        [0.5, [90, 235, 90]],
        [0.75, [255, 205, 60]],
        [1.0, [255, 70, 70]],
    ]
    for (let i = 1; i < stops.length; i++) {
        if (t <= stops[i][0]) {
            const [t0, c0] = stops[i - 1]
            const [t1, c1] = stops[i]
            const f = (t - t0) / (t1 - t0)
            return c0.map((v, k) => Math.round(v + (c1[k] - v) * f))
        }
    }
    return stops[stops.length - 1][1]
}

// --- stream selection ------------------------------------------------------
// Recordings name their streams differently (pointlio_lidar vs lidar vs
// livox/points), so a stream is picked by message kind: the requested name
// if given, else the first preferred name present, else the only stream of
// that kind.

function pickStream(source, kind, requested, preferred = []) {
    const kinds = source.kinds()
    const candidates = [...kinds.keys()].filter((name) => kinds.get(name) === kind).sort()
    const have = candidates.length ? candidates.join(", ") : "none"
    if (requested !== undefined) {
        if (!kinds.has(requested)) {
            console.error(`heatmap: no stream ${requested}; ${kind} streams here: ${have}`)
            Deno.exit(1)
        }
        return requested
    }
    const found = preferred.find((name) => kinds.has(name))
    if (found !== undefined) {
        return found
    }
    if (candidates.length !== 1) {
        console.error(`heatmap: no ${preferred.join("/")}; ${kind} streams here: ${have}; pick one with the flag`)
        Deno.exit(1)
    }
    console.error(`heatmap: no ${preferred.join("/")}, using ${candidates[0]}`)
    return candidates[0]
}

/**
 * The turn, in radians within a quarter circle, that lines the walls up with
 * the axes. Walls are long runs of points, so when they run along an axis the
 * points pile into a few rows and columns; the sum of squared bin counts peaks
 * there. Searched coarse to fine over 0-90 degrees.
 */
function wallAngle(xy) {
    const stride = Math.max(1, Math.floor(xy.length / 2 / 200000)) * 2
    const peakiness = (angle) => {
        const cos = Math.cos(-angle), sin = Math.sin(-angle)
        const rows = new Map(), cols = new Map()
        for (let i = 0; i < xy.length; i += stride) {
            const x = Math.round((xy[i] * cos - xy[i + 1] * sin) / 0.1)
            const y = Math.round((xy[i] * sin + xy[i + 1] * cos) / 0.1)
            cols.set(x, (cols.get(x) ?? 0) + 1)
            rows.set(y, (rows.get(y) ?? 0) + 1)
        }
        let score = 0
        for (const n of cols.values()) { score += n * n }
        for (const n of rows.values()) { score += n * n }
        return score
    }
    let best = 0, bestScore = -1
    for (let degrees = 0; degrees < 90; degrees += 1) {
        const score = peakiness(degrees * Math.PI / 180)
        if (score > bestScore) { best = degrees; bestScore = score }
    }
    const coarse = best
    for (let degrees = coarse - 1; degrees <= coarse + 1; degrees += 0.1) {
        const score = peakiness(degrees * Math.PI / 180)
        if (score > bestScore) { best = degrees; bestScore = score }
    }
    return best * Math.PI / 180
}

/** The grid a voxel map sits on: the most common small gap between its sorted distinct x values. */
function voxelPitch(xyz) {
    const xs = [...new Set(Array.from({ length: Math.min(20000, xyz.length / 3) }, (_, i) => Math.round(xyz[i * 3] * 1000)))].sort((a, b) => a - b)
    const gaps = new Map()
    for (let i = 1; i < xs.length; i++) {
        const gap = xs[i] - xs[i - 1]
        if (gap > 5) {
            gaps.set(gap, (gaps.get(gap) ?? 0) + 1)
        }
    }
    const best = [...gaps].sort((a, b) => b[1] - a[1])[0]
    return best ? best[0] / 1000 : 0.08
}

/** The x, y centre of a packed voxel key (see `bin`). */
function voxelCentre(key, voxel) {
    const xy = Math.floor(key / 2 ** 16)
    const ix = Math.floor(xy / 2 ** 18) - 2 ** 17
    const iy = (xy % 2 ** 18) - 2 ** 17
    return [(ix + 0.5) * voxel, (iy + 0.5) * voxel]
}

/** Draw one height band: its voxels as a top-down density, the path on that floor, and the measurements. */
async function renderSlice(slice, { odom, voxel, squaredBy, isMap, options }) {
    const { low, high, target } = slice
    // A voxel a scan stream hit only once is noise more often than wall; a map's
    // voxels are each already a surface, so they all count.
    const minimumHits = isMap ? 1 : 2
    // Columns: how many distinct voxels stack over each plan cell.
    const columns = new Map()
    for (const [key, hits] of slice.voxels) {
        if (hits >= minimumHits) {
            const xy = Math.floor(key / 2 ** 16)
            columns.set(xy, (columns.get(xy) ?? 0) + 1)
        }
    }
    slice.voxels = null
    const keep = []
    const weight = []
    for (const [xy, count] of columns) {
        const [x, y] = voxelCentre(xy * 2 ** 16, voxel)
        keep.push(x, y)
        weight.push(count)
    }

    // A height band is one floor of a building, so only the part of the walk
    // on that floor belongs on its plan; the stairs between are left out.
    const onFloor = (pose) => pose.z >= low && pose.z <= high
    const walked = odom.filter(onFloor)
    if (options.crop !== undefined && walked.length > 0) {
        const x0 = Math.min(...walked.map((p) => p.x)) - options.crop
        const x1 = Math.max(...walked.map((p) => p.x)) + options.crop
        const y0 = Math.min(...walked.map((p) => p.y)) - options.crop
        const y1 = Math.max(...walked.map((p) => p.y)) + options.crop
        let kept = 0
        for (let i = 0; i < keep.length; i += 2) {
            if (keep[i] >= x0 && keep[i] <= x1 && keep[i + 1] >= y0 && keep[i + 1] <= y1) {
                weight[kept / 2] = weight[i / 2]
                keep[kept++] = keep[i]
                keep[kept++] = keep[i + 1]
            }
        }
        keep.length = kept
        weight.length = kept / 2
    }

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    const note = (x, y) => {
        if (x < minX) { minX = x }
        if (x > maxX) { maxX = x }
        if (y < minY) { minY = y }
        if (y > maxY) { maxY = y }
    }
    for (let i = 0; i < keep.length; i += 2) {
        note(keep[i], keep[i + 1])
    }
    if (options.path) {
        for (const p of walked) {
            note(p.x, p.y)
        }
    }
    const margin = 1.0
    minX -= margin; maxX += margin; minY -= margin; maxY += margin
    if (options.extent) {
        [minX, minY, maxX, maxY] = options.extent.split(/[,_]/).map(Number)
    }

    // The plan is drawn on the voxel grid itself, a whole number of pixels per
    // voxel, since any other pitch beats against the grid as moire. A forced
    // --width gives that up and draws each voxel as a square of its own size.
    let width = options.width ?? 1600
    let cell = 1
    const onVoxelGrid = options.width === undefined
    if (onVoxelGrid) {
        minX = Math.floor(minX / voxel) * voxel
        minY = Math.floor(minY / voxel) * voxel
        const count = Math.min(4096, Math.round((maxX - minX) / voxel))
        const longest = Math.max(count, Math.round((maxY - minY) / voxel))
        cell = Math.max(1, Math.round(2000 / longest))
        width = count * cell
        maxX = minX + count * voxel
        maxY = minY + Math.round((maxY - minY) / voxel) * voxel
    }
    console.log(`heatmap: ${target} extent ${[minX, minY, maxX, maxY].map((v) => v.toFixed(2)).join(",")}`)
    const scale = width / (maxX - minX)
    const height = Math.max(1, Math.round((maxY - minY) * scale))
    const toPx = (x, y) => [
        Math.round((x - minX) * scale),
        height - 1 - Math.round((y - minY) * scale),
    ]

    const density = new Float32Array(width * height)
    const splat = onVoxelGrid ? cell : Math.max(1, Math.round(voxel * scale))
    for (let i = 0; i < keep.length; i += 2) {
        let x0, y0
        if (onVoxelGrid) {
            x0 = Math.floor((keep[i] - minX) / voxel) * cell
            y0 = Math.floor((maxY - keep[i + 1]) / voxel) * cell
        } else {
            const [cx, cy] = toPx(keep[i], keep[i + 1])
            x0 = cx - Math.floor((splat - 1) / 2)
            y0 = cy - Math.floor((splat - 1) / 2)
        }
        for (let dy = 0; dy < splat; dy++) {
            for (let dx = 0; dx < splat; dx++) {
                const px = x0 + dx
                const py = y0 + dy
                if (px >= 0 && px < width && py >= 0 && py < height) {
                    density[py * width + px] = Math.max(density[py * width + px], weight[i / 2])
                }
            }
        }
    }
    let peak = 0
    for (const value of density) {
        if (value > peak) {
            peak = value
        }
    }
    // A log ramp: a column one voxel deep stays dim, a full-height wall is bright.
    const ceiling = Math.max(1, peak * 0.5)

    const rgb = new Uint8Array(width * height * 3)
    for (let i = 0; i < width * height; i++) {
        rgb[i * 3] = 12
        rgb[i * 3 + 1] = 14
        rgb[i * 3 + 2] = 18
    }
    // The metre grid goes down before the cloud, so walls are drawn over it.
    const minor = niceStep(scale, 10)
    const major = niceStep(scale, 60)
    const map = { rgb, width, height }
    if (options.measurements) {
        for (const [step, colour] of [[minor, [22, 30, 44]], [major, [38, 58, 92]]]) {
            for (let gx = Math.ceil(minX / step) * step; gx <= maxX; gx += step) {
                fillRect(map, toPx(gx, 0)[0], 0, 1, height, colour)
            }
            for (let gy = Math.ceil(minY / step) * step; gy <= maxY; gy += step) {
                fillRect(map, 0, toPx(0, gy)[1], width, 1, colour)
            }
        }
    }
    for (let i = 0; i < density.length; i++) {
        if (density[i] > 0) {
            const t = Math.min(1, Math.log1p(density[i]) / Math.log1p(ceiling))
            const level = Math.round(60 + t * 190)
            rgb[i * 3] = level
            rgb[i * 3 + 1] = level
            rgb[i * 3 + 2] = Math.min(255, Math.round(level * 0.95 + 12))
        }
    }

    // Path last, so it is never buried by the cloud, and drawn as joined
    // segments: at 30 Hz the poses are far enough apart to read as dots.
    if (options.path && walked.length > 0) {
        const plot = (x, y, [r, g, b], radius) => fillRect(map, x - radius, y - radius, 2 * radius + 1, 2 * radius + 1, [r, g, b])
        let previous = toPx(odom[0].x, odom[0].y)
        for (let i = 1; i < odom.length; i++) {
            const current = toPx(odom[i].x, odom[i].y)
            if (onFloor(odom[i]) && onFloor(odom[i - 1])) {
                const colour = pathColour(i / (odom.length - 1))
                const steps = Math.max(Math.abs(current[0] - previous[0]), Math.abs(current[1] - previous[1]), 1)
                for (let s = 0; s <= steps; s++) {
                    plot(
                        Math.round(previous[0] + ((current[0] - previous[0]) * s) / steps),
                        Math.round(previous[1] + ((current[1] - previous[1]) * s) / steps),
                        colour,
                        1,
                    )
                }
            }
            previous = current
        }
        for (const [pose, colour] of [[odom[0], [64, 110, 255]], [odom[odom.length - 1], [255, 70, 70]]]) {
            if (onFloor(pose)) {
                const [x, y] = toPx(pose.x, pose.y)
                plot(x, y, [255, 255, 255], 4)
                plot(x, y, colour, 3)
            }
        }
    }

    const sheet = options.measurements
        ? measuredSheet(map, { minX, minY, maxX, maxY, toPx, minor, major, pixelsPerMetre: scale, title: slice.title, low, high, squaredBy, voxel })
        : map
    await Deno.writeFile(target, await encodePng(sheet.rgb, sheet.width, sheet.height))
    console.log(`heatmap: ${target}: ${keep.length / 2} cells, ${(maxX - minX).toFixed(1)} x ${(maxY - minY).toFixed(1)} m`)
}

// --- measured sheet --------------------------------------------------------
// The plan framed like a drawing: metre labels on every major grid line along
// all four edges, a scale bar, and the overall dimensions, so a distance can be
// read off the image without knowing its pixel pitch.

function measuredSheet(map, { minX, minY, maxX, maxY, toPx, minor, major, pixelsPerMetre, title, low, high, squaredBy, voxel }) {
    const size = 2
    const ink = [150, 180, 225]
    const faint = [90, 110, 140]
    const labelWidth = textWidth(metres(-Math.max(Math.abs(minY), Math.abs(maxY), 100)), size)
    const left = labelWidth + 24
    const right = labelWidth + 24
    const top = (title ? 44 : 0) + 36
    const bottom = 100
    const sheet = { width: map.width + left + right, height: map.height + top + bottom }
    sheet.rgb = new Uint8Array(sheet.width * sheet.height * 3)
    fillRect(sheet, 0, 0, sheet.width, sheet.height, [8, 10, 14])
    for (let y = 0; y < map.height; y++) {
        sheet.rgb.set(map.rgb.subarray(y * map.width * 3, (y + 1) * map.width * 3), ((y + top) * sheet.width + left) * 3)
    }
    // A border round the plan, one pixel outside it.
    fillRect(sheet, left - 1, top - 1, map.width + 2, 1, faint)
    fillRect(sheet, left - 1, top + map.height, map.width + 2, 1, faint)
    fillRect(sheet, left - 1, top - 1, 1, map.height + 2, faint)
    fillRect(sheet, left + map.width, top - 1, 1, map.height + 2, faint)

    for (let gx = Math.ceil(minX / major) * major; gx <= maxX; gx += major) {
        const px = left + toPx(gx, 0)[0]
        fillRect(sheet, px, top - 7, 1, 6, ink)
        fillRect(sheet, px, top + map.height + 1, 1, 6, ink)
        drawText(sheet, metres(gx), px, top - 7 - 7 * size - 4, size, ink, "center")
        drawText(sheet, metres(gx), px, top + map.height + 10, size, ink, "center")
    }
    for (let gy = Math.ceil(minY / major) * major; gy <= maxY; gy += major) {
        const py = top + toPx(0, gy)[1]
        fillRect(sheet, left - 7, py, 6, 1, ink)
        fillRect(sheet, left + map.width + 1, py, 6, 1, ink)
        drawText(sheet, metres(gy), left - 10, py - Math.round(3.5 * size), size, ink, "right")
        drawText(sheet, metres(gy), left + map.width + 10, py - Math.round(3.5 * size), size, ink)
    }

    // Scale bar: the largest round length that fits in a third of the width,
    // split into alternating metre blocks like a surveyor's bar.
    const barMetres = [1, 2, 5, 10, 20, 50].filter((m) => m * pixelsPerMetre <= map.width / 3).pop() ?? 1
    const barY = top + map.height + 36
    const segments = barMetres <= 10 ? barMetres : barMetres / 5
    const segmentPx = (barMetres * pixelsPerMetre) / segments
    for (let i = 0; i < segments; i++) {
        const x0 = Math.round(left + i * segmentPx)
        const x1 = Math.round(left + (i + 1) * segmentPx)
        fillRect(sheet, x0, barY, x1 - x0, 8, i % 2 ? [8, 10, 14] : ink)
    }
    fillRect(sheet, left, barY, Math.round(barMetres * pixelsPerMetre), 1, ink)
    fillRect(sheet, left, barY + 7, Math.round(barMetres * pixelsPerMetre), 1, ink)
    fillRect(sheet, left, barY - 3, 1, 14, ink)
    fillRect(sheet, Math.round(left + barMetres * pixelsPerMetre), barY - 3, 1, 14, ink)
    drawText(sheet, `${barMetres} M`, Math.round(left + barMetres * pixelsPerMetre) + 10, barY - 3, size, ink)

    const band = Number.isFinite(low) || Number.isFinite(high)
        ? `   Z ${Number.isFinite(low) ? metres(low) : "-"} TO ${Number.isFinite(high) ? metres(high) : "-"} M`
        : ""
    const turned = squaredBy ? `   TURNED ${metres(Math.round(squaredBy * 1800 / Math.PI) / 10)} DEG` : ""
    const caption = `${metres(maxX - minX)} X ${metres(maxY - minY)} M   GRID ${metres(minor)} M / ${metres(major)} M   VOXEL ${metres(voxel * 100)} CM${band}${turned}`
    drawText(sheet, caption, left, barY + 24, size, faint)
    if (title) {
        drawText(sheet, title, left, 12, 3, [220, 230, 245])
    }
    return sheet
}

// --- main ------------------------------------------------------------------

await new Command()
    .name("heatmap")
    .version("1.0.0")
    .description(
        "Top-down dark render of a cloud stream + trajectory from a memory2 .db or an .mcap, placed through tf alone. " +
            "Prefers the finished global_map, drawn as it is at one pixel per voxel; a per-scan stream is carried " +
            "into the world through the tf chain from the frame each cloud names, interpolated to its time.",
    )
    .arguments("<recording:string> [output:string]")
    .option("-w, --width <px:integer>", "Image width in pixels (default 1600; for a map, one pixel per 0.08 m voxel)")
    .option("--cloud <stream:string>", "Point cloud stream (default global_map, then pointlio_lidar, then lidar, then the only PointCloud2 stream)")
    .option("--tf <stream:string>", "The tf stream everything is placed through (default tf)")
    .option("--odom <stream:string>", "Take the path from this odometry stream rather than tf (default pointlio_odometry when drawing a map, which then needs no tf at all)")
    .option("--body <frame:string>", "The frame whose path is drawn, chained up to the tf root", { default: "base_link" })
    .option("--align-to <stream:string>", "Rigidly align onto this odometry stream's frame")
    .option("--extent <minX_minY_maxX_maxY:string>", "Force the world extent, for comparable renders (commas or underscores)")
    .option("--min-height <m:number>", "Drop points below this world z, in metres")
    .option("--max-height <m:number>", "Drop points above this world z, in metres")
    .option(
        "--slice <spec:string>",
        "out.png:minZ:maxZ[:title], one render per height band from a single read, e.g. floor1.png:-5.2:-3.3:FLOOR 1 (repeatable; replaces output, --min/--max-height and --title)",
        { collect: true },
    )
    .option("--voxel <m:number>", "Plan resolution: points are binned into voxels this size (default 0.08, the map's own; go finer with a per-scan --cloud)")
    .option("--no-path", "Leave the walked path off the plan")
    .option("--stride <n:integer>", "Use every Nth lidar scan", { default: 1 })
    .option("--title <text:string>", "A heading drawn above the plan, e.g. the floor's name")
    .option("--square [degrees:string]", "Rotate the plan so its walls run along the grid; a number of degrees, or no value to find it from the walls")
    .option("--crop <m:number>", "Draw only this far beyond the walked path, dropping returns seen through windows")
    .option("--no-measurements", "Draw the bare heatmap, with no metre grid, scale bar or dimensions")
    .action(async (options, recording, output) => {
        const target = output ?? recording.replace(/\.(db|mcap)$/, "") + "_heatmap.png"
        const source = recording.endsWith(".mcap") ? await mcapSource(recording) : sqliteSource(recording)
        options.cloud = pickStream(source, "PointCloud2", options.cloud, ["global_map", "pointlio_lidar", "lidar"])
        options.tf = pickStream(source, "TFMessage", options.tf, ["tf"])
        if (options.alignTo) {
            options.alignTo = pickStream(source, "Odometry", options.alignTo)
        }

        const readOdometry = async (stream) =>
            (await source.read(stream, "Odometry")).map((row) => ({ ts: row.ts, ...odometryPose(row.message) }))

        // A finished map (a stream named *map) already sits in the world frame and
        // its last message is the whole map, so only that is read.
        const isMap = /map/.test(options.cloud)
        const probe = await source.read(options.cloud, "PointCloud2", 1, { last: true })
        const probeFrame = probe[0]?.message.header.frame_id
        // The map's own voxel, read off its points: the smallest step between
        // distinct x coordinates.
        const mapVoxel = isMap && probe[0] ? voxelPitch(cloudXyz(probe[0].message)) : 0.08

        // A map plus an odometry stream needs no tf: /tf runs through every chunk
        // of a recording, so reading it means unpacking the whole file, where the
        // odometry is a few chunks post_process appended at the end.
        const odomStream = options.odom ?? (isMap && source.kinds().get("pointlio_odometry") === "Odometry" ? "pointlio_odometry" : undefined)
        let timeline = null
        let world = probeFrame
        let odom
        // The path is only read when something uses it: drawing it, or cropping
        // to it. A map drawn without either touches nothing but the last map chunk.
        const needsPath = options.path || options.crop !== undefined
        if (isMap && !needsPath) {
            odom = []
            console.error(`heatmap: world ${world}, no path wanted, so neither odometry nor tf is read`)
        } else if (isMap && odomStream !== undefined) {
            odom = await readOdometry(odomStream)
            console.error(`heatmap: world ${world}, path from ${odomStream} (${odom.length} poses), no tf read`)
        } else {
            const transforms = (await source.read(options.tf, "TFMessage")).map((row) => ({ ts: row.ts, edges: tfEdges(row.message, row.ts) }))
            if (transforms.length === 0) {
                console.error(`heatmap: no ${options.tf} in ${recording}`)
                Deno.exit(1)
            }
            timeline = tfTimeline(transforms)
            const roots = tfRoots(timeline)
            // The world is the root the clouds chain up to. A recording can carry a
            // second tree (a static camera tree under base_link, say) that never
            // joins the odometry's; picking a root by name would draw everything
            // in that one's frame.
            world = probeFrame === undefined
                ? roots[0]
                : chainToRoot(timeline, probeFrame, headerSeconds(probe[0].message.header) || probe[0].ts).root
            if (roots.length !== 1) {
                console.error(`heatmap: the tf tree has ${roots.length} roots (${roots.join(", ")}); ${options.cloud} reaches ${world}, so that is the world`)
            }
            if (odomStream !== undefined) {
                odom = await readOdometry(odomStream)
            } else {
                const found = trajectory(timeline, world, options.body)
                odom = found.poses
                console.error(`heatmap: world ${world}, trajectory ${world} -> ${found.child} (${odom.length} poses)`)
            }
        }
        if (needsPath && odom.length === 0) {
            console.error(`heatmap: no path under ${world}, so there is nothing to draw it from`)
            Deno.exit(1)
        }

        // The two SLAM systems have unrelated world origins, so nothing can be
        // compared until one trajectory is carried onto the other's frame.
        let alignment = IDENTITY
        if (options.alignTo) {
            const pairs = timeMatched(odom, await readOdometry(options.alignTo), 0.05)
            if (pairs.source.length < 3) {
                console.error(`heatmap: only ${pairs.source.length} poses matched ${options.alignTo} in time`)
                Deno.exit(1)
            }
            alignment = alignRigid(pairs.source, pairs.target)
            const residual = Math.sqrt(
                pairs.source.reduce((acc, point, i) => {
                    const moved = rotate(alignment.q, ...point).map((v, k) => v + alignment.t[k])
                    return acc + moved.reduce((sum, v, k) => sum + (v - pairs.target[i][k]) ** 2, 0)
                }, 0) / pairs.source.length,
            )
            console.log(
                `heatmap: aligned ${pairs.source.length} poses onto ${options.alignTo}, ` +
                    `fit rmse ${residual.toFixed(3)} m`,
            )
        }

        for (const pose of odom) {
            const moved = compose(alignment, { t: [pose.x, pose.y, pose.z], q: pose.q })
            pose.x = moved.t[0]
            pose.y = moved.t[1]
            pose.z = moved.t[2]
            pose.q = moved.q
        }

        // A per-scan stream is in whatever frame its header names -- the sensor's,
        // usually, with the mount between it and the body -- so each scan is
        // carried into the world through the tf chain at its own time.
        const voxel = options.voxel ?? (isMap ? mapVoxel : 0.08)
        if (isMap && voxel < mapVoxel - 1e-6) {
            console.error(`heatmap: ${options.cloud} is ${mapVoxel} m voxels, so --voxel ${voxel} adds nothing; use --cloud pointlio_lidar`)
        }

        // Every render is one height band. Without --slice there is exactly one,
        // from the positional output and --min/--max-height.
        const slices = (options.slice ?? []).map((spec) => {
            const [file, lowText, highText, ...title] = spec.split(":")
            return { target: file, low: Number(lowText), high: Number(highText), title: title.join(":") || undefined }
        })
        if (slices.length === 0) {
            slices.push({
                target: output ?? recording.replace(/\.(db|mcap)$/, "") + "_heatmap.png",
                low: options.minHeight ?? -Infinity,
                high: options.maxHeight ?? Infinity,
                title: options.title,
            })
        }
        for (const slice of slices) {
            if (Number.isNaN(slice.low) || Number.isNaN(slice.high)) {
                console.error(`heatmap: a --slice is out.png:minZ:maxZ[:title]; could not read ${slice.target}`)
                Deno.exit(1)
            }
            // Distinct 3-D voxels, with how often each was hit: a floor plan should
            // show a wall once however long it was looked at, and a voxel hit
            // only once is more likely a passer-by than a wall.
            slice.voxels = new Map()
        }

        // Squaring turns the plan so the building's walls run along the grid, and
        // it is applied before binning, so the voxels sit on the plan's own grid
        // rather than as tilted squares. The angle is found once, for every
        // slice, so all renders of a building share it and line up.
        let squaredBy = 0
        if (options.square === true) {
            const mapStream = [...source.kinds()].find(([name, kind]) => kind === "PointCloud2" && /map/.test(name))?.[0]
            const sampleRow = mapStream === undefined || mapStream === options.cloud
                ? probe[0]
                : (await source.read(mapStream, "PointCloud2", 1, { last: true }))[0]
            const points = cloudXyz(sampleRow.message)
            const sample = []
            for (let i = 0; i < points.length; i += 3) {
                sample.push(points[i], points[i + 1])
            }
            squaredBy = wallAngle(sample)
        } else if (options.square !== undefined) {
            squaredBy = Number(options.square) * Math.PI / 180
        }
        if (options.square !== undefined) {
            console.log(`heatmap: squared by ${(squaredBy * 180 / Math.PI).toFixed(1)} degrees`)
        }
        const cos = Math.cos(-squaredBy), sin = Math.sin(-squaredBy)
        const turn = (x, y) => [x * cos - y * sin, x * sin + y * cos]
        for (const pose of odom) {
            [pose.x, pose.y] = turn(pose.x, pose.y)
        }

        // Keys pack three voxel indices into one exact double: 18 bits each for
        // x and y (about 10 km either way at 4 cm) and 16 for z.
        const OFFSET = 2 ** 17
        const zBins = new Map()
        const bin = (worldX, worldY, z) => {
            const [x, y] = turn(worldX, worldY)
            const zBin = Math.floor(z * 10)
            zBins.set(zBin, (zBins.get(zBin) ?? 0) + 1)
            for (const slice of slices) {
                if (z >= slice.low && z <= slice.high) {
                    const key = ((Math.floor(x / voxel) + OFFSET) * 2 ** 18 + (Math.floor(y / voxel) + OFFSET)) * 2 ** 16 +
                        (Math.floor(z / voxel) + 2 ** 15)
                    slice.voxels.set(key, (slice.voxels.get(key) ?? 0) + 1)
                }
            }
        }
        const rootCounts = {}
        let scans = 0
        const place = (row) => {
            let placement = alignment
            if (!isMap) {
                // At the scan's own instant, not its arrival at the recorder.
                const chain = chainToRoot(timeline, row.message.header.frame_id, headerSeconds(row.message.header) || row.ts)
                rootCounts[chain.root] = (rootCounts[chain.root] ?? 0) + 1
                placement = compose(alignment, chain.transform)
            }
            const cloud = cloudXyz(row.message)
            // A map point is a whole voxel. Turned and re-binned at the same size,
            // one sample per voxel would leave some bins empty in a moire of holes,
            // so each voxel is sampled at four points across its footprint.
            const quarter = isMap && squaredBy !== 0 ? mapVoxel / 4 : 0
            const offsets = quarter ? [[-quarter, -quarter], [quarter, -quarter], [-quarter, quarter], [quarter, quarter]] : [[0, 0]]
            for (let i = 0; i < cloud.length; i += 3) {
                const [wx, wy, wz] = rotate(placement.q, cloud[i], cloud[i + 1], cloud[i + 2])
                for (const [dx, dy] of offsets) {
                    bin(wx + placement.t[0] + dx, wy + placement.t[1] + dy, wz + placement.t[2])
                }
            }
            scans++
            if (!isMap && scans % 500 === 0) {
                console.error(`heatmap: ${scans} scans binned`)
            }
        }
        const scanCount = isMap ? 1 : source.count(options.cloud)
        if (isMap) {
            console.error(`heatmap: drawing the last ${options.cloud} message as the map`)
            probe.forEach(place)
        } else {
            await source.each(options.cloud, "PointCloud2", options.stride, place)
        }
        source.close()

        // Every scan should reach the same root. More than one means the tf tree is
        // broken somewhere, and those scans are drawn short of the world frame.
        const reached = Object.entries(rootCounts).sort((a, b) => b[1] - a[1])
        if (reached.length > 0) {
            console.error(`heatmap: tf roots ${reached.map(([f, n]) => `${f} x${n}`).join(", ")}`)
        }
        if (reached.length > 1) {
            console.error(`heatmap: tf tree is disconnected — scans under ${reached.slice(1).map(([f]) => f).join(", ")} are misplaced`)
        }

        // Report the z distribution, because "chop above 2 m" is unanswerable
        // without knowing where this recording's floor actually sits.
        const zSorted = [...zBins.entries()].sort((a, b) => a[0] - b[0])
        const zTotal = zSorted.reduce((n, [, count]) => n + count, 0)
        const pct = (f) => {
            let seen = 0
            for (const [zBin, count] of zSorted) {
                seen += count
                if (seen >= zTotal * f) {
                    return zBin / 10
                }
            }
            return 0
        }
        console.log(
            `heatmap: world z  min ${pct(0).toFixed(1)}  p2 ${pct(0.02).toFixed(1)}  ` +
                `median ${pct(0.5).toFixed(1)}  p98 ${pct(0.98).toFixed(1)}  max ${pct(1).toFixed(1)} m`,
        )

        for (const slice of slices) {
            await renderSlice(slice, { odom, voxel, squaredBy, isMap, options })
        }
        console.log(`heatmap: ${odom.length} poses, ${scans} of ${scanCount} scans`)
    })
    .parse(Deno.args)
