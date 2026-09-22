// The terminal, as a thing you hand a list of lines to.
//
// Two decisions worth knowing about:
//
// 1. It diffs. A frame is an array of already-coloured strings, one per row,
//    and only the rows that changed are rewritten. A chat screen redraws on a
//    spinner tick many times a second, and repainting the whole window that
//    often flickers on every terminal and is visibly slow over ssh.
//
// 2. It owns the alternate screen buffer, so quitting leaves the scrollback
//    exactly as it was found. Every exit path goes through `stop()`, including
//    signals and an uncaught throw -- a terminal left in raw mode with the
//    cursor hidden is worse than a stack trace.

import { width } from "./theme.js"

const encoder = new TextEncoder()

export class Screen {
    constructor() {
        this.rows = 24
        this.columns = 80
        this._previous = []
        this._running = false
        this._caret = null
        this._onResize = null
        this._resizeListener = null
    }

    start({ onResize } = {}) {
        this._onResize = onResize ?? null
        this.measure()
        // 1049 = alternate screen, 25l = hide the cursor, 2J = clear it.
        this._writeRaw("\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H")
        this._running = true
        this._previous = []
        try {
            this._resizeListener = () => {
                this.measure()
                this._previous = [] // a resize invalidates every cached row
                if (this._onResize) {
                    this._onResize()
                }
            }
            Deno.addSignalListener("SIGWINCH", this._resizeListener)
        } catch (error) {
            this._resizeListener = null // not every platform has SIGWINCH
        }
    }

    stop() {
        if (!this._running) {
            return
        }
        this._running = false
        if (this._resizeListener) {
            try {
                Deno.removeSignalListener("SIGWINCH", this._resizeListener)
            } catch (error) {
                // already gone
            }
        }
        this._writeRaw("\x1b[?25h\x1b[?1049l")
    }

    measure() {
        try {
            const size = Deno.consoleSize()
            this.rows = Math.max(6, size.rows)
            this.columns = Math.max(24, size.columns)
        } catch (error) {
            // not a terminal; the defaults are as good a guess as any
        }
    }

    // `lines` is at most `rows` entries. `caret` is `{row, column}`, 0-based,
    // and is where the cursor is parked after the frame is written -- the
    // terminal's own cursor is the only one that blinks correctly and sits in
    // the right place for a screen reader.
    draw(lines, caret = null) {
        if (!this._running) {
            return
        }
        const out = []
        const total = Math.min(lines.length, this.rows)
        for (let row = 0; row < total; row++) {
            const line = lines[row] ?? ""
            if (this._previous[row] === line) {
                continue
            }
            this._previous[row] = line
            // \x1b[K clears to end of line, so a shorter row does not leave the
            // tail of the longer row that used to be there.
            out.push(`\x1b[${row + 1};1H${line}\x1b[K`)
        }
        for (let row = total; row < this._previous.length; row++) {
            if (this._previous[row] !== "") {
                this._previous[row] = ""
                out.push(`\x1b[${row + 1};1H\x1b[K`)
            }
        }
        this._previous.length = Math.max(total, 0)
        if (caret) {
            const row = Math.min(Math.max(0, caret.row), this.rows - 1)
            const column = Math.min(Math.max(0, caret.column), this.columns - 1)
            out.push(`\x1b[${row + 1};${column + 1}H\x1b[?25h`)
            this._caret = caret
        } else if (this._caret !== null) {
            out.push("\x1b[?25l")
            this._caret = null
        }
        if (out.length > 0) {
            this._writeRaw(out.join(""))
        }
    }

    _writeRaw(text) {
        try {
            Deno.stdout.writeSync(encoder.encode(text))
        } catch (error) {
            // The terminal went away mid-frame; the main loop will notice.
        }
    }
}

// Wrap for the input box, reporting where each row starts in the original
// text. The caret has to land on the right cell, and a wrap that breaks at a
// space consumes that space, so the row lengths alone do not add up to an
// offset. Rows are split by visible width, never by index.
export function wrapInput(text, room) {
    const limit = room < 2 ? 2 : room
    const segments = []
    let base = 0
    for (const paragraph of String(text).split("\n")) {
        let at = 0
        while (true) {
            // How much of the paragraph fits, measured in cells rather than
            // characters: one wide glyph is two cells and slicing by index
            // would overflow the row.
            let used = 0
            let end = at
            while (end < paragraph.length) {
                const character = String.fromCodePoint(paragraph.codePointAt(end))
                const step = width(character)
                if (used + step > limit) {
                    break
                }
                used += step
                end += character.length
            }
            if (end >= paragraph.length) {
                segments.push({ text: paragraph.slice(at), start: base + at })
                break
            }
            // Break at the last space in the row, unless that would leave an
            // almost-empty row -- an unbroken path or token has to be cut.
            const space = paragraph.lastIndexOf(" ", end)
            if (space > at && end - space < limit * 0.75) {
                segments.push({ text: paragraph.slice(at, space), start: base + at })
                at = space + 1
            } else {
                segments.push({ text: paragraph.slice(at, end), start: base + at })
                at = end
            }
        }
        base += paragraph.length + 1
    }
    return segments
}

// Wrap `text` to `room` columns, breaking at spaces where it can and mid-word
// where it cannot. Returns plain (uncoloured) segments -- colour is applied by
// the caller after wrapping, because wrapping coloured text means counting
// visible width per character and that is a different, slower problem.
export function wrap(text, room) {
    if (room < 4) {
        return [text]
    }
    const lines = []
    for (const paragraph of String(text).split("\n")) {
        if (paragraph === "") {
            lines.push("")
            continue
        }
        let line = ""
        for (const word of paragraph.split(" ")) {
            const candidate = line === "" ? word : `${line} ${word}`
            if (width(candidate) <= room) {
                line = candidate
                continue
            }
            if (line !== "") {
                lines.push(line)
                line = ""
            }
            let rest = word
            while (width(rest) > room) {
                // Cut by visible width, not by index: one wide character is two
                // cells and slicing by index would overflow the row.
                let cut = 0
                let used = 0
                for (const character of rest) {
                    const step = width(character)
                    if (used + step > room) {
                        break
                    }
                    used += step
                    cut += character.length
                }
                lines.push(rest.slice(0, cut))
                rest = rest.slice(cut)
            }
            line = rest
        }
        lines.push(line)
    }
    return lines
}
