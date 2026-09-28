#!/usr/bin/env -S deno run --allow-read --allow-write --allow-net --allow-env --allow-ffi --unstable-ffi
// mcap_to_db — copy ROS 2 (CDR) lidar / odometry / tf topics out of an .mcap into a
// dimos memory2 .db, re-encoded as LCM, so tools that only read memory2 (icp_stitch,
// Store(db).stream(...)) can work on a lite_record recording.
//
//   mcap_to_db in.mcap out.db [--map /topic=stream ...] [--skip /topic ...]
//              [--image-encoding jpeg|raw|keep] [--jpeg-quality N] [--stride N]
//              [--tf-prefer-message-frame FRAME] [--trim-to-odom]
//
// --skip TOPIC: leave a topic out, for one whose stream is written by something
//   else afterwards. --map already acts as a whitelist when given.
//
// --image-encoding: what a CompressedImage topic becomes. dimos carries a frame in
//   sensor_msgs.Image with the codec in `encoding`, not in a separate type, and
//   codec_for() hands any Image payload a JpegCodec, so `jpeg` (the default) is what
//   a recording made by dimos itself looks like: the stream becomes an Image under
//   the "jpeg" codec and loses a trailing /compressed from its name. A frame already
//   in jpeg is passed through rather than re-encoded, so no generation is lost.
//   `raw` decodes instead, to rgb8 or mono8 under lz4+lcm. `keep` only rewraps what
//   Image can already hold and leaves anything else a CompressedImage.
//   Topics recorded as a raw sensor_msgs/Image are never touched by this: depth is
//   16-bit and jpeg is not, so re-encoding one would destroy it. For the same reason a
//   16-bit png (compressed depth) stays a png under jpeg and keep, and becomes mono16 under
//   raw; a 16-bit jxl stays a jxl under all three. png, webp and 8-bit jxl are decoded.
// --jpeg-quality N: quality for the above, 1-100. Default 50, which is what dimos's
//   own JpegCodec uses.
//
// --tf-prefer-message-frame FRAME: when a tf edge (parent, child) carries more than
//   one value in the file (a recorder's original edge and a urdf's corrected one
//   republished side by side), keep only the samples from TF messages that also
//   mention FRAME, so consumers that need a static tree see one value.
// --trim-to-odom: drop point clouds stamped before the first odometry message, so
//   every scan can be placed.
//
// Without --map every PointCloud2, Odometry, TFMessage, CompressedImage, Image, Imu
// and CameraInfo channel is copied (raw Image blobs are LZ4-framed, codec lz4+lcm),
// named by its topic with the leading slash dropped and the rest joined by underscores
// (/livox/lidar -> livox_lidar). Two topics can flatten onto one name, and then each
// of them is written with __ for its slashes instead, so they stay apart. Row ts is
// the message header stamp (sensor clock) so lidar and odometry line up; the mcap log
// time is used when the stamp is zero.
// The tables mirror memory2's SqliteBackend DDL (registry row, rtree, jsonb tags).
import { Database } from "jsr:@db/sqlite@0.12"
import { McapIndexedReader } from "https://esm.sh/@mcap/core@2.1.7"
import { decompress as zstdDecompress } from "https://esm.sh/fzstd@0.1.1"
import lz4 from "https://esm.sh/lz4js@0.2.0"
import { PointCloud2, PointField, CompressedImage, Image, CameraInfo, Imu } from "https://esm.sh/jsr/@dimos/msgs@0.1.4/sensor_msgs"
import { Odometry } from "https://esm.sh/jsr/@dimos/msgs@0.1.4/nav_msgs"
import { TFMessage } from "https://esm.sh/jsr/@dimos/msgs@0.1.4/tf2_msgs"
import { TransformStamped } from "https://esm.sh/jsr/@dimos/msgs@0.1.4/geometry_msgs"

