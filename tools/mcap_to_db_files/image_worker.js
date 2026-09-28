// One core's share of the image re-encoding mcap_to_db does.
//
// Decoding a png and encoding a jpeg are the only expensive things in a
// conversion — everything else is a memcpy and a sqlite insert — so they run
// here, several at a time, rather than on the thread walking the mcap.
//
// A batch arrives as { frames: [{ codec, bytes }], target, quality } and comes
// back in the same order as [{ encoding, width, height, bytes }], or
// { error } for a frame that would not decode. Buffers are transferred both
// ways, so a frame is never copied between threads.

import jpeg from "https://esm.sh/jpeg-js@0.4.4"
import UPNG from "https://esm.sh/upng-js@2.1.0"
import decodeWebp from "https://esm.sh/@jsquash/webp@1.5.0/decode.js"
import decodeJxl from "https://esm.sh/@jsquash/jxl@1.3.0/decode.js"

// { width, height, channels, pixels } from a compressed frame, where pixels is
// RGBA for anything colour and one byte per pixel for greyscale. upng reports
// the source's colour type, which is what says whether a frame was greyscale
// before it was widened.
const decode = async (codec, bytes) => {
    if (codec === "png") {
        const image = UPNG.decode(bytes)
        if (image.depth === 16 && image.ctype === 0) {
            // png is big-endian; dimos's mono16 is little-endian. No row padding at 16 bits.
            const pixels = new Uint8Array(image.width * image.height * 2)
            const source = new Uint8Array(image.data)
            for (let at = 0; at < pixels.length; at += 2) {
                pixels[at] = source[at + 1]
                pixels[at + 1] = source[at]
            }
            return { width: image.width, height: image.height, grey: true, depth: 16, pixels }
        }
        const rgba = new Uint8Array(UPNG.toRGBA8(image)[0])
        return { width: image.width, height: image.height, grey: image.ctype === 0 || image.ctype === 4, depth: image.depth, rgba }
    }
    if (codec === "jpeg") {
        const image = jpeg.decode(bytes, { useTArray: true })
        return { width: image.width, height: image.height, grey: false, depth: 8, rgba: image.data }
    }
    if (codec === "webp" || codec === "jxl") {
        // Both hand back RGBA at 8 bits; a deep jxl never gets here.
        const own = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
        const image = codec === "webp" ? await decodeWebp(own) : await decodeJxl(own)
        return { width: image.width, height: image.height, grey: false, depth: 8, rgba: new Uint8Array(image.data.buffer) }
    }
    throw new Error(`cannot decode ${codec}`)
}

// RGBA down to one byte per pixel, for a frame that was greyscale to begin with.
const greyFrom = (rgba, width, height) => {
    const out = new Uint8Array(width * height)
    for (let i = 0; i < out.length; i++) {
        out[i] = rgba[i * 4]
    }
    return out
}

self.onmessage = async (event) => {
    const { frames, target, quality } = event.data
    const results = []
    const transfer = []
    for (const frame of frames) {
        try {
            const image = await decode(frame.codec, frame.bytes)
            if (image.depth === 16) {
                if (target === "jpeg") {
                    throw new Error("a 16-bit frame cannot become a jpeg without losing its depth")
                }
                results.push({ encoding: "mono16", width: image.width, height: image.height, step: image.width * 2, bytes: image.pixels })
                transfer.push(image.pixels.buffer)
                continue
            }
            if (target === "jpeg") {
                // jpeg-js takes RGBA and ignores the alpha it is handed.
                const encoded = jpeg.encode({ data: image.rgba, width: image.width, height: image.height }, quality)
                const bytes = new Uint8Array(encoded.data)
                results.push({ encoding: "jpeg", width: image.width, height: image.height, bytes })
                transfer.push(bytes.buffer)
                continue
            }
            // raw: a greyscale source stays one channel, everything else is rgb8.
            if (image.grey && image.depth === 8) {
                const bytes = greyFrom(image.rgba, image.width, image.height)
                results.push({ encoding: "mono8", width: image.width, height: image.height, step: image.width, bytes })
                transfer.push(bytes.buffer)
                continue
            }
            const rgb = new Uint8Array(image.width * image.height * 3)
            for (let i = 0, at = 0; at < rgb.length; i++, at += 3) {
                rgb[at] = image.rgba[i * 4]
                rgb[at + 1] = image.rgba[i * 4 + 1]
                rgb[at + 2] = image.rgba[i * 4 + 2]
            }
            results.push({ encoding: "rgb8", width: image.width, height: image.height, step: image.width * 3, bytes: rgb })
            transfer.push(rgb.buffer)
        } catch (error) {
            results.push({ error: String(error && error.message ? error.message : error) })
        }
    }
    self.postMessage(results, transfer)
}
