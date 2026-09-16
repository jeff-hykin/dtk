import { DtkError } from "./errors.js"

// What kind of recording a file is. Decided by what is inside it, not by its
// name: plenty of these files are called .db when they are an mcap and the
// other way round.

const SQLITE_MAGIC = "SQLite format 3\0"
const MCAP_MAGIC = new Uint8Array([0x89, 0x4d, 0x43, 0x41, 0x50, 0x30, 0x0d, 0x0a])

export function detectFormat(path) {
    let file = null
    try {
        file = Deno.openSync(path, { read: true })
    } catch (error) {
        if (error instanceof Deno.errors.NotFound) {
            throw new DtkError(`dtk data: no such recording: ${path}`)
        }
        throw error
    }
    try {
        const head = new Uint8Array(16)
        const readCount = file.readSync(head) || 0
        if (readCount >= MCAP_MAGIC.length && MCAP_MAGIC.every((byte, at) => head[at] === byte)) {
            return "mcap"
        }
        if (readCount >= 16 && new TextDecoder().decode(head) === SQLITE_MAGIC) {
            return "db"
        }
        return null
    } finally {
        file.close()
    }
}

const nameOf = { db: "a memory2 .db", mcap: "an .mcap" }

// Throws unless `path` is one of `accepted`.
export function requireFormat(path, accepted, verb) {
    const format = detectFormat(path)
    if (format === null) {
        throw new DtkError(
            `dtk data ${verb}: ${path} is neither a memory2 .db nor an .mcap ` +
            `(its first bytes match neither)`,
        )
    }
    if (!accepted.includes(format)) {
        const wanted = accepted.map((each) => nameOf[each]).join(" or ")
        throw new DtkError(
            `dtk data ${verb}: ${path} is ${nameOf[format]}, and this works on ${wanted}`,
        )
    }
    return format
}
