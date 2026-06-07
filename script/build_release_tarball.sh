#!/usr/bin/env bash
#
# Build the prebuilt release tarball
#
# Bundles WebATM/static/{vendor,dist} into webatm-prebuilt-<version>.tar.gz
# for attaching to a GitHub release. Entries are prefixed with WebATM/ so the
# archive extracts cleanly at the repo root.
#
# Large/rarely-changing assets (tiles, glyphs, navdata) live in a separate
# assets release built by build_assets_tarball.sh and pinned via .assets-version.
#
# Version is read from pyproject.toml. Optional first argument overrides the
# output directory (default: project root).
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUTPUT_DIR="${1:-$PROJECT_ROOT}"

VERSION="$(grep -E '^version = ' "$PROJECT_ROOT/pyproject.toml" | head -1 | sed -E 's/version = "(.+)"/\1/')"
if [ -z "$VERSION" ]; then
    echo "ERROR: could not read version from pyproject.toml" >&2
    exit 1
fi

ASSETS=(
    "WebATM/static/vendor"
    "WebATM/static/dist"
)

for path in "${ASSETS[@]}"; do
    if [ ! -d "$PROJECT_ROOT/$path" ]; then
        echo "ERROR: missing $path — run script/build_frontend.sh" >&2
        exit 1
    fi
done

mkdir -p "$OUTPUT_DIR"
OUTPUT_FILE="$OUTPUT_DIR/webatm-prebuilt-${VERSION}.tar.gz"

echo "Building release tarball for version $VERSION"
echo "Output: $OUTPUT_FILE"

cd "$PROJECT_ROOT"
tar -czf "$OUTPUT_FILE" "${ASSETS[@]}"

SIZE="$(du -h "$OUTPUT_FILE" | cut -f1)"
echo "✓ Created $OUTPUT_FILE ($SIZE)"
