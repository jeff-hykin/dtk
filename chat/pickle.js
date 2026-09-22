// Enough of the python pickle format to read a langchain message.
//
// `/agent`, `/agent_idle` and `/tool_streams` go over dimos's *pickled*
// transports: the LCM channel carries `pickle.dumps(object)` with no type
// suffix. Reading that is the one thing standing between `dtk chat` and not
// needing python at all, so it is done here rather than by shelling out.
//
// This is a *structural* unpickler. It never imports or constructs anything:
// a class reference becomes `{__class__: "module.Name"}` and `REDUCE` /
// `NEWOBJ` / `BUILD` fill in its fields. That is exactly what is wanted for
// reading a message, and it is also the only safe way to do it -- a faithful
// unpickler executes arbitrary constructors chosen by the sender, which is a
// remote code execution primitive. Nothing here can call anything.
//
// It works on langchain messages because pydantic v2 models pickle as their
// state dict: `BUILD` receives `{"__dict__": {...}, "__pydantic_extra__":
// ..., "__pydantic_fields_set__": ...}` and every leaf is a string, number,
// list or dict. No custom `__reduce__`, no C extension types.
//
// Protocols 0-5 opcodes are handled; the ones left out (`EXT1`/`EXT2`/`EXT4`
// copyreg extensions, `PERSID`) do not appear in a pydantic pickle and raise
// rather than silently returning something wrong.

const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: false })
const latin1 = new TextDecoder("latin1")

// A marker on the stack, for the opcodes that pop back to it.
const MARK = Symbol("mark")

class Reader {
    constructor(bytes) {
        this.bytes = bytes
        this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        this.at = 0
    }

    byte() {
        if (this.at >= this.bytes.length) {
            throw new Error("pickle: truncated")
        }
        return this.bytes[this.at++]
    }

    take(count) {
        if (this.at + count > this.bytes.length) {
            throw new Error("pickle: truncated")
        }
        const slice = this.bytes.subarray(this.at, this.at + count)
        this.at += count
        return slice
    }

    // Up to and including the next newline, without it.
    line() {
        const start = this.at
        while (this.at < this.bytes.length && this.bytes[this.at] !== 0x0a) {
            this.at++
        }
        const text = latin1.decode(this.bytes.subarray(start, this.at))
        this.at++ // the newline
        return text
    }

    uint8() {
        return this.byte()
    }

    uint16() {
        const value = this.view.getUint16(this.at, true)
        this.at += 2
        return value
    }

    int32() {
        const value = this.view.getInt32(this.at, true)
        this.at += 4
        return value
    }

    uint32() {
        const value = this.view.getUint32(this.at, true)
        this.at += 4
        return value
    }

    uint64() {
        const value = this.view.getBigUint64(this.at, true)
        this.at += 8
        return value
    }

    float64be() {
        const value = this.view.getFloat64(this.at, false)
        this.at += 8
        return value
    }
}

// A python object whose class was named but never constructed.
export class PyObject {
    constructor(className) {
        this.__class__ = className
        this.args = null
        this.state = null
        this.fields = {}
    }

    // Field lookup that sees through pydantic's state wrapper, so a caller can
    // ask for `content` without knowing how the model was pickled.
    get(name) {
        if (Object.hasOwn(this.fields, name)) {
            return this.fields[name]
        }
        return undefined
    }
}

// `int` coming back as a BigInt is a nuisance for every caller; only keep the
// BigInt when the value genuinely does not fit.
const narrow = (value) => {
    if (typeof value !== "bigint") {
        return value
    }
    return value >= -9007199254740991n && value <= 9007199254740991n ? Number(value) : value
}

function decodeLong(bytes) {
    if (bytes.length === 0) {
        return 0n
    }
    let value = 0n
    for (let index = bytes.length - 1; index >= 0; index--) {
        value = (value << 8n) | BigInt(bytes[index])
    }
    // Two's complement, little-endian, signed.
    const bits = BigInt(bytes.length * 8)
    if (bytes[bytes.length - 1] & 0x80) {
        value -= 1n << bits
    }
    return value
}

