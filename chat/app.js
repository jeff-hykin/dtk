// `dtk chat` -- the loop that ties the source, the keyboard and the screen
// together.
//
// Everything with an opinion lives in a neighbour: `source_lcm.js` /
// `bridge.js` put events on the wire, `presence.js` decides whether anyone is
// listening, `outbox.js` holds what cannot be sent yet, `view.js` turns state
// into rows. This file owns the state and the ordering, and nothing else.
//
// The render is a single scheduled frame rather than a call per change: a
// burst of tool-stream updates can arrive faster than a terminal can be
// written to, and drawing each one is how a TUI ends up slower than the
// program it is watching.

import { Editor } from "./editor.js"
import { History } from "./history.js"
import { Outbox } from "./outbox.js"
import { Presence } from "./presence.js"
import { Screen } from "./screen.js"
import { render } from "./view.js"
import { keyEvents, PASTE_OFF, PASTE_ON } from "./keys.js"
import { poolFrom } from "./numbers.js"
import { color } from "./theme.js"

const FRAME_MS = 60
// How long a tool box stays up after its last update before it is folded into
// the transcript. A tool that says nothing for this long is done, whether or
// not it sent a stop.
const TOOL_IDLE_MS = 6000
const TOOL_LINES = 5
const BLOCK_LIMIT = 600

export class ChatApp {
    constructor({ source, blueprintWiring = null, readOnly = false }) {
        this.source = source
        this.readOnly = readOnly
        this.blueprintWiring = blueprintWiring
        this.screen = new Screen()
        this.editor = new Editor()
        this.history = new History()
        this.presence = new Presence()
        this.outbox = new Outbox({ onChange: () => this.invalidate() })

        this.blocks = []
        this.toolPanels = []
        this.thinking = false
        this.thinkingSince = null
        this.idle = null
        this.backend = source.backend ?? null
        this.scroll = 0
        this.message = null
        this.forceArmed = false
        this.running = false

        this._frame = null
        this._ticker = null
        this._dirty = false
        this._sentTexts = []
        this._wiringAsked = new Set()
    }

    // ------------------------------------------------------------------ setup

    async start() {
        this.history.load()
        this.editor.setHistory(this.history.entries)

        this.source.onEvent = (event) => this.onEvent(event)
        this.source.onState = (state, detail) => {
            this.presence.noteBridge(state)
            if (state === "broken" || state === "down") {
                this.note(detail || `source ${state}`, "error")
            }
            this.invalidate()
        }

        this.screen.start({ onResize: () => this.invalidate() })
        try {
            Deno.stdin.setRaw(true)
        } catch (error) {
            // Not a terminal. `dtk chat` needs one; say so plainly.
            this.screen.stop()
            throw new Error("dtk chat needs a terminal (stdin is not a tty)")
        }
        Deno.stdout.writeSync(new TextEncoder().encode(PASTE_ON))

        this.running = true
        this.note("connecting…")
        await this.source.start()

        // One timer drives every animation and the two polls. A frame is only
        // actually drawn when something changed or an animation is live.
        this._ticker = setInterval(() => this.tick(), FRAME_MS)
        this.invalidate()

        for await (const key of keyEvents()) {
            if (!this.running) {
                break
            }
            await this.onKey(key)
        }
    }

    async stop() {
        if (!this.running) {
            return
        }
        this.running = false
        if (this._ticker !== null) {
            clearInterval(this._ticker)
        }
        if (this._frame !== null) {
            clearTimeout(this._frame)
        }
        try {
            Deno.stdout.writeSync(new TextEncoder().encode(PASTE_OFF))
            Deno.stdin.setRaw(false)
        } catch (error) {
            // stdin already restored or gone
        }
        this.screen.stop()
        await this.source.stop()
    }

    // ------------------------------------------------------------- the frame

    invalidate() {
        this._dirty = true
    }

    note(text, kind = "info") {
        this.message = { text, kind, at: Date.now() }
        this.invalidate()
    }

