// One core's share of the image re-encoding a conversion does (see recode.js).
//
// A batch arrives as { jobs: [{ frame, target, quality }] } and goes back in the same
// order as [{ encoding, width, height, step, bytes }], or { error } for a frame that
// would not convert. A frame is either compressed ({ codec, bytes }) or raw
// ({ encoding, width, height, step, bigEndian, bytes }).

import jpeg from "https://esm.sh/jpeg-js@0.4.4"
import UPNG from "https://esm.sh/upng-js@2.1.0"
import decodeWebp from "https://esm.sh/@jsquash/webp@1.5.0/decode.js"
import decodeJxl from "https://esm.sh/@jsquash/jxl@1.3.0/decode.js"

const RAW_8BIT = {
    rgb8: [3, "rgb"],
    bgr8: [3, "bgr"],
    rgba8: [4, "rgb"],
    bgra8: [4, "bgr"],
    mono8: [1, "grey"],
    "8uc1": [1, "grey"],
    "8uc3": [3, "bgr"],
}

// A decoded frame: { width, height, grey, rgba } for 8 bits, or
// { width, height, mono16 } (little-endian) for 16-bit greyscale.
const decode = async (frame) => {
    if (!frame.compressed) {
        return fromRaw(frame)
    }
    const { codec, bytes } = frame
    if (codec === "png") {
        const image = UPNG.decode(bytes)
        if (image.depth === 16 && image.ctype === 0) {
            // png is big-endian; dimos's mono16 is little-endian. No row padding at 16 bits.
            const mono16 = new Uint8Array(image.width * image.height * 2)
            const source = new Uint8Array(image.data)
            for (let at = 0; at < mono16.length; at += 2) {
                mono16[at] = source[at + 1]
                mono16[at + 1] = source[at]
            }
            return { width: image.width, height: image.height, mono16 }
        }
        const rgba = new Uint8Array(UPNG.toRGBA8(image)[0])
        return {
            width: image.width,
            height: image.height,
            grey: image.depth === 8 && (image.ctype === 0 || image.ctype === 4),
            rgba,
        }
    }
    if (codec === "jpeg") {
        const image = jpeg.decode(bytes, { useTArray: true })
        return { width: image.width, height: image.height, grey: false, rgba: image.data }
    }
    if (codec === "webp" || codec === "jxl") {
        // Both hand back RGBA at 8 bits; a deep jxl is never sent here.
        const own = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
        const image = codec === "webp" ? await decodeWebp(own) : await decodeJxl(own)
        return {
            width: image.width,
            height: image.height,
            grey: false,
            rgba: new Uint8Array(image.data.buffer),
        }
    }
    throw new Error(`cannot decode ${codec}`)
}

// A raw 8-bit frame widened to RGBA, whatever its channel order and row stride.
const fromRaw = (frame) => {
    const layout = RAW_8BIT[frame.encoding.toLowerCase()]
    if (!layout) {
        throw new Error(`cannot re-encode a ${frame.encoding} frame`)
    }
    const [channels, order] = layout
    const { width, height, bytes } = frame
    const step = frame.step || width * channels
    const rgba = new Uint8Array(width * height * 4)
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const from = y * step + x * channels
            const to = (y * width + x) * 4
            if (order === "grey") {
                rgba[to] = rgba[to + 1] = rgba[to + 2] = bytes[from]
            } else if (order === "bgr") {
                rgba[to] = bytes[from + 2]
                rgba[to + 1] = bytes[from + 1]
                rgba[to + 2] = bytes[from]
            } else {
                rgba[to] = bytes[from]
                rgba[to + 1] = bytes[from + 1]
                rgba[to + 2] = bytes[from + 2]
            }
            rgba[to + 3] = 255
        }
    }
    return { width, height, grey: order === "grey", rgba }
}

const convert = async ({ frame, target, quality }) => {
    const image = await decode(frame)
    if (image.mono16) {
        if (target === "jpeg") {
            throw new Error("a 16-bit frame cannot become a jpeg without losing its depth")
        }
        return {
            encoding: "mono16",
            width: image.width,
            height: image.height,
            step: image.width * 2,
            bytes: image.mono16,
        }
    }
    if (target === "jpeg") {
        // jpeg-js takes RGBA and ignores the alpha.
        const encoded = jpeg.encode(
            { data: image.rgba, width: image.width, height: image.height },
            quality,
        )
        return {
            encoding: "jpeg",
            width: image.width,
            height: image.height,
            step: 0,
            bytes: new Uint8Array(encoded.data),
        }
    }
    // raw: a greyscale source stays one channel, everything else is rgb8.
    if (image.grey) {
        const bytes = new Uint8Array(image.width * image.height)
        for (let i = 0; i < bytes.length; i++) {
            bytes[i] = image.rgba[i * 4]
        }
        return {
            encoding: "mono8",
            width: image.width,
            height: image.height,
            step: image.width,
            bytes,
        }
    }
    const bytes = new Uint8Array(image.width * image.height * 3)
    for (let i = 0, at = 0; at < bytes.length; i++, at += 3) {
        bytes[at] = image.rgba[i * 4]
        bytes[at + 1] = image.rgba[i * 4 + 1]
        bytes[at + 2] = image.rgba[i * 4 + 2]
    }
    return {
        encoding: "rgb8",
        width: image.width,
        height: image.height,
        step: image.width * 3,
        bytes,
    }
}

self.onmessage = async (event) => {
    const results = []
    const transfer = []
    for (const job of event.data.jobs) {
        try {
            const result = await convert(job)
            results.push(result)
            transfer.push(result.bytes.buffer)
        } catch (error) {
            results.push({ error: String(error && error.message ? error.message : error) })
        }
    }
    self.postMessage(results, transfer)
}