// Merge a `BUILD` state into an object. Pydantic hands over `__dict__` plus
// its own private slots; a plain object hands over a dict, or a
// `(dict, slots)` pair.
function applyState(target, state) {
    if (state === null || state === undefined) {
        return
    }
    let dictionary = state
    let slots = null
    if (Array.isArray(state) && state.length === 2) {
        dictionary = state[0]
        slots = state[1]
    }
    const absorb = (source) => {
        if (source instanceof Map) {
            for (const [key, value] of source) {
                target.fields[String(key)] = value
            }
        } else if (source && typeof source === "object") {
            for (const [key, value] of Object.entries(source)) {
                target.fields[key] = value
            }
        }
    }
    if (dictionary instanceof Map && dictionary.has("__dict__")) {
        // pydantic v2: the real fields live one level in.
        absorb(dictionary.get("__dict__"))
        for (const [key, value] of dictionary) {
            if (key !== "__dict__") {
                target.fields[key] = value
            }
        }
    } else {
        absorb(dictionary)
    }
    absorb(slots)
    target.state = state
}

// The handful of `REDUCE` targets worth evaluating, all of them pure builders
// with no side effects. Protocol 2 reaches for these where 4 and 5 have
// dedicated opcodes -- `bytes` becomes `_codecs.encode(text, "latin1")` and a
// `set` becomes `set([...])` -- and a `dtk chat` talking to an older writer
// should still show the value rather than an opaque class name. Anything not
// on this list stays an inert `PyObject`; nothing here can call out.
const PURE_REDUCERS = {
    "_codecs.encode": (args) => {
        const [text, encoding] = Array.isArray(args) ? args : []
        if (typeof text !== "string") {
            return text
        }
        if (encoding === undefined || String(encoding).toLowerCase().startsWith("latin")) {
            const bytes = new Uint8Array(text.length)
            for (let index = 0; index < text.length; index++) {
                bytes[index] = text.charCodeAt(index) & 0xff
            }
            return bytes
        }
        return encoder.encode(text)
    },
    "builtins.set": (args) => new Set(Array.isArray(args) ? args[0] ?? [] : []),
    "__builtin__.set": (args) => new Set(Array.isArray(args) ? args[0] ?? [] : []),
    "builtins.frozenset": (args) => new Set(Array.isArray(args) ? args[0] ?? [] : []),
    "builtins.bytearray": (args) => {
        const first = Array.isArray(args) ? args[0] : args
        return first instanceof Uint8Array ? first : new Uint8Array(0)
    },
}

