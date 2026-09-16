import { Command } from "jsr:@cliffy/command@1.0.0-rc.7"
import { version } from "../version.js"
import { cacheDir, runningFromSource, sourceBase } from "../tool_store.js"

export default new Command()
    .name("doctor")
    .description("Report what dtk sees about this machine")
    .action(() => {
        console.log(`dtk        ${version}`)
        console.log(`deno       ${Deno.version.deno}`)
        console.log(`platform   ${Deno.build.target}`)
        console.log(`source     ${runningFromSource ? `${sourceBase} (checkout)` : sourceBase}`)
        console.log(`cache      ${cacheDir}`)
    })
