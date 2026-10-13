// A headless Chromium for the browser stages. It must be a page Chrome considers visible and
// unthrottled: a background tab clamps timers to 1 Hz, and every latency it reports is then wrong.

import { DtkError } from "../errors.js"

function candidates() {
    const home = Deno.env.get("HOME") ?? ""
    const caches = [`${home}/Library/Caches/ms-playwright`, `${home}/.cache/ms-playwright`]
    const found = []
    for (const cache of caches) {
        let entries = []
        try {
            entries = [...Deno.readDirSync(cache)].map((entry) => entry.name)
        } catch {
            continue
        }
        // newest build first
        const byBuild = (prefix) =>
            entries.filter((name) => name.startsWith(prefix))
                .sort((a, b) => Number(b.split("-").at(-1)) - Number(a.split("-").at(-1)))
        for (const dir of byBuild("chromium_headless_shell-")) {
            for (const platform of ["mac-arm64", "mac-x64", "linux64", "linux-arm64"]) {
                found.push(
                    `${cache}/${dir}/chrome-headless-shell-${platform}/chrome-headless-shell`,
                )
            }
        }
        for (const dir of byBuild("chromium-")) {
            found.push(`${cache}/${dir}/chrome-mac/Chromium.app/Contents/MacOS/Chromium`)
            found.push(`${cache}/${dir}/chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium`)
            found.push(`${cache}/${dir}/chrome-linux/chrome`)
        }
    }
    found.push(
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/usr/bin/chromium",
        "/usr/bin/google-chrome",
    )
    return found
}

export function findChrome(explicit) {
    const list = explicit
        ? [explicit]
        : [Deno.env.get("DTK_CHROME"), ...candidates()].filter(Boolean)
    for (const path of list) {
        try {
            if (Deno.statSync(path).isFile) {
                return path
            }
        } catch {
            // not this one
        }
    }
    throw new DtkError(
        `dtk bench: no Chromium for the browser stages${
            explicit ? ` at ${explicit}` : ""
        }. Install one with\n` +
            `    deno run -A npm:playwright-core@1.56.1 install chromium-headless-shell\n` +
            `or pass --chrome <path>, or leave the browser stages out with --stages`,
    )
}

const pageFiles = { "/page.js": "page.js", "/protocol.js": "protocol.js" }

// The page is served from localhost here: WebTransport only exists in a secure context, which
// plain http on the far machine's IP is not (and headless Chromium ignores
// --unsafely-treat-insecure-origin-as-secure). It then talks to `remote` cross-origin.
function servePage(remote) {
    const html = `<!doctype html><meta charset="utf-8"><title>dtk bench</title>
<body style="font:14px monospace">dtk bench page, driven by the dtk bench command
<script>window.benchRemote = ${JSON.stringify(remote)}</script>
<script type="module">import * as bench from "./page.js"; window.bench = bench</script>`
    return Deno.serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, async (request) => {
        const path = new URL(request.url).pathname
        if (path === "/") {
            return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } })
        }
        if (pageFiles[path]) {
            // fetch reads file: and https: alike, so this works from a checkout or a remote install
            const body = await (await fetch(new URL(`./${pageFiles[path]}`, import.meta.url)))
                .arrayBuffer()
            return new Response(body, {
                headers: {
                    "content-type": "text/javascript; charset=utf-8",
                    "cache-control": "no-store",
                },
            })
        }
        return new Response("not found", { status: 404 })
    })
}

export async function openPage({ remote, chrome }) {
    const { chromium } = await import("npm:playwright-core@1.56.1")
    const server = servePage(remote)
    const browser = await chromium.launch({
        executablePath: findChrome(chrome),
        args: [
            "--disable-background-timer-throttling",
            "--disable-renderer-backgrounding",
            "--disable-backgrounding-occluded-windows",
            // real host candidates, not mDNS names a non-browser WebRTC peer cannot resolve
            "--disable-features=WebRtcHideLocalIpsWithMdns",
        ],
    })
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } }))
        .newPage()
    const errors = []
    page.on("pageerror", (error) => errors.push(String(error)))
    await page.goto(`http://localhost:${server.addr.port}/`)
    await page.waitForFunction(() => window.bench?.run, null, { timeout: 15000 })
    const visibility = await page.evaluate(() => document.visibilityState)
    if (visibility !== "visible") {
        await browser.close()
        await server.shutdown()
        throw new DtkError(
            `dtk bench: the bench page is ${visibility}, so its timers are throttled; refusing to measure`,
        )
    }
    return {
        run: (transport, bitsPerSecond, seconds, extra) =>
            page.evaluate(
                ([transport, rate, seconds, extra]) =>
                    window.bench.run(transport, rate === null ? Infinity : rate, seconds, extra),
                [transport, bitsPerSecond === Infinity ? null : bitsPerSecond, seconds, extra],
            ),
        errors,
        close: async () => {
            await browser.close().catch(() => {})
            await server.shutdown().catch(() => {})
        },
    }
}
