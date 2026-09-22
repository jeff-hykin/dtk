// Messages typed before anyone was listening.
//
// The outbox exists because of one asymmetry: the transport will happily
// accept a publish that nobody receives. `dtk chat` is most useful in exactly
// the moment that matters -- started before the blueprint, or alongside a
// `dtk run` that is still building native modules -- so a message typed then
// must be kept, shown as kept, and sent once there is something to send it to.
//
// Order is preserved and the flush is sequential. Two messages released into
// an agent at the same instant is a different conversation from the one that
// was typed.

let nextId = 1

export class Outbox {
    constructor({ onChange } = {}) {
        this.items = []
        this.onChange = onChange ?? (() => {})
    }

    // `status` is "held" until it is released, then "sending", then "sent" or
    // "failed". The transcript renders straight off these.
    add(text, { forced = false } = {}) {
        const item = {
            id: `m${nextId++}`,
            text,
            status: "held",
            at: Date.now(),
            forced,
        }
        this.items.push(item)
        this.onChange()
        return item
    }

    get held() {
        return this.items.filter((each) => each.status === "held")
    }

    get pending() {
        return this.items.filter((each) => each.status === "held" || each.status === "sending")
    }

    find(id) {
        return this.items.find((each) => each.id === id) ?? null
    }

    // Hand every held message to `send`, oldest first. `send` returns whether
    // the command was accepted by the source; a refusal leaves the message
    // held rather than losing it.
    flush(send) {
        for (const item of this.items) {
            if (item.status !== "held") {
                continue
            }
            const accepted = send({ t: "send", id: item.id, text: item.text })
            if (!accepted) {
                return false
            }
            item.status = "sending"
        }
        this.onChange()
        return true
    }

    markSent(id) {
        const item = this.find(id)
        if (item !== null) {
            item.status = "sent"
            this.onChange()
        }
        return item
    }

    markFailed(id, why) {
        const item = this.find(id)
        if (item !== null) {
            item.status = "failed"
            item.why = why
            this.onChange()
        }
        return item
    }

    // Put a failed message back in the queue, which is what a retry is.
    requeue(id) {
        const item = this.find(id)
        if (item !== null && item.status === "failed") {
            item.status = "held"
            this.onChange()
        }
    }

    dropHeld() {
        const dropped = this.held.length
        this.items = this.items.filter((each) => each.status !== "held")
        this.onChange()
        return dropped
    }

    // Anything that reached the agent is no longer the outbox's business; this
    // keeps the list from growing for the length of a long session.
    forget(id) {
        this.items = this.items.filter((each) => each.id !== id)
    }
}
