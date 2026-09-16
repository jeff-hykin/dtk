#!/usr/bin/env -S deno run --allow-read --allow-write --allow-net --allow-env --allow-ffi --unstable-ffi

// db_rename — rename a stream in a dimos memory2 .db, in place.
//
// A stream is a family of tables (`<name>`, `<name>_blob`, `<name>_vec`,
// `<name>_rtree` plus the r-tree's shadows) and one row in `_streams`. Nothing
// else refers to the name -- the registry's `config` blob holds module paths,
// not the stream name -- so renaming is ALTER TABLE plus one UPDATE, with no
// copying however large the recording is.

import { Database } from "jsr:@db/sqlite@0.12"

const args = [...Deno.args]
let dbPath = null
let oldName = null
let newName = null
let dryRun = false
let assumeYes = false

for (let index = 0; index < args.length; index++) {
    const argument = args[index]
    if (argument === "-h" || argument === "--help") {
        console.log(`db_rename — rename a stream in a dimos memory2 .db, in place

Usage: db_rename <recording.db> <old> <new> [--dry-run] [-y]

Options:
  -n, --dry-run   Show what would be renamed, change nothing
  -y, --yes       Skip the confirmation prompt`)
        Deno.exit(0)
    } else if (argument === "-n" || argument === "--dry-run") {
        dryRun = true
    } else if (argument === "-y" || argument === "--yes") {
        assumeYes = true
    } else if (dbPath === null) {
        dbPath = argument
    } else if (oldName === null) {
        oldName = argument
    } else if (newName === null) {
        newName = argument
    }
}

if (dbPath === null || oldName === null || newName === null) {
    console.error("error: need <recording.db> <old> <new> (see --help)")
    Deno.exit(1)
}
if (oldName === newName) {
    console.error("error: the old and new names are the same")
    Deno.exit(1)
}
if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(newName)) {
    console.error(`error: "${newName}" is not a usable stream name (letters, digits and _ only)`)
    Deno.exit(1)
}

const db = new Database(dbPath)

const present = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name),
)

// The r-tree's _node/_parent/_rowid shadows follow the virtual table on rename,
// so they are deliberately not listed here.
const suffixes = ["", "_blob", "_vec", "_rtree"]
const moves = suffixes
    .map((suffix) => ({ from: `${oldName}${suffix}`, to: `${newName}${suffix}` }))
    .filter((move) => present.has(move.from))

const collisions = moves.filter((move) => present.has(move.to))
if (collisions.length > 0) {
    console.error(`error: "${newName}" is already taken (${collisions.map((each) => each.to).join(", ")})`)
    db.close()
    Deno.exit(1)
}

const hasRegistry = present.has("_streams")
const inRegistry = hasRegistry &&
    db.prepare("SELECT COUNT(*) AS count FROM _streams WHERE name = ?").get(oldName).count > 0

if (moves.length === 0 && !inRegistry) {
    console.error(`error: no tables or registry entry found for stream "${oldName}"`)
    const streams = hasRegistry
        ? db.prepare("SELECT name FROM _streams ORDER BY name").all().map((row) => row.name)
        : [...present].sort()
    console.error(`available: ${streams.join(", ")}`)
    db.close()
    Deno.exit(1)
}

console.log(`stream "${oldName}" -> "${newName}" in ${dbPath}`)
for (const move of moves) {
    const count = db.prepare(`SELECT COUNT(*) AS count FROM "${move.from}"`).get().count
    console.log(`  rename table  ${move.from}  ->  ${move.to}  (${count} rows)`)
}
if (inRegistry) {
    console.log(`  update _streams row  ${oldName}  ->  ${newName}`)
}

if (dryRun) {
    console.log("dry run — nothing changed")
    db.close()
    Deno.exit(0)
}

if (!assumeYes && !confirm(`Rename stream "${oldName}" to "${newName}"?`)) {
    console.log("aborted")
    db.close()
    Deno.exit(0)
}

db.exec("BEGIN")
try {
    for (const move of moves) {
        db.exec(`ALTER TABLE "${move.from}" RENAME TO "${move.to}"`)
    }
    if (inRegistry) {
        db.prepare("UPDATE _streams SET name = ? WHERE name = ?").run(newName, oldName)
    }
    db.exec("COMMIT")
} catch (error) {
    db.exec("ROLLBACK")
    console.error("failed, rolled back:", error.message)
    db.close()
    Deno.exit(1)
}
db.close()
console.log("done")