export function unpickle(bytes) {
    const reader = new Reader(bytes)
    const stack = []
    const memo = new Map()

    const popMark = () => {
        const index = stack.lastIndexOf(MARK)
        if (index === -1) {
            throw new Error("pickle: no mark")
        }
        const items = stack.splice(index + 1)
        stack.pop() // the mark itself
        return items
    }

    const pairsToMap = (items) => {
        const map = new Map()
        for (let index = 0; index + 1 < items.length; index += 2) {
            map.set(items[index], items[index + 1])
        }
        return map
    }

    while (true) {
        const opcode = reader.byte()
        switch (opcode) {
            // ------------------------------------------------------ framing
            case 0x80: // PROTO
                reader.byte()
                break
            case 0x95: // FRAME
                reader.uint64()
                break
            case 0x2e: // STOP
                return stack.pop()

            // ------------------------------------------------------ scalars
            case 0x4e: // NONE
                stack.push(null)
                break
            case 0x88: // NEWTRUE
                stack.push(true)
                break
            case 0x89: // NEWFALSE
                stack.push(false)
                break
            case 0x49: { // INT
                const text = reader.line()
                if (text === "01") {
                    stack.push(true)
                } else if (text === "00") {
                    stack.push(false)
                } else {
                    stack.push(Number(text))
                }
                break
            }
            case 0x4c: { // LONG
                const text = reader.line().replace(/L$/, "")
                stack.push(narrow(BigInt(text)))
                break
            }
            case 0x8a: // LONG1
                stack.push(narrow(decodeLong(reader.take(reader.uint8()))))
                break
            case 0x8b: // LONG4
                stack.push(narrow(decodeLong(reader.take(reader.uint32()))))
                break
            case 0x4a: // BININT
                stack.push(reader.int32())
                break
            case 0x4b: // BININT1
                stack.push(reader.uint8())
                break
            case 0x4d: // BININT2
                stack.push(reader.uint16())
                break
            case 0x46: // FLOAT
                stack.push(Number(reader.line()))
                break
            case 0x47: // BINFLOAT
                stack.push(reader.float64be())
                break

            // ------------------------------------------------------ strings
            case 0x58: // BINUNICODE
                stack.push(decoder.decode(reader.take(reader.uint32())))
                break
            case 0x8c: // SHORT_BINUNICODE
                stack.push(decoder.decode(reader.take(reader.uint8())))
                break
            case 0x8d: // BINUNICODE8
                stack.push(decoder.decode(reader.take(Number(reader.uint64()))))
                break
            case 0x56: // UNICODE (protocol 0, raw-unicode-escape)
                stack.push(
                    reader.line().replace(
                        /\\u([0-9a-fA-F]{4})/g,
                        (_all, hex) => String.fromCharCode(parseInt(hex, 16)),
                    ),
                )
                break
            case 0x55: // SHORT_BINSTRING
                stack.push(latin1.decode(reader.take(reader.uint8())))
                break
            case 0x54: // BINSTRING
                stack.push(latin1.decode(reader.take(reader.uint32())))
                break
            case 0x53: { // STRING
                const text = reader.line()
                stack.push(text.replace(/^['"]|['"]$/g, ""))
                break
            }

            // -------------------------------------------------------- bytes
            case 0x42: // BINBYTES
                stack.push(reader.take(reader.uint32()).slice())
                break
            case 0x43: // SHORT_BINBYTES
                stack.push(reader.take(reader.uint8()).slice())
                break
            case 0x8e: // BINBYTES8
                stack.push(reader.take(Number(reader.uint64())).slice())
                break
            case 0x96: // BYTEARRAY8
                stack.push(reader.take(Number(reader.uint64())).slice())
                break

            // ---------------------------------------------- lists and tuples
            case 0x28: // MARK
                stack.push(MARK)
                break
            case 0x29: // EMPTY_TUPLE
                stack.push([])
                break
            case 0x74: // TUPLE
                stack.push(popMark())
                break
            case 0x85: // TUPLE1
                stack.push([stack.pop()])
                break
            case 0x86: { // TUPLE2
                const second = stack.pop()
                const first = stack.pop()
                stack.push([first, second])
                break
            }
            case 0x87: { // TUPLE3
                const third = stack.pop()
                const second = stack.pop()
                const first = stack.pop()
                stack.push([first, second, third])
                break
            }
            case 0x5d: // EMPTY_LIST
                stack.push([])
                break
            case 0x6c: // LIST
                stack.push(popMark())
                break
            case 0x61: { // APPEND
                const value = stack.pop()
                stack[stack.length - 1].push(value)
                break
            }
            case 0x65: { // APPENDS
                const items = popMark()
                stack[stack.length - 1].push(...items)
                break
            }

            // ------------------------------------------------ dicts and sets
            case 0x7d: // EMPTY_DICT
                stack.push(new Map())
                break
            case 0x64: // DICT
                stack.push(pairsToMap(popMark()))
                break
            case 0x73: { // SETITEM
                const value = stack.pop()
                const key = stack.pop()
                stack[stack.length - 1].set(key, value)
                break
            }
            case 0x75: { // SETITEMS
                const items = popMark()
                const target = stack[stack.length - 1]
                for (let index = 0; index + 1 < items.length; index += 2) {
                    target.set(items[index], items[index + 1])
                }
                break
            }
            case 0x8f: // EMPTY_SET
                stack.push(new Set())
                break
            case 0x90: { // ADDITEMS
                const items = popMark()
                const target = stack[stack.length - 1]
                for (const item of items) {
                    target.add(item)
                }
                break
            }
            case 0x91: // FROZENSET
                stack.push(new Set(popMark()))
                break

            // --------------------------------------------------------- memo
            case 0x70: // PUT
                memo.set(reader.line(), stack[stack.length - 1])
                break
            case 0x71: // BINPUT
                memo.set(String(reader.uint8()), stack[stack.length - 1])
                break
            case 0x72: // LONG_BINPUT
                memo.set(String(reader.uint32()), stack[stack.length - 1])
                break
            case 0x94: // MEMOIZE
                memo.set(String(memo.size), stack[stack.length - 1])
                break
            case 0x67: // GET
                stack.push(memo.get(reader.line()))
                break
            case 0x68: // BINGET
                stack.push(memo.get(String(reader.uint8())))
                break
            case 0x6a: // LONG_BINGET
                stack.push(memo.get(String(reader.uint32())))
                break

            // ----------------------------------------------- classes, states
            case 0x63: { // GLOBAL
                const module = reader.line()
                const name = reader.line()
                stack.push(new PyObject(`${module}.${name}`))
                break
            }
            case 0x93: { // STACK_GLOBAL
                const name = stack.pop()
                const module = stack.pop()
                stack.push(new PyObject(`${module}.${name}`))
                break
            }
            case 0x52: { // REDUCE
                const args = stack.pop()
                const callable = stack.pop()
                const name = callable instanceof PyObject ? callable.__class__ : String(callable)
                const reducer = PURE_REDUCERS[name]
                if (reducer !== undefined) {
                    stack.push(reducer(args))
                    break
                }
                const object = new PyObject(name)
                object.args = args
                // `_reconstructor` and the pydantic validators pass the real
                // class as the first argument; prefer that name, it is the one
                // a reader recognizes.
                if (Array.isArray(args) && args[0] instanceof PyObject) {
                    object.__class__ = args[0].__class__
                }
                stack.push(object)
                break
            }
            case 0x81: { // NEWOBJ
                const args = stack.pop()
                const callable = stack.pop()
                const object = new PyObject(
                    callable instanceof PyObject ? callable.__class__ : String(callable),
                )
                object.args = args
                stack.push(object)
                break
            }
            case 0x92: { // NEWOBJ_EX
                stack.pop() // kwargs
                const args = stack.pop()
                const callable = stack.pop()
                const object = new PyObject(
                    callable instanceof PyObject ? callable.__class__ : String(callable),
                )
                object.args = args
                stack.push(object)
                break
            }
            case 0x62: { // BUILD
                const state = stack.pop()
                const target = stack[stack.length - 1]
                if (target instanceof PyObject) {
                    applyState(target, state)
                } else if (target instanceof Map && state instanceof Map) {
                    for (const [key, value] of state) {
                        target.set(key, value)
                    }
                }
                break
            }
            case 0x30: // POP
                stack.pop()
                break
            case 0x31: // POP_MARK
                popMark()
                break
            case 0x32: // DUP
                stack.push(stack[stack.length - 1])
                break

            default:
                throw new Error(
                    `pickle: opcode 0x${opcode.toString(16)} at ${reader.at - 1} is not handled`,
                )
        }
    }
}

// ---------------------------------------------------------------- writing

// `pickle.dumps(text)` for a string, at protocol 2. `/human_input` carries a
// bare `str`, so this is the only thing that ever needs writing -- protocol 2
// keeps it to opcodes every python since 2.3 reads, and there is no framing or
// memo to get wrong.
export function pickleString(text) {
    const body = encoder.encode(String(text))
    // PROTO 2, then BINUNICODE with its little-endian 4-byte length.
    // SHORT_BINUNICODE would be a byte shorter but is protocol 4.
    const out = [
        0x80,
        0x02,
        0x58,
        body.length & 0xff,
        (body.length >> 8) & 0xff,
        (body.length >> 16) & 0xff,
        (body.length >> 24) & 0xff,
    ]
    const bytes = new Uint8Array(out.length + body.length + 1)
    bytes.set(out, 0)
    bytes.set(body, out.length)
    bytes[bytes.length - 1] = 0x2e // STOP
    return bytes
}

// --------------------------------------------------------------- reading help

// Plain-javascript view of whatever came back, for the parts of the TUI that
// just want to show it: Maps become objects, PyObjects become their fields
// plus a `__class__`, bytes become a length note.
export function plain(value, depth = 0) {
    if (depth > 12) {
        return "…"
    }
    if (value instanceof PyObject) {
        const out = { __class__: value.__class__ }
        for (const [key, field] of Object.entries(value.fields)) {
            out[key] = plain(field, depth + 1)
        }
        return out
    }
    if (value instanceof Map) {
        const out = {}
        for (const [key, field] of value) {
            out[String(key)] = plain(field, depth + 1)
        }
        return out
    }
    if (value instanceof Set) {
        return [...value].map((each) => plain(each, depth + 1))
    }
    if (value instanceof Uint8Array) {
        return `<${value.length} bytes>`
    }
    if (Array.isArray(value)) {
        return value.map((each) => plain(each, depth + 1))
    }
    if (typeof value === "bigint") {
        return value.toString()
    }
    return value
}
