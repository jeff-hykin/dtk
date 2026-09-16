// `dtk data to_rrd` keeps its output, because converting a recording is slow and
// the answer only changes when the recording does.

import { DtkError } from "./errors.js"
import { cacheDir } from "./tool_store.js"
import { toolsByName } from "./registry.js"
import { runTool } from "./tool_store.js"

// Path + mtime + size, so an edited recording converts again and an untouched one
// never does. Reading the whole file to hash it would cost about what the
// conversion costs, which would defeat the point.
async function cacheKey(path, options) {
    const info = Deno.statSync(path)
    const identity = [
        Deno.realPathSync(path),
        info.mtime?.getTime() ?? 0,
        info.size,
        JSON.stringify(options),
    ].join("\n")
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity))
    return [...new Uint8Array(digest)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("")
}

function rerunOnPath() {
    try {
        const { success } = new Deno.Command("rerun", {
            args: ["--version"],
            stdout: "null",
            stderr: "null",
        }).outputSync()
        return success
    } catch (error) {
        return false
    }
}

function installerFor() {
    for (const [program, args] of [
        ["uv", ["tool", "install", "rerun-sdk"]],
        ["pipx", ["install", "rerun-sdk"]],
    ]) {
        try {
            new Deno.Command(program, { args: ["--version"], stdout: "null", stderr: "null" }).outputSync()
            return [program, args]
        } catch (error) {
            continue
        }
    }
    return null
}

async function offerToInstallRerun() {
    const installer = installerFor()
    if (installer === null) {
        console.error("dtk: no global `rerun` to open this with, and neither uv nor pipx is here.")
        console.error("dtk: install one of those, or `pip install rerun-sdk`, then re-run.")
        return false
    }
    const [program, args] = installer
    console.error(`dtk: there is no global \`rerun\` to open this with.`)
    if (!confirm(`dtk: install it with \`${program} ${args.join(" ")}\`?`)) {
        return false
    }
    const { success } = await new Deno.Command(program, {
        args,
        stdout: "inherit",
        stderr: "inherit",
    }).output()
    if (!success) {
        console.error("dtk: that install did not work; the .rrd is still on disk")
        return false
    }
    return rerunOnPath()
}

export async function toRrd(recording, { force, open, conversion }) {
    const folder = `${cacheDir}/rrd`
    Deno.mkdirSync(folder, { recursive: true })
    const name = recording.replace(/^.*\//, "").replace(/\.db$/, "")
    const target = `${folder}/${name}.${await cacheKey(recording, conversion)}.rrd`

    let reused = false
    try {
        Deno.statSync(target)
        reused = !force
    } catch (error) {
        // not converted yet
    }

    if (reused) {
        console.error(`dtk: reusing ${target}`)
    } else {
        // --no-open because opening is this command's job, not the converter's
        const code = await runTool(
            toolsByName["db_to_rrd"],
            [recording, "-o", target, "--no-open", ...conversion],
        )
        if (code !== 0) {
            throw new DtkError(`dtk data to_rrd: the conversion failed (exit ${code})`)
        }
    }

    console.log(target)
    if (!open) {
        return 0
    }
    if (!rerunOnPath() && !(await offerToInstallRerun())) {
        return 0
    }
    // Detached, so the terminal comes back while the viewer stays up, and quiet,
    // because the viewer logs a paragraph at INFO on every start.
    const viewer = new Deno.Command("rerun", {
        args: [target],
        stdin: "null",
        stdout: "null",
        stderr: "null",
    }).spawn()
    viewer.unref()
    console.error("dtk: opened it in rerun")
    return 0
}
