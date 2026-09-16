// The built-in commands of dtk itself. Sub-tools are listed in ../registry.js
// instead, and are dispatched before cliffy ever sees the arguments.

import data from "./data.js"
import doctor from "./doctor.js"
import list from "./list.js"
import remove from "./remove.js"
import update from "./update.js"
import where from "./where.js"

export const commands = [
    data,
    list,
    update,
    remove,
    where,
    doctor,
]
