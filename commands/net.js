import { Command } from "jsr:@cliffy/command@1.0.0-rc.7"
import { DtkError } from "../errors.js"
import { toolsByName } from "../registry.js"
import { ensureDownloaded } from "../tool_store.js"
import { dim } from "../style.js"

// Where the recorder and its unit land on whichever machine is being watched.
// Deliberately not inside the deno cache: a systemd unit that points into a
// content-addressed cache breaks the next time the tool is updated.
const SCRIPT_PATH = ".dtk/net_log.js"
const UNIT_NAME = "dtk-netlog.service"
const UNIT_PATH = `.config/systemd/user/${UNIT_NAME}`
const LOG_DIR = ".dimos/logs"

// A remote target is any ssh destination; with none, everything runs here. Both
// paths go through the same shell string so the two cannot drift apart.
async function sh(host, script, { capture = true, input = null } = {}) {
    const [program, args] = host
        ? ["ssh", [host, "bash -s"]]
        : ["bash", ["-s"]]
    const proc = new Deno.Command(program, {
        args,
        stdin: "piped",
        stdout: capture ? "piped" : "inherit",
        stderr: capture ? "piped" : "inherit",
    }).spawn()
    const writer = proc.stdin.getWriter()
    await writer.write(new TextEncoder().encode(input === null ? script : script))
    await writer.close()
    const out = await proc.output()
    const decode = (buf) => (buf ? new TextDecoder().decode(buf) : "")
    return {
        code: out.code,
        stdout: decode(out.stdout).trim(),
        stderr: decode(out.stderr).trim(),
    }
}

async function copyScript(host, localPath) {
    const source = await Deno.readTextFile(localPath)
    // Heredoc with a quoted terminator so nothing in the script is expanded.
    const script = `
set -e
mkdir -p "$HOME/$(dirname ${SCRIPT_PATH})"
cat > "$HOME/${SCRIPT_PATH}" <<'DTK_NET_LOG_EOF'
${source}
DTK_NET_LOG_EOF
chmod +x "$HOME/${SCRIPT_PATH}"
echo "$HOME/${SCRIPT_PATH}"
`
    const { code, stdout, stderr } = await sh(host, script)
    if (code !== 0) {
        throw new DtkError(`dtk net: could not copy the recorder — ${stderr || "ssh failed"}`)
    }
    return stdout
}

function where(host) {
    return host ? ` on ${host}` : ""
}

const install = new Command()
    .name("install")
    .description("Install the recorder as a user service and start it")
    .option("--host <ssh:string>", "Install on this ssh destination instead of here")
    .option("--iface <name:string>", "Wireless interface to watch", { default: "wlan0" })
    .option("--ports <list:string>", "Comma-separated local ports to watch", { default: "1024,8190" })
    .option("--keep-days <n:number>", "Days of logs to retain", { default: 7 })
    .action(async (options) => {
        const tool = toolsByName["net_log"]
        const localPath = await ensureDownloaded(tool)
        const remotePath = await copyScript(options.host, localPath)
        console.log(dim(`recorder → ${remotePath}`))

        // deno may only exist in a login shell's PATH (nix profile, ~/.deno),
        // so the unit gets an absolute path resolved on the target itself.
        const script = `
set -e
DENO=$(command -v deno || echo "$HOME/.nix-profile/bin/deno")
if [ ! -x "$DENO" ]; then DENO="$HOME/.deno/bin/deno"; fi
if [ ! -x "$DENO" ]; then echo "deno not found" >&2; exit 1; fi
mkdir -p "$HOME/.config/systemd/user" "$HOME/${LOG_DIR}"
cat > "$HOME/${UNIT_PATH}" <<EOF
[Unit]
Description=dtk net — link and control-path recorder
After=network-online.target

[Service]
Type=simple
ExecStart=$DENO run --allow-all $HOME/${SCRIPT_PATH} --iface ${options.iface} --ports ${options.ports} --dir $HOME/${LOG_DIR} --keep-days ${options.keepDays}
Restart=always
RestartSec=5
Environment="HOME=$HOME"
Nice=15
CPUWeight=10
MemoryMax=300M

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable ${UNIT_NAME}
# restart, not just 'enable --now': --now leaves an already-running service
# alone, so re-installing an updated recorder would silently keep the old one.
systemctl --user restart ${UNIT_NAME}
sleep 3
systemctl --user is-active ${UNIT_NAME}
`
        const { code, stdout, stderr } = await sh(options.host, script)
        if (code !== 0 || stdout !== "active") {
            throw new DtkError(`dtk net install: service did not start — ${stderr || stdout}`)
        }
        console.log(`dtk net: recording${where(options.host)} (${options.iface}, ports ${options.ports})`)
        console.log(dim(`  logs: ~/${LOG_DIR}/netlog-<date>.jsonl · dtk net status · dtk net report`))
    })

