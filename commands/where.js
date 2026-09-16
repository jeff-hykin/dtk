import { Command } from "jsr:@cliffy/command@1.0.0-rc.7"
import { toolsByName } from "../registry.js"
import { binaryPathOf, cacheDir, runningFromSource, sourceBase } from "../tool_store.js"

export default new Command()
    .name("where")
    .description("Print where a sub-tool lives on disk")
    .arguments("<tool:string>")
    .action((options, name) => {
        const tool = toolsByName[name]
        if (!tool) {
            throw new Error(`dtk: no such tool: ${name}`)
        }
        if (tool.kind === "binary") {
            console.log(binaryPathOf(tool))
        } else if (runningFromSource) {
            console.log(new URL(tool.entry, sourceBase).pathname)
        } else {
            console.log(`${cacheDir}/tools/${tool.name}/${tool.entry.replace(/^tools\//, "")}`)
        }
    })
