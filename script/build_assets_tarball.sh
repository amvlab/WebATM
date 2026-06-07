#!/usr/bin/env bash
#
# Build the static-assets release tarball
#
# Bundles WebATM/static/{tiles,glyphs,navdata} into webatm-assets-<tag>.tar.gz
# for attaching to a separate "assets" GitHub release. These directories change
# rarely (offline tiles, fonts, navdata cycles), so they're decoupled from the
# per-version code tarball produced by build_release_tarball.sh.
#
# The tag is read from .assets-version at the repo root. To cut a new assets
# release, bump that file (e.g. assets-v1 -> assets-v2), run this script, and
# `gh release create <tag> webatm-assets-<tag>.tar.gz`.
#
# Optional first argument overrides the output directory (default: project root).
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUTPUT_DIR="${1:-$PROJECT_ROOT}"

VERSION_FILE="$PROJECT_ROOT/.assets-version"
if [ ! -f "$VERSION_FILE" ]; then
    echo "ERROR: $VERSION_FILE not found" >&2
    exit 1
fi
TAG="$(tr -d '[:space:]' < "$VERSION_FILE")"
if [ -z "$TAG" ]; then
    echo "ERROR: $VERSION_FILE is empty" >&2
    exit 1
fi

ASSETS=(
    "WebATM/static/tiles"
    "WebATM/static/glyphs"
    "WebATM/static/navdata"
)

for path in "${ASSETS[@]}"; do
    if [ ! -d "$PROJECT_ROOT/$path" ]; then
        echo "ERROR: missing $path" >&2
        exit 1
    fi
done

mkdir -p "$OUTPUT_DIR"
OUTPUT_FILE="$OUTPUT_DIR/webatm-${TAG}.tar.gz"

echo "Building assets tarball for $TAG"
echo "Output: $OUTPUT_FILE"

cd "$PROJECT_ROOT"
tar -czf "$OUTPUT_FILE" "${ASSETS[@]}"

SIZE="$(du -h "$OUTPUT_FILE" | cut -f1)"
echo "✓ Created $OUTPUT_FILE ($SIZE)"
