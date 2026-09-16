// Where sub-tools live once they have been downloaded, and how they get there.

import { DtkError } from "./errors.js"
import { runPython } from "./python.js"
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

// Bump `version` in version.js after changing anything under tools/, or an
// install that already cached a tool will happily keep the old copy. `dtk
// update` is the escape hatch either way.
const currentStamp = (tool) =>
    [version, sourceBase, tool.entry, ...(tool.extraFiles || [])].join("\n") + "\n"

export function isDownloaded(tool) {
    // a binary is never in the checkout, so this one is asked even from source
    if (tool.kind === "binary") {
        try {
            Deno.statSync(binaryPathOf(tool))
            return true
        } catch (error) {
            return false
        }
    }
    if (runningFromSource) {
        return true
    }
    try {
        if (Deno.readTextFileSync(stampOf(tool)) !== currentStamp(tool)) {
            return false
        }
        // The stamp is about what was fetched, not about what survived; a cache
        // someone deleted half of should download again rather than fail later.
        Deno.statSync(scriptPathOf(tool))
        return true
    } catch (error) {
        return false
    }
}

export function scriptPathOf(tool) {
    return `${cacheDir}/tools/${tool.name}/${tool.entry.replace(/^tools\//, "")}`
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
    // A rename inside tools/ would otherwise leave the old file sitting there.
    try {
        Deno.removeSync(folder, { recursive: true })
    } catch (error) {
        // nothing cached yet
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
    const target = Deno.build.target
    if (!force && isDownloaded(tool)) {
        // Asked again even though the binary is here: the first attempt can have
        // downloaded the binary and then failed to import its closure, and
        // running it in that state fails with a bare "no such file" from the
        // kernel looking for an interpreter that is not there.
        await ensureNixClosure(tool, target)
        return destination
    }
    const assetName = tool.assets[target]
    if (!assetName) {
        throw new Error(
            `dtk: ${tool.name} has no prebuilt binary for ${target}\n` +
            `     available: ${Object.keys(tool.assets).join(", ")}`,
        )
    }
    Deno.mkdirSync(`${cacheDir}/bin`, { recursive: true })
    const temporaryPath = `${destination}.partial`
    console.error(`dtk: downloading ${tool.name} for ${target}`)
    await downloadAsset(tool, assetName, temporaryPath)
    Deno.chmodSync(temporaryPath, 0o755)
    Deno.renameSync(temporaryPath, destination)
    await ensureNixClosure(tool, target, { force })
    return destination
}

// Some of these binaries come out of nix and are not static: they name
// /nix/store paths as their ELF interpreter and RUNPATH, because the libraries
// they need are dynamic. The release carries a gzipped `nix-store --export` of
// the runtime closure beside each one, and importing that is what makes those
// paths exist here.
async function ensureNixClosure(tool, target, { force = false } = {}) {
    const assetName = tool.nixClosure?.[target]
    if (assetName === undefined) {
        return
    }
    const stamp = `${binaryPathOf(tool)}.closure`
    if (!force) {
        try {
            Deno.statSync(stamp)
            return
        } catch (error) {
            // not imported yet
        }
    }
    let nixVersion = null
    try {
        const probe = await new Deno.Command("nix", {
            args: ["--version"],
            stdout: "piped",
            stderr: "null",
        }).output()
        nixVersion = new TextDecoder().decode(probe.stdout).trim()
    } catch (error) {
        nixVersion = null
    }
    if (nixVersion === null) {
        throw new DtkError(
            `dtk: ${tool.name} for ${target} is built by nix and needs nix here to run.\n` +
            `     Install it, then run \`dtk update ${tool.name}\`:\n` +
            `       curl -fsSL https://install.determinate.systems/nix | sh -s -- install`,
        )
    }
    console.error(`dtk: fetching what ${tool.name} needs at runtime (${nixVersion})`)
    const archive = `${binaryPathOf(tool)}.closure.gz`
    await downloadAsset(tool, assetName, archive)
    const importer = new Deno.Command("nix-store", {
        args: ["--import"],
        stdin: "piped",
        stdout: "null",
        stderr: "piped",
    }).spawn()
    const complaints = []
    const watching = (async () => {
        for await (const chunk of importer.stderr.pipeThrough(new TextDecoderStream())) {
            complaints.push(chunk)
            await Deno.stderr.write(new TextEncoder().encode(chunk))
        }
    })()
    const file = await Deno.open(archive, { read: true })
    try {
        await file.readable
            .pipeThrough(new DecompressionStream("gzip"))
            .pipeTo(importer.stdin)
    } catch (error) {
        // nix-store gave up early and closed its end; its own complaint below is
        // the useful one, not "broken pipe"
        if (!(error instanceof Deno.errors.BrokenPipe)) {
            throw error
        }
    }
    const { success } = await importer.status
    await watching
    Deno.removeSync(archive)
    if (!success) {
        const said = complaints.join("")
        if (said.includes("lacks a signature by a trusted key")) {
            throw new DtkError(
                `dtk: nix refused ${tool.name}'s runtime closure because you are not a trusted\n` +
                `     user, and these paths are unsigned. Add yourself, then try again:\n` +
                `       echo "trusted-users = root $(whoami)" | sudo tee -a /etc/nix/nix.conf\n` +
                `       sudo systemctl restart nix-daemon   # or: sudo pkill nix-daemon\n` +
                `     On Jeff's machines \`nix_add_self_as_trusted_user\` does the same thing.`,
            )
        }
        throw new DtkError(`dtk: could not import ${tool.name}'s runtime closure`)
    }
    Deno.writeTextFileSync(stamp, `${assetName}\n`)
}

// The plain fetch first, then `gh`, which already has credentials for a private repo.
async function downloadAsset(tool, assetName, destination) {
    const url = `https://github.com/${tool.repo}/releases/latest/download/${assetName}`
    const response = await fetch(url)
    if (response.ok) {
        const file = await Deno.open(destination, { write: true, create: true, truncate: true })
        await response.body.pipeTo(file.writable)
        return
    }
    response.body?.cancel()
    await downloadWithGh(tool, assetName, destination, response.status)
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
    if (tool.kind === "python") {
        // Paths among the arguments are where the walk up for a project starts,
        // so `dtk graph some/repo/thing.py` uses that repo's environment
        // whatever directory it was typed from.
        const startPaths = args.filter((each) => {
            if (each.startsWith("-")) {
                return false
            }
            try {
                Deno.statSync(each)
                return true
            } catch (error) {
                return false
            }
        })
        return await runPython({
            script: path,
            args,
            startPaths,
            needsDimosModule: tool.needsDimosModule ?? null,
            withPackages: tool.withPackages ?? [],
            verbose: Deno.env.get("DTK_VERBOSE") === "1",
        })
    }
    if (tool.kind === "deno") {
        command = new Deno.Command(Deno.execPath(), {
            args: ["run", ...(tool.permissions || ["--allow-all"]), path, ...args],
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
