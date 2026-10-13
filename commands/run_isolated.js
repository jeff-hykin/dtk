import { Command } from "jsr:@cliffy/command@1.0.0-rc.7"
import { toolsByName } from "../registry.js"
import { runTool } from "../tool_store.js"

export default new Command()
    .name("run-isolated")
    .description("`dtk run`, with zenoh kept on this machine: client sessions through a loopback-only router")
    .usage("<blueprint> [config tokens] [--check-only] [--no-dtop] [--no-build]")
    .useRawArgs()
    .action(async (...raw) => {
        const args = raw.flat().filter((each) => typeof each === "string")
        Deno.exit(await runTool(toolsByName["run_supervisor"], ["--isolated", ...args]))
    })
