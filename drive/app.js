// dtk drive: a thin web_ctrl. Everything robot-side goes through dimos_websdk —
// cmd_vel via publish + its dead-man switch, cameras as H.264, discovery via topics().
import { Dimos } from "/dimos.js"
import { decode, geometry_msgs } from "https://esm.sh/jsr/@dimos/msgs@0.1.4"

const element = (id) => document.getElementById(id)
const setText = (node, text) => {
    if (node.textContent !== text) {
        node.textContent = text
    }
}

const PUBLISH_HZ = 20
const IMAGE_TYPES = new Set(["sensor_msgs.Image", "sensor_msgs.CompressedImage"])
const TOPIC_POLL_MS = 3000
const SETTINGS_KEY = "dtk_drive_settings"

const defaults = {
    topic: "/cmd_vel",
    linearSpeed: 0.25,
    angularSpeed: 0.5,
    deadmanMs: 400,
    invertTurn: false,
    maxWidth: 960,
    fps: 15,
    bitrate: 1500000,
}
const settings = { ...defaults, ...readStored() }

function readStored() {
    try {
        return JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}")
    } catch {
        return {}
    }
}

function store() {
    try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
    } catch {
        // private window: settings just do not persist
    }
}

const state = {
    axes: { forward: 0, strafe: 0, turn: 0 },
    keys: new Set(),
    strafeMode: false,
    tiles: new Map(),
    topics: [],
    stopTail: 0,
}

/** @type {Dimos | null} */
let app = null

// ---- connection

async function connect() {
    const { websdkPort } = await (await fetch("/config.json")).json()
    for (;;) {
        try {
            app = await Dimos.connect({
                decode,
                dimosWs: { host: location.hostname, port: websdkPort },
            })
        } catch {
            renderLink(false, "no dimos_websdk")
            await new Promise((resolve) => setTimeout(resolve, 1000))
            continue
        }
        renderLink(true)
        armDeadman()
        for (const [topic, tile] of state.tiles) {
            startPlayer(topic, tile)
        }
        refreshTopics()
        await app.closed
        app = null
        renderLink(false, "reconnecting")
        for (const tile of state.tiles.values()) {
            tile.player = null
        }
    }
}

function renderLink(live, why = "") {
    element("link-dot").classList.toggle("live", live)
    const pill = element("publish-target")
    pill.classList.toggle("bad", !live)
    setText(pill, live ? `${settings.topic} · zenoh` : why)
}

// The server publishes a zero Twist if this page goes quiet for deadmanMs or its socket
// dies, so a dropped phone stops the robot even though the page cannot.
function armDeadman() {
    app?.setHeartbeat(settings.topic, {
        timeoutMs: Number(settings.deadmanMs),
        stop: new geometry_msgs.Twist(),
    })
}

// ---- driving

function command() {
    const turnSign = settings.invertTurn ? 1 : -1
    // screen-space axes (right is +) to REP-103 (+y left, +yaw counter-clockwise)
    return {
        x: clamp(state.axes.forward) * settings.linearSpeed,
        y: -clamp(state.axes.strafe) * settings.linearSpeed,
        yaw: clamp(state.axes.turn) * settings.angularSpeed * turnSign,
    }
}

const clamp = (value) => Math.max(-1, Math.min(1, value))

// Publishing only while steering (plus a second of zeros so the stop is heard) keeps a
// parked browser from drowning out every other teleop source on the same topic.
function startCommandLoop() {
    setInterval(() => {
        if (!app) {
            return
        }
        const { x, y, yaw } = command()
        if (x !== 0 || y !== 0 || yaw !== 0) {
            state.stopTail = PUBLISH_HZ
        } else if (state.stopTail > 0) {
            state.stopTail -= 1
        } else {
            return
        }
        app.publish(
            settings.topic,
            new geometry_msgs.Twist({
                linear: new geometry_msgs.Vector3({ x, y, z: 0 }),
                angular: new geometry_msgs.Vector3({ x: 0, y: 0, z: yaw }),
            }),
        )
    }, 1000 / PUBLISH_HZ)
}

function renderValues() {
    const { x, yaw } = command()
    setText(element("value-linear"), x.toFixed(2))
    setText(element("value-angular"), yaw.toFixed(2))
}

function updateAxesFromKeys() {
    const held = (...names) => names.some((name) => state.keys.has(name))
    state.axes.forward = (held("w", "arrowup") ? 1 : 0) - (held("s", "arrowdown") ? 1 : 0)
    state.axes.turn = (held("d", "arrowright") ? 1 : 0) - (held("a", "arrowleft") ? 1 : 0)
    state.axes.strafe = (held("e") ? 1 : 0) - (held("q") ? 1 : 0)
    for (const button of document.querySelectorAll(".dpad-key")) {
        button.classList.toggle("down", state.keys.has(button.dataset.key))
    }
    renderValues()
}

function stopEverything() {
    state.keys.clear()
    state.axes = { forward: 0, strafe: 0, turn: 0 }
    updateAxesFromKeys()
}

