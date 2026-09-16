import { Command } from "jsr:@cliffy/command@1.0.0-rc.7"
import { version } from "../version.js"
import { cacheDir, runningFromSource, sourceBase } from "../tool_store.js"
import { uvIsInstalled } from "../python.js"
import { bold, cyan, dim, green, heading, pad, red, yellow } from "../style.js"

const looksInstalled = (program) => {
    try {
        new Deno.Command(program, { args: ["--version"], stdout: "null", stderr: "null" }).outputSync()
        return true
    } catch (error) {
        return false
    }
}

// What each one is for, so a missing tick says what it costs rather than just
// being a missing tick.
const NEEDED = [
    ["uv", "the python tools", () => uvIsInstalled()],
    ["rerun", "`dtk data to_rrd` opening what it makes", () => looksInstalled("rerun")],
    ["ffmpeg", "`dtk data to_video`", () => looksInstalled("ffmpeg")],
    ["gh", "downloading from a private release", () => looksInstalled("gh")],
]

export default new Command()
    .name("doctor")
    .description("Report what dtk sees about this machine")
    .action(() => {
        const rows = [
            ["dtk", bold(version)],
            ["deno", Deno.version.deno],
            ["platform", Deno.build.target],
            ["source", runningFromSource ? `${sourceBase} ${dim("(checkout)")}` : `${sourceBase}`],
            ["cache", cacheDir],
        ]
        console.log("")
        console.log(heading("this dtk"))
        for (const [label, value] of rows) {
            console.log(`  ${pad(dim(label), 10)} ${value}`)
        }

        console.log("")
        console.log(heading("what the tools want"))
        for (const [program, why, check] of NEEDED) {
            const there = check()
            const mark = there ? green("yes") : yellow("no ")
            console.log(`  ${pad(cyan(program), 10)} ${mark}  ${dim(why)}`)
        }
        console.log("")
    })
