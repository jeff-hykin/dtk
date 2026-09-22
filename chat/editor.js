// The text box: a cursor, a string, and the usual readline motions.
//
// Multi-line is supported because a pasted or shift-entered message is a
// normal thing to send to an agent; Enter sends, Alt+Enter adds a newline.
//
// `suggestion` is the ghost completion shown after the cursor. It is only ever
// offered when the cursor is at the end of the text -- a completion appearing
// in the middle of a line being edited is noise, not help.

export class Editor {
    constructor() {
        this.text = ""
        this.cursor = 0
        this.suggestion = ""
        this._history = []
        this._historyAt = null
        this._draft = ""
    }

    setHistory(entries) {
        this._history = entries
    }

    get value() {
        return this.text
    }

    clear() {
        this.text = ""
        this.cursor = 0
        this.suggestion = ""
        this._historyAt = null
    }

    set(text, cursor = null) {
        this.text = text
        this.cursor = cursor === null ? text.length : Math.min(cursor, text.length)
    }

    insert(piece) {
        this.text = this.text.slice(0, this.cursor) + piece + this.text.slice(this.cursor)
        this.cursor += piece.length
        this._historyAt = null
    }

    backspace() {
        if (this.cursor === 0) {
            return
        }
        // Step back by a whole code point, so deleting an emoji does not leave
        // half a surrogate pair behind.
        const before = [...this.text.slice(0, this.cursor)]
        const last = before[before.length - 1] ?? ""
        this.text = this.text.slice(0, this.cursor - last.length) + this.text.slice(this.cursor)
        this.cursor -= last.length
        this._historyAt = null
    }

    deleteForward() {
        if (this.cursor >= this.text.length) {
            return
        }
        const after = [...this.text.slice(this.cursor)]
        const next = after[0] ?? ""
        this.text = this.text.slice(0, this.cursor) + this.text.slice(this.cursor + next.length)
        this._historyAt = null
    }

    deleteWordBack() {
        if (this.cursor === 0) {
            return
        }
        const head = this.text.slice(0, this.cursor)
        const trimmed = head.replace(/\S+\s*$|\s+$/, "")
        this.text = trimmed + this.text.slice(this.cursor)
        this.cursor = trimmed.length
        this._historyAt = null
    }

    killToEnd() {
        this.text = this.text.slice(0, this.cursor)
        this._historyAt = null
    }

    killToStart() {
        this.text = this.text.slice(this.cursor)
        this.cursor = 0
        this._historyAt = null
    }

    left() {
        if (this.cursor > 0) {
            const before = [...this.text.slice(0, this.cursor)]
            this.cursor -= (before[before.length - 1] ?? "").length
        }
    }

    right() {
        if (this.cursor < this.text.length) {
            const after = [...this.text.slice(this.cursor)]
            this.cursor += (after[0] ?? "").length
        }
    }

    wordLeft() {
        const head = this.text.slice(0, this.cursor)
        this.cursor = head.replace(/\S+\s*$|\s+$/, "").length
    }

    wordRight() {
        const tail = this.text.slice(this.cursor)
        const match = tail.match(/^\s*\S+/)
        this.cursor += match ? match[0].length : tail.length
    }

    lineStart() {
        const start = this.text.lastIndexOf("\n", Math.max(0, this.cursor - 1))
        this.cursor = start === -1 ? 0 : start + 1
    }

    lineEnd() {
        const end = this.text.indexOf("\n", this.cursor)
        this.cursor = end === -1 ? this.text.length : end
    }

    // ------------------------------------------------------------- suggestions

    // The ghost text after the cursor, or "" when there is nothing to offer.
    // Most recent first, and never a suggestion identical to what is typed.
    refreshSuggestion() {
        this.suggestion = ""
        if (this.text === "" || this.cursor !== this.text.length) {
            return
        }
        if (this.text.includes("\n")) {
            return
        }
        for (let index = this._history.length - 1; index >= 0; index--) {
            const entry = this._history[index]
            if (entry.length > this.text.length && entry.startsWith(this.text)) {
                this.suggestion = entry.slice(this.text.length)
                return
            }
        }
        // Nothing starts with it; try a case-insensitive pass before giving up,
        // because history is full of sentences and the first letter is the one
        // most likely to be typed in the other case.
        const lowered = this.text.toLowerCase()
        for (let index = this._history.length - 1; index >= 0; index--) {
            const entry = this._history[index]
            if (entry.length > this.text.length && entry.toLowerCase().startsWith(lowered)) {
                this.suggestion = entry.slice(this.text.length)
                return
            }
        }
    }

    acceptSuggestion() {
        if (this.suggestion === "") {
            return false
        }
        this.text += this.suggestion
        this.cursor = this.text.length
        this.suggestion = ""
        return true
    }

    // Accept one word of the suggestion: the shape that makes a long recalled
    // command editable instead of all-or-nothing.
    acceptSuggestionWord() {
        if (this.suggestion === "") {
            return false
        }
        const match = this.suggestion.match(/^\s*\S+/)
        const piece = match ? match[0] : this.suggestion
        this.text += piece
        this.cursor = this.text.length
        this.suggestion = this.suggestion.slice(piece.length)
        return true
    }

    // ----------------------------------------------------------------- history

    // Up/Down walk history, filtered by what is already typed when the walk
    // starts -- the behaviour of a shell's history search rather than a blind
    // scroll through everything ever sent.
    historyBack() {
        if (this._history.length === 0) {
            return
        }
        if (this._historyAt === null) {
            this._draft = this.text
            this._historyAt = this._history.length
        }
        const prefix = this._draft
        for (let index = this._historyAt - 1; index >= 0; index--) {
            if (prefix === "" || this._history[index].startsWith(prefix)) {
                this._historyAt = index
                this.set(this._history[index])
                return
            }
        }
    }

    historyForward() {
        if (this._historyAt === null) {
            return
        }
        const prefix = this._draft
        for (let index = this._historyAt + 1; index < this._history.length; index++) {
            if (prefix === "" || this._history[index].startsWith(prefix)) {
                this._historyAt = index
                this.set(this._history[index])
                return
            }
        }
        this._historyAt = null
        this.set(this._draft)
    }

    // Where the cursor sits inside the wrapped box. `segments` come from
    // `wrapInput`, which reports each row's offset into the text -- wrapping
    // eats the space it breaks at, so a row's length alone does not say where
    // the next row starts and the caret would drift.
    caretIn(segments) {
        for (let row = segments.length - 1; row >= 0; row--) {
            const segment = segments[row]
            if (this.cursor >= segment.start) {
                return {
                    row,
                    column: Math.min(this.cursor - segment.start, segment.text.length),
                }
            }
        }
        return { row: 0, column: 0 }
    }
}
