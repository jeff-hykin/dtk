import { Command } from "jsr:@cliffy/command@1.0.0-rc.7"
import { toolsByName } from "../registry.js"
import { binaryPathOf, cacheDir } from "../tool_store.js"

export default new Command()
    .name("remove")
    .description("Delete a downloaded sub-tool from the cache")
    .arguments("<tool:string>")
    .action((options, name) => {
        const tool = toolsByName[name]
        if (!tool) {
            throw new Error(`dtk: no such tool: ${name}`)
        }
        const path = tool.kind === "binary" ? binaryPathOf(tool) : `${cacheDir}/tools/${tool.name}`
        try {
            Deno.removeSync(path, { recursive: true })
            console.log(`removed ${path}`)
        } catch (error) {
            console.log(`${tool.name} was not downloaded`)
        }
        if (tool.kind === "binary") {
            // the note saying its nix closure is already imported; the store
            // paths themselves stay, for nix's own garbage collection to decide
            try {
                Deno.removeSync(`${path}.closure`)
            } catch (error) {
                // there was none
            }
        }
    })