    tick() {
        this.presence.pollRegistry()
        this.askWiring()
        this.expireToolPanels()
        this.releaseOutbox()

        // An animation is running whenever there is something moving on
        // screen; otherwise a frame is only drawn on a real change.
        const animating = this.thinking ||
            this.toolPanels.length > 0 ||
            this.outbox.pending.length > 0 ||
            this.presence.assess().state === "live" ||
            (this.message !== null && Date.now() - this.message.at < 4200) ||
            this.blocks.some((each) => Date.now() - each.at < 1300)
        if (this._dirty || animating) {
            this._dirty = false
            this.draw()
        }
    }

    // A block's badge follows its outbox item, so the flip from held to sent
    // happens on the message itself rather than only in the status bar.
    syncBlockStatuses() {
        for (const block of this.blocks) {
            if (block.outboxId === undefined) {
                continue
            }
            const item = this.outbox.find(block.outboxId)
            if (item === null) {
                // Gone from the outbox means it was sent and forgotten.
                if (block.status !== "failed") {
                    block.status = "sent"
                }
                continue
            }
            block.status = item.status
        }
    }

    draw() {
        this.syncBlockStatuses()
        const assessment = this.presence.assess()
        const state = {
            screen: this.screen,
            editor: this.editor,
            blocks: this.blocks,
            toolPanels: this.toolPanels,
            thinking: this.thinking,
            thinkingSince: this.thinkingSince,
            presence: assessment,
            bridge: this.source.state,
            publisher: this.source.publisher ?? null,
            readOnly: this.readOnly,
            blueprint: this.presence.blueprint,
            backend: this.backend,
            outbox: this.outbox.held.length,
            idle: this.idle,
            scroll: this.scroll,
            message: this.message,
            forceArmed: this.forceArmed,
            numberPool: poolFrom(this._sentTexts, 5),
            now: Date.now(),
        }
        const frame = render(state)
        this.screen.draw(frame.lines, frame.caret)
    }

    // -------------------------------------------------------------- transcript

    push(block) {
        this.blocks.push({ at: Date.now(), ...block })
        if (this.blocks.length > BLOCK_LIMIT) {
            this.blocks = this.blocks.slice(-BLOCK_LIMIT)
        }
        // Following the tail is the default; a reader who has scrolled up stays
        // where they are, with the "more below" marker telling them why.
        if (this.scroll > 0) {
            this.scroll += 1
        }
        this.invalidate()
    }

    // ------------------------------------------------------------------ events

    onEvent(event) {
        switch (event.t) {
            case "hello":
                this.backend = event.backend ?? this.backend
                break
            case "ready":
                this.note(
                    this.backend === "lcm"
                        ? `listening on ${this.source.url ?? "lcm"}`
                        : "connected",
                )
                break
            case "agent":
                this.onAgent(event)
                break
            case "idle":
                this.idle = event.value
                this.presence.noteIdle(event.value)
                // Idle going false is the agent picking the message up, which
                // is the only positive acknowledgement there is.
                this.setThinking(event.value === false)
                if (event.value === true) {
                    this.finalizeAllToolPanels()
                }
                break
            case "tool":
                this.onTool(event)
                break
            case "stats":
                this.presence.noteStats(event.workers)
                break
            case "sent": {
                const item = this.outbox.markSent(event.id)
                if (item !== null) {
                    this.outbox.forget(event.id)
                }
                // Without an idle signal, a sent message is the best moment to
                // start showing that something is happening.
                if (this.idle === null) {
                    this.setThinking(true)
                }
                break
            }
            case "problem":
                if (event.id) {
                    this.outbox.markFailed(event.id, event.message)
                }
                this.push({
                    role: "system",
                    text: `${event.where}: ${event.message}`,
                    textColor: color.error,
                })
                break
            default:
                break // pong, and anything a newer source learns to say
        }
        this.invalidate()
    }

