#!/usr/bin/env -S deno run --allow-all

import { Command } from "jsr:@cliffy/command@1.0.0-rc.7"
import { commands } from "./commands/mod.js"
import { tools, toolsByName } from "./registry.js"
import { runTool } from "./tool_store.js"
import { version } from "./version.js"

// A sub-tool gets every argument after its name untouched, `--help` included,
// so this runs before cliffy sees anything.
const [first, ...rest] = Deno.args
if (toolsByName[first]) {
    Deno.exit(await runTool(toolsByName[first], rest))
}

let cli = new Command()
    .name("dtk")
    .version(version)
    .description("dimos toolkit — sub-tools are downloaded the first time you run them")
    .action(function () {
        this.showHelp()
    })

for (const command of commands) {
    cli = cli.command(command.getName(), command)
}

// listed only so they show up in --help; the dispatch above is what runs them
for (const tool of tools) {
    cli = cli.command(
        tool.name,
        new Command()
            .description(tool.description)
            .useRawArgs()
            .action(async (...args) => {
                Deno.exit(await runTool(tool, args.slice(1)))
            }),
    )
}

await cli.parse(Deno.args)
