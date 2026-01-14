#!/bin/bash
# Test an example with npm pack to simulate production install
#
# This script:
# 1. Builds the library
# 2. Creates a tarball with npm pack (simulates npm publish)
# 3. Installs the tarball in the example (uses peerDependencies correctly)
# 4. Runs the example with adk-devtools
#
# Usage: ./scripts/test-example.sh [example-name]
# Example: ./scripts/test-example.sh basic-agent-anthropic

set -e

EXAMPLE=${1:-basic-agent-anthropic}
ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
EXAMPLE_DIR="$ROOT_DIR/examples/$EXAMPLE"

# Check if example exists
if [ ! -d "$EXAMPLE_DIR" ]; then
  echo "Error: Example '$EXAMPLE' not found at $EXAMPLE_DIR"
  echo "Available examples:"
  ls -1 "$ROOT_DIR/examples"
  exit 1
fi

echo "=== Testing example: $EXAMPLE ==="

# 1. Build the library
echo ""
echo "1. Building library..."
cd "$ROOT_DIR"
bun run build

# 2. Create tarball with npm pack
echo ""
echo "2. Creating tarball with npm pack..."
rm -f adk-llm-bridge-*.tgz
npm pack

# Get the tarball name
TARBALL=$(ls adk-llm-bridge-*.tgz)
echo "   Created: $TARBALL"

# 3. Install in example
echo ""
echo "3. Installing in example..."
cd "$EXAMPLE_DIR"

# Clean up previous install
rm -rf node_modules bun.lock package-lock.json

# Install the tarball (use npm to properly resolve peerDependencies)
npm install "$ROOT_DIR/$TARBALL"

# Verify deduplication
echo ""
echo "   Verifying @google/adk is deduped..."
npm ls @google/adk

# 4. Run the example
echo ""
echo "4. Running example..."
echo "   Starting adk-devtools at http://localhost:8000"
echo ""
bun run web
