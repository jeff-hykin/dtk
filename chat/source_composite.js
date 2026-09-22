// Read from one thing, write with another.
//
// The two halves of a chat have completely different costs here:
//
//   reading   `spy` is a rust binary dtk already has. It starts in
//             milliseconds, sniffs LCM and zenoh at once, and needs no python,
//             no uv, no venv and no dimos checkout.
//   writing   nothing available to deno can publish. Deno cannot set
//             `IP_MULTICAST_IF`, so its multicast sends are not delivered at
//             all on macOS (measured: a raw socket joined to the group saw
//             every python packet and none from deno), and zenoh has no deno
//             client that does not need the router's remote-api plugin. So a
//             publisher is a separate process.
//
// Pairing them means the conversation is on screen immediately and python is
// only ever paid for by someone who actually sends something. Start `dtk chat`
// to watch a run and no python process is ever launched.
//
// The publisher is started on the first send and the command is buffered until
// it is up, which is the same promise the outbox already makes: a message is
// never lost, and its badge says where it is.

export class CompositeSource {
    constructor({ reader, writer, onEvent, onState }) {
        this.reader = reader
        this.writer = writer
        this.onEvent = onEvent
        this.onState = onState
        this._queued = []
        this._writerStarting = false

        // Reader events pass straight through. Writer events are filtered: its
        // subscriptions are off, but it still reports sends and problems.
        this.reader.onEvent = (event) => this._emit(event)
        this.reader.onState = (state, detail) => {
            if (this.onState) {
                this.onState(state, detail)
            }
        }
        this.writer.onEvent = (event) => {
            if (event.t === "ready") {
                this._flushQueued()
                return
            }
            if (event.t === "hello") {
                return // the reader already said hello
            }
            this._emit(event)
        }
        this.writer.onState = (state, detail) => {
            if (state === "broken") {
                // Nothing can be sent. Fail every queued message rather than
                // leaving them looking like they are still on their way.
                for (const command of this._queued) {
                    this._emit({
                        t: "problem",
                        where: "send",
                        message: `cannot publish: ${detail}`,
                        id: command.id,
                    })
                }
                this._queued = []
                this._emit({ t: "problem", where: "publisher", message: detail })
            }
        }
    }

    _emit(event) {
        if (this.onEvent) {
            this.onEvent(event)
        }
    }

    // The state the status bar shows is the reader's: that is what "am I
    // seeing the conversation" means.
    get state() {
        return this.reader.state
    }

    get detail() {
        return this.reader.detail
    }

    get backend() {
        return this.reader.backend
    }

    get url() {
        return this.reader.url ?? null
    }

    get usable() {
        return this.reader.usable
    }

    // What the publisher is doing, for the status bar to show separately.
    get publisher() {
        if (!this._writerStarting && this.writer.state === "starting") {
            return "idle" // not started, because nothing has been sent yet
        }
        return this.writer.state
    }

    async start() {
        await this.reader.start()
    }

    send(command) {
        if (command.t === "ping") {
            return this.reader.send(command)
        }
        if (this.writer.usable) {
            return this.writer.send(command)
        }
        this._queued.push(command)
        if (!this._writerStarting) {
            this._writerStarting = true
            // Publish on the backend the conversation was actually seen on.
            // Guessing from `DIMOS_TRANSPORT` is how a message goes out on
            // zenoh while the blueprint is listening on lcm: both halves
            // report success and nothing is delivered.
            const observed = this.reader.observed ?? null
            if (observed !== null && this.writer.transport !== observed) {
                this.writer.transport = observed
            }
            this._emit({
                t: "problem",
                where: "publisher",
                message: "starting the publisher (this takes a moment the first time)",
            })
            this.writer.start().catch((error) => {
                this._emit({
                    t: "problem",
                    where: "publisher",
                    message: error instanceof Error ? error.message : String(error),
                })
            })
        }
        // Accepted, not yet sent. The `sent` event is what confirms it, and
        // the outbox keeps showing it as pending until then.
        return true
    }

    _flushQueued() {
        const queued = this._queued
        this._queued = []
        for (const command of queued) {
            if (!this.writer.send(command)) {
                this._queued.push(command)
            }
        }
    }

    async stop() {
        await this.reader.stop()
        await this.writer.stop()
    }
}
