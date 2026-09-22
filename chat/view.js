// One frame of the chat, as an array of coloured rows.
//
// The renderer is pure: state in, lines out, no writes and no timers. Every
// animation is a function of `now`, so a frame can be rebuilt at any moment
// and the spinner is wherever it should be rather than wherever it was left.
// That is also what makes the whole screen testable without a terminal.
//
// Layout, top to bottom:
//
//   status bar      one row, coloured by the connection state
//   transcript      bottom-anchored and scrollable; the newest thing is at the
//                   bottom, which is where the eye already is
//   tool boxes      docked above the input while a tool is streaming, so
//                   progress does not scroll away under the conversation
//   input box       grows with what is typed, up to a third of the screen
//   hint row        whatever is most useful right now, not a fixed legend

import { bold, color, dim, fg, italic, NUMBER_STOPS, padTo, ramp, reset, width } from "./theme.js"
import { wrap, wrapInput } from "./screen.js"
import { paintNumbers } from "./numbers.js"

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
const PULSE = ["·", "•", "●", "•"]
const STATE_LOOK = {
    live: { dot: "●", color: color.good, label: "live" },
    probably: { dot: "◐", color: color.warn, label: "not ready" },
    searching: { dot: "○", color: color.grey, label: "waiting" },
    stale: { dot: "◍", color: color.warn, label: "quiet" },
    "no-bridge": { dot: "✕", color: color.error, label: "no listener" },
}

const ROLE_LOOK = {
    you: { mark: "▌", color: color.human, label: "you" },
    ai: { mark: "◆", color: color.agent, label: "agent" },
    system: { mark: "!", color: color.system, label: "system" },
    tool: { mark: "↳", color: color.tool, label: "tool" },
    call: { mark: "▶", color: color.tool, label: "" },
    note: { mark: "·", color: color.grey, label: "dtk" },
}

const clock = (at) => new Date(at).toTimeString().slice(0, 8)

// A newly arrived block gets a brighter left bar that fades out over about a
// second. It is the cheapest possible "this one is new" and costs no rows.
function markFor(role, ageMs) {
    const look = ROLE_LOOK[role] ?? ROLE_LOOK.note
    if (ageMs > 1200) {
        return `${fg(look.color)}${look.mark}${reset}`
    }
    const heat = 1 - ageMs / 1200
    return `${fg(ramp([[0, look.color], [1, "#ffffff"]], heat))}${bold}${look.mark}${reset}`
}

function elapsed(ms) {
    const seconds = Math.floor(ms / 1000)
    if (seconds < 60) {
        return `${seconds}s`
    }
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) {
        return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`
    }
    return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`
}

// Arguments of a tool call on one line, short enough to read.
function summarizeArguments(args, room) {
    if (args === null || args === undefined) {
        return ""
    }
    let text = ""
    if (typeof args === "string") {
        text = args
    } else if (typeof args === "object" && !Array.isArray(args)) {
        text = Object.entries(args)
            .map(([key, value]) => `${key}=${shortValue(value)}`)
            .join(" ")
    } else {
        text = JSON.stringify(args)
    }
    text = text.replace(/\s+/g, " ").trim()
    return width(text) > room ? text.slice(0, Math.max(0, room - 1)) + "…" : text
}

function shortValue(value) {
    if (typeof value === "string") {
        return value.length > 40 ? `"${value.slice(0, 39)}…"` : `"${value}"`
    }
    if (value === null || typeof value !== "object") {
        return String(value)
    }
    const text = JSON.stringify(value)
    return text.length > 40 ? text.slice(0, 39) + "…" : text
}

// ------------------------------------------------------------------ status bar

// What the publisher is up to, when that is worth a word. `idle` means no
// python has been started, which is the normal state until the first message
// and worth saying out loud -- it is the difference between "nothing running"
// and "something broken".
const PUBLISHER_LOOK = {
    idle: null,
    up: null,
    starting: { text: "publisher starting", color: color.warn },
    down: { text: "publisher down", color: color.error },
    broken: { text: "cannot send", color: color.error },
}

