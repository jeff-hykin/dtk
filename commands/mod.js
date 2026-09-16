// Every subcommand of dtk is listed here. To add one, drop a file in this
// folder that default-exports a cliffy Command, then import it below.

import doctor from "./doctor.js"

export const commands = [
    doctor,
]
