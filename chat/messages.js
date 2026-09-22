// Unpickled python objects, as the events the TUI renders.
//
// Shared by every source, so `dtk chat` shows the same thing whether the bytes
// came off the wire through `spy`, straight off an LCM socket, or out of the
// python bridge. The event shape is documented at the top of `chat_bridge.py`;
// this file and that file have to agree.

import { plain, PyObject } from "./pickle.js"

export const TOPIC_NAMES = {
    humanInput: "human_input",
    agent: "agent",
    agentIdle: "agent_idle",
    toolStreams: "tool_streams",
    resourceStats: "resource_stats",
}

// The same logical channel is spelled three ways depending on the backend:
// `/agent` on LCM, `dimos/agent` on zenoh, and a typed zenoh topic carries a
// `/module.Type` suffix on the end. Reduce all of them to the bare name.
export function channelName(channel) {
    let name = String(channel).replace(/^\//, "")
    if (name.startsWith("dimos/")) {
        name = name.slice("dimos/".length)
    }
    // A `#type` (LCM) or `/module.Type` (zenoh) suffix is type information, not
    // part of the channel.
    name = name.split("#")[0]
    const parts = name.split("/")
    if (parts.length > 1 && parts[parts.length - 1].includes(".")) {
        parts.pop()
    }
    return parts.join("/")
}

// `McpClient` re-emits tool-stream updates onto `/agent` behind this prefix.
const TOOL_MSG_PREFIX = "[tool:"

function splitToolMessage(content) {
    if (!content.startsWith(TOOL_MSG_PREFIX)) {
        return null
    }
    const end = content.indexOf("]")
    if (end === -1) {
        return null
    }
    return [content.slice(TOOL_MSG_PREFIX.length, end), content.slice(end + 1).replace(/^\s+/, "")]
}

// The text of a langchain message. `content` is a string for an ordinary reply
// and a list of content blocks for a multimodal one.
function messageText(message) {
    const content = message.get("content")
    if (typeof content === "string") {
        return content
    }
    if (Array.isArray(content)) {
        const parts = []
        for (const block of content) {
            if (typeof block === "string") {
                parts.push(block)
            } else if (block instanceof Map && typeof block.get("text") === "string") {
                parts.push(block.get("text"))
            }
        }
        return parts.join("")
    }
    if (content === null || content === undefined) {
        return ""
    }
    return JSON.stringify(plain(content))
}

// `ai` / `human` / `system` / `tool`. Langchain stores it in a `type` field;
// the class name is the fallback for a message that predates it.
function roleOf(message) {
    const declared = message.get("type")
    if (typeof declared === "string" && declared !== "") {
        return declared === "assistant" ? "ai" : declared
    }
    const name = String(message.__class__ ?? "").toLowerCase()
    for (const candidate of ["ai", "human", "system", "tool", "chat", "function"]) {
        if (name.includes(`.${candidate}message`) || name.includes(`.${candidate}.`)) {
            return candidate
        }
    }
    return "unknown"
}

function toolCallsOf(message) {
    let raw = message.get("tool_calls")
    if (!Array.isArray(raw) || raw.length === 0) {
        const extra = message.get("additional_kwargs")
        const nested = extra instanceof Map ? extra.get("tool_calls") : null
        raw = Array.isArray(nested) ? nested : []
    }
    const out = []
    for (const call of raw) {
        const at = (key) => (call instanceof Map ? call.get(key) : undefined)
        // The OpenAI wire shape nests name and arguments under "function".
        const nested = at("function")
        const fromNested = (key) => (nested instanceof Map ? nested.get(key) : undefined)
        let args = at("args") ?? fromNested("arguments")
        if (typeof args === "string") {
            try {
                args = JSON.parse(args)
            } catch (error) {
                // A half-streamed argument string is still worth showing.
            }
        }
        out.push({
            name: at("name") ?? fromNested("name") ?? "?",
            args: plain(args),
            id: at("id") ?? at("tool_call_id") ?? null,
        })
    }
    return out
}

// One `/agent` message.
export function agentEvent(message) {
    if (!(message instanceof PyObject)) {
        // Not a langchain message at all; show it rather than drop it.
        return { t: "agent", role: "unknown", text: JSON.stringify(plain(message)) }
    }
    const text = messageText(message)
    const event = { t: "agent", role: roleOf(message), text }

    const split = splitToolMessage(text)
    if (split !== null) {
        event.tool = split[0]
        event.text = split[1]
        event.about_tool = true
    }
    const calls = toolCallsOf(message)
    if (calls.length > 0) {
        event.tool_calls = calls
    }
    for (const field of ["tool_call_id", "name", "status"]) {
        const value = message.get(field)
        if (value) {
            event[field] = value
        }
    }
    return event
}

// One `/tool_streams` frame: an MCP `notifications/*` json-rpc envelope.
export function toolEvent(frame) {
    if (!(frame instanceof Map)) {
        return { t: "tool", tool: "?", text: JSON.stringify(plain(frame)) }
    }
    const params = frame.get("params")
    const at = (key) => (params instanceof Map ? params.get(key) : undefined)
    let text = at("data") ?? at("message")
    const progress = at("progress")
    if (text === undefined && progress !== undefined) {
        const total = at("total")
        text = total === undefined ? String(progress) : `${progress}/${total}`
    }
    const event = {
        t: "tool",
        tool: at("logger") ?? at("toolName") ?? at("tool") ?? "?",
        method: frame.get("method") ?? "",
    }
    if (text !== undefined) {
        event.text = typeof text === "string" ? text : JSON.stringify(plain(text))
    }
    if (progress !== undefined) {
        event.progress = progress
        event.total = at("total")
    }
    return event
}

// One `/resource_stats` frame, which dtop publishes.
export function statsEvent(stats) {
    if (!(stats instanceof Map)) {
        return null
    }
    const workers = []
    for (const worker of stats.get("workers") ?? []) {
        if (!(worker instanceof Map)) {
            continue
        }
        workers.push({
            modules: [...(worker.get("modules") ?? [])].map(String),
            pid: worker.get("pid") ?? null,
            cpu: worker.get("cpu_percent") ?? 0,
            mem: worker.get("mem_mb") ?? 0,
        })
    }
    return { t: "stats", workers }
}

// One decoded payload on one of the five channels, as an event -- or null when
// the channel is not one this chat cares about.
export function eventFor(channel, value) {
    switch (channelName(channel)) {
        case TOPIC_NAMES.agent:
            return agentEvent(value)
        case TOPIC_NAMES.agentIdle:
            return { t: "idle", value: Boolean(value) }
        case TOPIC_NAMES.toolStreams:
            return toolEvent(value)
        case TOPIC_NAMES.resourceStats:
            return statsEvent(value)
        case TOPIC_NAMES.humanInput:
            // Somebody else's message -- the web input, a voice transcript, or
            // another `dtk chat`. Showing it is the point: the conversation is
            // shared, and a reply that answers a question nobody in this window
            // asked is otherwise baffling.
            return {
                t: "agent",
                role: "human",
                text: typeof value === "string" ? value : String(value),
            }
        default:
            return null
    }
}
