# dtk

The dimos toolkit. One command that is the entrypoint to a collection of dimos tooling.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/jeff-hykin/dtk/master/install.sh | sh
```

That installs [deno](https://deno.land) if you don't already have it, then installs `dtk`.

Already have deno? This is the whole install:

```sh
deno install -gfA --reload -n dtk https://raw.githubusercontent.com/jeff-hykin/dtk/master/main.js
```

Re-run either line to update. Uninstall with `deno uninstall -g dtk`.

## Usage

```sh
dtk --help
dtk doctor
```

## Adding a command

1. Add `commands/<name>.js` that default-exports a [cliffy](https://jsr.io/@cliffy/command) `Command`
2. Import it in `commands/mod.js` and add it to the `commands` list

```js
import { Command } from "jsr:@cliffy/command@1.0.0-rc.7"

export default new Command()
    .name("hello")
    .description("Say hello")
    .action(() => {
        console.log("hello")
    })
```

## Development

```sh
deno task dtk --help     # run from source
deno task install        # install the local copy as `dtk`
```
