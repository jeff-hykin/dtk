// `dtk replay <runs> [<other runs>]` — the top-down GSC replay page: one tab per map, two runs side by side, a time
// slider over the whole run (stand-still included), the live published map, closures by state, optional GT.
//
// What it takes:
//   dtk replay <battery>                     a dir with cand/ and base/ (each <map>/a.kf ...): one tab per map, cand left
//   dtk replay <battery A> <battery B>       two dirs of <map>/ run dirs: the maps both have
//   dtk replay <run A> [<run B>]             one or two pgo-eval run dirs (a.kf, a.kf.closures, a.json): one tab
// The recording, its streams and the GT come from the run dirs (a.json's head, else summary.json's command). Then it
// writes <out>/page<N>/ (index.html, report.json, <map>/*.b64 + meta.json, files.json) split under the Artifact size
// limit, prints the publish call for each page, and renders check frames (<out>/check/<map>/*.png) at the biggest GNC
// events so the frames can be looked at before publishing.

import { Command } from "jsr:@cliffy/command@1.0.0-rc.7"
import { DtkError } from "../errors.js"
import { toolsByName } from "../registry.js"
import { ensureDownloaded, runTool } from "../tool_store.js"
import { bold, dim, yellow } from "../style.js"

const PAGE_BYTES = Number(Deno.env.get("DTK_REPLAY_PAGE_MB") ?? 60) * 1e6 // an Artifact version holds 64 MB, the page included
const FILE_BYTES = 15e6 // one file of an Artifact
const MAP_LABELS = {
    huge_fastlio: "Huge loop, Mid-360 FAST-LIO",
    huge_l1: "Huge loop, Go2 L1 (Mac timing)",
    huge_l1_jetson: "Huge loop, Go2 L1 (Jetson timing)",
    small_l1: "Small loop, Go2 L1",
    small_fastlio: "Small loop, Mid-360 FAST-LIO",
    gir_park_pointlio: "GIR park, Point-LIO",
    gir2_pointlio: "GIR stairs 2, Point-LIO",
    gir1_pointlio: "GIR stairs 1, Point-LIO",
    office555: "Office 555, Point-LIO",
    athens_pointlio: "Athens stairs, Point-LIO",
}
const MAP_ORDER = Object.keys(MAP_LABELS)

const exists = (path) => {
    try {
        Deno.statSync(path)
        return true
    } catch {
        return false
    }
}
const isRun = (dir) => exists(`${dir}/a.kf`)
const absolute = (path) =>
    (path.startsWith("/") ? path : `${Deno.cwd()}/${path}`).replace(/\/+$/, "")
const baseName = (path) => path.replace(/\/+$/, "").split("/").pop()
const readJson = (path) => (exists(path) ? JSON.parse(Deno.readTextFileSync(path)) : null)
const mapDirs = (dir) =>
    [...Deno.readDirSync(dir)].filter((e) => e.isDirectory && isRun(`${dir}/${e.name}`)).map((e) =>
        e.name
    )
const byMapOrder = (a, b) => {
    const [i, j] = [MAP_ORDER.indexOf(a), MAP_ORDER.indexOf(b)]
    return (i === -1 ? 99 : i) - (j === -1 ? 99 : j) || a.localeCompare(b)
}

// What pgo-eval read: a.json opens with db / odom_stream / lidar_stream; summary.json keeps the command line.
function recordingOf(run) {
    let head = ""
    if (exists(`${run}/a.json`)) {
        const file = Deno.openSync(`${run}/a.json`)
        const buffer = new Uint8Array(4096)
        const n = file.readSync(buffer) ?? 0
        file.close()
        head = new TextDecoder().decode(buffer.subarray(0, n))
    }
    const field = (key) => head.match(new RegExp(`"${key}":\\s*"([^"]*)"`))?.[1]
    const found = { db: field("db"), odom: field("odom_stream"), lidar: field("lidar_stream") }
    const command = readJson(`${run}/summary.json`)?.command
    if (command) {
        const flag = (name) => command[command.indexOf(name) + 1]
        found.db ??= command.includes("--db") ? flag("--db") : undefined
        found.odom ??= command.includes("--odom-stream") ? flag("--odom-stream") : undefined
        found.lidar ??= command.includes("--lidar-stream") ? flag("--lidar-stream") : undefined
        found.binary = command[0]
    }
    return found
}

