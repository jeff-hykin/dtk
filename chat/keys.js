// Raw stdin bytes, as key events.
//
// Deno has no key decoder, so this is the whole job: read chunks, split them
// into escape sequences and characters, and hand out `{name, text, ctrl, alt}`.
//
// Bracketed paste is enabled, and matters more than it looks: without it a
// pasted multi-line message arrives as a burst of Enter presses and sends
// itself line by line. With it the paste arrives as one `paste` event and can
// be dropped into the box intact.

const decoder = new TextDecoder()

export const PASTE_ON = "\x1b[?2004h"
export const PASTE_OFF = "\x1b[?2004l"

const SIMPLE = {
    "\x1b[A": "up",
    "\x1b[B": "down",
    "\x1b[C": "right",
    "\x1b[D": "left",
    "\x1bOA": "up",
    "\x1bOB": "down",
    "\x1bOC": "right",
    "\x1bOD": "left",
    "\x1b[H": "home",
    "\x1b[F": "end",
    "\x1bOH": "home",
    "\x1bOF": "end",
    "\x1b[1~": "home",
    "\x1b[4~": "end",
    "\x1b[3~": "delete",
    "\x1b[5~": "pageup",
    "\x1b[6~": "pagedown",
    "\x1b[Z": "shift-tab",
    "\x1b[1;5C": "ctrl-right",
    "\x1b[1;5D": "ctrl-left",
    "\x1b[1;3C": "alt-right",
    "\x1b[1;3D": "alt-left",
    "\x1b[1;5A": "ctrl-up",
    "\x1b[1;5B": "ctrl-down",
}

const CONTROL_NAMES = {
    1: "ctrl-a",
    2: "ctrl-b",
    3: "ctrl-c",
    4: "ctrl-d",
    5: "ctrl-e",
    6: "ctrl-f",
    7: "ctrl-g",
    8: "backspace", // some terminals send BS for backspace
    9: "tab",
    10: "enter",
    11: "ctrl-k",
    12: "ctrl-l",
    13: "enter",
    14: "ctrl-n",
    15: "ctrl-o",
    16: "ctrl-p",
    18: "ctrl-r",
    19: "ctrl-s",
    20: "ctrl-t",
    21: "ctrl-u",
    22: "ctrl-v",
    23: "ctrl-w",
    24: "ctrl-x",
    25: "ctrl-y",
    26: "ctrl-z",
    127: "backspace",
}

// Split one decoded chunk into events. Returns `{events, remainder}`; the
// remainder is a partial escape sequence to prepend to the next chunk, which
// happens whenever a key's bytes land across a read boundary.
export function decodeChunk(text) {
    const events = []
    let at = 0
    while (at < text.length) {
        const rest = text.slice(at)

        if (rest.startsWith("\x1b[200~")) {
            const end = rest.indexOf("\x1b[201~")
            if (end === -1) {
                return { events, remainder: rest } // paste still arriving
            }
            events.push({ name: "paste", text: rest.slice(6, end) })
            at += end + 6
            continue
        }

        if (rest[0] === "\x1b") {
            // A lone escape at the very end of a chunk is ambiguous: it is
            // either the Escape key or the start of a sequence whose remaining
            // bytes have not arrived. Holding it costs one keypress of latency
            // on Escape and avoids emitting a spurious one on every arrow key.
            if (rest.length === 1) {
                return { events, remainder: rest }
            }
            let matched = null
            for (const sequence of Object.keys(SIMPLE)) {
                if (rest.startsWith(sequence)) {
                    if (matched === null || sequence.length > matched.length) {
                        matched = sequence
                    }
                }
            }
            if (matched !== null) {
                events.push({ name: SIMPLE[matched] })
                at += matched.length
                continue
            }
            // An unfinished CSI (`\x1b[` with no final byte yet).
            if (/^\x1b\[[0-9;?]*$/.test(rest)) {
                return { events, remainder: rest }
            }
            const csi = rest.match(/^\x1b\[[0-9;?]*[a-zA-Z~]/)
            if (csi) {
                events.push({ name: "unknown", text: csi[0] })
                at += csi[0].length
                continue
            }
            // Alt+key arrives as escape followed by the key.
            const next = rest[1]
            if (next === "\r" || next === "\n") {
                events.push({ name: "alt-enter" })
                at += 2
                continue
            }
            if (next === "\x7f") {
                events.push({ name: "alt-backspace" })
                at += 2
                continue
            }
            if (next >= " " && next <= "~") {
                events.push({ name: `alt-${next.toLowerCase()}`, text: next, alt: true })
                at += 2
                continue
            }
            events.push({ name: "escape" })
            at += 1
            continue
        }

        const code = text.codePointAt(at)
        if (code < 32 || code === 127) {
            events.push({ name: CONTROL_NAMES[code] ?? "unknown", ctrl: true })
            at += 1
            continue
        }
        const character = String.fromCodePoint(code)
        events.push({ name: "char", text: character })
        at += character.length
    }
    return { events, remainder: "" }
}

// How long to wait for the rest of an escape sequence before deciding the
// lone escape byte was the Escape key. Every terminal sends the whole sequence
// in one write, so this only ever fires for a real keypress -- but it has to
// exist: without it a bare Escape is held for the rest of the session waiting
// for bytes that are never coming.
const ESCAPE_GRACE_MS = 40

// Async iterator of key events off a raw-mode stdin.
export async function* keyEvents(signal) {
    let remainder = ""
    // The read promise outlives a lost race: `Deno.stdin.read` cannot be
    // cancelled, so the same pending read is awaited again next time round
    // rather than starting a second one (two concurrent reads on the same fd
    // interleave keystrokes).
    let pending = null
    let buffer = null

    while (!(signal && signal.aborted)) {
        if (pending === null) {
            buffer = new Uint8Array(4096)
            const target = buffer
            pending = Deno.stdin.read(target).then((count) => ({ count, target }))
        }

        let settled = null
        try {
            settled = remainder === "\x1b"
                ? await Promise.race([
                    pending,
                    new Promise((resolve) => setTimeout(() => resolve("timeout"), ESCAPE_GRACE_MS)),
                ])
                : await pending
        } catch (error) {
            return // stdin closed under us
        }
        if (settled === "timeout") {
            remainder = ""
            yield { name: "escape" }
            continue // the same read is still pending; await it next time
        }
        pending = null
        if (settled === null || settled.count === null) {
            return
        }
        const text = remainder +
            decoder.decode(settled.target.subarray(0, settled.count), { stream: true })
        const result = decodeChunk(text)
        remainder = result.remainder
        for (const event of result.events) {
            yield event
        }
    }
}
