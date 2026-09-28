// An LZ4 frame that the C library (python's lz4, Foxglove's mcap readers) can read.
//
// lz4js's compressor breaks the LZ4 end-of-block rule: it lets a match start up to 9
// bytes from the end of a block, where the spec (and liblz4) wants 12. Its own
// decoder does not mind, so every JS reader here read the files back fine, but
// liblz4 fails with ERROR_decompressionFailed — measured on mcap chunks and on the
// lz4+lcm blobs of big raw frames. So blocks are compressed here instead, greedy and
// by the spec, 64 KB at a time and each on its own.

// magic, FLG (version 1, independent blocks), BD (64 KB blocks), header checksum
const HEADER = [0x04, 0x22, 0x4d, 0x18, 0x60, 0x40, 0x82]
const BLOCK = 64 * 1024
const MIN_MATCH = 4
const MF_LIMIT = 12 // a match starts at least this far from the end of the block
const LAST_LITERALS = 5 // and the block always ends in this many literals

const blockBound = (length) => length + Math.ceil(length / 255) + 16

// One block into `out` at `at`; returns the compressed length, or 0 when it would not
// shrink (unless `always`, for a format with no way to store a block uncompressed).
function compressBlock(source, start, length, out, at, table, always = false) {
    table.fill(-1)
    const end = start + length
    const matchEnd = end - LAST_LITERALS
    const lastStart = end - MF_LIMIT
    const begin = at
    let anchor = start
    let index = start
    let misses = 0
    const read32 = (i) =>
        source[i] | (source[i + 1] << 8) | (source[i + 2] << 16) | (source[i + 3] << 24)
    const writeLength = (value) => {
        for (; value >= 255; value -= 255) {
            out[at++] = 255
        }
        out[at++] = value
    }
    while (index < lastStart) {
        const word = read32(index)
        const hash = Math.imul(word, 2654435761) >>> 16
        const candidate = table[hash]
        table[hash] = index - start
        const match = candidate + start
        if (candidate < 0 || index - match > 65535 || read32(match) !== word) {
            index += 1 + (misses++ >> 6) // step up through data that does not compress
            continue
        }
        misses = 0
        let matchLength = MIN_MATCH
        while (
            index + matchLength < matchEnd &&
            source[match + matchLength] === source[index + matchLength]
        ) {
            matchLength++
        }
        const literals = index - anchor
        const extra = matchLength - MIN_MATCH
        out[at++] = (Math.min(literals, 15) << 4) | Math.min(extra, 15)
        if (literals >= 15) {
            writeLength(literals - 15)
        }
        out.set(source.subarray(anchor, index), at)
        at += literals
        const offset = index - match
        out[at++] = offset & 0xff
        out[at++] = offset >> 8
        if (extra >= 15) {
            writeLength(extra - 15)
        }
        index += matchLength
        anchor = index
        if (!always && at - begin >= length) {
            return 0
        }
    }
    const literals = end - anchor
    out[at++] = Math.min(literals, 15) << 4
    if (literals >= 15) {
        writeLength(literals - 15)
    }
    out.set(source.subarray(anchor, end), at)
    at += literals
    return always || at - begin < length ? at - begin : 0
}

// A bare LZ4 block (no frame) of any size, as rerun's .rrd wants.
export function compressRawBlock(source) {
    const out = new Uint8Array(blockBound(source.length))
    return out.slice(
        0,
        compressBlock(source, 0, source.length, out, 0, new Int32Array(1 << 16), true),
    )
}

export function compressFrame(source) {
    const out = new Uint8Array(
        HEADER.length + Math.ceil(source.length / BLOCK) * (blockBound(BLOCK) + 4) + 4,
    )
    const view = new DataView(out.buffer)
    out.set(HEADER)
    let at = HEADER.length
    const table = new Int32Array(1 << 16)
    for (let start = 0; start < source.length; start += BLOCK) {
        const length = Math.min(BLOCK, source.length - start)
        const size = compressBlock(source, start, length, out, at + 4, table)
        if (size === 0) {
            view.setUint32(at, 0x80000000 | length, true) // stored uncompressed
            out.set(source.subarray(start, start + length), at + 4)
            at += 4 + length
        } else {
            view.setUint32(at, size, true)
            at += 4 + size
        }
    }
    view.setUint32(at, 0, true) // end mark
    return out.subarray(0, at + 4)
}
