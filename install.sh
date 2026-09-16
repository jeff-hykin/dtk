#!/usr/bin/env sh
# Installs the dtk command. Installs deno first if it is missing.
set -e

DTK_URL="${DTK_URL:-https://raw.githubusercontent.com/jeff-hykin/dtk/master/main.js}"

if ! command -v deno >/dev/null 2>&1
then
    echo "deno not found, installing it"
    curl -fsSL https://deno.land/install.sh | sh -s -- -y
    # so this shell can see it without a restart
    DENO_INSTALL="${DENO_INSTALL:-$HOME/.deno}"
    PATH="$DENO_INSTALL/bin:$PATH"
    export PATH
fi

deno install --global --force --reload --allow-all --name dtk "$DTK_URL"

echo ""
echo "installed: $(command -v dtk || echo dtk)"
echo "if 'dtk' is not found, add deno's bin folder to your PATH:"
echo "    export PATH=\"\$HOME/.deno/bin:\$PATH\""
