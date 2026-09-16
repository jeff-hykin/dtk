import { Command } from "jsr:@cliffy/command@1.0.0-rc.7"
import { DtkError } from "../errors.js"
import { toolsByName } from "../registry.js"
import { runPython } from "../python.js"
import { ensureDownloaded } from "../tool_store.js"

// Where dimos writes its jsonl log is a question only dimos can answer -- the
// directory moves with the project root -- so this asks it, through the same
// project resolution every other python tool here uses.
async function askPython(args) {
    const tool = toolsByName["log_path"]
    const script = await ensureDownloaded(tool)
    const { code, stdout, stderr } = await runPython({
        script,
        args,
        needsDimosModule: tool.needsDimosModule,
        withPackages: tool.withPackages ?? [],
        capture: true,
    })
    if (code !== 0) {
        throw new DtkError(stderr.trim() || "dtk log: could not find the log")
    }
    return stdout.trim()
}

export default new Command()
    .name("log")
    .description("Print the path of dimos's jsonl log, and open it")
    .option("--no-open", "Just print the path")
    .option("--all", "List every log, newest first, and open none of them")
    .action(async (options) => {
        if (options.all === true) {
            console.log(await askPython(["--all"]))
            return
        }
        const path = await askPython([])
        console.log(path)
        if (options.open === false) {
            return
        }
        // $EDITOR first: a jsonl log is for reading, and whatever the desktop
        // hands a .jsonl to is rarely what someone asking for it wants.
        const editor = Deno.env.get("EDITOR")
        const [program, programArgs] = editor
            ? [editor, [path]]
            : [Deno.build.os === "darwin" ? "open" : "xdg-open", [path]]
        try {
            await new Deno.Command(program, {
                args: programArgs,
                stdin: "inherit",
                stdout: "inherit",
                stderr: "inherit",
            }).output()
        } catch (error) {
            console.error(`dtk: could not open it with ${program} (${error.message})`)
        }
    })
