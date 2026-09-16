// Colour, but only when someone is there to see it.
//
// Every one of these is the identity function when stdout is not a terminal or
// NO_COLOR is set, so `dtk list | grep ready` and `dtk data summary x.db > out`
// stay plain text. That matters more than it sounds: escape codes in a pipe are
// how a tool's output stops being usable by the next tool.

const wanted = (() => {
    if (Deno.env.get("NO_COLOR")) {
        return false
    }
    if (Deno.env.get("DTK_COLOR") === "1") {
        return true
    }
    try {
        return Deno.stdout.isTerminal()
    } catch (error) {
        return false
    }
})()

const wrap = (open, close) => (text) => (wanted ? `\x1b[${open}m${text}\x1b[${close}m` : `${text}`)

export const bold = wrap(1, 22)
export const dim = wrap(2, 22)
export const italic = wrap(3, 23)
export const red = wrap(31, 39)
export const green = wrap(32, 39)
export const yellow = wrap(33, 39)
export const blue = wrap(34, 39)
export const magenta = wrap(35, 39)
export const cyan = wrap(36, 39)

export const colorEnabled = wanted

// Padding has to count characters, not bytes: a coloured string is longer than
// it looks and `padEnd` would under-pad it into a ragged column.
export function pad(text, width) {
    const visible = String(text).replace(/\x1b\[[0-9;]*m/g, "")
    return String(text) + " ".repeat(Math.max(0, width - visible.length))
}

export const heading = (text) => bold(cyan(text))

// One row of a two-column list, wrapped so a long description does not run off
// the edge and take the next line's indentation with it.
export function describe(label, description, { width = 18, total = 96 } = {}) {
    const room = Math.max(24, total - width - 2)
    const words = String(description).split(/\s+/)
    const lines = [""]
    for (const word of words) {
        const line = lines[lines.length - 1]
        if (line.length === 0) {
            lines[lines.length - 1] = word
        } else if (line.length + 1 + word.length <= room) {
            lines[lines.length - 1] = `${line} ${word}`
        } else {
            lines.push(word)
        }
    }
    const out = [`${pad(label, width)}  ${dim(lines[0])}`]
    for (const line of lines.slice(1)) {
        out.push(`${" ".repeat(width + 2)}${dim(line)}`)
    }
    return out.join("\n")
}
