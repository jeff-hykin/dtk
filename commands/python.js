import { Command } from "jsr:@cliffy/command@1.0.0-rc.7"
import { resolveProject, runPython } from "../python.js"

export default new Command()
    .name("python")
    .description("Run a python file under the environment that belongs to it")
    .usage("<script.py> [args...]")
    .useRawArgs()
    .action(async (...raw) => {
        const args = raw.flat().filter((each) => typeof each === "string")
        if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
            console.log(`dtk python — run a python file under the environment that belongs to it

Usage: dtk python <script.py> [args...]
       dtk python --where <script.py>

The project is found by walking up from the script for uv.lock, pyproject.toml
or .venv, then by walking up from the working directory. It is then run with
\`uv run --project <that>\`, or with \`--no-project\` when there is none.

Options before the script:
  --with PKG      add a pypi package to the environment (repeatable)
  --project DIR   use this project instead of walking up for one
  --where         print the project that would be used, and stop`)
            return
        }

        const withPackages = []
        let project = null
        let onlyShow = false
        let at = 0
        while (at < args.length && args[at].startsWith("-")) {
            if (args[at] === "--with") {
                withPackages.push(args[++at])
            } else if (args[at] === "--project") {
                project = args[++at]
            } else if (args[at] === "--where") {
                onlyShow = true
            } else {
                break
            }
            at++
        }
        const script = args[at]
        const rest = args.slice(at + 1)
        if (script === undefined) {
            console.error("dtk python: need a script (see --help)")
            Deno.exit(2)
        }

        if (project !== null) {
            if (onlyShow) {
                console.log(project)
                return
            }
            Deno.exit(await runPython({
                script,
                args: rest,
                startPaths: [project],
                withPackages,
                verbose: true,
            }))
        }
        if (onlyShow) {
            const { root, why } = resolveProject({ startPaths: [script] })
            console.log(root ?? "(none)")
            console.error(why)
            return
        }
        Deno.exit(await runPython({
            script,
            args: rest,
            startPaths: [script],
            withPackages,
            verbose: true,
        }))
    })