// "cand 337286ca76" from .../pgo-eval-337286ca76, "base (gsc006_target)" from .../gsc006_target/release/pgo-eval
function defaultLabel(side, run) {
    const binary = recordingOf(run).binary
    if (!binary) {
        return side
    }
    const sha = binary.match(/pgo-eval-([0-9a-f]{7,})$/)?.[1]
    if (sha) {
        return `${side} ${sha}`
    }
    const parts = binary.split("/")
    const target = parts.length > 3 && parts.at(-2) === "release" ? parts.at(-3) : null
    return target ? `${side} (${target})` : side
}

// Smaller exports for longer maps, so a ten-map battery fits a page or two.
function sizeOptions(keyframes) {
    if (keyframes > 3000) {
        return {
            max_points: 30,
            icp_accepted: 3,
            icp_rejected: 3,
            state_budget_bytes: 500000,
            odom_hz: 1.0,
        }
    }
    if (keyframes > 1000) {
        return { max_points: 60, icp_accepted: 6, icp_rejected: 6, state_budget_bytes: 900000 }
    }
    return {}
}

const keyframesOf = (run) => Deno.statSync(`${run}/a.kf`).size / 120

// The pairs to draw: [{name, a, b}] from what was handed over.
function pairsOf(first, second, sideA, sideB) {
    if (second === undefined) {
        if (isRun(first)) {
            return {
                pairs: [{ name: baseName(first), a: first, b: null }],
                sides: [baseName(first), null],
            }
        }
        const [a, b] = [`${first}/${sideA}`, `${first}/${sideB}`]
        if (!exists(a) || !exists(b)) {
            throw new DtkError(
                `dtk replay: ${first} is neither a run dir (no a.kf) nor a battery (no ${sideA}/ and ${sideB}/)`,
            )
        }
        return { pairs: pairsOf(a, b).pairs, sides: [sideA, sideB] }
    }
    if (isRun(first) !== isRun(second)) {
        throw new DtkError(`dtk replay: give two run dirs or two batteries, not one of each`)
    }
    if (isRun(first)) {
        const name = baseName(first) === baseName(second)
            ? baseName(first)
            : `${baseName(first)}_vs_${baseName(second)}`
        return {
            pairs: [{ name, a: first, b: second }],
            sides: [baseName(first), baseName(second)],
        }
    }
    const inB = new Set(mapDirs(second))
    const both = mapDirs(first).filter((m) => inB.has(m)).sort(byMapOrder)
    const onlyOne = [...mapDirs(first), ...inB].filter((m) => !both.includes(m))
    if (onlyOne.length) {
        console.error(
            yellow(
                `dtk replay: skipping maps only one side has: ${[...new Set(onlyOne)].join(", ")}`,
            ),
        )
    }
    return {
        pairs: both.map((name) => ({ name, a: `${first}/${name}`, b: `${second}/${name}` })),
        sides: [baseName(first), baseName(second)],
    }
}

// battery scores.json: "<side>/<map>" -> the summary table's loops and GT error
function scoresOf(batteryRoot, side, name) {
    const row = batteryRoot ? readJson(`${batteryRoot}/scores.json`)?.[`${side}/${name}`] : null
    return row ? { loops: row.solves?.kept_last ?? row.kept, gt: row.gt } : {}
}

function heavyJobsRunning() {
    try {
        const out = new Deno.Command("pgrep", {
            args: ["-l", "pgo-eval"],
            stdout: "piped",
            stderr: "null",
        }).outputSync()
        return new TextDecoder().decode(out.stdout).trim()
    } catch {
        return ""
    }
}

function filesUnder(dir, prefix = "") {
    const out = []
    for (const e of Deno.readDirSync(dir)) {
        const rel = prefix ? `${prefix}/${e.name}` : e.name
        if (e.isDirectory) {
            out.push(...filesUnder(`${dir}/${e.name}`, rel))
        } else {
            out.push(rel)
        }
    }
    return out
}
const sizeOf = (dir) =>
    filesUnder(dir).reduce((sum, rel) => sum + Deno.statSync(`${dir}/${rel}`).size, 0)

