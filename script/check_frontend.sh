#!/usr/bin/env bash
#
# Run the frontend checks: type-check, lint, and unit tests.
# Mirrors the GitHub Actions CI workflow (minus the production build).
#

set -e  # Exit on error

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

echo "✓ All frontend checks passed"
