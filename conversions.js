// Turning a recording into the other format, for the verbs that do their work on one
// format and are handed the other. Results are kept in the dtk cache, keyed on the
// recording's path, mtime and size, so a second verb on the same unchanged recording
// does not convert it again.

import { DtkError } from "./errors.js"
import { cacheDir, runTool } from "./tool_store.js"
import { toolsByName } from "./registry.js"

// Path + mtime + size, so an edited recording converts again and an untouched one
// never does. Reading the whole file to hash it would cost about what the
// conversion costs, which would defeat the point.
export async function cacheKey(path, options) {
    const info = Deno.statSync(path)
    const identity = [
        Deno.realPathSync(path),
        info.mtime?.getTime() ?? 0,
        info.size,
        JSON.stringify(options),
    ].join("\n")
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity))
    return [...new Uint8Array(digest)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0"))
        .join("")
}

// The flags that pick image encodings (see tools/image_recode/recode.js), split from
// the rest so each can go to the tool that takes it.
export function splitEncodeFlags(args) {
    const encode = []
    const rest = []
    for (let i = 0; i < args.length; i++) {
        if (["--encode", "--image-encoding", "--jpeg-quality"].includes(args[i])) {
            encode.push(args[i], args[++i])
        } else {
            rest.push(args[i])
        }
    }
    return { encode, rest }
}

async function run(toolName, args, what) {
    const code = await runTool(toolsByName[toolName], args)
    if (code !== 0) {
        throw new DtkError(`dtk data: ${what} failed (exit ${code})`)
    }
}

// db -> mcap: db_to_mcap writes every stream it can map, then mcap_recode applies the
// image choices, since the image codecs live on the deno side.
export async function dbToMcap(db, out, { encode = [], dbToMcapArgs = [] } = {}) {
    const folder = await Deno.makeTempDir({ prefix: "dtk_to_mcap_" })
    try {
        const plain = `${folder}/plain.mcap`
        await run(
            "db_to_mcap",
            [db, "-o", plain, ...dbToMcapArgs],
            "converting the .db to an .mcap",
        )
        await run("mcap_recode", [plain, out, ...encode], "re-encoding the .mcap's images")
    } finally {
        await Deno.remove(folder, { recursive: true })
    }
}

export async function mcapToDb(mcap, out, args = []) {
    await run("mcap_to_db", [mcap, out, ...args], "converting the .mcap to a .db")
}

// A converted copy of `recording` in `format`, from the cache when it is still good.
// `args` go to the converter and are part of the cache key.
export async function asFormat(recording, format, args = []) {
    const folder = `${cacheDir}/converted`
    Deno.mkdirSync(folder, { recursive: true })
    const name = recording.replace(/^.*\//, "").replace(/\.(db|mcap)$/, "")
    const target = `${folder}/${name}.${await cacheKey(recording, args)}.${format}`
    try {
        Deno.statSync(target)
        console.error(`dtk: using the converted copy ${target}`)
        return target
    } catch {
        // not converted yet
    }
    const partial = `${target}.partial`
    console.error(
        `dtk: converting ${recording} to ${
            format === "db" ? "a .db" : "an .mcap"
        } first (kept at ${target})`,
    )
    if (format === "db") {
        await mcapToDb(recording, partial, args)
    } else {
        await dbToMcap(recording, partial, { encode: args })
    }
    Deno.renameSync(partial, target)
    return target
}