    onAgent(event) {
        this.presence.noteAgentTraffic()

        // A reply that is about a running tool belongs in that tool's box, not
        // in the middle of the conversation.
        if (event.about_tool && event.tool) {
            const panel = this.panelFor(event.tool)
            panel.entries.push({ text: event.text, fromAgent: true, at: Date.now() })
            while (panel.entries.length > TOOL_LINES) {
                panel.entries.shift()
            }
            panel.count += 1
            panel.lastAt = Date.now()
            this.invalidate()
            return
        }

        const role = event.role === "ai"
            ? "ai"
            : event.role === "tool"
            ? "tool"
            : event.role === "human"
            ? "you"
            : "system"

        const hasText = (event.text ?? "").trim() !== ""
        const calls = event.tool_calls ?? []
        if (!hasText && calls.length === 0) {
            return
        }
        this.push({
            role,
            text: event.text ?? "",
            toolCalls: calls,
            // A tool's *result* is data and gets the number ramp; the agent's
            // prose does not, or a paragraph ends up speckled.
            numbers: role === "tool",
            textColor: role === "system" ? color.system : undefined,
            status: role === "you" ? "sent" : undefined,
        })
        if (role === "ai" && hasText) {
            this.setThinking(false)
        }
    }

    onTool(event) {
        if (event.method === "dimos/tool_stopped") {
            this.finalizeToolPanel(event.tool)
            return
        }
        const panel = this.panelFor(event.tool)
        panel.entries.push({ text: event.text ?? "", fromAgent: false, at: Date.now() })
        while (panel.entries.length > TOOL_LINES) {
            panel.entries.shift()
        }
        panel.count += 1
        panel.lastAt = Date.now()
        this.invalidate()
    }

    panelFor(tool) {
        let panel = this.toolPanels.find((each) => each.tool === tool)
        if (panel === undefined) {
            panel = {
                tool,
                entries: [],
                count: 0,
                startedAt: Date.now(),
                lastAt: Date.now(),
                done: false,
            }
            this.toolPanels.push(panel)
        }
        return panel
    }

    // A finished tool becomes one transcript entry: the box disappears and the
    // fact that it ran, and what it last said, stays in the history.
    finalizeToolPanel(tool) {
        const index = this.toolPanels.findIndex((each) => each.tool === tool)
        if (index === -1) {
            return
        }
        const [panel] = this.toolPanels.splice(index, 1)
        const seconds = Math.round((Date.now() - panel.startedAt) / 1000)
        const tail = panel.entries[panel.entries.length - 1]
        this.push({
            role: "tool",
            text: `${panel.tool} finished — ${panel.count} update${panel.count === 1 ? "" : "s"}` +
                ` in ${seconds}s` + (tail ? `\n${tail.text}` : ""),
            numbers: true,
        })
    }

    finalizeAllToolPanels() {
        for (const panel of [...this.toolPanels]) {
            this.finalizeToolPanel(panel.tool)
        }
    }

    expireToolPanels() {
        const at = Date.now()
        for (const panel of [...this.toolPanels]) {
            if (at - panel.lastAt > TOOL_IDLE_MS) {
                this.finalizeToolPanel(panel.tool)
            }
        }
    }

    setThinking(value) {
        if (value && !this.thinking) {
            this.thinkingSince = Date.now()
        }
        if (!value) {
            this.thinkingSince = null
        }
        this.thinking = value
        this.invalidate()
    }

    // --------------------------------------------------------------- presence

    // Ask the blueprint's own graph whether anything in it takes /human_input.
    // This is what lets a message be released before the agent has ever
    // spoken; see the deadlock note in presence.js.
    askWiring() {
        const blueprint = this.presence.blueprint
        if (blueprint === null || this.blueprintWiring === null) {
            return
        }
        if (this._wiringAsked.has(blueprint)) {
            return
        }
        this._wiringAsked.add(blueprint)
        this.blueprintWiring(blueprint)
            .then((result) => {
                if (result === null) {
                    return
                }
                this.presence.noteWiring(blueprint, result.listens, result.modules)
                if (!result.listens) {
                    this.note(`${blueprint} has no module taking /human_input`, "error")
                }
                this.invalidate()
            })
            .catch(() => {
                // A graph that cannot be read is simply one fewer signal.
            })
    }

    releaseOutbox() {
        if (this.outbox.held.length === 0) {
            return
        }
        const assessment = this.presence.assess()
        if (!assessment.sendable && !this.forceArmed) {
            return
        }
        if (!this.source.usable) {
            return
        }
        const count = this.outbox.held.length
        this.outbox.flush((command) => this.source.send(command))
        this.forceArmed = false
        if (count > 0) {
            this.note(`released ${count} held message${count === 1 ? "" : "s"}`)
        }
    }

    // ------------------------------------------------------------------- keys