const positional = []
const mapping = new Map()
const skipped = new Set()
let imageEncoding = "jpeg"
let jpegQuality = 50
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
    } else if (arg === "--image-encoding") {
        imageEncoding = Deno.args[++i]
        if (!["jpeg", "raw", "keep"].includes(imageEncoding)) {
            console.error(`--image-encoding must be jpeg, raw or keep, not ${imageEncoding}`)
            Deno.exit(2)
        }
    } else if (arg === "--jpeg-quality") {
        jpegQuality = Math.min(100, Math.max(1, Number(Deno.args[++i])))
    } else if (arg === "--skip") {
        skipped.add(Deno.args[++i])
    } else if (arg === "--stride") {
        stride = Math.max(1, Number(Deno.args[++i]))
    } else if (arg === "-h" || arg === "--help") {
        console.log("usage: mcap_to_db in.mcap out.db [--map /topic=stream ...] [--skip /topic ...]\n" +
            "                  [--image-encoding jpeg|raw|keep] [--jpeg-quality N] [--stride N]")
        Deno.exit(0)
    } else {
        positional.push(arg)
    }
}
const [inPath, outPath] = positional
if (!inPath || !outPath) {
    console.error("usage: mcap_to_db in.mcap out.db [--map /topic=stream ...] [--skip /topic ...] [--stride N]")
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

// The compressed codecs dimos's sensor_msgs.Image understands in its `encoding`
// field. Image.lcm_decode dispatches on that field and knows the raw layouts plus
// "jpeg"; "png" raises there, so png bytes can only reach an Image by being
// re-encoded (--image-encoding jpeg, the default) or decoded (raw). Under `keep`
// a png channel stays a CompressedImage, which readers that decode one
// (memory_world wraps such a stream in a cv2 decoder) handle.
const CARRIED_BY_IMAGE = new Set(["jpeg"])

// What this tool can decode on the way to another encoding.
const DECODABLE = new Set(["png", "jpeg", "webp", "jxl"])

// Bits per sample in a jxl frame, from its image metadata, or `null` when the header
// holds something this does not walk (a preview or animation header) — a caller then
// treats the frame as possibly deep. A bare codestream starts ff0a; the container
// form carries it in a jxlc box, or split over jxlp boxes whose first holds the header.
const jxlBitDepth = (data) => {
    let stream = data
    if (data[0] !== 0xff) {
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
        stream = null
        for (let at = 0; at + 8 <= data.length; ) {
            let size = view.getUint32(at)
            const type = String.fromCharCode(...data.subarray(at + 4, at + 8))
            let header = 8
            if (size === 1) {
                size = Number(view.getBigUint64(at + 8))
                header = 16
            } else if (size === 0) {
                size = data.length - at
            }
            if (type === "jxlc" || type === "jxlp") {
                stream = data.subarray(at + header + (type === "jxlp" ? 4 : 0), at + size)
                break
            }
            if (size < header) {
                return null
            }
            at += size
        }
    }
    if (!stream || stream[0] !== 0xff || stream[1] !== 0x0a) {
        return null
    }
    let bit = 16
    const u = (count) => {
        let value = 0
        for (let i = 0; i < count; i++, bit++) {
            value |= ((stream[bit >> 3] >> (bit & 7)) & 1) << i
        }
        return value
    }
    const u32 = (...choices) => {
        const [bits, offset] = choices[u(2)]
        return u(bits) + offset
    }
    const sizeHeader = () => {
        const small = u(1)
        const dimension = () => (small ? u(5) : u32([9, 1], [13, 1], [18, 1], [30, 1]))
        dimension()
        if (u(3) === 0) {
            dimension()
        }
    }
    sizeHeader()
    if (u(1)) {
        return 8 // all_default metadata
    }
    if (u(1)) {
        u(3) // orientation
        if (u(1)) {
            sizeHeader() // intrinsic size
        }
        if (u(1) || u(1)) {
            return null // preview or animation header
        }
    }
    return u(1) ? u32([0, 32], [0, 16], [0, 24], [6, 1]) : u32([0, 8], [0, 10], [0, 12], [6, 1])
}

// Whether a frame's bytes are the codec it claims, for codecs whose size the tool
// never needs to read itself because a worker decodes them.
const hasSignature = (codec, data) => {
    if (codec === "webp") {
        return data.length >= 12 && String.fromCharCode(...data.subarray(0, 4)) === "RIFF" &&
            String.fromCharCode(...data.subarray(8, 12)) === "WEBP"
    }
    if (codec === "jxl") {
        return (data[0] === 0xff && data[1] === 0x0a) ||
            String.fromCharCode(...data.subarray(4, 8)) === "JXL "
    }
    return frameSize(codec, data) !== null
}

// A compressed frame's pixel size, read out of the frame itself. `null` when the
// bytes are not the codec they claim to be, which sends the frame down the
// CompressedImage path rather than writing an Image with a bogus width.
const frameSize = (codec, data) => {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    if (codec === "png") {
        // 8-byte signature, then an IHDR chunk whose width and height lead its body.
        if (data.length < 24 || view.getUint32(0) !== 0x89504e47 || view.getUint32(12) !== 0x49484452) {
            return null
        }
        return { width: view.getUint32(16), height: view.getUint32(20) }
    }
    if (codec === "jpeg") {
        if (data.length < 4 || view.getUint16(0) !== 0xffd8) {
            return null
        }
        // Walk the marker segments to the frame header; only SOFn carries the size,
        // and SOF4/SOF8/SOF12 are not frame headers despite sitting in that range.
        for (let at = 2; at + 4 <= data.length; ) {
            if (view.getUint8(at) !== 0xff) {
                return null
            }
            const marker = view.getUint8(at + 1)
            if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
                at += 2
                continue
            }
            const length = view.getUint16(at + 2)
            if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
                if (at + 9 > data.length) {
                    return null
                }
                return { width: view.getUint16(at + 7), height: view.getUint16(at + 5) }
            }
            at += 2 + length
        }
        return null
    }
    return null
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
    // dimos carries a compressed frame in sensor_msgs.Image with the codec in
    // `encoding` and the payload in `data`, rather than in a separate type, so a
    // CompressedImage is written as an Image when its channel can reach one. A
    // channel whose codec Image already holds passes its bytes through untouched;
    // one that has to be re-encoded hands the frame back for a worker to do, since
    // that is the only expensive step in a conversion. Width and height are not in
    // the ROS message, so they are read out of the frame header.
    "sensor_msgs/msg/CompressedImage": (bytes, seq, asImage = false, recode = null) => {
        const reader = new CdrReader(bytes)
        const header = reader.header()
        const format = reader.string()
        const dataLength = reader.uint32()
        const data = reader.bytes(dataLength)
        const stampSeconds = header.stamp.sec + header.stamp.nsec / 1e9
        const codec = format.toLowerCase().split(/[;, ]/)[0]
        if (asImage && recode) {
            return { recode: { codec, bytes: data }, header, seq, stampSeconds, pose: null }
        }
        if (asImage) {
            const size = frameSize(codec, data)
            // The stream is already registered as an Image, so a frame that cannot be
            // sized has nowhere valid to go; writing a CompressedImage into it would
            // leave rows the reader cannot decode.
            if (!size) {
                throw new Error(`frame ${seq} is ${format}, which does not parse as a frame this stream can hold`)
            }
            const message = new Image()
            fillHeader(message.header, header, seq)
            message.height = size.height
            message.width = size.width
            message.encoding = codec
            message.is_bigendian = 0
            message.step = 0 // no row stride in a compressed frame
            message.data = data
            message.data_length = dataLength
            return { lcmBytes: message.encode(), stampSeconds, pose: null }
        }
        const message = new CompressedImage()
        fillHeader(message.header, header, seq)
        message.format = format
        message.data = data
        message.data_length = dataLength
        return { lcmBytes: message.encode(), stampSeconds, pose: null }
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
    // The three covariances are fixed float64[9], so they carry no length prefix.
    "sensor_msgs/msg/Imu": (bytes, seq) => {
        const reader = new CdrReader(bytes)
        const header = reader.header()
        const message = new Imu()
        fillHeader(message.header, header, seq)
        fillXyz(message.orientation, reader.quaternion())
        message.orientation_covariance = reader.float64s(9)
        fillXyz(message.angular_velocity, reader.vector3())
        message.angular_velocity_covariance = reader.float64s(9)
        fillXyz(message.linear_acceleration, reader.vector3())
        message.linear_acceleration_covariance = reader.float64s(9)
        return { lcmBytes: message.encode(), stampSeconds: header.stamp.sec + header.stamp.nsec / 1e9, pose: null }
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
    "sensor_msgs/msg/Imu": "dimos.msgs.sensor_msgs.Imu.Imu",
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

const flatName = (topic) => topic.replace(/^\//, "").replace(/\//g, "_")
const spacedName = (topic) => topic.replace(/^\//, "").replace(/\//g, "__")

const eligible = []
for (const channel of reader.channelsById.values()) {
    const schema = reader.schemasById.get(channel.schemaId)
    const convert = schema && CONVERTERS[schema.name]
    if (!convert || channel.messageEncoding !== "cdr") {
        continue
    }
    if (mapping.size > 0 && !mapping.has(channel.topic)) {
        continue
    }
    if (skipped.has(channel.topic)) {
        continue
    }
    eligible.push({ channel, schema, convert, name: mapping.get(channel.topic) })
}

// Which payload a CompressedImage channel writes is a property of the channel, not
// of one message, because the stream's registry row is fixed before any row is
// written. So each one is decided here from its first frame and every later frame
// follows that, rather than a stray frame in another codec flipping the type
// halfway through the stream.
const COMPRESSED_SUFFIX = "/compressed"
for (const item of eligible.filter((item) => item.schema.name === "sensor_msgs/msg/CompressedImage")) {
    item.asImage = false
    for await (const message of reader.readMessages({ topics: [item.channel.topic] })) {
        const peek = new CdrReader(message.data)
        peek.header()
        const codec = peek.string().toLowerCase().split(/[;, ]/)[0]
        const bytes = peek.bytes(peek.uint32())
        if (!hasSignature(codec, bytes)) {
            break // not the codec it claims; leave the channel alone
        }
        item.codec = codec
        // A deep frame is depth: jpeg holds 8 bits, so it is only ever decoded to mono16
        // (raw, png only — the jxl decoder hands back 8 bits) or left as it came,
        // never squeezed through jpeg. A jxl header this cannot read counts as deep.
        const deep = (codec === "png" && bytes[24] === 16) || (codec === "jxl" && jxlBitDepth(bytes) !== 8)
        if (deep) {
            if (imageEncoding === "raw" && codec === "png" && bytes[25] === 0) {
                item.asImage = true
                item.recode = "raw"
            }
            break
        }
        if (imageEncoding === "jpeg" && DECODABLE.has(codec)) {
            // Already jpeg means the bytes go straight through: re-encoding a jpeg
            // only loses a generation for nothing.
            item.asImage = true
            item.recode = codec === "jpeg" ? null : "jpeg"
        } else if (imageEncoding === "raw" && DECODABLE.has(codec)) {
            item.asImage = true
            item.recode = "raw"
        } else if (CARRIED_BY_IMAGE.has(codec)) {
            item.asImage = true
            item.recode = null
        }
        break
    }
    // The recorder marks a compressed topic with this suffix so it can sit beside the
    // decoded one; carrying it into a stream that is now an Image would misname it.
    if (item.asImage && item.name === undefined && item.channel.topic.endsWith(COMPRESSED_SUFFIX)) {
        item.renamed = item.channel.topic.slice(0, -COMPRESSED_SUFFIX.length)
    }
}

// Joining a topic's segments with _ can land two different topics on one name
// (/a/b/c and /a/b_c both give a_b_c), which used to merge their rows into a single
// stream with nothing said. Anything that would collide is written with __ for its
// slashes instead, which separates those two and, being derived from the topic alone,
// comes out the same on every run. --map is what the caller asked for, so those names
// are reserved first and never rewritten.
const taken = new Set()
for (const item of eligible.filter((item) => item.name !== undefined)) {
    if (taken.has(item.name)) {
        console.error(`--map sends more than one topic to the stream "${item.name}"`)
        Deno.exit(2)
    }
    taken.add(item.name)
}
const auto = eligible.filter((item) => item.name === undefined).sort((a, b) => (a.channel.topic < b.channel.topic ? -1 : 1))
const nameSource = (item) => item.renamed ?? item.channel.topic
const flatCount = new Map()
for (const item of auto) {
    flatCount.set(flatName(nameSource(item)), (flatCount.get(flatName(nameSource(item))) ?? 0) + 1)
}
for (const item of auto) {
    const flat = flatName(nameSource(item))
    if (flatCount.get(flat) === 1 && !taken.has(flat)) {
        item.name = flat
        taken.add(flat)
        continue
    }
    let candidate = spacedName(nameSource(item))
    for (let suffix = 2; taken.has(candidate); suffix++) {
        candidate = `${spacedName(nameSource(item))}_${suffix}`
    }
    item.name = candidate
    taken.add(candidate)
    console.warn(`warning: ${item.channel.topic} collides with another topic on "${flat}", writing it as "${candidate}"`)
}

const plan = new Map() // channel id -> { name, convert, statements, seq }
for (const item of eligible) {
    const schemaName = item.asImage ? "sensor_msgs/msg/Image" : item.schema.name
    // dimos stores a jpeg Image under the "jpeg" codec, not "lcm": codec_for() hands
    // any Image payload a JpegCodec by default, and that is what a recording made by
    // dimos itself carries (see rtab/alfred2.db). The blob either codec reads is the
    // same LCM Image envelope, but the registry row should say what wrote it.
    // A raw frame gets the lz4 wrapper a recorded one has; a compressed frame is
    // already small and is stored under the codec that wrote it.
    const codec = item.asImage ? (item.recode === "raw" ? "lz4+lcm" : "jpeg") : CODECS[item.schema.name] ?? "lcm"
    const convert = item.asImage ? (bytes, seq) => item.convert(bytes, seq, true, item.recode) : item.convert
    plan.set(item.channel.id, { name: item.name, topic: item.channel.topic, convert, recode: item.recode, statements: createStream(item.name, PAYLOAD_MODULES[schemaName], codec), seq: 0, written: 0 })
}
if (plan.size === 0) {
    console.error(`no cdr channels matched; convertible schemas are ${Object.keys(CONVERTERS).join(", ")}`)
    Deno.exit(1)
}
for (const entry of plan.values()) {
    console.log(`${entry.topic} -> ${entry.name}`)
}

// Re-encoding runs on every core but two, in batches, because decoding a png and
// encoding a jpeg together cost far more than the rest of a conversion put
// together and would otherwise idle the machine one frame at a time. Frames are
// held in arrival order and written in that order, so a stream's rows still climb
// in time even though the work finishes out of order.
const recodeWanted = [...plan.values()].some((entry) => entry.recode)
const workerCount = recodeWanted ? Math.max(1, (navigator.hardwareConcurrency || 4) - 2) : 0
const workers = []
for (let i = 0; i < workerCount; i++) {
    workers.push(new Worker(import.meta.resolve("./mcap_to_db_files/image_worker.js"), { type: "module" }))
}
const runBatch = (worker, frames, target) =>
    new Promise((resolve, reject) => {
        worker.onmessage = (event) => resolve(event.data)
        worker.onerror = (event) => reject(new Error(event.message))
        worker.postMessage(
            { frames: frames.map((f) => ({ codec: f.recode.codec, bytes: f.recode.bytes })), target, quality: jpegQuality },
            frames.map((f) => f.recode.bytes.buffer),
        )
    })

const BATCH = 24 // frames per worker per round
let pending = [] // { entry, ts, recode, header, seq }
const flushPending = async () => {
    if (pending.length === 0) {
        return
    }
    // Sliced per target, since one recording can want jpeg for colour and raw for
    // something else, and a batch carries one target for all its frames.
    const slices = []
    for (const target of new Set(pending.map((frame) => frame.entry.recode))) {
        const group = pending.filter((frame) => frame.entry.recode === target)
        for (let at = 0; at < group.length; at += BATCH) {
            slices.push(group.slice(at, at + BATCH))
        }
    }
    const results = await Promise.all(
        slices.map((slice, index) => runBatch(workers[index % workers.length], slice, slice[0].entry.recode)),
    )
    for (const [index, slice] of slices.entries()) {
        for (const [at, frame] of slice.entries()) {
            const out = results[index][at]
            if (out.error) {
                throw new Error(`${frame.entry.topic}: ${out.error}`)
            }
            const message = new Image()
            fillHeader(message.header, frame.header, frame.seq)
            message.height = out.height
            message.width = out.width
            message.encoding = out.encoding
            message.is_bigendian = 0
            message.step = out.step ?? 0
            message.data = out.bytes
            message.data_length = out.bytes.length
            const encoded = message.encode()
            insert(frame.entry, frame.ts, null, out.step ? new Uint8Array(lz4.compress(encoded)) : encoded)
        }
    }
    pending = []
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
    if (converted.recode) {
        pending.push({ entry, ts, recode: converted.recode, header: converted.header, seq: converted.seq })
        if (pending.length >= BATCH * workers.length) {
            await flushPending()
        }
    } else if (converted.tf) {
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
await flushPending()
for (const worker of workers) {
    worker.terminate()
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
