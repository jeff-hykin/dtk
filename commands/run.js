import { Command } from "jsr:@cliffy/command@1.0.0-rc.7"
import { toolsByName } from "../registry.js"
import { runTool } from "../tool_store.js"

export default new Command()
    .name("run")
    .description("Run a blueprint through `dimos run`, filtered and watched")
    .usage("<blueprint> [config tokens] [--check-only] [--no-dtop] [--no-build]")
    .useRawArgs()
    .action(async (...raw) => {
        const args = raw.flat().filter((each) => typeof each === "string")
        Deno.exit(await runTool(toolsByName["run_supervisor"], args))
    })