// The buttons feed the same held-key set as the keyboard, so a press pins one axis at
// exactly full scale — driving perfectly straight, which a stick cannot give you.
function setupButtons() {
    for (const button of document.querySelectorAll(".dpad-key")) {
        const key = button.dataset.key
        button.addEventListener("pointerdown", (event) => {
            event.preventDefault()
            button.setPointerCapture(event.pointerId)
            if (key === "stop") {
                stopEverything()
                return
            }
            state.keys.add(key)
            updateAxesFromKeys()
        })
        for (const name of ["pointerup", "pointercancel"]) {
            button.addEventListener(name, () => {
                state.keys.delete(key)
                updateAxesFromKeys()
            })
        }
    }
}

function setupKeyboard() {
    const tracked = [
        "w",
        "a",
        "s",
        "d",
        "q",
        "e",
        "arrowup",
        "arrowdown",
        "arrowleft",
        "arrowright",
    ]
    addEventListener("keydown", (event) => {
        const key = event.key.toLowerCase()
        if (event.target.matches?.("input")) {
            return
        }
        if (key === " ") {
            stopEverything()
        } else if (tracked.includes(key)) {
            state.keys.add(key)
            updateAxesFromKeys()
        } else {
            return
        }
        event.preventDefault()
    })
    addEventListener("keyup", (event) => {
        state.keys.delete(event.key.toLowerCase())
        updateAxesFromKeys()
    })
    addEventListener("blur", stopEverything)
    // a hidden tab keeps a stale command alive on some phones
    document.addEventListener("visibilitychange", () => {
        if (document.hidden) {
            stopEverything()
        }
    })
}

function setupPad() {
    const pad = element("pad")
    const knob = element("pad-knob")
    let active = false
    const move = (event) => {
        const bounds = pad.getBoundingClientRect()
        const limit = pad.clientWidth / 2 - knob.clientWidth / 2
        let offsetX = event.clientX - bounds.left - bounds.width / 2
        let offsetY = event.clientY - bounds.top - bounds.height / 2
        const distance = Math.hypot(offsetX, offsetY)
        if (distance > limit) {
            offsetX = (offsetX / distance) * limit
            offsetY = (offsetY / distance) * limit
        }
        knob.style.transform = `translate(${offsetX}px, ${offsetY}px)`
        const sideways = offsetX / limit
        state.axes.forward = -offsetY / limit
        state.axes.turn = state.strafeMode ? 0 : sideways
        state.axes.strafe = state.strafeMode ? sideways : 0
        renderValues()
    }
    const release = () => {
        active = false
        pad.classList.remove("active")
        knob.style.transform = "translate(0, 0)"
        state.axes = { forward: 0, strafe: 0, turn: 0 }
        renderValues()
    }
    pad.addEventListener("pointerdown", (event) => {
        active = true
        pad.classList.add("active")
        pad.setPointerCapture(event.pointerId)
        move(event)
    })
    pad.addEventListener("pointermove", (event) => {
        if (active) {
            move(event)
        }
    })
    pad.addEventListener("pointerup", release)
    pad.addEventListener("pointercancel", release)
    element("strafe-mode").addEventListener("change", (event) => {
        state.strafeMode = event.target.checked
    })
}

// ---- cameras

async function refreshTopics() {
    if (!app) {
        return
    }
    try {
        state.topics = await app.topics({ seconds: 1 })
    } catch {
        return
    }
    renderCameras()
    renderTopicTable()
}

function renderCameras() {
    const picker = element("camera-picker")
    const images = state.topics.filter((topic) => IMAGE_TYPES.has(topic.type))
    const wanted = new Set(images.map((topic) => topic.topic))
    for (const chip of [...picker.children]) {
        if (!wanted.has(chip.dataset.topic)) {
            chip.remove()
        }
    }
    for (const topic of images) {
        let chip = picker.querySelector(`[data-topic="${CSS.escape(topic.topic)}"]`)
        if (!chip) {
            chip = document.createElement("button")
            chip.className = "chip"
            chip.dataset.topic = topic.topic
            chip.addEventListener("click", () => toggleStream(topic.topic))
            chip.append(
                Object.assign(document.createElement("span"), { textContent: `${topic.topic} · ` }),
                Object.assign(document.createElement("span"), { className: "hz" }),
            )
            picker.append(chip)
        }
        setText(chip.lastChild, `${topic.hz.toFixed(0)}hz`)
        chip.classList.toggle("on", state.tiles.has(topic.topic))
    }
    if (images.length && state.tiles.size === 0 && !state.openedOnce) {
        state.openedOnce = true
        toggleStream(images[0].topic)
    }
    if (!images.length && !state.tiles.size) {
        setText(element("streams-empty"), "No camera topics seen yet…")
    }
}

