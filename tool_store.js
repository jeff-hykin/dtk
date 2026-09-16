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
        await ensureRuntime(tool, target)
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
    await ensureRuntime(tool, target, { force })
    return destination
}

// Some of these binaries come out of nix and are not static: they name
// /nix/store paths as their ELF interpreter and RUNPATH, because the libraries
// they need are dynamic. The release carries a tarball of exactly those store
// paths beside each one; unpacking it into the cache is what makes them exist.
//
// Deliberately not `nix-store --import`: that needs nix on this machine AND a
// trusted user, because the paths are unsigned, and a plain account on a plain
// machine is neither. A tarball needs neither -- the binary is then run through
// the loader inside it, so the absolute paths baked into the ELF never matter.
async function ensureRuntime(tool, target, { force = false } = {}) {
    const assetName = tool.runtime?.[target]
    if (assetName === undefined) {
        return
    }
    const folder = runtimePathOf(tool)
    const stamp = `${folder}/.stamp`
    if (!force) {
        try {
            if (Deno.readTextFileSync(stamp).trim() === assetName) {
                return
            }
        } catch (error) {
            // not unpacked yet
        }
    }
    console.error(`dtk: fetching the libraries ${tool.name} needs at runtime`)
    const archive = `${folder}.tar.gz`
    Deno.mkdirSync(folder.replace(/\/[^/]+$/, ""), { recursive: true })
    await downloadAsset(tool, assetName, archive)
    try {
        Deno.removeSync(folder, { recursive: true })
    } catch (error) {
        // nothing unpacked yet
    }
    Deno.mkdirSync(folder, { recursive: true })
    const { success } = await new Deno.Command("tar", {
        args: ["-xzf", archive, "-C", folder],
        stdout: "inherit",
        stderr: "inherit",
    }).output()
    Deno.removeSync(archive)
    if (!success) {
        throw new DtkError(`dtk: could not unpack ${tool.name}'s runtime libraries`)
    }
    Deno.writeTextFileSync(stamp, `${assetName}\n`)
}

export function runtimePathOf(tool) {
    return `${cacheDir}/runtime/${tool.name}`
}

// Every `lib` directory in the unpacked closure, and the loader among them. The
// loader is found by name rather than by reading the ELF's PT_INTERP: there is
// exactly one ld-linux/ld-musl in a closure, and globbing for it is a great deal
// less code than parsing program headers to learn the same thing.
function loaderAndLibraries(folder) {
    const store = `${folder}/nix/store`
    const libraries = []
    let loader = null
    let entries = []
    try {
        entries = [...Deno.readDirSync(store)]
    } catch (error) {
        return { loader: null, libraries: [] }
    }
    for (const entry of entries) {
        const lib = `${store}/${entry.name}/lib`
        try {
            if (!Deno.statSync(lib).isDirectory) {
                continue
            }
        } catch (error) {
            continue
        }
        libraries.push(lib)
        if (loader === null) {
            for (const inside of Deno.readDirSync(lib)) {
                if (/^ld-(linux|musl)[^/]*\.so(\.\d+)?$/.test(inside.name)) {
                    loader = `${lib}/${inside.name}`
                    break
                }
            }
        }
    }
    return { loader, libraries }
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
        let program = path
        let leading = []
        if (tool.runtime?.[Deno.build.target]) {
            const { loader, libraries } = loaderAndLibraries(runtimePathOf(tool))
            if (loader === null) {
                throw new DtkError(
                    `dtk: ${tool.name}'s runtime libraries are not unpacked; run ` +
                    `\`dtk update ${tool.name}\``,
                )
            }
            program = loader
            leading = ["--library-path", libraries.join(":"), path]
        }
        command = new Deno.Command(program, {
            args: [...leading, ...args],
            stdin: "inherit",
            stdout: "inherit",
            stderr: "inherit",
        })
    }
    const { code } = await command.output()
    return code
}
