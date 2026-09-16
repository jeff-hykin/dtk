#!/usr/bin/env sh
# Installs the dtk command. Installs deno first if it is missing.
set -e

REPO="${DTK_REPO:-jeff-hykin/dtk}"
BRANCH="${DTK_BRANCH:-master}"

if ! command -v deno >/dev/null 2>&1
then
    echo "deno not found, installing it"
    curl -fsSL https://deno.land/install.sh | sh -s -- -y
    # so this shell can see it without a restart
    DENO_INSTALL="${DENO_INSTALL:-$HOME/.deno}"
    PATH="$DENO_INSTALL/bin:$PATH"
    export PATH
fi

# Installed from the branch name, every module would come through a url that
# github's cdn caches for a few minutes, so a fresh install can end up a mix of
# old and new files -- and deno then caches that mix forever. A commit sha is
# immutable, so the whole install is one consistent snapshot, and re-running
# this script is what moves it forward.
SHA=$(curl -fsSL "https://api.github.com/repos/$REPO/commits/$BRANCH" \
      | sed -n 's/^  *"sha": "\([0-9a-f]\{40\}\)".*/\1/p' \
      | head -1)
if [ -z "$SHA" ]
then
    echo "could not resolve $REPO@$BRANCH, falling back to the branch itself" >&2
    SHA="$BRANCH"
fi

deno install --global --force --reload --allow-all --name dtk \
    "https://raw.githubusercontent.com/$REPO/$SHA/main.js"

echo ""
echo "installed dtk at $SHA"
echo "  $(command -v dtk || echo dtk)"
echo "if 'dtk' is not found, add deno's bin folder to your PATH:"
echo "    export PATH=\"\$HOME/.deno/bin:\$PATH\""