const uninstall = new Command()
    .name("uninstall")
    .description("Stop the recorder and remove its service (logs are kept)")
    .option("--host <ssh:string>", "Act on this ssh destination instead of here")
    .action(async (options) => {
        const script = `
systemctl --user disable --now ${UNIT_NAME} 2>/dev/null || true
rm -f "$HOME/${UNIT_PATH}"
systemctl --user daemon-reload
echo removed
`
        await sh(options.host, script)
        console.log(`dtk net: recorder removed${where(options.host)} (logs left in ~/${LOG_DIR})`)
    })

const status = new Command()
    .name("status")
    .description("Is the recorder running, and how much has it collected")
    .option("--host <ssh:string>", "Act on this ssh destination instead of here")
    .action(async (options) => {
        const script = `
echo "state: $(systemctl --user is-active ${UNIT_NAME} 2>/dev/null || echo not-installed)"
echo "files:"
ls -la "$HOME/${LOG_DIR}"/netlog-*.jsonl 2>/dev/null | awk '{print "  " $9 "  " $5 " bytes"}' || echo "  (none yet)"
LAST=$(ls -t "$HOME/${LOG_DIR}"/netlog-*.jsonl 2>/dev/null | head -1)
if [ -n "$LAST" ]; then
  echo "samples: $(grep -c '"k":"s"' "$LAST" 2>/dev/null || echo 0)"
  echo "latest:  $(tail -1 "$LAST" | cut -c1-90)…"
fi
`
        const { stdout } = await sh(options.host, script)
        console.log(stdout)
    })

const log = new Command()
    .name("log")
    .description("Print recent recorder lines")
    .option("--host <ssh:string>", "Act on this ssh destination instead of here")
    .option("-n, --lines <n:number>", "How many lines", { default: 20 })
    .option("-f, --follow", "Keep printing as they arrive")
    .option("--events", "Only the kernel/NetworkManager events, not the 1 Hz samples")
    .action(async (options) => {
        const filter = options.events ? ` | grep '\"k\":\"e\"'` : ""
        const script = options.follow
            ? `tail -n ${options.lines} -F "$HOME/${LOG_DIR}"/netlog-*.jsonl${filter}`
            : `tail -qn ${options.lines} "$HOME/${LOG_DIR}"/netlog-*.jsonl${filter}`
        await sh(options.host, script, { capture: false })
    })

const report = new Command()
    .name("report")
    .description("Fetch the recorder's log and summarise what the link was doing")
    .option("--host <ssh:string>", "Fetch from this ssh destination instead of here")
    .option("--out <path:string>", "Write the raw jsonl here", { default: "netlog.jsonl" })
    .action(async (options) => {
        const { code, stdout, stderr } = await sh(options.host, `cat "$HOME/${LOG_DIR}"/netlog-*.jsonl`)
        if (code !== 0 || !stdout) {
            throw new DtkError(`dtk net report: no log found${where(options.host)} — ${stderr || "is it installed?"}`)
        }
        await Deno.writeTextFile(options.out, stdout + "\n")

        const samples = []
        const events = new Map()
        for (const line of stdout.split("\n")) {
            if (!line.trim()) {
                continue
            }
            let row
            try {
                row = JSON.parse(line)
            } catch {
                continue
            }
            if (row.k === "s") {
                samples.push(row)
            }
            if (row.k === "e") {
                events.set(row.kind, (events.get(row.kind) || 0) + (row.n || 1))
            }
        }
        if (samples.length === 0) {
            throw new DtkError("dtk net report: the log has no samples yet")
        }
        const worstSendq = samples.reduce((acc, s) => {
            const q = Math.max(0, ...(s.socks || []).map((x) => x.sendq || 0))
            return q > acc.q ? { q, t: s.t } : acc
        }, { q: 0, t: null })
        const retrans = samples.at(-1).socks?.reduce((a, x) => a + (x.retrans || 0), 0) ?? 0
        const signals = samples.map((s) => s.iw?.signal).filter((v) => typeof v === "number")
        const pings = samples.flatMap((s) => Object.values(s.ping || {}))
        const lost = pings.filter((p) => p.loss).length

        console.log(`samples      ${samples.length}  (${samples[0].t} → ${samples.at(-1).t})`)
        console.log(`raw jsonl    ${options.out}`)
        console.log(`signal       ${signals.length ? `${Math.min(...signals)} … ${Math.max(...signals)} dBm` : "n/a"}`)
        console.log(`worst Send-Q ${worstSendq.q} bytes${worstSendq.t ? ` at ${worstSendq.t}` : ""}`)
        console.log(`TCP retrans  ${retrans} (cumulative on the sockets open at the end)`)
        console.log(`ping         ${lost}/${pings.length} probes lost`)
        console.log("events")
        if (events.size === 0) {
            console.log("  (none)")
        }
        for (const [kind, n] of [...events].sort((a, b) => b[1] - a[1])) {
            console.log(`  ${kind.padEnd(14)} ${n}`)
        }
    })

export default new Command()
    .name("net")
    .description("Record and inspect what the network is doing on a robot")
    .action(function () {
        this.showHelp()
    })
    .command("install", install)
    .command("uninstall", uninstall)
    .command("status", status)
    .command("log", log)
    .command("report", report)
