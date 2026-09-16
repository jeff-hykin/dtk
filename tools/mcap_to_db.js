#!/usr/bin/env -S deno run --allow-read --allow-write --allow-net --allow-env --allow-ffi --unstable-ffi
// mcap_to_db — copy ROS 2 (CDR) lidar / odometry / tf topics out of an .mcap into a
// dimos memory2 .db, re-encoded as LCM, so tools that only read memory2 (icp_stitch,
// Store(db).stream(...)) can work on a lite_record recording.
//
//   mcap_to_db in.mcap out.db [--map /topic=stream ...] [--stride N]
//              [--tf-prefer-message-frame FRAME] [--trim-to-odom]
//
// --tf-prefer-message-frame FRAME: when a tf edge (parent, child) carries more than
//   one value in the file (a recorder's original edge and a urdf's corrected one
//   republished side by side), keep only the samples from TF messages that also
//   mention FRAME, so consumers that need a static tree see one value.
// --trim-to-odom: drop point clouds stamped before the first odometry message, so
//   every scan can be placed.
//
// Without --map every PointCloud2, Odometry, TFMessage, CompressedImage, Image and
// CameraInfo channel is copied (raw Image blobs are LZ4-framed, codec lz4+lcm), named
// by its topic with the leading slash dropped and the rest joined by underscores
// (/livox/lidar -> livox_lidar). Row ts is the message header stamp (sensor clock)
// so lidar and odometry line up; the mcap log time is used when the stamp is zero.
// The tables mirror memory2's SqliteBackend DDL (registry row, rtree, jsonb tags).
import { Database } from "jsr:@db/sqlite@0.12"
import { McapIndexedReader } from "https://esm.sh/@mcap/core@2.1.7"
import { decompress as zstdDecompress } from "https://esm.sh/fzstd@0.1.1"
import lz4 from "https://esm.sh/lz4js@0.2.0"
import { PointCloud2, PointField, CompressedImage, Image, CameraInfo } from "https://esm.sh/jsr/@dimos/msgs@0.1.4/sensor_msgs"
import { Odometry } from "https://esm.sh/jsr/@dimos/msgs@0.1.4/nav_msgs"
import { TFMessage } from "https://esm.sh/jsr/@dimos/msgs@0.1.4/tf2_msgs"
import { TransformStamped } from "https://esm.sh/jsr/@dimos/msgs@0.1.4/geometry_msgs"

const positional = []
const mapping = new Map()
let stride = 1
let preferFrame = null
let trimToOdom = false
for (let i = 0; i < Deno.args.length; i++) {
    const arg = Deno.args[i]
    if (arg === "--tf-prefer-message-frame") {
        preferFrame = Deno.args[++i]
    } else if (arg === "--trim-to-odom") {
        trimToOdom = true
    } else if (arg === "--map") {
        const [topic, stream] = Deno.args[++i].split("=")
        mapping.set(topic, stream)
    } else if (arg === "--stride") {
        stride = Math.max(1, Number(Deno.args[++i]))
    } else if (arg === "-h" || arg === "--help") {
        console.log("usage: mcap_to_db in.mcap out.db [--map /topic=stream ...] [--stride N]")
        Deno.exit(0)
    } else {
        positional.push(arg)
    }
}
const [inPath, outPath] = positional
if (!inPath || !outPath) {
    console.error("usage: mcap_to_db in.mcap out.db [--map /topic=stream ...] [--stride N]")
    Deno.exit(2)
}

// --- CDR ---------------------------------------------------------------
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
        const text = new TextDecoder().decode(this.bytesIn.subarray(this.at, this.at + Math.max(0, length - 1)))
        this.at += length
        return text
    }
    bytes(count) {
        const out = this.bytesIn.slice(this.at, this.at + count)
        this.at += count
        return out
    }
    header() {
        return { stamp: { sec: this.int32(), nsec: this.uint32() }, frame_id: this.string() }
    }
    vector3() {
        return { x: this.float64(), y: this.float64(), z: this.float64() }
    }
    quaternion() {
        return { x: this.float64(), y: this.float64(), z: this.float64(), w: this.float64() }
    }
    float64s(count) {
        const out = []
        for (let i = 0; i < count; i++) {
            out.push(this.float64())
        }
        return out
    }
}

