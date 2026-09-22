// The python bridge, from the TUI's side.
//
// A dead bridge is a *status*, not a crash: the chat stays on screen, says the
// listener is down, keeps holding what has been typed, and relaunches with
// backoff. Losing the transport is the single most likely thing to go wrong
// (the blueprint was not up yet, zenoh restarted, uv was still resolving), and
// having to re-run the command and retype the message is the worst possible
// answer to it.
//
// stderr is not shown: dimos logs there, and a chat window full of somebody
// else's logging is unreadable. It goes to a file, whose path is on screen, so
// `dtk chat` can still be debugged.

import { resolveProject, uvIsInstalled } from "../python.js"
import { DtkError } from "../errors.js"

const decoder = new TextDecoder()

// The first relaunch is immediate -- the usual cause is a transport that was
// not ready a second ago -- and then it backs off so a permanently broken
// environment does not spin.
const BACKOFF_MS = [0, 500, 1500, 4000, 8000, 15000]

export class Bridge {
    constructor({ script, dimosModule, transport, logPath, sendOnly = false, onEvent, onState }) {
        this.script = script
        // Send-only skips every subscription: when `spy` is doing the reading,
        // subscribing here too would show each message twice.
        this.sendOnly = sendOnly
        this.dimosModule = dimosModule
        this.transport = transport ?? null
        this.logPath = logPath
        this.onEvent = onEvent
        this.onState = onState
        this.state = "starting" // starting | up | down | broken
        this.detail = ""
        this.attempts = 0
        this.projectRoot = null
        this._process = null
        this._writer = null
        this._stopped = false
        this._logFile = null
    }

    async start() {
        this._stopped = false
        await this._launch()
    }

    async stop() {
        this._stopped = true
        await this._kill()
        if (this._logFile !== null) {
            try {
                this._logFile.close()
            } catch (error) {
                // already closed
            }
            this._logFile = null
        }
    }

    // `true` when the bridge is running and told us its subscriptions are up.
    get usable() {
        return this.state === "up"
    }

    send(command) {
        if (this._writer === null) {
            return false
        }
        try {
            this._writer.write(new TextEncoder().encode(JSON.stringify(command) + "\n"))
            return true
        } catch (error) {
            return false
        }
    }

    _setState(state, detail = "") {
        this.state = state
        this.detail = detail
        if (this.onState) {
            this.onState(state, detail)
        }
    }

    async _kill() {
        const process_ = this._process
        this._process = null
        this._writer = null
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

    async _launch() {
        if (this._stopped) {
            return
        }
        if (!uvIsInstalled()) {
            this._setState(
                "broken",
                "this needs `uv` — curl -LsSf https://astral.sh/uv/install.sh | sh",
            )
            return
        }
        let root = null
        try {
            root = resolveProject({ needsDimosModule: this.dimosModule }).root
        } catch (error) {
            const message = error instanceof DtkError ? error.message.split("\n")[0] : String(error)
            this._setState("broken", message.replace(/^dtk: /, ""))
            return
        }
        this.projectRoot = root

        const args = ["run", "--project", root, "python", this.script]
        if (this.transport !== null) {
            args.push("--transport", this.transport)
        }
        if (this.sendOnly) {
            args.push("--send-only")
        }
        // So a bridge cannot outlive the chat that started it: closed stdin
        // handles a clean exit, but `uv run` plus a SIGKILL'd parent can leave
        // the pipe open and the publisher alive.
        args.push("--parent-pid", String(Deno.pid))

        if (this._logFile === null) {
            try {
                Deno.mkdirSync(this.logPath.replace(/\/[^/]*$/, ""), { recursive: true })
                this._logFile = Deno.openSync(this.logPath, {
                    create: true,
                    write: true,
                    truncate: true,
                })
            } catch (error) {
                this._logFile = null
            }
        }

        let process_ = null
        try {
            process_ = new Deno.Command("uv", {
                args,
                stdin: "piped",
                stdout: "piped",
                stderr: "piped",
            }).spawn()
        } catch (error) {
            this._setState("broken", `could not start uv: ${error}`)
            return
        }
        this._process = process_
        this._writer = process_.stdin.getWriter()
        this.attempts += 1
        this._setState("starting", `uv run --project ${root}`)

        this._pumpStdout(process_).catch(() => {})
        this._pumpStderr(process_).catch(() => {})
        this._watchExit(process_).catch(() => {})
    }

    async _pumpStdout(process_) {
        let pending = ""
        for await (const chunk of process_.stdout) {
            pending += decoder.decode(chunk, { stream: true })
            let newline = pending.indexOf("\n")
            while (newline !== -1) {
                const line = pending.slice(0, newline).trim()
                pending = pending.slice(newline + 1)
                newline = pending.indexOf("\n")
                if (line === "") {
                    continue
                }
                let event = null
                try {
                    event = JSON.parse(line)
                } catch (error) {
                    // Not an event. The bridge guards its stdout, so this means
                    // something wrote past the guard; keep it for the log rather
                    // than dropping it silently.
                    this._log(`[unparsed] ${line}\n`)
                    continue
                }
                if (event.t === "ready") {
                    this._setState("up", this.detail)
                }
                if (event.t === "problem" && event.fatal) {
                    this._setState("broken", event.message ?? "bridge refused to start")
                }
                if (this.onEvent) {
                    this.onEvent(event)
                }
            }
        }
    }

    async _pumpStderr(process_) {
        for await (const chunk of process_.stderr) {
            this._log(decoder.decode(chunk))
        }
    }

    _log(text) {
        if (this._logFile === null) {
            return
        }
        try {
            this._logFile.writeSync(new TextEncoder().encode(text))
        } catch (error) {
            this._logFile = null
        }
    }

    async _watchExit(process_) {
        const status = await process_.status
        if (this._stopped || this._process !== process_) {
            return
        }
        this._process = null
        this._writer = null
        if (this.state !== "broken") {
            this._setState("down", `bridge exited (${status.code}) — see ${this.logPath}`)
        }
        const wait = BACKOFF_MS[Math.min(this.attempts, BACKOFF_MS.length - 1)]
        setTimeout(() => {
            this._launch().catch(() => {})
        }, wait)
    }
}