function escapeHtml(text) {
    return text.replace(
        /[&<>"']/g,
        (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
    )
}

async function viewerHtml() {
    const exportScript = await ensureDownloaded(toolsByName.replay_export)
    return Deno.readTextFileSync(exportScript.replace(/[^/]+$/, "viewer.html"))
}

// Pages of maps, each under PAGE_BYTES, in tab order.
function packPages(names, mapsDir) {
    const pages = []
    let current = [], used = 0
    for (const name of names) {
        const size = sizeOf(`${mapsDir}/${name}`)
        if (current.length && used + size > PAGE_BYTES) {
            pages.push(current)
            current = []
            used = 0
        }
        current.push(name)
        used += size
    }
    if (current.length) {
        pages.push(current)
    }
    return pages
}

function writePage({ dir, names, mapsDir, viewer, title, labels, header, pageNumber, pageCount }) {
    try {
        Deno.removeSync(dir, { recursive: true })
    } catch {
        // first build
    }
    Deno.mkdirSync(dir, { recursive: true })
    const recordings = []
    for (const name of names) {
        const meta = readJson(`${mapsDir}/${name}/meta.json`)
        recordings.push({ name, label: meta.label })
        Deno.mkdirSync(`${dir}/${name}`)
        for (const rel of filesUnder(`${mapsDir}/${name}`)) {
            Deno.linkSync(`${mapsDir}/${name}/${rel}`, `${dir}/${name}/${rel}`)
        }
    }
    const pageTitle = pageCount > 1 ? `${title} (${pageNumber} of ${pageCount})` : title
    const report = {
        title: pageTitle,
        built: new Date().toISOString().slice(0, 16).replace("T", " "),
        labels,
        recordings,
    }
    Deno.writeTextFileSync(`${dir}/report.json`, JSON.stringify(report, null, 1))
    // the Artifact wraps the page in its own doctype/head/body, so the viewer's are dropped
    let page = viewer.replace(
        /<!doctype html>|<\/?html[^>]*>|<\/?head>|<\/?body>|<meta [^>]*>/gi,
        "",
    )
    const pageLine = pageCount > 1
        ? `<p class="cap">Page ${pageNumber} of ${pageCount}: ${
            names.map((n) => escapeHtml(readJson(`${mapsDir}/${n}/meta.json`).label)).join(", ")
        }.</p>`
        : ""
    page = page.replace('<main id="main"></main>', header + pageLine + '<main id="main"></main>')
    page = page.replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(pageTitle)}</title>`)
    Deno.writeTextFileSync(`${dir}/index.html`, page.trim() + "\n")
    const files = {}
    for (const rel of filesUnder(dir)) {
        if (rel === "index.html" || rel === "files.json") {
            continue
        }
        files[rel] = rel.endsWith(".b64") ? { from: rel, contentType: "text/plain" } : { from: rel }
        if (Deno.statSync(`${dir}/${rel}`).size >= FILE_BYTES) {
            throw new DtkError(
                `dtk replay: ${dir}/${rel} is over 15 MB (an Artifact file's limit); lower --opt max_points / state_budget_bytes`,
            )
        }
    }
    Deno.writeTextFileSync(`${dir}/files.json`, JSON.stringify(files, null, 1))
    return { dir, files, bytes: sizeOf(dir), title: pageTitle }
}