function statusBar(state, columns) {
    const { presence, bridge, blueprint, backend, now, outbox, idle, publisher, readOnly } = state
    const look = STATE_LOOK[presence.state] ?? STATE_LOOK.searching
    const left = []

    left.push(`${fg(color.accent)}${bold}dtk chat${reset}`)

    // The dot breathes while live, so a frozen screen is obvious at a glance.
    const dot = presence.state === "live" ? PULSE[Math.floor(now / 420) % PULSE.length] : look.dot
    left.push(`${fg(look.color)}${dot} ${look.label}${reset}`)

    if (blueprint) {
        left.push(`${fg(color.white)}${blueprint}${reset}`)
    }

    const right = []
    if (outbox > 0) {
        right.push(`${fg(color.held)}${bold}held ${outbox}${reset}`)
    }
    if (idle === false) {
        right.push(`${fg(color.agent)}busy${reset}`)
    }
    if (readOnly) {
        right.push(`${dim}${fg(color.grey)}read-only${reset}`)
    }
    const publisherLook = PUBLISHER_LOOK[publisher] ?? null
    if (publisherLook !== null) {
        right.push(`${fg(publisherLook.color)}${publisherLook.text}${reset}`)
    }
    if (backend) {
        right.push(`${dim}${fg(color.grey)}${backend}${reset}`)
    }
    if (bridge !== "up") {
        right.push(`${fg(color.error)}not reading (${bridge})${reset}`)
    }

    const divider = `${dim}${fg(color.darkGrey)} │ ${reset}`
    const leftText = left.join(divider)
    const rightText = right.join(divider)

    // `why` is the one part that can be any length ("memory-world-hyperspace
    // is running, but the agent has not spoken"), so it gets whatever room is
    // left and is cut to fit. The status bar must be exactly one row: a second
    // row shifts the whole transcript and the frame diff repaints everything.
    let middle = ""
    const fixed = width(leftText) + width(rightText)
    const spare = columns - fixed - 6
    if (presence.why && spare > 12) {
        const text = width(presence.why) > spare
            ? presence.why.slice(0, Math.max(0, spare - 1)) + "…"
            : presence.why
        middle = divider + `${dim}${fg(color.grey)}${text}${reset}`
    }

    const head = leftText + middle
    const room = columns - width(head) - width(rightText)
    if (room < 1) {
        return padTo(head, columns)
    }
    return head + " ".repeat(room) + rightText
}

// ------------------------------------------------------------------- transcript

// One transcript entry as rows. `pool` is the number pool for colour-scaling.
function blockLines(block, columns, now, pool) {
    const look = ROLE_LOOK[block.role] ?? ROLE_LOOK.note
    const gutter = 2
    const room = Math.max(8, columns - gutter - 10)
    const mark = markFor(block.role, now - block.at)
    const lines = []

    const stamp = `${dim}${fg(color.darkGrey)}${clock(block.at)}${reset}`
    const badges = []
    if (block.status === "held") {
        badges.push(`${fg(color.held)}held${reset}`)
    }
    if (block.status === "sending") {
        badges.push(
            `${fg(color.held)}${SPINNER[Math.floor(now / 80) % SPINNER.length]} sending${reset}`,
        )
    }
    if (block.status === "failed") {
        badges.push(`${fg(color.error)}not sent${reset}`)
    }
    if (block.role === "you" && block.status === "sent") {
        badges.push(`${fg(color.good)}✓${reset}`)
    }

    const label = look.label ? `${fg(look.color)}${bold}${look.label}${reset}` : ""
    const head = [label, stamp, ...badges].filter((each) => each !== "").join(" ")
    if (head !== "") {
        lines.push(`${mark} ${head}`)
    }

    for (const raw of wrap(block.text ?? "", room)) {
        // Numbers are scaled for what the human types and for anything that
        // reads like data coming back; prose from the agent is left alone, so a
        // paragraph is not speckled.
        const painted = block.numbers
            ? paintNumbers(raw, pool, block.textColor ?? color.white)
            : `${fg(block.textColor ?? color.white)}${raw}${reset}`
        lines.push(`${fg(look.color)}${look.mark === "▌" ? "▌" : " "}${reset} ${painted}`)
    }

    for (const call of block.toolCalls ?? []) {
        const summary = summarizeArguments(call.args, room - width(call.name) - 4)
        lines.push(
            `${fg(color.tool)}  ▶ ${bold}${call.name}${reset}` +
                (summary ? ` ${dim}${fg(color.grey)}${summary}${reset}` : ""),
        )
    }
    return lines
}