// The generated LCM classes size themselves through nested class instances, so
// nested fields are filled in place rather than replaced with plain objects.
const fillHeader = (target, header, seq) => {
    target.seq = seq
    target.stamp.sec = header.stamp.sec
    target.stamp.nsec = header.stamp.nsec
    target.frame_id = header.frame_id
}
const fillXyz = (target, source) => {
    target.x = source.x
    target.y = source.y
    target.z = source.z
    if ("w" in source) {
        target.w = source.w
    }
}

// Each converter returns { lcmBytes, stampSeconds, pose } from a CDR payload.
const CONVERTERS = {
    "sensor_msgs/msg/PointCloud2": (bytes, seq) => {
        const reader = new CdrReader(bytes)
        const header = reader.header()
        const message = new PointCloud2()
        fillHeader(message.header, header, seq)
        message.height = reader.uint32()
        message.width = reader.uint32()
        const fieldCount = reader.uint32()
        message.fields = []
        for (let i = 0; i < fieldCount; i++) {
            const field = new PointField()
            field.name = reader.string()
            field.offset = reader.uint32()
            field.datatype = reader.uint8()
            field.count = reader.uint32()
            message.fields.push(field)
        }
        message.fields_length = fieldCount
        message.is_bigendian = reader.uint8() !== 0
        message.point_step = reader.uint32()
        message.row_step = reader.uint32()
        const dataLength = reader.uint32()
        message.data = reader.bytes(dataLength)
        message.data_length = dataLength
        message.is_dense = reader.uint8() !== 0
        return { lcmBytes: message.encode(), stampSeconds: header.stamp.sec + header.stamp.nsec / 1e9, pose: null }
    },
    "nav_msgs/msg/Odometry": (bytes, seq) => {
        const reader = new CdrReader(bytes)
        const header = reader.header()
        const message = new Odometry()
        fillHeader(message.header, header, seq)
        message.child_frame_id = reader.string()
        const position = reader.vector3()
        const orientation = reader.quaternion()
        fillXyz(message.pose.pose.position, position)
        fillXyz(message.pose.pose.orientation, orientation)
        message.pose.covariance = reader.float64s(36)
        fillXyz(message.twist.twist.linear, reader.vector3())
        fillXyz(message.twist.twist.angular, reader.vector3())
        message.twist.covariance = reader.float64s(36)
        const pose = [position.x, position.y, position.z, orientation.x, orientation.y, orientation.z, orientation.w]
        return { lcmBytes: message.encode(), stampSeconds: header.stamp.sec + header.stamp.nsec / 1e9, pose }
    },
    "sensor_msgs/msg/CompressedImage": (bytes, seq) => {
        const reader = new CdrReader(bytes)
        const header = reader.header()
        const message = new CompressedImage()
        fillHeader(message.header, header, seq)
        message.format = reader.string()
        const dataLength = reader.uint32()
        message.data = reader.bytes(dataLength)
        message.data_length = dataLength
        return { lcmBytes: message.encode(), stampSeconds: header.stamp.sec + header.stamp.nsec / 1e9, pose: null }
    },
    "sensor_msgs/msg/Image": (bytes, seq) => {
        const reader = new CdrReader(bytes)
        const header = reader.header()
        const message = new Image()
        fillHeader(message.header, header, seq)
        message.height = reader.uint32()
        message.width = reader.uint32()
        message.encoding = reader.string()
        message.is_bigendian = reader.uint8()
        message.step = reader.uint32()
        const dataLength = reader.uint32()
        message.data = reader.bytes(dataLength)
        message.data_length = dataLength
        // Raw frames are big and repetitive; memory2's lz4+lcm codec is an LZ4
        // frame around the LCM bytes, which every reader here unwraps.
        return { lcmBytes: new Uint8Array(lz4.compress(message.encode())), stampSeconds: header.stamp.sec + header.stamp.nsec / 1e9, pose: null, codec: "lz4+lcm" }
    },
    "sensor_msgs/msg/CameraInfo": (bytes, seq) => {
        const reader = new CdrReader(bytes)
        const header = reader.header()
        const message = new CameraInfo()
        fillHeader(message.header, header, seq)
        message.height = reader.uint32()
        message.width = reader.uint32()
        message.distortion_model = reader.string()
        const dLength = reader.uint32()
        message.D = reader.float64s(dLength)
        message.D_length = dLength
        message.K = reader.float64s(9)
        message.R = reader.float64s(9)
        message.P = reader.float64s(12)
        message.binning_x = reader.uint32()
        message.binning_y = reader.uint32()
        message.roi.x_offset = reader.uint32()
        message.roi.y_offset = reader.uint32()
        message.roi.height = reader.uint32()
        message.roi.width = reader.uint32()
        message.roi.do_rectify = reader.uint8() !== 0
        return { lcmBytes: message.encode(), stampSeconds: header.stamp.sec + header.stamp.nsec / 1e9, pose: null }
    },
    "tf2_msgs/msg/TFMessage": (bytes, seq) => {
        const reader = new CdrReader(bytes)
        const message = new TFMessage()
        const count = reader.uint32()
        message.transforms = []
        let stamp = 0
        for (let i = 0; i < count; i++) {
            const transform = new TransformStamped()
            const header = reader.header()
            fillHeader(transform.header, header, seq)
            transform.child_frame_id = reader.string()
            fillXyz(transform.transform.translation, reader.vector3())
            fillXyz(transform.transform.rotation, reader.quaternion())
            message.transforms.push(transform)
            stamp = stamp || header.stamp.sec + header.stamp.nsec / 1e9
        }
        message.transforms_length = count
        return { message, stampSeconds: stamp, pose: null, tf: true }
    },
}
const PAYLOAD_MODULES = {
    "sensor_msgs/msg/CompressedImage": "dimos.msgs.sensor_msgs.CompressedImage.CompressedImage",
    "sensor_msgs/msg/Image": "dimos.msgs.sensor_msgs.Image.Image",
    "sensor_msgs/msg/CameraInfo": "dimos.msgs.sensor_msgs.CameraInfo.CameraInfo",
    "sensor_msgs/msg/PointCloud2": "dimos.msgs.sensor_msgs.PointCloud2.PointCloud2",
    "nav_msgs/msg/Odometry": "dimos.msgs.nav_msgs.Odometry.Odometry",
    "tf2_msgs/msg/TFMessage": "dimos.msgs.tf2_msgs.TFMessage.TFMessage",
}

