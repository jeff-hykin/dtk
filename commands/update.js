import { Command } from "jsr:@cliffy/command@1.0.0-rc.7"
import { tools, toolsByName } from "../registry.js"
import { ensureDownloaded, isDownloaded, runningFromSource } from "../tool_store.js"

export default new Command()
    .name("update")
    .description("Re-download a sub-tool (or every one already downloaded)")
    .arguments("[tool:string]")
    .action(async (options, name) => {
        if (runningFromSource) {
            console.error("dtk: running from a checkout, so nothing is downloaded; use git")
            return
        }
        const wanted = name ? [toolsByName[name]] : tools.filter(isDownloaded)
        if (name && !wanted[0]) {
            throw new Error(`dtk: no such tool: ${name}`)
        }
        for (const tool of wanted) {
            await ensureDownloaded(tool, { force: true })
            console.log(`updated ${tool.name}`)
        }
    })
