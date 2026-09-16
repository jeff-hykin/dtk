#!/usr/bin/env -S deno run --allow-read --allow-write --allow-net --allow-run --allow-env

// urdf_edit — open a URDF in the browser and view/edit its frames (no meshes; basis vectors only)
//
// Usage: urdf_edit <robot.urdf> [--port N] [--no-open]
//
// The browser app renders an axis triad for every link frame, draws the
// kinematic connections, lets you click a frame to highlight its neighbors,
// drag a single basis vector to move that frame along that axis, and download
// a modified URDF (only <origin> attributes change; everything else is preserved).

const args = [...Deno.args]
let urdfPath = null
let port = 8723
let open = true

for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port") {
        port = parseInt(args[++i])
    } else if (args[i] === "--no-open") {
        open = false
    } else if (args[i] === "-h" || args[i] === "--help") {
        console.log(`urdf_edit — view & edit URDF frames in the browser

Usage: urdf_edit <robot.urdf> [--port N] [--no-open]

Controls:
  mouse drag        orbit
  scroll            zoom
  WASD              move camera in space
  IJKL              change viewing angle
  click frame       highlight connected frames
  drag a basis arrow move that frame along only that axis
  Download button   save modified URDF`)
        Deno.exit(0)
    } else if (!urdfPath) {
        urdfPath = args[i]
    }
}

if (!urdfPath) {
    console.error("error: no URDF file given\n  usage: urdf_edit <robot.urdf> [--port N] [--no-open]")
    Deno.exit(1)
}

const urdfText = await Deno.readTextFile(urdfPath)
const webDir = new URL("./urdf_edit_files/", import.meta.url).pathname

const contentTypes = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".xml": "application/xml",
    ".svg": "image/svg+xml",
    ".ico": "image/svg+xml",
}

// Where the editor's Save button puts things, the same directory the dim
// desktop app uses, so a URDF saved from either turns up in the other's list.
const SAVES_DIR = `${Deno.env.get("HOME") ?? "."}/.local/share/dim/urdf_saves`
// Only a basename shaped like this is accepted from the browser, so a crafted
// name cannot walk out of SAVES_DIR.
const SAFE_FILE = /^[A-Za-z0-9._-]+\.urdf$/

function fileNameFor(rawName) {
    let base = String(rawName || "robot").replace(/\.urdf$/i, "")
    base = base.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+/, "")
    return `${base || "robot"}.urdf`
}

async function listRecent() {
    const files = []
    try {
        for await (const entry of Deno.readDir(SAVES_DIR)) {
            if (!entry.isFile || !entry.name.endsWith(".urdf")) {
                continue
            }
            let savedAt = 0
            try {
                const info = await Deno.stat(`${SAVES_DIR}/${entry.name}`)
                savedAt = info.mtime ? info.mtime.getTime() : 0
            } catch (error) {
                continue // vanished between readDir and stat
            }
            files.push({ file: entry.name, name: entry.name.replace(/\.urdf$/i, ""), savedAt })
        }
    } catch (error) {
        // nothing saved yet
    }
    files.sort((left, right) => right.savedAt - left.savedAt)
    return files
}

// The editor's front end talks to its host over a small websocket bus: it sends
// `{data: [kind, payload]}` and expects the same shape back. Standing in for that
// host here is what makes Save, Recent and Load work without the dim desktop.
function serveAppBus(request) {
    const { socket, response } = Deno.upgradeWebSocket(request)
    const send = (kind, payload) => {
        try {
            socket.send(JSON.stringify({ data: [kind, payload] }))
        } catch (error) {
            // the page went away mid-reply
        }
    }
    // The first list is sent as soon as the socket opens, and a message can arrive
    // while that read is still in flight. Everything waits on it, so a save that
    // lands first is never overwritten by a list taken before it.
    let ready = Promise.resolve()
    socket.onopen = () => {
        // the front end checks the host's version before it trusts the bus
        try {
            socket.send(JSON.stringify({ __dimHost: { v: "0.3.0" } }))
        } catch (error) {
            return
        }
        ready = listRecent().then((files) => send("recent", { files }))
    }
    socket.onmessage = async (event) => {
        await ready
        let message = null
        try {
            message = JSON.parse(event.data)
        } catch (error) {
            return
        }
        if (message?.__dim) {
            return
        }
        const [kind, payload] = message?.data ?? []
        if (kind === "save") {
            const body = payload?.text
            if (typeof body !== "string" || !body.trim()) {
                send("saved", { ok: false, error: "nothing to save" })
                return
            }
            const file = fileNameFor(payload?.name)
            try {
                await Deno.mkdir(SAVES_DIR, { recursive: true })
                await Deno.writeTextFile(`${SAVES_DIR}/${file}`, body)
            } catch (error) {
                send("saved", { ok: false, error: error.message })
                return
            }
            send("saved", {
                ok: true,
                file,
                name: file.replace(/\.urdf$/i, ""),
                path: `${SAVES_DIR}/${file}`,
            })
            send("recent", { files: await listRecent() })
        } else if (kind === "load") {
            const file = payload?.file
            if (typeof file !== "string" || !SAFE_FILE.test(file)) {
                send("loaded", { ok: false, error: "invalid file name" })
                return
            }
            try {
                const body = await Deno.readTextFile(`${SAVES_DIR}/${file}`)
                send("loaded", { ok: true, file, name: file.replace(/\.urdf$/i, ""), text: body })
            } catch (error) {
                send("loaded", { ok: false, file, error: error.message })
            }
        } else if (kind === "list" || kind === "hello") {
            send("recent", { files: await listRecent() })
        }
    }
    return response
}

function typeFor(path) {
    const dot = path.lastIndexOf(".")
    return contentTypes[path.slice(dot)] ?? "application/octet-stream"
}

const server = Deno.serve({ port, onListen: () => {} }, async (request) => {
    const url = new URL(request.url)
    let path = url.pathname

    if (path === "/ws" && request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        return serveAppBus(request)
    }
    if (path === "/urdf.xml") {
        return new Response(urdfText, {
            headers: {
                "content-type": "application/xml",
                // so the page's title says the file's name rather than "urdf"
                "x-urdf-name": urdfPath.replace(/^.*\//, "").replace(/\.urdf$/i, ""),
            },
        })
    }
    if (path === "/") {
        path = "/index.html"
    }
    // The editor is shared with the dim desktop, which serves its design system
    // from /assets and its tab icon from the app directory. Both are served from
    // here so the page looks the same outside the desktop as inside it.
    if (path === "/assets/theme.css") {
        path = "/theme.css"
    }
    if (path === "/favicon.ico") {
        path = "/icon.svg"
    }

    const filePath = webDir + path.replace(/^\//, "")
    try {
        const body = await Deno.readFile(filePath)
        return new Response(body, { headers: { "content-type": typeFor(path) } })
    } catch {
        return new Response("not found", { status: 404 })
    }
})

const address = `http://localhost:${port}/`
console.log(`urdf_edit serving ${urdfPath}\n  ${address}`)

if (open) {
    const opener = Deno.build.os === "darwin" ? "open" : "xdg-open"
    try {
        await new Deno.Command(opener, { args: [address] }).output()
    } catch {
        console.log("  (could not auto-open browser; open the URL above manually)")
    }
}

await server.finished