// --- memory2 write side (mirrors dimos SqliteBackend / icp_stitch memory2.rs) --------------
const CODECS = { "sensor_msgs/msg/Image": "lz4+lcm" }
const streamConfig = (payloadModule, codec = "lcm") =>
    `{"payload_module": "${payloadModule}", "codec_id": "${codec}", "eager_blobs": false, "page_size": 256, ` +
    `"blob_store": {"class": "dimos.memory2.blobstore.sqlite.SqliteBlobStore", "config": {"path": null}}, ` +
    `"vector_store": {"class": "dimos.memory2.vectorstore.sqlite.SqliteVectorStore", "config": {"path": null}}, ` +
    `"notifier": {"class": "dimos.memory2.notifier.subject.SubjectNotifier", "config": {}}}`

const db = new Database(outPath)
db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = OFF;")
db.exec("CREATE TABLE IF NOT EXISTS _streams (name TEXT PRIMARY KEY, config TEXT NOT NULL)")
const createStream = (name, payloadModule, codec) => {
    if (name.includes('"')) {
        throw new Error(`illegal stream name ${name}`)
    }
    db.prepare("INSERT OR REPLACE INTO _streams (name, config) VALUES (?, ?)").run(name, streamConfig(payloadModule, codec))
    db.exec(`DROP TABLE IF EXISTS "${name}"; DROP TABLE IF EXISTS "${name}_rtree"; DROP TABLE IF EXISTS "${name}_blob";`)
    db.exec(`CREATE TABLE IF NOT EXISTS "${name}" (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL NOT NULL, value NUMERIC,
        pose_x REAL, pose_y REAL, pose_z REAL, pose_qx REAL, pose_qy REAL, pose_qz REAL, pose_qw REAL,
        tags BLOB DEFAULT (jsonb('{}')));
        CREATE VIRTUAL TABLE IF NOT EXISTS "${name}_rtree" USING rtree(id, x_min, x_max, y_min, y_max, z_min, z_max);
        CREATE TABLE IF NOT EXISTS "${name}_blob" (id INTEGER PRIMARY KEY, data BLOB NOT NULL);`)
    return {
        meta: db.prepare(`INSERT INTO "${name}" (ts, pose_x, pose_y, pose_z, pose_qx, pose_qy, pose_qz, pose_qw) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
        rtree: db.prepare(`INSERT INTO "${name}_rtree" (id, x_min, x_max, y_min, y_max, z_min, z_max) VALUES (?, ?, ?, ?, ?, ?, ?)`),
        blob: db.prepare(`INSERT INTO "${name}_blob" (id, data) VALUES (?, ?)`),
    }
}

// --- read the mcap ----------------------------------------------------------
const file = await Deno.open(inPath, { read: true })
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
const reader = await McapIndexedReader.Initialize({
    readable,
    decompressHandlers: {
        zstd: (bytes, expected) => zstdDecompress(bytes, new Uint8Array(Number(expected))),
        lz4: (bytes) => new Uint8Array(lz4.decompress(bytes)),
    },
})

const streamName = (topic) => mapping.get(topic) ?? topic.replace(/^\//, "").replace(/\//g, "_")
const plan = new Map() // channel id -> { name, convert, statements, seq }
for (const channel of reader.channelsById.values()) {
    const schema = reader.schemasById.get(channel.schemaId)
    const convert = schema && CONVERTERS[schema.name]
    if (!convert || channel.messageEncoding !== "cdr") {
        continue
    }
    if (mapping.size > 0 && !mapping.has(channel.topic)) {
        continue
    }
    const name = streamName(channel.topic)
    plan.set(channel.id, { name, topic: channel.topic, convert, statements: createStream(name, PAYLOAD_MODULES[schema.name], CODECS[schema.name] ?? "lcm"), seq: 0, written: 0 })
}
if (plan.size === 0) {
    console.error("no PointCloud2 / Odometry / TFMessage cdr channels matched")
    Deno.exit(1)
}
for (const entry of plan.values()) {
    console.log(`${entry.topic} -> ${entry.name}`)
}

const started = performance.now()
let seen = 0
const tfBuffer = [] // { entry, ts, message }
const earlyScans = [] // scans seen before the first odometry stamp (only with --trim-to-odom)
let firstOdomStamp = null
let trimmed = 0
const insert = (entry, ts, pose, lcmBytes) => {
    const [x, y, z, qx, qy, qz, qw] = pose ?? [null, null, null, null, null, null, null]
    const { lastInsertRowId } = entry.statements.meta.run(ts, x, y, z, qx, qy, qz, qw)
    const id = lastInsertRowId ?? db.lastInsertRowId
    if (pose) {
        entry.statements.rtree.run(id, x, x, y, y, z, z)
    }
    entry.statements.blob.run(id, lcmBytes)
    entry.written++
}
db.exec("BEGIN")
for await (const message of reader.readMessages({ topics: [...plan.values()].map((entry) => entry.topic) })) {
    const entry = plan.get(message.channelId)
    if (!entry || entry.seq++ % stride !== 0) {
        continue
    }
    const converted = entry.convert(message.data, entry.seq)
    const ts = converted.stampSeconds > 0 ? converted.stampSeconds : Number(message.logTime) / 1e9
    if (converted.tf) {
        tfBuffer.push({ entry, ts, message: converted.message })
    } else if (trimToOdom && converted.pose === null && firstOdomStamp === null) {
        earlyScans.push({ entry, ts, lcmBytes: converted.lcmBytes })
    } else if (trimToOdom && converted.pose === null && ts < firstOdomStamp) {
        // read order is log time, which can run ahead of the stamps
        trimmed++
    } else {
        if (converted.pose !== null && firstOdomStamp === null) {
            firstOdomStamp = ts
            for (const scan of earlyScans) {
                if (scan.ts >= firstOdomStamp) {
                    insert(scan.entry, scan.ts, null, scan.lcmBytes)
                } else {
                    trimmed++
                }
            }
            earlyScans.length = 0
        }
        insert(entry, ts, converted.pose, converted.lcmBytes)
    }
    if (++seen % 2000 === 0) {
        db.exec("COMMIT; BEGIN")
        console.log(`  ${seen} rows, ${((performance.now() - started) / 1000).toFixed(0)} s`)
    }
}
for (const scan of earlyScans) {
    insert(scan.entry, scan.ts, null, scan.lcmBytes)
}

// tf: resolve edges that carry more than one value in the file.
const edgeKey = (t) => `${t.header.frame_id}->${t.child_frame_id}`
const valueKey = (t) => {
    const { translation: v, rotation: q } = t.transform
    return [v.x, v.y, v.z, q.x, q.y, q.z, q.w].map((n) => n.toFixed(6)).join(",")
}
const valuesByEdge = new Map()
for (const { message } of tfBuffer) {
    for (const t of message.transforms) {
        const key = edgeKey(t)
        if (!valuesByEdge.has(key)) {
            valuesByEdge.set(key, new Set())
        }
        valuesByEdge.get(key).add(valueKey(t))
    }
}
// A moving edge (odom->base_link) has thousands of values; a re-published static
// edge has two or three. Only the latter is a conflict worth resolving.
const conflicting = new Set([...valuesByEdge.entries()].filter(([, values]) => values.size > 1 && values.size <= 8).map(([key]) => key))
if (conflicting.size > 0) {
    console.log(`tf edges with more than one value: ${[...conflicting].join(", ")}`)
    if (!preferFrame) {
        console.log("  (pass --tf-prefer-message-frame FRAME to keep one; all samples kept as-is)")
    }
}
let droppedTransforms = 0
for (const { entry, ts, message } of tfBuffer) {
    if (preferFrame && conflicting.size > 0) {
        const mentionsFrame = message.transforms.some((t) => t.header.frame_id === preferFrame || t.child_frame_id === preferFrame)
        const kept = message.transforms.filter((t) => !conflicting.has(edgeKey(t)) || mentionsFrame)
        droppedTransforms += message.transforms.length - kept.length
        if (kept.length === 0) {
            continue
        }
        message.transforms = kept
        message.transforms_length = kept.length
    }
    insert(entry, ts, null, message.encode())
}
if (droppedTransforms > 0) {
    console.log(`tf: dropped ${droppedTransforms} conflicting transform(s) from messages not mentioning ${preferFrame}`)
}
if (trimmed > 0) {
    console.log(`trimmed ${trimmed} scan(s) stamped before the first odometry message`)
}
db.exec("COMMIT")
db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
db.close()
file.close()
for (const entry of plan.values()) {
    console.log(`${entry.name}: ${entry.written} rows`)
}
console.log(`wrote ${outPath} in ${((performance.now() - started) / 1000).toFixed(0)} s`)
