// Reading the conversation off the wire through `spy`.
//
// `spy` is the rust binary dtk already downloads for `dtk constellation`. It
// sniffs LCM *and* zenoh and prints one json object per message with the raw
// payload base64'd:
//
//     {"kind":"raw","channel":"/agent","transport":"lcm","b64":"gASV…"}
//     {"kind":"packets","events":[["lcm","/resource_stats",1,155]],"t":…}
//
// That is the whole receive side of `dtk chat`, for both backends, with no
// python and no zenoh client. `pickle.js` turns the payload into a message and
// `messages.js` turns the message into an event.
//
// It cannot publish -- it is a sniffer -- so `send` is somebody else's job;
// `source_composite.js` pairs this with a publisher.

import { unpickle } from "./pickle.js"
import { channelName, eventFor, TOPIC_NAMES } from "./messages.js"

const decoder = new TextDecoder()
const WANTED = new Set(Object.values(TOPIC_NAMES))

const base64ToBytes = (text) => {
    const binary = atob(text)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index++) {
        bytes[index] = binary.charCodeAt(index)
    }
    return bytes
}

export class SpySource {
    constructor({ path, transport = null, onEvent, onState } = {}) {
        this.path = path
        this.transport = transport
        this.onEvent = onEvent
        this.onState = onState
        this.state = "starting"
        this.detail = ""
        this.backend = transport
        this.seen = new Set() // which channels have actually carried something
        // Which transport the conversation is actually happening on, observed
        // rather than guessed. The publisher needs this: a blueprint on lcm
        // and a publisher on zenoh both "work" and never meet.
        this.observed = null
        this._process = null
        this._stopped = false
    }

    get usable() {
        return this.state === "up"
    }

    _emit(event) {
        if (this.onEvent) {
            this.onEvent(event)
        }
    }

    _setState(state, detail = "") {
        this.state = state
        this.detail = detail
        if (this.onState) {
            this.onState(state, detail)
        }
    }

    async start() {
        this._stopped = false
        let process_ = null
        try {
            process_ = new Deno.Command(this.path, {
                stdout: "piped",
                stderr: "piped",
            }).spawn()
        } catch (error) {
            this._setState("broken", `could not run the spy: ${error}`)
            return
        }
        this._process = process_
        this._setState("up", this.path)
        this._emit({ t: "hello", backend: this.backend ?? "lcm+zenoh", via: "spy" })
        this._emit({ t: "ready", publishing: false })

        this._pump(process_).catch((error) => {
            if (!this._stopped) {
                this._setState("down", `the spy stopped: ${error}`)
            }
        })
        this._drainStderr(process_).catch(() => {})
        this._watchExit(process_).catch(() => {})
    }

    async _pump(process_) {
        let pending = ""
        for await (const chunk of process_.stdout) {
            pending += decoder.decode(chunk, { stream: true })
            const lines = pending.split("\n")
            pending = lines.pop() ?? ""
            for (const line of lines) {
                if (line.trim() === "") {
                    continue
                }
                let record = null
                try {
                    record = JSON.parse(line)
                } catch (error) {
                    continue // a partial or non-json line
                }
                this._onRecord(record)
            }
        }
    }

    _onRecord(record) {
        if (record.kind === "packets") {
            // A traffic tick. It carries no payload, but it does say which
            // transport is alive, which is how the status bar can name the
            // backend without being told.
            for (const event of record.events ?? []) {
                const [transport] = event
                if (this.backend === null && typeof transport === "string") {
                    this.backend = transport
                }
            }
            return
        }
        if (record.kind !== "raw" || typeof record.b64 !== "string") {
            return
        }
        const name = channelName(record.channel ?? "")
        if (!WANTED.has(name)) {
            return
        }
        if (this.backend === null && typeof record.transport === "string") {
            this.backend = record.transport
        }
        // `/agent` and `/human_input` are the conversation itself, so they are
        // the authority on where to publish; `/resource_stats` is a weaker
        // signal (dtop could be on a different backend) but better than an
        // env-var guess, so it only fills in when nothing better is known.
        if (typeof record.transport === "string") {
            const strong = name === TOPIC_NAMES.agent ||
                name === TOPIC_NAMES.humanInput ||
                name === TOPIC_NAMES.agentIdle
            if (strong || this.observed === null) {
                this.observed = record.transport
            }
        }
        // A `--transport` filter is honoured here rather than by the spy, so
        // both backends can be watched at once by default.
        if (this.transport !== null && record.transport !== this.transport) {
            return
        }
        this.seen.add(name)

        let value = null
        try {
            value = unpickle(base64ToBytes(record.b64))
        } catch (error) {
            this._emit({
                t: "problem",
                where: `decode ${record.channel}`,
                message: error instanceof Error ? error.message : String(error),
            })
            return
        }
        const event = eventFor(record.channel ?? "", value)
        if (event !== null) {
            this._emit(event)
        }
    }

    async _drainStderr(process_) {
        // The spy is chatty about zenoh scouting. None of it belongs in a chat
        // window, and none of it is worth a file either.
        for await (const chunk of process_.stderr) {
            void chunk
        }
    }

    async _watchExit(process_) {
        const status = await process_.status
        if (this._stopped || this._process !== process_) {
            return
        }
        this._process = null
        this._setState("down", `the spy exited (${status.code})`)
    }

    // A sniffer cannot publish. Saying so plainly lets the composite source
    // decide what to do instead of silently dropping a message.
    send(command) {
        if (command.t === "ping") {
            this._emit({ t: "pong", id: command.id })
            return true
        }
        return false
    }

    async stop() {
        this._stopped = true
        const process_ = this._process
        this._process = null
        if (process_ === null) {
            return
        }
        try {
            process_.kill("SIGTERM")
        } catch (error) {
            // already dead
        }
        try {
            await process_.status
        } catch (error) {
            // already reaped
        }
    }
}
