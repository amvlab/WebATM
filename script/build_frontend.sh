#!/usr/bin/env bash
#
# Build the WebATM frontend
#
# Compiles the TypeScript sources in frontend/ into JavaScript bundles
# served by the web application (output goes to WebATM/static/dist/).
#
# Pass --integrated to produce the integrated bundle (BlueSky server controls +
# live "Server Log" tab) via `npm run build:integrated`; otherwise the default
# bundle is built and the integrated code is excluded.
#

set -e  # Exit on error

INTEGRATED=0
while [[ $# -gt 0 ]]; do
    case "$1" in
        --integrated|-i)
            INTEGRATED=1
            shift
            ;;
        --help|-h)
            echo "Usage: $0 [--integrated]"
            echo "  --integrated, -i  Build the integrated bundle (server controls + live log tab)"
            echo "  --help, -h        Show this help message"
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

# Get the project root directory (parent of script/)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
FRONTEND_DIR="$PROJECT_ROOT/frontend"

echo "Building frontend assets..."
echo "Project root: $PROJECT_ROOT"
echo "Frontend directory: $FRONTEND_DIR"

# Change to frontend directory
cd "$FRONTEND_DIR"

# Install dependencies if node_modules is missing or stale relative to the lockfile.
# (npm ci wipes node_modules each run, so we skip it when it's already in sync.)
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules ]; then
    echo "Installing dependencies..."
    npm ci
else
    echo "Dependencies up to date, skipping install."
fi

# Build the frontend bundles
if [ "$INTEGRATED" -eq 1 ]; then
    echo "Building frontend (integrated variant)..."
    npm run build:integrated
else
    echo "Building frontend..."
    npm run build
fi

echo "✓ Frontend build complete!"
