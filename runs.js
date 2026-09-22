// What dimos thinks is running on this machine.
//
// The run registry is the same set of files `dimos stop` reads, so a blueprint
// named here is the blueprint on the wire. Entries are not always cleaned up
// (a killed run leaves its file behind), so every one is checked against the
// live process table before it counts.
//
// It is local-only by construction: a blueprint running on a robot across
// zenoh has no entry here. Anything that uses this has to treat "no runs" as
// "nothing local", never as "nothing at all".

const RUNS_DIR = `${Deno.env.get("HOME") ?? "."}/.local/state/dimos/runs`

export function alivePids() {
    try {
        const { stdout } = new Deno.Command("ps", {
            args: ["-eo", "pid="],
            stdout: "piped",
            stderr: "null",
        }).outputSync()
        return new Set(
            new TextDecoder().decode(stdout)
                .split("\n")
                .map((each) => Number(each.trim()))
                .filter(Boolean),
        )
    } catch (error) {
        return new Set()
    }
}

// Every live run, oldest first. `[]` when the registry is missing entirely.
export function runningBlueprints() {
    const live = alivePids()
    const entries = []
    let names = []
    try {
        names = [...Deno.readDirSync(RUNS_DIR)]
            .map((each) => each.name)
            .filter((each) => each.endsWith(".json"))
    } catch (error) {
        return []
    }
    for (const name of names) {
        try {
            const record = JSON.parse(Deno.readTextFileSync(`${RUNS_DIR}/${name}`))
            if (typeof record?.blueprint !== "string" || !record?.pid) {
                continue
            }
            if (!live.has(Number(record.pid))) {
                continue
            }
            entries.push({
                name: record.blueprint,
                pid: Number(record.pid),
                started: record.started_at ?? "",
                runId: record.run_id ?? name.replace(/\.json$/, ""),
                logDir: record.log_dir ?? "",
            })
        } catch (error) {
            continue // stale or half-written entry
        }
    }
    entries.sort((left, right) => left.started.localeCompare(right.started))
    return entries
}

// The newest live blueprint's name, or null.
export function newestBlueprint() {
    const entries = runningBlueprints()
    return entries.length > 0 ? entries[entries.length - 1].name : null
}
