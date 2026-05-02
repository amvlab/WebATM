#!/usr/bin/env bash
#
# Build the WebATM frontend
#
# Compiles the TypeScript sources in frontend/ into JavaScript bundles
# served by the web application (output goes to WebATM/static/dist/).
#

set -e  # Exit on error

# Get the project root directory (parent of script/)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
FRONTEND_DIR="$PROJECT_ROOT/frontend"

echo "Building frontend assets..."
echo "Project root: $PROJECT_ROOT"
echo "Frontend directory: $FRONTEND_DIR"

# Change to frontend directory
cd "$FRONTEND_DIR"

# Install dependencies
echo "Installing dependencies..."
npm ci

# Build the frontend bundles
echo "Building frontend..."
npm run build

echo "✓ Frontend build complete!"
