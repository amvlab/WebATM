#!/usr/bin/env bash
#
# Run the frontend checks: type-check, lint, and unit tests.
# Mirrors the GitHub Actions CI workflow (minus the production build).
#
# Pass --integrated to additionally verify the integrated bundle compiles
# (npm run build:integrated) after the checks. The type-check, lint, and tests
# already cover the integrated sources either way.
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
            echo "  --integrated, -i  Also build the integrated bundle as a compile check"
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

echo "Checking frontend..."
echo "Frontend directory: $FRONTEND_DIR"

cd "$FRONTEND_DIR"

# Install dependencies if node_modules is missing or stale relative to the lockfile.
# (npm ci wipes node_modules each run, so we skip it when it's already in sync.)
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules ]; then
    echo "Installing dependencies..."
    npm ci
else
    echo "Dependencies up to date, skipping install."
fi

echo "Type-checking..."
npm run type-check

echo "Linting..."
npm run lint

echo "Running tests..."
npm test

if [ "$INTEGRATED" -eq 1 ]; then
    echo "Building integrated bundle (compile check)..."
    npm run build:integrated
fi

echo "✓ All frontend checks passed"