    async onKey(key) {
        switch (key.name) {
            case "ctrl-c":
            case "ctrl-d":
                await this.stop()
                return
            case "enter":
                this.submit()
                break
            case "alt-enter":
            case "alt-m":
                this.editor.insert("\n")
                break
            case "paste":
                this.editor.insert(key.text)
                break
            case "char":
                this.editor.insert(key.text)
                break
            case "backspace":
                this.editor.backspace()
                break
            case "delete":
                this.editor.deleteForward()
                break
            case "ctrl-w":
            case "alt-backspace":
                this.editor.deleteWordBack()
                break
            case "ctrl-k":
                this.editor.killToEnd()
                break
            case "ctrl-u":
                this.editor.killToStart()
                break
            case "ctrl-a":
                this.editor.lineStart()
                break
            case "ctrl-e":
                this.editor.lineEnd()
                break
            case "left":
                this.editor.left()
                break
            case "right":
                // At the end of the line, Right takes the suggestion -- the
                // shell behaviour, and the reason the ghost text is worth
                // having.
                if (!this.editor.acceptSuggestion()) {
                    this.editor.right()
                }
                break
            case "ctrl-left":
            case "alt-left":
                this.editor.wordLeft()
                break
            case "ctrl-right":
                this.editor.wordRight()
                break
            case "alt-right":
                if (!this.editor.acceptSuggestionWord()) {
                    this.editor.wordRight()
                }
                break
            case "tab":
                this.editor.acceptSuggestion()
                break
            case "up":
                this.editor.historyBack()
                break
            case "down":
                this.editor.historyForward()
                break
            case "pageup":
                this.scroll += Math.max(1, this.screen.rows - 8)
                break
            case "pagedown":
                this.scroll = Math.max(0, this.scroll - Math.max(1, this.screen.rows - 8))
                break
            case "ctrl-up":
                this.scroll += 1
                break
            case "ctrl-down":
                this.scroll = Math.max(0, this.scroll - 1)
                break
            case "home":
                this.editor.lineStart()
                break
            case "end":
                if (this.scroll > 0) {
                    this.scroll = 0
                } else {
                    this.editor.lineEnd()
                }
                break
            case "ctrl-s":
                this.armForce()
                break
            case "ctrl-x":
                this.dropHeld()
                break
            case "ctrl-l":
                this.screen._previous = [] // force a full repaint
                break
            case "escape":
                if (this.editor.text !== "") {
                    this.editor.clear()
                } else {
                    this.scroll = 0
                }
                break
            default:
                break
        }
        this.editor.refreshSuggestion()
        this.invalidate()
    }

    submit() {
        const text = this.editor.text.trim()
        if (text === "") {
            return
        }
        if (this.readOnly) {
            this.note("read-only: --read-only never starts the publisher", "error")
            return
        }
        this.history.add(text)
        this.editor.setHistory(this.history.entries)
        this._sentTexts.push(text)
        this.editor.clear()

        const assessment = this.presence.assess()
        const sendNow = (assessment.sendable || this.forceArmed) && this.source.usable
        const item = this.outbox.add(text, { forced: this.forceArmed })
        this.push({
            role: "you",
            text,
            numbers: true,
            status: sendNow ? "sending" : "held",
            outboxId: item.id,
        })
        this.scroll = 0

        if (sendNow) {
            this.outbox.flush((command) => this.source.send(command))
            this.forceArmed = false
        } else {
            this.note(assessment.why ? `held — ${assessment.why}` : "held", "info")
        }
    }

    armForce() {
        if (this.outbox.held.length === 0) {
            this.note("nothing held to send", "info")
            return
        }
        if (!this.source.usable) {
            this.note("cannot send: the source is not up", "error")
            return
        }
        this.forceArmed = true
        this.note("sending anyway — nobody may be listening", "info")
        this.releaseOutbox()
    }

    dropHeld() {
        const dropped = this.outbox.dropHeld()
        if (dropped === 0) {
            this.note("nothing held to drop", "info")
            return
        }
        for (const block of this.blocks) {
            if (block.status === "held") {
                block.status = "failed"
            }
        }
        this.note(`dropped ${dropped} held message${dropped === 1 ? "" : "s"}`, "info")
    }
}
