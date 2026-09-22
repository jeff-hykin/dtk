// Is anybody listening?
//
// There is no single answer to that, which is the whole reason this file
// exists. The transport is fire-and-forget: publishing to `/human_input`
// succeeds whether or not an agent module ever subscribed. So presence is a
// vote of independent signals, each with its own timestamp and its own
// weakness, and the UI shows what is actually known rather than a guess
// dressed up as a fact.
//
//   agent traffic      a message on `/agent` or `/agent_idle`. The only
//                      *proof* an agent exists. Works across machines. Says
//                      nothing until the agent first speaks.
//   resource stats     `/resource_stats`, published by dtop. A heartbeat with
//                      module names in it, so it can say whether an agent-ish
//                      module is loaded. Absent when a run has no dtop.
//   run registry       local run files. Immediate and reliable for a local
//                      run, blind to a remote one.
//   wiring             the running blueprint's own graph, read the way
//                      `dtk run` reads it. If a module in it takes
//                      `/human_input` as an input, it *will* listen once it is
//                      built -- a static fact, available before the agent has
//                      ever spoken. This is what breaks the deadlock below.
//
// The states, and what each one means for a message being typed:
//
//   no-bridge   the python side is not up; nothing can be sent. Hold.
//   searching   bridge up, no signal yet. Hold.
//   probably    a run exists (or a heartbeat names no agent) but no agent has
//               ever spoken. Hold -- this is the case where publishing looks
//               fine and the message is silently dropped.
//   live        an agent has spoken, or a heartbeat names an agent module.
//               Send.
//   stale       it was live and every signal has now gone quiet. Hold, and say
//               how long it has been.
//
// `probably` holding rather than sending is the deliberate part. Blueprints
// take tens of seconds to come up, and the window where the run exists but
// `McpClient` has not finished building is exactly when the first message gets
// typed.
//
// The deadlock it would otherwise cause is worth spelling out: "an agent has
// spoken" cannot be the only evidence, because an agent only speaks once it
// has been spoken to. Without the wiring check, a plain `dimos run` (no dtop,
// so no heartbeat) would hold the first message for ever waiting for a reply
// to a message it is holding. The wiring check answers it statically; a remote
// blueprint that has neither dtop nor traffic still cannot be proven, and
// there the status bar says so and Ctrl-S sends anyway.

import { runningBlueprints } from "../runs.js"

// A heartbeat older than this is not a heartbeat.
const HEARTBEAT_STALE_MS = 12000
// How long after the last agent traffic a live agent is still assumed live.
// Deliberately long: an agent is allowed to sit and think.
const AGENT_STALE_MS = 180000
const REGISTRY_POLL_MS = 2000

// Module names that mean "something here talks to a human". Matched loosely
// because the class names differ across dimos branches.
const AGENT_MODULE_PATTERN = /mcp.?client|agent|planner|llm/i

export class Presence {
    constructor({ now = () => Date.now() } = {}) {
        this._now = now
        this.lastAgentAt = null
        this.lastHeartbeatAt = null
        this.heartbeatModules = []
        this.agentModules = []
        this.runs = []
        this.bridgeState = "starting"
        this.idle = null
        this._lastRegistryPoll = 0
        // blueprint name -> {listens, modules} from its graph, or null while
        // the graph is still being read.
        this.wiring = new Map()
    }

    // The blueprint's graph says a module subscribes to `/human_input`.
    noteWiring(blueprint, listens, modules = []) {
        this.wiring.set(blueprint, { listens, modules })
    }

    get wiredListener() {
        const blueprint = this.blueprint
        if (blueprint === null) {
            return null
        }
        return this.wiring.get(blueprint) ?? null
    }

    noteBridge(state) {
        this.bridgeState = state
    }

    // Anything at all on `/agent` or `/agent_idle`.
    noteAgentTraffic() {
        this.lastAgentAt = this._now()
    }

    noteIdle(value) {
        this.idle = value
        this.noteAgentTraffic()
    }

    noteStats(workers) {
        this.lastHeartbeatAt = this._now()
        const modules = []
        for (const worker of workers ?? []) {
            for (const name of worker.modules ?? []) {
                modules.push(name)
            }
        }
        this.heartbeatModules = modules
        this.agentModules = modules.filter((each) => AGENT_MODULE_PATTERN.test(each))
    }

    pollRegistry() {
        const at = this._now()
        if (at - this._lastRegistryPoll < REGISTRY_POLL_MS) {
            return
        }
        this._lastRegistryPoll = at
        this.runs = runningBlueprints()
    }

    get blueprint() {
        return this.runs.length > 0 ? this.runs[this.runs.length - 1].name : null
    }

    // `{state, why, sendable, sinceMs}`
    assess() {
        const at = this._now()
        if (this.bridgeState === "broken") {
            return { state: "no-bridge", why: "the python bridge cannot start", sendable: false }
        }
        if (this.bridgeState !== "up") {
            return { state: "no-bridge", why: "connecting to the transport", sendable: false }
        }

        const agentAge = this.lastAgentAt === null ? null : at - this.lastAgentAt
        const heartbeatAge = this.lastHeartbeatAt === null ? null : at - this.lastHeartbeatAt
        const heartbeatFresh = heartbeatAge !== null && heartbeatAge < HEARTBEAT_STALE_MS

        if (agentAge !== null && agentAge < AGENT_STALE_MS) {
            return {
                state: "live",
                why: heartbeatFresh && this.agentModules.length > 0
                    ? this.agentModules.join(", ")
                    : "the agent has been talking",
                sendable: true,
                sinceMs: agentAge,
            }
        }
        if (heartbeatFresh && this.agentModules.length > 0) {
            return {
                state: "live",
                why: `${this.agentModules.join(", ")} is loaded`,
                sendable: true,
                sinceMs: heartbeatAge,
            }
        }
        const wired = this.wiredListener
        if (wired !== null && wired.listens && this.runs.length > 0) {
            return {
                state: "live",
                why: `${wired.modules.join(", ") || this.blueprint} takes /human_input`,
                sendable: true,
                sinceMs: heartbeatAge ?? undefined,
            }
        }
        if (agentAge !== null) {
            return {
                state: "stale",
                why: "the agent has gone quiet",
                sendable: false,
                sinceMs: agentAge,
            }
        }
        if (wired !== null && !wired.listens && this.runs.length > 0) {
            return {
                state: "probably",
                why: `${this.blueprint} has no module taking /human_input`,
                sendable: false,
            }
        }
        if (heartbeatFresh) {
            return {
                state: "probably",
                why: "a blueprint is running, but no agent module in it yet",
                sendable: false,
                sinceMs: heartbeatAge,
            }
        }
        if (this.runs.length > 0) {
            return {
                state: "probably",
                why: `${this.blueprint} is running, but the agent has not spoken`,
                sendable: false,
            }
        }
        return { state: "searching", why: "waiting for a blueprint", sendable: false }
    }
}
