// One way to answer "which python does this run under", for every python tool
// dtk carries. `uv run --project <root>` is what actually does the work; the
// only question is which root, and that is what this file settles.

import { DtkError } from "./errors.js"

// What says "a python project lives here". `.venv` is included because a
// checkout can have an environment before it has a lockfile.
const PROJECT_MARKERS = ["uv.lock", "pyproject.toml", ".venv"]

const directoryOf = (path) => {
    try {
        return Deno.statSync(path).isDirectory ? path : path.replace(/\/[^/]*$/, "")
    } catch (error) {
        return path.replace(/\/[^/]*$/, "")
    }
}

// Walks up from `startPath` until a marker turns up. Returns null at the root.
export function findProjectFrom(startPath) {
    if (!startPath) {
        return null
    }
    let at = null
    try {
        at = Deno.realPathSync(directoryOf(startPath))
    } catch (error) {
        return null
    }
    while (true) {
        for (const marker of PROJECT_MARKERS) {
            try {
                Deno.statSync(`${at}/${marker}`)
                return at
            } catch (error) {
                continue
            }
        }
        const up = at.replace(/\/[^/]*$/, "")
        if (up === at || up === "") {
            return null
        }
        at = up
    }
}

// The clones sit on different branches and not all of them have the module a
// given tool imports, so the probe is for the module rather than for a folder
// called dimos.
export function findDimosRepo(moduleRelativePath) {
    const home = Deno.env.get("HOME") ?? ""
    const candidates = [
        Deno.env.get("DIMOS_REPO"),
        `${home}/repos/dimos`,
        `${home}/repos/dimos2`,
        `${home}/repos/dimos3`,
        `${home}/repos/dimos4`,
        `${home}/repos/dimos5`,
        `${home}/repos/dimos6`,
        `${home}/dimos`,
    ].filter((each) => each)
    for (const candidate of candidates) {
        try {
            Deno.statSync(`${candidate}/${moduleRelativePath}`)
            return candidate
        } catch (error) {
            continue
        }
    }
    return null
}

// `startPaths` are tried in order: the file being worked on first, then the
// working directory, so `dtk graph some/repo/blueprint.py` uses that repo's
// environment whatever directory it was typed from.
export function resolveProject({ startPaths = [], needsDimosModule = null } = {}) {
    for (const startPath of [...startPaths, Deno.cwd()]) {
        const found = findProjectFrom(startPath)
        if (found !== null) {
            if (needsDimosModule === null) {
                return { root: found, why: "walked up from " + startPath }
            }
            try {
                Deno.statSync(`${found}/${needsDimosModule}`)
                return { root: found, why: "walked up from " + startPath }
            } catch (error) {
                // the right kind of project, but not one that has what is needed
            }
        }
    }
    if (needsDimosModule !== null) {
        const repo = findDimosRepo(needsDimosModule)
        if (repo !== null) {
            return { root: repo, why: `has ${needsDimosModule}` }
        }
        throw new DtkError(
            `dtk: found no python project containing ${needsDimosModule}.\n` +
            `     Run this from inside a dimos checkout, or set DIMOS_REPO to one.`,
        )
    }
    return { root: null, why: "no project found; running with an ephemeral environment" }
}

export function uvIsInstalled() {
    try {
        new Deno.Command("uv", { args: ["--version"], stdout: "null", stderr: "null" }).outputSync()
        return true
    } catch (error) {
        return false
    }
}

export async function runPython({
    script,
    args = [],
    startPaths = [],
    needsDimosModule = null,
    withPackages = [],
    module = null,
    verbose = false,
}) {
    if (!uvIsInstalled()) {
        throw new DtkError(
            "dtk: this needs `uv`.\n" +
            "     curl -LsSf https://astral.sh/uv/install.sh | sh",
        )
    }
    const { root, why } = resolveProject({ startPaths, needsDimosModule })
    if (verbose) {
        console.error(`dtk: python project ${root ?? "(none)"} — ${why}`)
    }
    const uvArguments = ["run"]
    if (root === null) {
        uvArguments.push("--no-project")
    } else {
        uvArguments.push("--project", root)
    }
    for (const each of withPackages) {
        uvArguments.push("--with", each)
    }
    if (module !== null) {
        uvArguments.push(module, ...args)
    } else {
        uvArguments.push("python", script, ...args)
    }
    const command = new Deno.Command("uv", {
        args: uvArguments,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
    })
    const { code } = await command.output()
    return code
}
