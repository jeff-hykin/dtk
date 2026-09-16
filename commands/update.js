import { Command } from "jsr:@cliffy/command@1.0.0-rc.7"
import { DtkError } from "../errors.js"
import { tools, toolsByName } from "../registry.js"
import { ensureDownloaded, isCurrent, isDownloaded, runningFromSource } from "../tool_store.js"

export default new Command()
    .name("update")
    .description("Bring a sub-tool up to date (or every one already downloaded)")
    .arguments("[tool:string]")
    .option("--force", "Download again even when the copy here is already the current one")
    .action(async (options, name) => {
        const wanted = name ? [toolsByName[name]] : tools.filter(isDownloaded)
        if (name && !wanted[0]) {
            throw new DtkError(`dtk: no such tool: ${name}`)
        }
        for (const tool of wanted) {
            // A binary is fetched even from a checkout -- it is never in the repo --
            // but a script is used in place, and there is nothing to update.
            if (runningFromSource && tool.kind !== "binary") {
                console.log(`${tool.name} comes from this checkout; use git`)
                continue
            }
            // A binary is checked against what the release is serving, which is one
            // HEAD rather than a download; a script belongs to the dtk snapshot that
            // fetched it, so its stamp already answers this.
            if (!options.force && await isCurrent(tool)) {
                console.log(`${tool.name} is already current`)
                continue
            }
            await ensureDownloaded(tool, { force: true })
            console.log(`updated ${tool.name}`)
        }
    })
