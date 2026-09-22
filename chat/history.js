// Everything that has been sent, so it can be suggested back.
//
// One file, one message per line, newest last, newlines inside a message
// escaped so the file stays line-oriented. Deduplicated on write: a message
// sent twice moves to the end rather than appearing twice, because the
// suggester walks from the end and duplicates would make Up feel stuck.
//
// It is per-user, not per-blueprint. The messages worth recalling ("stand up",
// "go to the kitchen", "what do you see") are the same ones whatever blueprint
// is running, and a per-blueprint file would start empty exactly when the
// suggestions would be most useful.

const LIMIT = 500

function defaultPath() {
    const override = Deno.env.get("DTK_CHAT_HISTORY")
    if (override) {
        return override
    }
    const home = Deno.env.get("HOME") ?? "."
    const cache = Deno.env.get("XDG_CACHE_HOME") || `${home}/.cache`
    return `${cache}/dtk/chat_history`
}

const encode = (text) => text.replace(/\\/g, "\\\\").replace(/\n/g, "\\n")
const decode = (text) => text.replace(/\\n/g, "\n").replace(/\\\\/g, "\\")

export class History {
    constructor(path = defaultPath()) {
        this.path = path
        this.entries = []
    }

    load() {
        try {
            const text = Deno.readTextFileSync(this.path)
            this.entries = text.split("\n").filter((each) => each !== "").map(decode)
        } catch (error) {
            this.entries = [] // no history yet is the normal first run
        }
        return this.entries
    }

    add(message) {
        const text = String(message)
        if (text.trim() === "") {
            return
        }
        const already = this.entries.indexOf(text)
        if (already !== -1) {
            this.entries.splice(already, 1)
        }
        this.entries.push(text)
        if (this.entries.length > LIMIT) {
            this.entries = this.entries.slice(-LIMIT)
        }
        this.save()
    }

    save() {
        try {
            const directory = this.path.replace(/\/[^/]*$/, "")
            Deno.mkdirSync(directory, { recursive: true })
            Deno.writeTextFileSync(this.path, this.entries.map(encode).join("\n") + "\n")
        } catch (error) {
            // A read-only home should not take the chat down with it.
        }
    }
}
