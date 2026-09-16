import { Command } from "jsr:@cliffy/command@1.0.0-rc.7"
import { tools } from "../registry.js"
import { isDownloaded, runningFromSource } from "../tool_store.js"

export default new Command()
    .name("list")
    .description("List the sub-tools, and whether each one has been downloaded yet")
    .action(() => {
        const width = Math.max(...tools.map((each) => each.name.length))
        for (const tool of tools) {
            const state = runningFromSource ? "source" : (isDownloaded(tool) ? "ready" : "-")
            console.log(`${tool.name.padEnd(width)}  ${state.padEnd(6)}  ${tool.description}`)
        }
    })