// A tool that is streaming right now, as a small box docked above the input.
function toolBoxLines(panel, columns, now) {
    const room = Math.max(10, columns - 4)
    const age = elapsed(now - panel.startedAt)
    const spin = panel.done ? "✓" : SPINNER[Math.floor(now / 80) % SPINNER.length]
    const status = panel.done ? `${panel.count} updates` : `${panel.count} · ${age}`
    const title = `${fg(color.tool)}${spin} ${bold}${panel.tool}${reset} ` +
        `${dim}${fg(color.grey)}${status}${reset}`
    const lines = [`${fg(color.tool)}╭─${reset} ${title}`]
    const hidden = panel.count - panel.entries.length
    if (hidden > 0) {
        lines.push(`${fg(color.tool)}│${reset} ${dim}${fg(color.grey)}(+${hidden} earlier)${reset}`)
    }
    for (const entry of panel.entries) {
        for (const raw of wrap(entry.text, room)) {
            const painted = entry.fromAgent
                ? `${fg(color.agent)}› ${raw}${reset}`
                : paintNumbers(raw, [], color.white)
            lines.push(`${fg(color.tool)}│${reset} ${painted}`)
        }
    }
    lines.push(`${fg(color.tool)}╰${"─".repeat(Math.min(columns - 2, 20))}${reset}`)
    return lines
}

function thinkingLines(state, columns) {
    const { now, thinkingSince } = state
    const spin = SPINNER[Math.floor(now / 80) % SPINNER.length]
    // A slow brightness sweep, so it reads as alive without flashing.
    const heat = (Math.sin(now / 500) + 1) / 2
    const shade = fg(ramp([[0, "#2a5c5c"], [1, color.agent]], heat))
    const since = thinkingSince === null
        ? ""
        : ` ${dim}${fg(color.grey)}${elapsed(now - thinkingSince)}${reset}`
    return [`${fg(color.agent)}◆${reset} ${shade}${spin} thinking${reset}${since}`]
}

// -------------------------------------------------------------------- input box

