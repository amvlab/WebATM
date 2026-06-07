#!/usr/bin/env bash
#
# Build the WebATM navdata vector-tile archive from X-Plane data.
#
# Pipeline:
#   apt.dat / earth_fix.dat  --(parse_xplane.py)-->  *.geojson + navdata.sqlite
#   *.geojson                --(tippecanoe)------->  per-layer .pmtiles
#   per-layer .pmtiles       --(tile-join)-------->  navdata.pmtiles
#
# The final archive contains two source-layers ("airports", "waypoints") with
# independent zoom ranges, so waypoints (there are ~hundreds of thousands of
# them globally) are only generated from a mid zoom upward and never bloat the
# low-zoom tiles. It is copied to WebATM/static/tiles/ where the frontend reads
# it via the already-registered pmtiles:// protocol. The SQLite index is copied
# to WebATM/static/navdata/ for the /api/navdata/search endpoint.
#
# Requirements (build machine only - not needed at runtime):
#   * python3            (>= 3.9, stdlib only)
#   * tippecanoe + tile-join   https://github.com/felt/tippecanoe
#
# Usage:
#   ./build_navdata_tiles.sh --apt /path/to/apt.dat --fix /path/to/earth_fix.dat
#
# Optional, for class-based airport importance (recommended):
#   --download-ourairports          fetch OurAirports airports.csv (public
#                                   domain) and use airport class as the
#                                   importance signal
#   --ourairports /path/to/airports.csv   use a local copy instead
#
set -euo pipefail

# --- defaults ------------------------------------------------------------
APT=""
FIX=""
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
BUILD_DIR="${SCRIPT_DIR}/build"
TILES_OUT="${REPO_ROOT}/WebATM/static/tiles"
INDEX_OUT="${REPO_ROOT}/WebATM/static/navdata"

# Zoom ranges. Airports stay visible when zoomed out; waypoints only get
# generated from AIRPORT? no - from WPT_MINZOOM up to keep the archive small.
APT_MINZOOM=2
HEL_MINZOOM=7
WPT_MINZOOM=6
RWY_MINZOOM=10
PAVE_MINZOOM=11
MAXZOOM=14

# Airport density is thinned per-feature, not by tippecanoe: parse_xplane.py
# bakes a density-aware, rank-prioritised tippecanoe.minzoom into each airport
# (see assign_airport_minzooms / DECLUTTER_SPACING_PX there). Tune the airport
# decluttering in that script, then re-tile.

# OurAirports class data (optional). When provided, airport class drives
# importance instead of runway length. --download-ourairports fetches it.
OA_FILE=""
DOWNLOAD_OA=false
OURAIRPORTS_URL="https://davidmegginson.github.io/ourairports-data/airports.csv"

usage() {
    grep '^#' "$0" | sed 's/^# \{0,1\}//'
    exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --apt) APT="$2"; shift 2 ;;
        --fix) FIX="$2"; shift 2 ;;
        --apt-minzoom) APT_MINZOOM="$2"; shift 2 ;;
        --hel-minzoom) HEL_MINZOOM="$2"; shift 2 ;;
        --wpt-minzoom) WPT_MINZOOM="$2"; shift 2 ;;
        --rwy-minzoom) RWY_MINZOOM="$2"; shift 2 ;;
        --pave-minzoom) PAVE_MINZOOM="$2"; shift 2 ;;
        --maxzoom) MAXZOOM="$2"; shift 2 ;;
        --ourairports) OA_FILE="$2"; shift 2 ;;
        --download-ourairports) DOWNLOAD_OA=true; shift ;;
        -h|--help) usage 0 ;;
        *) echo "unknown argument: $1" >&2; usage 1 ;;
    esac
done

if [[ -z "${APT}" && -z "${FIX}" ]]; then
    echo "error: provide at least one of --apt or --fix" >&2
    usage 1
fi

for tool in tippecanoe tile-join python3; do
    if ! command -v "${tool}" >/dev/null 2>&1; then
        echo "error: required tool not found on PATH: ${tool}" >&2
        echo "       install tippecanoe (provides tippecanoe + tile-join):" >&2
        echo "       https://github.com/felt/tippecanoe" >&2
        exit 1
    fi
done

mkdir -p "${BUILD_DIR}" "${TILES_OUT}" "${INDEX_OUT}"

# --- 0. fetch OurAirports class data (optional) --------------------------
if [[ "${DOWNLOAD_OA}" == true ]]; then
    if ! command -v curl >/dev/null 2>&1; then
        echo "error: curl is required for --download-ourairports" >&2
        exit 1
    fi
    OA_FILE="${BUILD_DIR}/airports.csv"
    echo ">> downloading OurAirports data (${OURAIRPORTS_URL})..."
    curl -fSL --retry 3 -o "${OA_FILE}" "${OURAIRPORTS_URL}"
fi

# --- 1. parse .dat -> geojson + sqlite -----------------------------------
PARSE_ARGS=(--out-dir "${BUILD_DIR}")
[[ -n "${APT}" ]] && PARSE_ARGS+=(--apt "${APT}")
[[ -n "${FIX}" ]] && PARSE_ARGS+=(--fix "${FIX}")
[[ -n "${OA_FILE}" ]] && PARSE_ARGS+=(--ourairports "${OA_FILE}")
echo ">> parsing X-Plane data..."
python3 "${SCRIPT_DIR}/parse_xplane.py" "${PARSE_ARGS[@]}"

