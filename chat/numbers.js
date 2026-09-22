// Numbers in a message, coloured by how big they are relative to their
// neighbours.
//
// The point is reading a line like `goto x: 4.2 y: -1.8 yaw: 0.3` at a glance
// and seeing which component is the large one, without parsing it. So the
// scale is *local*: the pool is the numbers in the text being typed plus the
// numbers in the last few messages, and the ends of the ramp are that pool's
// own minimum and maximum. A number typed on its own has nothing to compare
// against and is left the ordinary foreground colour rather than being painted
// as though it were an extreme.
//
// Two things the naive version gets wrong, both fixed here:
//
//  - `dimos6`, `#ff00aa` and `v1.2` are not measurements. A digit glued to the
//    end of an identifier is part of the identifier.
//  - one outlier flattens everything else. `x: 0.1 y: 0.2 timeout: 30000`
//    paints x and y the same colour on a linear scale, which is exactly the
//    comparison being asked for. When the spread is more than three orders of
//    magnitude the scale goes logarithmic, which keeps the small numbers
//    distinguishable from each other.

import { fg, NUMBER_STOPS, ramp, reset } from "./theme.js"

// Signed decimals with an optional exponent. The leading `(^|[^...])` guard is
// handled by the filter below rather than the pattern, so that the match
// offsets stay exact.
const NUMBER_PATTERN = /-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g

const IDENTIFIER_CHARACTER = /[A-Za-z_#]/

export function findNumbers(text) {
    const found = []
    NUMBER_PATTERN.lastIndex = 0
    let match = null
    while ((match = NUMBER_PATTERN.exec(text)) !== null) {
        const start = match.index
        const end = start + match[0].length
        const before = start > 0 ? text[start - 1] : ""
        // Part of a word (`dimos6`, `#ff0`, `utf8`), or the tail of a version
        // or a date (`1.2.3`, `2026-09-18`) -- none of these are quantities.
        // A digit before a match only happens when the match begins with `-`,
        // which is the `09` of a date or a subtraction, never a quantity.
        if (before !== "" && (IDENTIFIER_CHARACTER.test(before) || /[\d.]/.test(before))) {
            continue
        }
        const after = text[end] ?? ""
        if (after === "." && /\d/.test(text[end + 1] ?? "")) {
            continue // `1.2.3`: a version, not a number
        }
        const value = Number(match[0])
        if (!Number.isFinite(value)) {
            continue
        }
        found.push({ start, end, text: match[0], value })
    }
    return found
}

// `pool` is every value in scope, including the ones in `text`.
export function scaleFor(pool) {
    const values = pool.filter((each) => Number.isFinite(each))
    if (values.length < 2) {
        return null
    }
    const low = Math.min(...values)
    const high = Math.max(...values)
    if (!(high > low)) {
        return null // every number is the same; a ramp would be a lie
    }
    const magnitude = (value) => Math.abs(value)
    const smallest = Math.min(...values.map(magnitude).filter((each) => each > 0))
    const largest = Math.max(...values.map(magnitude))
    const logarithmic = smallest > 0 && largest / smallest > 1000 && low >= 0

    if (logarithmic) {
        const floor = Math.log10(smallest)
        const ceiling = Math.log10(largest)
        return (value) => {
            const at = Math.log10(Math.max(magnitude(value), smallest))
            return (at - floor) / (ceiling - floor || 1)
        }
    }
    return (value) => (value - low) / (high - low)
}

// Paint the numbers in `text`, given a pool of values to scale against.
// Everything that is not a number keeps `baseColor`.
export function paintNumbers(text, pool, baseColor) {
    const numbers = findNumbers(text)
    const base = baseColor ? fg(baseColor) : ""
    if (numbers.length === 0) {
        return `${base}${text}${reset}`
    }
    const scale = scaleFor([...pool, ...numbers.map((each) => each.value)])
    if (scale === null) {
        return `${base}${text}${reset}`
    }
    const out = []
    let at = 0
    for (const number of numbers) {
        out.push(base + text.slice(at, number.start))
        out.push(fg(ramp(NUMBER_STOPS, scale(number.value))) + number.text + reset)
        at = number.end
    }
    out.push(base + text.slice(at) + reset)
    return out.join("")
}

// The pool a message is scaled against: its own numbers plus those of the
// previous `depth` messages. Kept here so the input box and the transcript use
// the same rule and a line does not change colour once it is sent.
export function poolFrom(previousTexts, depth = 5) {
    const pool = []
    for (const text of previousTexts.slice(-depth)) {
        for (const number of findNumbers(text)) {
            pool.push(number.value)
        }
    }
    return pool
}
