#!/usr/bin/env -S deno run --allow-all

import { Command } from "jsr:@cliffy/command@1.0.0-rc.7"
import { commands } from "./commands/mod.js"
import { DtkError } from "./errors.js"
import { tools, toolsByName } from "./registry.js"
import { runTool } from "./tool_store.js"
import { dim } from "./style.js"
import { version } from "./version.js"

// A sub-tool gets every argument after its name untouched, `--help` included,
// so this runs before cliffy sees anything.
const [first, ...rest] = Deno.args
if (toolsByName[first]) {
    try {
        Deno.exit(await runTool(toolsByName[first], rest))
    } catch (error) {
        if (!(error instanceof DtkError)) {
            throw error
        }
        console.error(error.message)
        Deno.exit(2)
    }
}

// A name that is neither a command nor a tool would otherwise fall through to
// cliffy and print the whole help, which does not say what went wrong.
if (first !== undefined && !first.startsWith("-")) {
    const known = [...commands.map((each) => each.getName()), ...tools.map((each) => each.name)]
    if (!known.includes(first)) {
        const near = known.filter((name) =>
            name.includes(first) || first.includes(name) ||
            name.slice(0, 3) === first.slice(0, 3)
        )
        console.error(`dtk: no such command or tool: ${first}`)
        if (near.length > 0) {
            console.error(`     did you mean: ${near.slice(0, 5).join(", ")}`)
        }
        console.error(`     ${dim("dtk --help")} for the commands, ${dim("dtk list")} for the tools`)
        Deno.exit(2)
    }
}

let cli = new Command()
    .name("dtk")
    .version(version)
    .description(
        `dimos toolkit

` +
        `  There are ${tools.length} sub-tools alongside the commands below — ${dim("dtk list")} shows them,
` +
        `  and each one downloads the first time you run it. ${dim("dtk <tool> --help")} is
` +
        `  the tool's own help, not a summary of it.`,
    )
    .example("a recording", "dtk data summary drive.db")
    .example("what is wrong with its tf", "dtk data tf full_check drive.db")
    .example("run a blueprint readably", "dtk run <blueprint>")
    .example("what is on the wire", "dtk constellation")
    .action(function () {
        this.showHelp()
    })

for (const command of commands) {
    cli = cli.command(command.getName(), command)
}

// The sub-tools are deliberately NOT registered as cliffy commands: the raw
// dispatch above already runs them, and listing twenty-odd of them here buries
// the handful of commands dtk actually has. `dtk list` is where they live.

try {
    await cli.parse(Deno.args)
} catch (error) {
    // `dtk list | head` closes the pipe on us partway through; that is not an error
    if (error instanceof Deno.errors.BrokenPipe) {
        // nothing left to write to
    } else if (error instanceof DtkError) {
        console.error(error.message)
        Deno.exit(2)
    } else {
        throw error
    }
}
