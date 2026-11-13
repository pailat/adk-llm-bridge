#!/usr/bin/env bash
# Checks every example against the packed package, before it is on npm.
#
# The examples are standalone projects that depend on the published
# `adk-llm-bridge`. For each one this script:
# 1. copies the example (without node_modules) to a temporary directory, so
#    nothing resolves from the repository's own node_modules;
# 2. points its `adk-llm-bridge` dependency at the tarball made by `npm pack`
#    (in the copy only, never in the repository) and runs `npm install`;
# 3. type checks it with its own `tsc --noEmit`;
# 4. bundles its entry files with `bun build`, so every runtime import resolves;
# 5. with --audit, runs `npm audit --audit-level=high` on its dependencies.
#
# Usage: scripts/check-examples.sh [--no-build] [--audit] [example ...]
#   --no-build  reuse the current dist/ instead of running `bun run build`
#   --audit     fail on high or critical advisories in an example's dependencies
# With no example names, every directory under examples/ is checked.
# KEEP_EXAMPLES_DIR=1 keeps the temporary directory for inspection.

set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
BUILD=1
AUDIT=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --no-build) BUILD=0 ;;
    --audit) AUDIT=1 ;;
    *) break ;;
  esac
  shift
done

if [ "$#" -gt 0 ]; then
  EXAMPLES=("$@")
else
  EXAMPLES=()
  for dir in "$ROOT_DIR"/examples/*/; do
    EXAMPLES+=("$(basename "$dir")")
  done
fi

WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/adk-llm-bridge-examples.XXXXXX")
cleanup() {
  if [ "${KEEP_EXAMPLES_DIR:-}" = "1" ]; then
    echo "Kept $WORK_DIR"
  else
    rm -rf "$WORK_DIR"
  fi
}
trap cleanup EXIT

cd "$ROOT_DIR"
if [ "$BUILD" = "1" ]; then
  bun run build
fi
TARBALL=$(npm pack --silent --pack-destination "$WORK_DIR" | tail -n 1)
TARBALL="$WORK_DIR/$TARBALL"
echo "Packed $TARBALL"
# shellcheck disable=SC2207
OPTIONAL_PEERS=($(node -p "Object.entries(require('./package.json').peerDependenciesMeta ?? {}).filter(([, meta]) => meta.optional).map(([name]) => name).join(' ')"))

failed=()
for name in "${EXAMPLES[@]}"; do
  src="$ROOT_DIR/examples/$name"
  if [ ! -f "$src/package.json" ]; then
    echo "No example named $name" >&2
    exit 2
  fi
  echo ""
  echo "=== $name ==="
  dest="$WORK_DIR/examples/$name"
  mkdir -p "$dest"
  (cd "$src" && tar --exclude=./node_modules -cf - .) | (cd "$dest" && tar -xf -)
  # A plain subshell, not an `if` condition, so `set -e` stops at the first
  # failing command.
  set +e
  (
    set -e
    cd "$dest"
    npm pkg set "dependencies.adk-llm-bridge=file:$TARBALL"
    npm install --no-audit --no-fund --loglevel=error
    resolved=$(node -p "require('./node_modules/adk-llm-bridge/package.json').version")
    echo "adk-llm-bridge $resolved installed from the tarball"
    npm ls @google/adk
    npm run --silent typecheck
    entries=()
    for file in *.ts src/*.ts; do
      [ -f "$file" ] && entries+=("$file")
    done
    # The bridge loads its optional peers (agent SDKs, QuickJS) only when they
    # are used; an example that does not install one keeps it external.
    externals=()
    for peer in "${OPTIONAL_PEERS[@]}"; do
      [ -d "node_modules/$peer" ] || externals+=(--external "$peer")
    done
    bun build "${entries[@]}" --target=bun ${externals[@]+"${externals[@]}"} \
      --outdir "$WORK_DIR/build/$name" >/dev/null
    echo "built ${#entries[@]} entry file(s): ${entries[*]}"
    if [ "$AUDIT" = "1" ]; then
      npm audit --audit-level=high
    fi
  )
  status=$?
  set -e
  if [ "$status" -ne 0 ]; then
    failed+=("$name")
  fi
done

echo ""
if [ "${#failed[@]}" -gt 0 ]; then
  echo "Examples that failed: ${failed[*]}" >&2
  exit 1
fi
echo "All ${#EXAMPLES[@]} examples installed the packed package, type checked and built."