function toggleStream(topic) {
    const tile = state.tiles.get(topic)
    if (tile) {
        tile.player?.stop()
        tile.root.remove()
        state.tiles.delete(topic)
    } else {
        openStream(topic)
    }
    element("streams-empty").hidden = state.tiles.size > 0
    for (const chip of element("camera-picker").children) {
        chip.classList.toggle("on", state.tiles.has(chip.dataset.topic))
    }
}

function openStream(topic) {
    const root = document.createElement("div")
    root.className = "tile offline"
    const canvas = document.createElement("canvas")
    const bar = document.createElement("div")
    bar.className = "tile-bar"
    const name = Object.assign(document.createElement("strong"), { textContent: topic })
    const info = Object.assign(document.createElement("span"), {
        textContent: "waiting for a keyframe",
    })
    bar.append(name, info)
    root.append(canvas, bar)
    element("streams").append(root)
    const tile = { root, canvas, info, player: null, decoded: 0, countedAt: performance.now() }
    state.tiles.set(topic, tile)
    startPlayer(topic, tile)
}

function startPlayer(topic, tile) {
    if (!app) {
        return
    }
    tile.player = app.playVideo(topic, tile.canvas, {
        maxWidth: Number(settings.maxWidth),
        fps: Number(settings.fps),
        bitrate: Number(settings.bitrate),
        priority: -1,
    })
    tile.decoded = 0
    tile.received = 0
}

// A frozen last frame reads exactly like a live one, so a stalled feed says so.
function renderTileStats() {
    for (const tile of state.tiles.values()) {
        const player = tile.player
        const seconds = (performance.now() - tile.countedAt) / 1000
        const decoded = player ? player.decoded : 0
        const fps = (decoded - tile.decoded) / seconds
        tile.decoded = decoded
        // received vs drawn: a phone whose decoder is the bottleneck looks healthy from the robot
        const received = player ? player.received : 0
        const receivedFps = (received - tile.received) / seconds
        tile.received = received
        tile.countedAt = performance.now()
        tile.root.classList.toggle("offline", fps === 0)
        if (!player) {
            setText(tile.info, "disconnected")
        } else if (fps === 0) {
            setText(tile.info, player.decoded ? "stalled" : "waiting for a keyframe")
        } else {
            setText(
                tile.info,
                `${fps.toFixed(0)}/${
                    receivedFps.toFixed(0)
                } fps drawn/sent · ${tile.canvas.width}×${tile.canvas.height}`,
            )
        }
    }
}

function renderTopicTable() {
    const table = element("topic-table")
    table.replaceChildren(...state.topics.map((topic) => {
        const row = document.createElement("div")
        row.className = "topic-row"
        row.append(
            Object.assign(document.createElement("span"), { textContent: topic.topic }),
            Object.assign(document.createElement("span"), {
                className: "type",
                textContent: topic.type || "pickled",
            }),
            Object.assign(document.createElement("span"), {
                className: "rate",
                textContent: `${topic.hz.toFixed(0)} hz`,
            }),
        )
        return row
    }))
}

// ---- settings

const labels = {
    linearSpeed: (value) => `${(+value).toFixed(2)} m/s`,
    angularSpeed: (value) => `${(+value).toFixed(1)} rad/s`,
    deadmanMs: (value) => `${(+value).toFixed(0)} ms`,
    maxWidth: (value) => `${value} px`,
    fps: (value) => `${value} fps`,
    bitrate: (value) => `${(value / 1e6).toFixed(1)} Mb/s`,
}

function setupSettings() {
    const drawer = element("settings")
    const scrim = element("settings-scrim")
    const show = (open) => {
        drawer.hidden = !open
        scrim.hidden = !open
    }
    element("settings-open").addEventListener("click", () => show(true))
    element("settings-close").addEventListener("click", () => show(false))
    scrim.addEventListener("click", () => show(false))

    for (const key of Object.keys(labels)) {
        const input = element(key)
        input.value = settings[key]
        setText(element(`label-${key}`), labels[key](input.value))
        input.addEventListener("input", () => {
            settings[key] = Number(input.value)
            setText(element(`label-${key}`), labels[key](input.value))
            store()
            renderValues()
            if (key === "deadmanMs") {
                armDeadman()
            }
        })
    }
    const invert = element("invertTurn")
    invert.checked = settings.invertTurn
    invert.addEventListener("change", () => {
        settings.invertTurn = invert.checked
        store()
        renderValues()
    })
    const topic = element("topic")
    topic.value = settings.topic
    topic.addEventListener("change", () => {
        const name = "/" + topic.value.trim().replace(/^\/+/, "")
        if (name === "/" || /[#*\s]/.test(name)) {
            topic.value = settings.topic
            return
        }
        // stop the old topic before moving, and move its dead-man switch with it
        app?.setHeartbeat(settings.topic, null)
        settings.topic = name
        topic.value = name
        store()
        armDeadman()
        renderLink(Boolean(app))
    })
}

setupKeyboard()
setupPad()
setupButtons()
setupSettings()
renderValues()
startCommandLoop()
setInterval(refreshTopics, TOPIC_POLL_MS)
setInterval(renderTileStats, 1000)
connect()
