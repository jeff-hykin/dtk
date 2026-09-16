// Where sub-tools live once they have been downloaded, and how they get there.

import { version } from "./version.js"

// Running from a checkout, this is a file:// url and the tools are simply used
// in place. Installed from a url, it is that url and the tools get downloaded.
export const sourceBase = new URL("./", import.meta.url)
export const runningFromSource = sourceBase.protocol === "file:"

export const cacheDir = (() => {
    const override = Deno.env.get("DTK_CACHE")
    if (override) {
        return override
    }
    const xdg = Deno.env.get("XDG_CACHE_HOME")
    if (xdg) {
        return `${xdg}/dtk`
    }
    const home = Deno.env.get("HOME") || Deno.env.get("USERPROFILE")
    return `${home}/.cache/dtk`
})()

const stampOf = (tool) => `${cacheDir}/tools/${tool.name}/.stamp`

const currentStamp = (tool) => `${version}\n${sourceBase}\n`

export function isDownloaded(tool) {
    if (runningFromSource) {
        return true
    }
    if (tool.kind === "binary") {
        try {
            Deno.statSync(binaryPathOf(tool))
            return true
        } catch (error) {
            return false
        }
    }
    try {
        return Deno.readTextFileSync(stampOf(tool)) === currentStamp(tool)
    } catch (error) {
        return false
    }
}

export function binaryPathOf(tool) {
    return `${cacheDir}/bin/${tool.name}`
}

// Returns the path to the thing that should be executed.
export async function ensureDownloaded(tool, { force = false } = {}) {
    if (tool.kind === "binary") {
        return await ensureBinary(tool, { force })
    }
    if (runningFromSource) {
        return new URL(tool.entry, sourceBase).pathname
    }
    return await ensureScript(tool, { force })
}

async function ensureScript(tool, { force }) {
    const folder = `${cacheDir}/tools/${tool.name}`
    const localPathOf = (relativePath) => `${folder}/${relativePath.replace(/^tools\//, "")}`
    if (!force && isDownloaded(tool)) {
        return localPathOf(tool.entry)
    }
    console.error(`dtk: downloading ${tool.name}`)
    for (const relativePath of [tool.entry, ...(tool.extraFiles || [])]) {
        const from = new URL(relativePath, sourceBase)
        const response = await fetch(from)
        if (!response.ok) {
            throw new Error(`dtk: could not download ${from} (${response.status})`)
        }
        const to = localPathOf(relativePath)
        Deno.mkdirSync(to.replace(/\/[^/]+$/, ""), { recursive: true })
        Deno.writeFileSync(to, new Uint8Array(await response.arrayBuffer()))
    }
    Deno.writeTextFileSync(stampOf(tool), currentStamp(tool))
    return localPathOf(tool.entry)
}

async function ensureBinary(tool, { force }) {
    const destination = binaryPathOf(tool)
    if (!force && isDownloaded(tool)) {
        return destination
    }
    const target = Deno.build.target
    const assetName = tool.assets[target]
    if (!assetName) {
        throw new Error(
            `dtk: ${tool.name} has no prebuilt binary for ${target}\n` +
            `     available: ${Object.keys(tool.assets).join(", ")}`,
        )
    }
    Deno.mkdirSync(`${cacheDir}/bin`, { recursive: true })
    const temporaryPath = `${destination}.partial`
    const url = `https://github.com/${tool.repo}/releases/latest/download/${assetName}`
    console.error(`dtk: downloading ${tool.name} for ${target}`)
    const response = await fetch(url)
    if (response.ok) {
        Deno.writeFileSync(temporaryPath, new Uint8Array(await response.arrayBuffer()))
    } else {
        // a private repo needs auth, and `gh` already has it
        response.body?.cancel()
        await downloadWithGh(tool, assetName, temporaryPath, response.status)
    }
    Deno.chmodSync(temporaryPath, 0o755)
    Deno.renameSync(temporaryPath, destination)
    return destination
}

async function downloadWithGh(tool, assetName, temporaryPath, status) {
    const gh = new Deno.Command("gh", {
        args: [
            "release", "download",
            "--repo", tool.repo,
            "--pattern", assetName,
            "--output", temporaryPath,
            "--clobber",
        ],
        stdout: "inherit",
        stderr: "inherit",
    })
    let result = null
    try {
        result = await gh.output()
    } catch (error) {
        throw new Error(
            `dtk: could not download ${tool.name} (http ${status}) and \`gh\` is not installed.\n` +
            `     ${tool.repo} may be private; install the github cli and \`gh auth login\`.`,
        )
    }
    if (!result.success) {
        throw new Error(`dtk: could not download ${tool.name} from ${tool.repo} (http ${status}, and gh failed)`)
    }
}

export async function runTool(tool, args) {
    const path = await ensureDownloaded(tool)
    let command = null
    if (tool.kind === "deno") {
        command = new Deno.Command(Deno.execPath(), {
            args: ["run", ...(tool.permissions || ["--allow-all"]), path, ...args],
            stdin: "inherit",
            stdout: "inherit",
            stderr: "inherit",
        })
    } else if (tool.kind === "sh") {
        command = new Deno.Command("/bin/sh", {
            args: [path, ...args],
            stdin: "inherit",
            stdout: "inherit",
            stderr: "inherit",
        })
    } else {
        command = new Deno.Command(path, {
            args: args,
            stdin: "inherit",
            stdout: "inherit",
            stderr: "inherit",
        })
    }
    const { code } = await command.output()
    return code
}
