#!/usr/bin/env bash
# Runs one example against the packed package, as a user would install it.
#
# This script:
# 1. builds the library and packs it with `npm pack` (what npm publish ships);
# 2. copies the example (without node_modules, with its .env) to a temporary
#    directory, so the repository's example stays untouched;
# 3. points the copy's `adk-llm-bridge` dependency at the tarball and runs
#    `npm install`, then shows that there is one `@google/adk`;
# 4. starts the example's DevTools UI (`bun run web`) from the copy.
#
# Usage: ./scripts/test-example.sh [example-name]
# Example: ./scripts/test-example.sh basic-agent-anthropic
# KEEP_EXAMPLE_DIR=1 keeps the temporary directory.

set -euo pipefail

EXAMPLE=${1:-basic-agent-anthropic}
ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
EXAMPLE_DIR="$ROOT_DIR/examples/$EXAMPLE"

if [ ! -f "$EXAMPLE_DIR/package.json" ]; then
  echo "Error: Example '$EXAMPLE' not found at $EXAMPLE_DIR" >&2
  echo "Available examples:" >&2
  ls -1 "$ROOT_DIR/examples" >&2
  exit 1
fi

WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/adk-llm-bridge-example.XXXXXX")
cleanup() {
  if [ "${KEEP_EXAMPLE_DIR:-}" = "1" ]; then
    echo "Kept $WORK_DIR"
  else
    rm -rf "$WORK_DIR"
  fi
}
trap cleanup EXIT

echo "=== Testing example: $EXAMPLE ==="

echo ""
echo "1. Building and packing the library..."
cd "$ROOT_DIR"
bun run build
TARBALL=$(npm pack --silent --pack-destination "$WORK_DIR" | tail -n 1)
TARBALL="$WORK_DIR/$TARBALL"
echo "   Created: $TARBALL"

echo ""
echo "2. Copying the example..."
dest="$WORK_DIR/$EXAMPLE"
mkdir -p "$dest"
(cd "$EXAMPLE_DIR" && tar --exclude=./node_modules -cf - .) | (cd "$dest" && tar -xf -)

echo ""
echo "3. Installing the tarball in the copy..."
cd "$dest"
rm -f bun.lock package-lock.json
npm pkg set "dependencies.adk-llm-bridge=file:$TARBALL"
npm install --no-audit --no-fund --loglevel=error
echo "   Verifying @google/adk is deduped..."
npm ls @google/adk

echo ""
echo "4. Running example..."
echo "   Starting adk-devtools at http://localhost:8000"
echo ""
bun run web
