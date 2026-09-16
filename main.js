#!/usr/bin/env -S deno run --allow-all

import { Command } from "jsr:@cliffy/command@1.0.0-rc.7"
import { commands } from "./commands/mod.js"
import { version } from "./version.js"

let cli = new Command()
    .name("dtk")
    .version(version)
    .description("dimos toolkit — the entrypoint for dimos tooling")
    .action(function () {
        this.showHelp()
    })

for (const command of commands) {
    cli = cli.command(command.getName(), command)
}

await cli.parse(Deno.args)