export default new Command()
    .name("replay")
    .description(
        "Top-down GSC replay page: one tab per map, two runs side by side, time slider, published map, closures, GT.\n" +
            "  <runs> is a battery (cand/ and base/ of <map>/ run dirs), a dir of <map>/ run dirs, or one pgo-eval run dir.",
    )
    .arguments("<runs:string> [other:string]")
    .option("--label-a <name:string>", "left run's name (default: side dir + binary)")
    .option("--label-b <name:string>", "right run's name")
    .option("--side-a <dir:string>", "battery subdir drawn on the left", { default: "cand" })
    .option("--side-b <dir:string>", "battery subdir drawn on the right", { default: "base" })
    .option(
        "--maps <names:string>",
        "only these maps, comma separated (others keep their old export)",
    )
    .option(
        "--out <dir:string>",
        "output folder (default <battery>/replay); must be under the session's cwd or scratchpad to publish",
    )
    .option("--title <text:string>", "page title (default '<A> vs <B>: replays')")
    .option(
        "--note <html:string>",
        "an extra line of html above the replays (a status line, what changed)",
    )
    .option("--caption <text:string>", "text added to every map's caption (config, timing)")
    .option(
        "--gt-stream <name:string>",
        "use this corrected-odometry stream as GT instead of the automatic pick",
    )
    .option(
        "--opt <setting:string>",
        "KEY=VALUE export size knob (max_points, state_budget_bytes, icp_accepted, odom_hz, ...)",
        { collect: true },
    )
    .option("--force", "re-export maps whose inputs did not change")
    .option("--frames <n:number>", "most check frames per map", { default: 8 })
    .option("--no-check", "skip rendering the check frames")
    .option("--check-only", "only re-render the check frames of an existing --out")
    .example(
        "battery, cand vs base",
        "dtk replay ~/.dimos/recordings/gsc_runs/2026-11-17_c007rc2_vs_006 --label-a '0.0.7 rc2' --label-b 0.0.6",
    )
    .example(
        "two runs of one map",
        "dtk replay runs/huge_l1_on runs/huge_l1_off --label-a 'hot path on' --label-b off",
    )
    .example("redo one map's export", "dtk replay <battery> --maps athens_pointlio --force")
    .action(async (options, runs, other) => {
        const first = absolute(runs)
        const second = other === undefined ? undefined : absolute(other)
        const { pairs: allPairs, sides } = pairsOf(first, second, options.sideA, options.sideB)
        const batteryRoot = second === undefined && !isRun(first) ? first : null
        const out = absolute(
            options.out ??
                (batteryRoot
                    ? `${batteryRoot}/replay`
                    : `${isRun(first) ? first.replace(/\/[^/]+$/, "") : first}/replay`),
        )
        const mapsDir = `${out}/maps`, sourcesDir = `${out}/sources`
        Deno.mkdirSync(mapsDir, { recursive: true })
        Deno.mkdirSync(sourcesDir, { recursive: true })
        const only = options.maps
            ? options.maps.split(",").map((s) => s.trim()).filter(Boolean)
            : null
        const firstPair = allPairs[0]
        if (!firstPair) {
            throw new DtkError("dtk replay: no maps to draw")
        }
        const labels = {
            gsc: options.labelA ?? defaultLabel(sides[0], firstPair.a),
            ...(firstPair.b ? { ivan: options.labelB ?? defaultLabel(sides[1], firstPair.b) } : {}),
        }
        const extra = Object.fromEntries((options.opt ?? []).map((kv) => {
            const [k, v] = kv.split("=")
            return [k, Number.isNaN(Number(v)) ? v : Number(v)]
        }))

        if (!options.checkOnly) {
            for (const pair of allPairs) {
                const rec = recordingOf(pair.a)
                if (!rec.db || !rec.odom || !rec.lidar) {
                    throw new DtkError(
                        `dtk replay: ${pair.a} names no recording (no a.json head or summary.json command with --db / --odom-stream / --lidar-stream)`,
                    )
                }
                if (pair.b) {
                    const recB = recordingOf(pair.b)
                    if (recB.db !== rec.db || recB.odom !== rec.odom || recB.lidar !== rec.lidar) {
                        console.error(
                            yellow(
                                `dtk replay: ${pair.name}: the two runs read different inputs (${rec.db} ${rec.odom} vs ${recB.db} ${recB.odom}); drawing points from ${pair.a}'s`,
                            ),
                        )
                    }
                }
                if (!exists(rec.db)) {
                    throw new DtkError(
                        `dtk replay: ${pair.name}: the recording ${rec.db} is not on this machine`,
                    )
                }
                const keyframes = Math.max(keyframesOf(pair.a), pair.b ? keyframesOf(pair.b) : 0)
                const entry = {
                    name: pair.name,
                    label: MAP_LABELS[pair.name] ?? pair.name,
                    config_name: options.caption ?? "",
                    labels,
                    runs: { gsc: pair.a, ...(pair.b ? { ivan: pair.b } : {}) },
                    db: rec.db,
                    streams: { lidar: rec.lidar, odom: rec.odom },
                    gt: "auto",
                    ...(options.gtStream ? { gt_stream: options.gtStream } : {}),
                    options: { ...sizeOptions(keyframes), ...extra },
                    scores: batteryRoot
                        ? {
                            gsc: scoresOf(batteryRoot, sides[0], pair.name),
                            ivan: scoresOf(batteryRoot, sides[1], pair.name),
                        }
                        : {},
                }
                const entryPath = `${sourcesDir}/${pair.name}.json`
                const previous = exists(entryPath) ? Deno.readTextFileSync(entryPath) : null
                const text = JSON.stringify(entry, null, 1)
                const fresh = exists(`${mapsDir}/${pair.name}/meta.json`) && previous === text
                if (
                    (only && !only.includes(pair.name) &&
                        exists(`${mapsDir}/${pair.name}/meta.json`)) || (fresh && !options.force)
                ) {
                    console.error(
                        dim(`dtk replay: ${pair.name}: export up to date (--force redoes it)`),
                    )
                    continue
                }
                if (only && !only.includes(pair.name)) {
                    continue
                }
                const busy = heavyJobsRunning()
                if (busy) {
                    console.error(
                        yellow(
                            `dtk replay: pgo-eval is running (${
                                busy.split("\n").length
                            }); one heavy job at a time on a laptop. Exporting anyway.`,
                        ),
                    )
                }
                Deno.writeTextFileSync(entryPath, text)
                const code = await runTool(toolsByName.replay_export, [entryPath, mapsDir])
                if (code !== 0) {
                    Deno.removeSync(entryPath)
                    throw new DtkError(`dtk replay: ${pair.name}: the export failed (exit ${code})`)
                }
            }

            const names = allPairs.map((p) => p.name).filter((n) =>
                exists(`${mapsDir}/${n}/meta.json`)
            )
            const title = options.title ??
                (labels.ivan ? `${labels.gsc} vs ${labels.ivan}: replays` : `${labels.gsc}: replay`)
            const header =
                `<p class="cap" style="max-width:72ch">Top-down replays: ${
                    escapeHtml(labels.gsc)
                } (left)` +
                (labels.ivan ? ` and ${escapeHtml(labels.ivan)} (right)` : "") +
                `, scrubbable over the whole run including any stand-still after the last scan. Each keyframe's points are placed by the newest graph that run had published at that time; the arrow is the robot's base_link. GT is off by default (tick GT map); each map's caption names its source.</p>` +
                (options.note ? `<p class="cap" style="max-width:72ch">${options.note}</p>` : "")
            const viewer = await viewerHtml()
            const pages = packPages(names, mapsDir)
            for (const old of [...Deno.readDirSync(out)].filter((e) => /^page\d+$/.test(e.name))) {
                Deno.removeSync(`${out}/${old.name}`, { recursive: true })
            }
            const written = pages.map((pageNames, i) =>
                writePage({
                    dir: `${out}/page${i + 1}`,
                    names: pageNames,
                    mapsDir,
                    viewer,
                    title,
                    labels,
                    header,
                    pageNumber: i + 1,
                    pageCount: pages.length,
                })
            )
            console.log(`\n${bold("replay pages")} in ${out}`)
            for (const page of written) {
                console.log(
                    `\n  ${page.dir}  (${(page.bytes / 1e6).toFixed(1)} MB, ${
                        Object.keys(page.files).length
                    } files)`,
                )
                console.log(`  publish with the Artifact tool:`)
                console.log(`    file_path: ${page.dir}/index.html`)
                console.log(`    root:      ${page.dir}`)
                console.log(
                    `    files:     the JSON in ${page.dir}/files.json (every .b64 as text/plain)`,
                )
                console.log(`    title:     ${page.title}`)
            }
            console.log(
                dim(`\n  the out dir must be under the session's working directory or scratchpad for the publish; --out moves it`),
            )
        }

        if (options.check !== false) {
            const args = [out, "--frames", String(options.frames)]
            if (only) {
                args.push("--maps", ...only)
            }
            // check.py reads report.json for the side names: hand it the first page's
            if (exists(`${out}/page1/report.json`)) {
                Deno.copyFileSync(`${out}/page1/report.json`, `${out}/report.json`)
            }
            console.log(
                `\n${
                    bold("check frames")
                } (Read them before publishing: arrow along the travel, map not torn, closures sane)`,
            )
            const code = await runTool(toolsByName.replay_check, args)
            if (code !== 0) {
                throw new DtkError(`dtk replay: rendering the check frames failed (exit ${code})`)
            }
        }
    })
