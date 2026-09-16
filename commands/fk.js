import { Command } from "jsr:@cliffy/command@1.0.0-rc.7"

// `dtk fk` — kill everything a dimos run leaves behind.
//
// A rewrite of ~/Commands/kd. The shell version worked, but it re-ran the same
// `ps | grep` five times and its "did it die" check was a fixed 0.5s sleep; this
// takes the process table once per pass and polls until the pids are actually
// gone, so a slow exit is waited out rather than reported as a failure.

// Every pattern group. Matching a directory rather than a list of binary names
// keeps new native modules covered: the old list missed mls_planner and left
// three orphaned copies holding 220 GB each after a killed run.
const PATTERNS = {
    dimos: /dimos run |dimos-viewer|dimos[0-9]*\/\.venv\/bin\/python3|repos\/dimos\/\.venv\/bin\/python3/,
    "native modules": /\/(result\/bin|rust\/target\/release)\/[A-Za-z0-9_-]+/,
    unity: /Model\.x86_64|Unity|unity_envs/,
    gazebo: /gzserver|gzclient|ign-gazebo|ignition-gazebo|gz sim /,
    ros: /ros-navigation-autonomy-stack|\/opt\/ros\/|ros2|roscore|rosmaster|roslaunch|rosout|joy_node|teleop_twist_joy|ros2_daemon/,
    // fastlio2 spawns tcpdump with start_new_session=True, so these outlive their parent
    tcpdump: /tcpdump.*dimos|dimos.*tcpdump/,
}

// 7446 is zenoh's RPC multicast; a stray peer there wedges the next run's
// set_transport. 9876 is Blender's MCP, which is whitelisted below rather than
// left out, because rerun also uses it.
const PORTS = [7446, 7779, 9090, 3030, 9876, 9877, 10000]

// Never killed on a port: it is not part of a dimos run and losing it costs an
// unsaved scene.
const SPARED = /blender/i

const DOCKER_NAMES = ["dimos", "ognav", "rosnav", "nav_stack"]

async function run(program, args) {
    try {
        const { success, stdout } = await new Deno.Command(program, {
            args,
            stdout: "piped",
            stderr: "null",
        }).output()
        return success ? new TextDecoder().decode(stdout) : ""
    } catch (error) {
        return ""
    }
}

// pid -> command line, for everything running. Taken once per pass: the shell
// version paid for a full `ps` per pattern group.
async function processTable() {
    const table = new Map()
    const text = await run("ps", ["axo", "pid=,command="])
    for (const line of text.split("\n")) {
        const match = line.match(/^\s*(\d+)\s+(.*)$/)
        if (match === null) {
            continue
        }
        table.set(Number(match[1]), match[2])
    }
    return table
}

// This process, and claude's, are never candidates: `dtk fk` matching its own
// command line and killing the session that ran it is the obvious way for a
// pattern like /ros2/ to go wrong.
const ownPids = new Set([Deno.pid, Deno.ppid])

function candidates(table) {
    const found = new Map()
    for (const [pid, command] of table) {
        if (ownPids.has(pid) || command.includes("claude") || command.includes("dtk fk")) {
            continue
        }
        for (const [label, pattern] of Object.entries(PATTERNS)) {
            if (pattern.test(command)) {
                found.set(pid, { label, command })
                break
            }
        }
    }
    return found
}

const alive = (pid) => {
    try {
        Deno.kill(pid, "SIGCONT")
        return true
    } catch (error) {
        return false
    }
}

async function waitForGone(pids, seconds) {
    const deadline = performance.now() + seconds * 1000
    let left = pids.filter(alive)
    while (left.length > 0 && performance.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        left = left.filter(alive)
    }
    return left
}

function killAll(pids) {
    for (const pid of pids) {
        try {
            Deno.kill(pid, "SIGKILL")
        } catch (error) {
            // already gone, or not ours to signal
        }
    }
}

async function killByPort(dryRun) {
    for (const port of PORTS) {
        const text = await run("lsof", ["-ti", `:${port}`])
        for (const line of text.split("\n")) {
            const pid = Number(line.trim())
            if (!pid || ownPids.has(pid)) {
                continue
            }
            const command = (await run("ps", ["-p", String(pid), "-o", "command="])).trim()
            if (SPARED.test(command)) {
                console.log(`  :${port} pid ${pid} is blender, left alone`)
                continue
            }
            console.log(`  :${port} pid ${pid}  ${command.slice(0, 70)}`)
            if (!dryRun) {
                killAll([pid])
            }
        }
    }
}

async function killContainers(dryRun) {
    const filters = DOCKER_NAMES.flatMap((name) => ["--filter", `name=${name}`])
    const text = await run("docker", ["ps", "-q", ...filters])
    const ids = [...new Set(text.split("\n").map((each) => each.trim()).filter(Boolean))]
    if (ids.length === 0) {
        return
    }
    console.log(`  ${ids.length} docker container(s)`)
    if (!dryRun) {
        await run("docker", ["kill", ...ids])
        await run("docker", ["rm", "-f", ...ids])
    }
}

export default new Command()
    .name("fk")
    .description("Kill everything a dimos run leaves behind: modules, unity, gazebo, ros, ports")
    .option("-n, --dry-run", "List what would be killed and kill nothing")
    .action(async (options) => {
        const dryRun = options.dryRun === true
        const found = candidates(await processTable())

        if (found.size === 0) {
            console.log("nothing dimos-shaped is running")
        } else {
            const byLabel = new Map()
            for (const [pid, { label, command }] of found) {
                if (!byLabel.has(label)) {
                    byLabel.set(label, [])
                }
                byLabel.get(label).push({ pid, command })
            }
            for (const [label, entries] of byLabel) {
                console.log(`${label} (${entries.length})`)
                for (const { pid, command } of entries) {
                    console.log(`  ${String(pid).padStart(7)}  ${command.slice(0, 80)}`)
                }
            }
            if (!dryRun) {
                const pids = [...found.keys()]
                killAll(pids)
                let left = await waitForGone(pids, 3)
                if (left.length > 0) {
                    // AppArmor's tcpdump profile rejects signals from a
                    // vscode-labeled shell, so kill -9 EPERMs even as root. An
                    // unconfined label is one the profile accepts.
                    console.log(`still up: ${left.join(", ")} — retrying unconfined`)
                    await run("florp", ["aa-exec", "-p", "unconfined", "--", "kill", "-9", ...left.map(String)])
                    left = await waitForGone(left, 3)
                }
                console.log(left.length === 0 ? "all killed" : `still running: ${left.join(", ")}`)
            }
        }

        console.log(dryRun ? "ports (nothing killed):" : "ports:")
        await killByPort(dryRun)
        await killContainers(dryRun)
        if (dryRun) {
            console.log("dry run — nothing was killed")
        }
    })
