import { Command } from "jsr:@cliffy/command@1.0.0-rc.7"
import { tools } from "../registry.js"
import { isDownloaded, runningFromSource } from "../tool_store.js"
import { cyan, dim, green, heading, magenta, pad, yellow } from "../style.js"

// What a tool is, in one word, so the list reads as three kinds of thing rather
// than one long undifferentiated column.
const KINDS = {
    deno: { label: "deno", color: cyan },
    python: { label: "python", color: yellow },
    binary: { label: "binary", color: magenta },
}

export default new Command()
    .name("list")
    .description("List the sub-tools, and whether each one has been downloaded yet")
    .option("--plain", "One name per line, for feeding to something else")
    .action((options) => {
        if (options.plain === true) {
            for (const tool of tools) {
                console.log(tool.name)
            }
            return
        }

        const width = Math.max(...tools.map((each) => each.name.length))
        const byKind = new Map()
        for (const tool of tools) {
            if (!byKind.has(tool.kind)) {
                byKind.set(tool.kind, [])
            }
            byKind.get(tool.kind).push(tool)
        }

        for (const [kind, group] of byKind) {
            const { label, color } = KINDS[kind] ?? { label: kind, color: dim }
            console.log("")
            console.log(`${heading(label)} ${dim(`(${group.length})`)}`)
            for (const tool of group) {
                const state = runningFromSource && kind !== "binary"
                    ? dim("source")
                    : (isDownloaded(tool) ? green("ready") : dim("     ·"))
                console.log(`  ${pad(color(tool.name), width)}  ${pad(state, 6)}  ${dim(tool.description)}`)
            }
        }
        console.log("")
        console.log(dim("  a tool downloads the first time you run it"))
    })