function inputLines(state, columns) {
    const { editor, presence, now, forceArmed } = state
    const room = columns - 4
    const segments = wrapInput(editor.text, room)
    const sendable = presence.sendable || forceArmed
    const edge = sendable ? color.accent : color.held
    const rows = []

    rows.push(`${fg(edge)}╭${"─".repeat(Math.max(0, columns - 2))}╮${reset}`)
    const pool = state.numberPool
    for (let index = 0; index < segments.length; index++) {
        const text = segments[index].text
        let painted = paintNumbers(text, pool, color.brightWhite)
        let trailing = ""
        if (index === segments.length - 1) {
            if (editor.suggestion !== "") {
                const roomLeft = room - width(text)
                const ghost = editor.suggestion.length > roomLeft
                    ? editor.suggestion.slice(0, Math.max(0, roomLeft - 1)) + "…"
                    : editor.suggestion
                trailing = `${dim}${italic}${fg(color.grey)}${ghost}${reset}`
            } else if (editor.text === "") {
                trailing = `${dim}${fg(color.darkGrey)}${
                    sendable ? "say something to the agent" : "type anyway — it will be held"
                }${reset}`
            }
        }
        const content = painted + trailing
        const used = width(text) + width(trailing.replace(/\x1b\[[0-9;]*m/g, ""))
        rows.push(
            `${fg(edge)}│${reset} ${content}${" ".repeat(Math.max(0, room - used))} ${
                fg(edge)
            }│${reset}`,
        )
    }
    const cue = sendable
        ? `${dim}${fg(color.darkGrey)}enter to send${reset}`
        : `${fg(color.held)}${PULSE[Math.floor(now / 420) % PULSE.length]} will be held${reset}`
    const bottom = `${fg(edge)}╰${"─".repeat(Math.max(0, columns - 2 - width(cue) - 2))}${reset}` +
        ` ${cue} ${fg(edge)}╯${reset}`
    rows.push(bottom)
    return { rows, segments }
}

function hintRow(state, columns) {
    const { editor, presence, outbox, message, now } = state
    if (message !== null && now - message.at < 4000) {
        const tone = message.kind === "error" ? color.error : color.accent
        return padTo(`${fg(tone)}${message.text}${reset}`, columns)
    }
    const parts = []
    if (editor.suggestion !== "") {
        parts.push(`${fg(color.accent)}tab${reset}${dim}${fg(color.grey)} complete${reset}`)
        parts.push(`${fg(color.accent)}alt+→${reset}${dim}${fg(color.grey)} one word${reset}`)
    } else {
        parts.push(`${dim}${fg(color.grey)}↑ history${reset}`)
    }
    if (outbox > 0 && !presence.sendable) {
        parts.push(`${fg(color.accent)}ctrl+s${reset}${dim}${fg(color.grey)} send anyway${reset}`)
        parts.push(`${fg(color.accent)}ctrl+x${reset}${dim}${fg(color.grey)} drop held${reset}`)
    }
    parts.push(`${dim}${fg(color.grey)}alt+enter newline${reset}`)
    parts.push(`${dim}${fg(color.grey)}ctrl+c quit${reset}`)

    // Drop whole hints from the end until the row fits. Cutting mid-word gives
    // "alt+enter ne", which reads as a rendering bug rather than a short row --
    // and the hints are ordered most-useful-first for exactly this reason.
    const separator = `${dim}${fg(color.darkGrey)}  ·  ${reset}`
    let shown = parts
    while (shown.length > 1 && width(shown.join(separator)) > columns) {
        shown = shown.slice(0, -1)
    }
    return padTo(shown.join(separator), columns)
}

// ------------------------------------------------------------------- the frame

export function render(state) {
    const { screen } = state
    const columns = screen.columns
    const rows = screen.rows

    const input = inputLines(state, columns)
    const tools = []
    for (const panel of state.toolPanels) {
        tools.push(...toolBoxLines(panel, columns, state.now))
    }

    // The transcript gets whatever is left after the fixed furniture. The tool
    // boxes are clipped first if they would squeeze it below a few rows: the
    // conversation matters more than a progress box.
    const furniture = 1 + input.rows.length + 1
    let transcriptRoom = rows - furniture - tools.length
    let toolRows = tools
    if (transcriptRoom < 4) {
        toolRows = tools.slice(Math.max(0, tools.length - Math.max(0, rows - furniture - 4)))
        transcriptRoom = Math.max(0, rows - furniture - toolRows.length)
    }

    const body = []
    for (const block of state.blocks) {
        body.push(...blockLines(block, columns, state.now, state.numberPool))
    }
    if (state.thinking) {
        body.push(...thinkingLines(state, columns))
    }

    // Bottom-anchored, with `scroll` counted in rows from the bottom.
    const maxScroll = Math.max(0, body.length - transcriptRoom)
    const scroll = Math.min(state.scroll, maxScroll)
    const end = body.length - scroll
    const start = Math.max(0, end - transcriptRoom)
    const visible = body.slice(start, end)
    while (visible.length < transcriptRoom) {
        visible.unshift("")
    }

    const lines = [statusBar(state, columns)]
    lines.push(...visible)
    if (scroll > 0) {
        // Replace the last transcript row with a marker rather than stealing a
        // row: the reader needs to know they are not at the bottom.
        lines[lines.length - 1] = padTo(
            `${fg(color.accent)}  ↓ ${scroll} more row${
                scroll === 1 ? "" : "s"
            } below — end to jump back${reset}`,
            columns,
        )
    }
    lines.push(...toolRows)
    lines.push(...input.rows)
    lines.push(hintRow(state, columns))

    // Where the terminal cursor goes: inside the box, on the caret.
    const caretIn = state.editor.caretIn(input.segments)
    const caret = {
        row: lines.length - 1 - input.rows.length + caretIn.row,
        column: 2 + caretIn.column,
    }
    return { lines, caret }
}
