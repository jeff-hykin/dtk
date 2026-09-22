// Colour, in whatever the terminal can actually do.
//
// The palette is DimOS's own (dimos/cli/dimos.tcss) so `dtk chat` and the
// textual humancli look like the same product. Every colour goes through
// `fg`/`bg`, which degrade from truecolor to the 256-colour cube to the 16
// ANSI colours to plain text -- a gradient over numbers is the whole point of
// this screen, so it has to still mean something at 256 colours.

const environment = (name) => Deno.env.get(name) ?? ""

export const depth = (() => {
    if (environment("NO_COLOR")) {
        return 0
    }
    if (environment("DTK_COLOR_DEPTH")) {
        return Number(environment("DTK_COLOR_DEPTH"))
    }
    const colorterm = environment("COLORTERM").toLowerCase()
    if (colorterm.includes("truecolor") || colorterm.includes("24bit")) {
        return 24
    }
    const term = environment("TERM")
    if (term.includes("256")) {
        return 8
    }
    if (term === "" || term === "dumb") {
        return 0
    }
    return 4
})()

const clamp = (value, low, high) => (value < low ? low : value > high ? high : value)

// The 6x6x6 cube plus the greyscale ramp, which is what 256-colour terminals
// actually have. Picking the nearer of the two matters for greys: the cube's
// greys are coarse and a status bar spends most of its life grey.
function to256(red, green, blue) {
    const level = (value) => clamp(Math.round((value / 255) * 5), 0, 5)
    const cube = 16 + 36 * level(red) + 6 * level(green) + level(blue)
    const average = (red + green + blue) / 3
    if (
        Math.abs(red - average) < 12 && Math.abs(green - average) < 12 &&
        Math.abs(blue - average) < 12
    ) {
        const grey = clamp(Math.round((average - 8) / 10), 0, 23)
        return 232 + grey
    }
    return cube
}

function to16(red, green, blue) {
    const bright = Math.max(red, green, blue) > 150
    const bit = (value) => (value > 100 ? 1 : 0)
    const code = bit(red) + 2 * bit(green) + 4 * bit(blue)
    return (bright ? 90 : 30) + code
}

const hexToRgb = (hex) => {
    const text = hex.replace("#", "")
    const full = text.length === 3 ? [...text].map((each) => each + each).join("") : text
    return [
        parseInt(full.slice(0, 2), 16),
        parseInt(full.slice(2, 4), 16),
        parseInt(full.slice(4, 6), 16),
    ]
}

export function fg(color) {
    if (depth === 0) {
        return ""
    }
    const [red, green, blue] = typeof color === "string" ? hexToRgb(color) : color
    if (depth >= 24) {
        return `\x1b[38;2;${red};${green};${blue}m`
    }
    if (depth >= 8) {
        return `\x1b[38;5;${to256(red, green, blue)}m`
    }
    return `\x1b[${to16(red, green, blue)}m`
}

export const reset = depth === 0 ? "" : "\x1b[0m"
export const bold = depth === 0 ? "" : "\x1b[1m"
export const dim = depth === 0 ? "" : "\x1b[2m"
export const italic = depth === 0 ? "" : "\x1b[3m"

// The DimOS palette.
export const color = {
    accent: "#00eeee",
    cyan: "#00eeee",
    white: "#b5e4f4",
    brightWhite: "#ffffff",
    grey: "#5a6a70",
    darkGrey: "#33403f",
    background: "#0b0f0f",
    human: "#8cbdf2",
    agent: "#00eeee",
    system: "#ffcc00",
    tool: "#c792ea",
    error: "#ff5370",
    good: "#4ddba0",
    warn: "#ffcc00",
    held: "#ffa657",
}

// Interpolate a list of stops, each `[position, hex]`, at `t` in [0, 1].
export function ramp(stops, t) {
    const at = clamp(Number.isFinite(t) ? t : 0, 0, 1)
    let low = stops[0]
    let high = stops[stops.length - 1]
    for (let index = 0; index < stops.length - 1; index++) {
        if (at >= stops[index][0] && at <= stops[index + 1][0]) {
            low = stops[index]
            high = stops[index + 1]
            break
        }
    }
    const span = high[0] - low[0] || 1
    const fraction = (at - low[0]) / span
    const [lowRed, lowGreen, lowBlue] = hexToRgb(low[1])
    const [highRed, highGreen, highBlue] = hexToRgb(high[1])
    return [
        Math.round(lowRed + (highRed - lowRed) * fraction),
        Math.round(lowGreen + (highGreen - lowGreen) * fraction),
        Math.round(lowBlue + (highBlue - lowBlue) * fraction),
    ]
}

// Cool for small, hot for large. Deliberately not a rainbow: the ends have to
// be obviously different at a glance and stay distinguishable at 256 colours.
export const NUMBER_STOPS = [
    [0.0, "#4f86c6"],
    [0.35, "#00eeee"],
    [0.6, "#4ddba0"],
    [0.8, "#ffcc00"],
    [1.0, "#ff7043"],
]

// Visible width of a string, ignoring escape codes. Wide CJK and emoji take
// two cells; combining marks take none.
export function width(text) {
    let total = 0
    for (const character of String(text).replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")) {
        const point = character.codePointAt(0)
        if (point < 32 || (point >= 0x300 && point <= 0x36f)) {
            continue
        }
        const wide = (point >= 0x1100 && point <= 0x115f) ||
            (point >= 0x2e80 && point <= 0xa4cf) ||
            (point >= 0xac00 && point <= 0xd7a3) ||
            (point >= 0xf900 && point <= 0xfaff) ||
            (point >= 0xfe30 && point <= 0xfe6f) ||
            (point >= 0xff00 && point <= 0xff60) ||
            (point >= 0xffe0 && point <= 0xffe6) ||
            (point >= 0x1f300 && point <= 0x1faff)
        total += wide ? 2 : 1
    }
    return total
}

export function padTo(text, room) {
    const short = room - width(text)
    return short > 0 ? text + " ".repeat(short) : clip(text, room)
}

// Cut a coloured string to `room` visible cells. Escape sequences are copied
// through and cost nothing, so the colours survive the cut; a reset is added
// because the cut may well have removed the one that was there.
export function clip(text, room) {
    if (width(text) <= room) {
        return text
    }
    let out = ""
    let used = 0
    let at = 0
    const source = String(text)
    while (at < source.length && used < room) {
        if (source[at] === "\x1b") {
            const match = source.slice(at).match(/^\x1b\[[0-9;?]*[a-zA-Z]/)
            if (match) {
                out += match[0]
                at += match[0].length
                continue
            }
        }
        const character = String.fromCodePoint(source.codePointAt(at))
        const step = width(character)
        if (used + step > room) {
            break
        }
        out += character
        used += step
        at += character.length
    }
    return out + reset
}
