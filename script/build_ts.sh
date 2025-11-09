#!/usr/bin/env bash
#
# Build TypeScript assets for WebATM
#
# This script compiles the TypeScript source code into JavaScript bundles
# that are served by the web application.
#

set -e  # Exit on error

# Get the project root directory (parent of script/)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TS_DIR="$PROJECT_ROOT/WebATM/static/ts"

echo "Building TypeScript assets..."
echo "Project root: $PROJECT_ROOT"
echo "TypeScript directory: $TS_DIR"

# Change to TypeScript directory
cd "$TS_DIR"

# Install dependencies
echo "Installing dependencies..."
npm ci

# Build TypeScript
echo "Building TypeScript..."
npm run build:production

echo "✓ TypeScript build complete!"