# --- 2. geojson -> per-layer pmtiles -------------------------------------
JOIN_INPUTS=()

if [[ -n "${APT}" ]]; then
    echo ">> tiling airports (z${APT_MINZOOM}-${MAXZOOM})..."
    # Each airport already carries a density-aware tippecanoe.minzoom baked in by
    # parse_xplane.py, which decides exactly when it appears (rank-prioritised, so
    # a major hub like EHAM is never dropped while a minor neighbour shows).
    # --drop-rate=1 disables tippecanoe's own geographic dot-dropping so that
    # baked minzoom is the sole, deterministic thinning - tippecanoe must not
    # second-guess it. (Earlier attempts here failed: tippecanoe's dot-dropping
    # is geographic, blind to rank, and the felt-only --order-* flags don't exist
    # in mapbox/tippecanoe.)
    tippecanoe \
        --force \
        --output "${BUILD_DIR}/airports.pmtiles" \
        --layer airports \
        --minimum-zoom="${APT_MINZOOM}" \
        --maximum-zoom="${MAXZOOM}" \
        --full-detail=10 \
        --drop-rate=1 \
        --no-feature-limit \
        --no-tile-size-limit \
        "${BUILD_DIR}/airports.geojson"
    JOIN_INPUTS+=("${BUILD_DIR}/airports.pmtiles")

    # Heliports (their own layer + symbol in the client).
    if [[ -s "${BUILD_DIR}/heliports.geojson" ]]; then
        echo ">> tiling heliports (z${HEL_MINZOOM}-${MAXZOOM})..."
        tippecanoe \
            --force \
            --output "${BUILD_DIR}/heliports.pmtiles" \
            --layer heliports \
            --minimum-zoom="${HEL_MINZOOM}" \
            --maximum-zoom="${MAXZOOM}" \
            --full-detail=10 \
            --no-feature-limit \
            --no-tile-size-limit \
            --drop-densest-as-needed \
            "${BUILD_DIR}/heliports.geojson"
        JOIN_INPUTS+=("${BUILD_DIR}/heliports.pmtiles")
    fi

    # Runways come from the same apt.dat parse. They are polygons that only
    # matter once zoomed into an airport, so they start at a higher zoom.
    if [[ -s "${BUILD_DIR}/runways.geojson" ]]; then
        echo ">> tiling runways (z${RWY_MINZOOM}-${MAXZOOM})..."
        tippecanoe \
            --force \
            --output "${BUILD_DIR}/runways.pmtiles" \
            --layer runways \
            --minimum-zoom="${RWY_MINZOOM}" \
            --maximum-zoom="${MAXZOOM}" \
            --full-detail=12 \
            --no-feature-limit \
            --no-tile-size-limit \
            "${BUILD_DIR}/runways.geojson"
        JOIN_INPUTS+=("${BUILD_DIR}/runways.pmtiles")
    fi

    # Taxiways + aprons (apt.dat row 110). These are the bulk of the data, so
    # they start at a high zoom and are only worth drawing close in.
    if [[ -s "${BUILD_DIR}/pavement.geojson" ]]; then
        echo ">> tiling pavement / taxiways (z${PAVE_MINZOOM}-${MAXZOOM})..."
        tippecanoe \
            --force \
            --output "${BUILD_DIR}/pavement.pmtiles" \
            --layer pavement \
            --minimum-zoom="${PAVE_MINZOOM}" \
            --maximum-zoom="${MAXZOOM}" \
            --full-detail=12 \
            --no-feature-limit \
            --no-tile-size-limit \
            --coalesce-densest-as-needed \
            "${BUILD_DIR}/pavement.geojson"
        JOIN_INPUTS+=("${BUILD_DIR}/pavement.pmtiles")
    fi
fi

if [[ -n "${FIX}" ]]; then
    echo ">> tiling waypoints (z${WPT_MINZOOM}-${MAXZOOM})..."
    tippecanoe \
        --force \
        --output "${BUILD_DIR}/waypoints.pmtiles" \
        --layer waypoints \
        --minimum-zoom="${WPT_MINZOOM}" \
        --maximum-zoom="${MAXZOOM}" \
        --full-detail=10 \
        --no-feature-limit \
        --no-tile-size-limit \
        --drop-densest-as-needed \
        "${BUILD_DIR}/waypoints.geojson"
    JOIN_INPUTS+=("${BUILD_DIR}/waypoints.pmtiles")
fi

# --- 3. join into a single archive ---------------------------------------
echo ">> joining into navdata.pmtiles..."
tile-join \
    --force \
    --no-tile-size-limit \
    --output "${TILES_OUT}/navdata.pmtiles" \
    "${JOIN_INPUTS[@]}"

# --- 4. publish the search index -----------------------------------------
if [[ -f "${BUILD_DIR}/navdata.sqlite" ]]; then
    cp "${BUILD_DIR}/navdata.sqlite" "${INDEX_OUT}/navdata.sqlite"
fi

echo ""
echo "done:"
echo "  tiles  -> ${TILES_OUT}/navdata.pmtiles"
echo "  search -> ${INDEX_OUT}/navdata.sqlite"
echo ""
echo "Both are gitignored by default (large/binary). Deploy them alongside the app."
