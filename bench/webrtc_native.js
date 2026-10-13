// node-datachannel (libdatachannel, the C++ WebRTC stack) under Deno. Deno fetches the npm
// package but never runs its install script, which is what drops the prebuilt binary in place,
// so this does that one step: the release's .node file into the package's folder in deno's cache.

const version = "0.29.0"
const specifier = `npm:node-datachannel@${version}`

async function output(args) {
    const out = await new Deno.Command(Deno.execPath(), { args, stdout: "piped", stderr: "piped" })
        .output()
    if (!out.success) {
        throw new Error(new TextDecoder().decode(out.stderr).trim().split("\n").at(-1))
    }
    return new TextDecoder().decode(out.stdout)
}

function platform() {
    const os = { darwin: "darwin", linux: "linux" }[Deno.build.os]
    const arch = { aarch64: "arm64", x86_64: "x64" }[Deno.build.arch]
    if (!os || !arch) {
        throw new Error(`no node-datachannel build for ${Deno.build.os}/${Deno.build.arch}`)
    }
    return `${os}-${arch}`
}

export async function loadNodeDatachannel() {
    await output(["cache", "--quiet", specifier])
    const npmCache = JSON.parse(await output(["info", "--json"])).npmCache
    const folder = `${npmCache}/registry.npmjs.org/node-datachannel/${version}`
    const binary = `${folder}/build/Release/node_datachannel.node`
    try {
        Deno.statSync(binary)
    } catch {
        const url =
            `https://github.com/murat-dogan/node-datachannel/releases/download/v${version}/node-datachannel-v${version}-napi-v8-${platform()}.tar.gz`
        const response = await fetch(url)
        if (!response.ok) {
            throw new Error(`could not download ${url}: ${response.status}`)
        }
        const archive = await Deno.makeTempFile({ suffix: ".tar.gz" })
        await Deno.writeFile(archive, new Uint8Array(await response.arrayBuffer()))
        const untar = await new Deno.Command("tar", {
            args: ["xzf", archive, "-C", folder],
            stderr: "piped",
        }).output()
        await Deno.remove(archive).catch(() => {})
        if (!untar.success) {
            throw new Error(`could not unpack ${url}: ${new TextDecoder().decode(untar.stderr)}`)
        }
    }
    return await import(`${specifier}/polyfill`)
}
