#!/usr/bin/env bash
#
# Build the WebATM navdata vector-tile archive from OurAirports open data.
#
# Pipeline:
#   airports/runways/navaids.csv  --(parse_ourairports.py)-->  *.geojson + navdata.sqlite
#   *.geojson                     --(tippecanoe)---------->  per-layer .pmtiles
#   per-layer .pmtiles            --(tile-join)----------->  navdata.pmtiles
#
# The final archive contains the source-layers "airports", "heliports",
# "waypoints" (radio navaids) and "runways", each with an independent zoom
# range - plus "pavement" (aprons), "taxiways" and "buildings" (terminals /
# hangars) when an OpenStreetMap extract is supplied. It is copied to WebATM/static/tiles/ where the frontend
# reads it via the already-registered pmtiles:// protocol. The SQLite index is
# copied to WebATM/static/navdata/ for the /api/navdata/search endpoint.
#
# The primary source data is the public-domain OurAirports dataset
# (https://ourairports.com/data/) - no licensing constraints, and the CSVs are
# small enough to download as part of the build (the default). OurAirports has
# no taxiway/apron geometry, so that (optional) layer comes from OpenStreetMap
# (ODbL, (c) OpenStreetMap contributors): pass --osm-pbf with any .osm.pbf
# extract covering your area of interest (a Geofabrik regional extract, or the
# full planet) and the aeroway=apron/taxiway features are pulled out of it.
#
# Requirements (build machine only - not needed at runtime):
#   * python3            (>= 3.9, stdlib only)
#   * tippecanoe + tile-join   https://github.com/felt/tippecanoe
#   * curl               (only when downloading the CSVs)
#   * osmium             (only with --osm-pbf)  https://osmcode.org/osmium-tool/
#
# Usage:
#   ./build_navdata_tiles.sh                  # downloads the OurAirports CSVs
#   ./build_navdata_tiles.sh --airports /path/to/airports.csv \
#                            --runways /path/to/runways.csv \
#                            --navaids /path/to/navaids.csv
#
#   # with OSM taxiways/aprons (e.g. a Geofabrik extract):
#   ./build_navdata_tiles.sh --osm-pbf /path/to/netherlands-latest.osm.pbf
#
set -euo pipefail

# --- defaults ------------------------------------------------------------
AIRPORTS=""
RUNWAYS=""
NAVAIDS=""
OSM_PBF=""
OSM_AEROWAYS=""
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
BUILD_DIR="${SCRIPT_DIR}/build"
TILES_OUT="${REPO_ROOT}/WebATM/static/tiles"
INDEX_OUT="${REPO_ROOT}/WebATM/static/navdata"

# OurAirports publishes daily CSV snapshots at this mirror (public domain).
OURAIRPORTS_BASE_URL="https://davidmegginson.github.io/ourairports-data"

# Zoom ranges. Airports stay visible when zoomed out; waypoints (navaids) and
# runways only get generated from a mid/high zoom upward to keep the archive
# small.
APT_MINZOOM=2
HEL_MINZOOM=7
WPT_MINZOOM=6
RWY_MINZOOM=10
PAVE_MINZOOM=11
MAXZOOM=14

# Airport density is thinned per-feature, not by tippecanoe:
# parse_ourairports.py bakes a density-aware, rank-prioritised
# tippecanoe.minzoom into each airport (see assign_airport_minzooms /
# DECLUTTER_SPACING_PX there). Tune the airport decluttering in that script,
# then re-tile.

usage() {
    grep '^#' "$0" | sed 's/^# \{0,1\}//'
    exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --airports) AIRPORTS="$2"; shift 2 ;;
        --runways) RUNWAYS="$2"; shift 2 ;;
        --navaids) NAVAIDS="$2"; shift 2 ;;
        --osm-pbf) OSM_PBF="$2"; shift 2 ;;
        --osm-aeroways) OSM_AEROWAYS="$2"; shift 2 ;;
        --apt-minzoom) APT_MINZOOM="$2"; shift 2 ;;
        --hel-minzoom) HEL_MINZOOM="$2"; shift 2 ;;
        --wpt-minzoom) WPT_MINZOOM="$2"; shift 2 ;;
        --rwy-minzoom) RWY_MINZOOM="$2"; shift 2 ;;
        --pave-minzoom) PAVE_MINZOOM="$2"; shift 2 ;;
        --maxzoom) MAXZOOM="$2"; shift 2 ;;
        -h|--help) usage 0 ;;
        *) echo "unknown argument: $1" >&2; usage 1 ;;
    esac
done

for tool in tippecanoe tile-join python3; do
    if ! command -v "${tool}" >/dev/null 2>&1; then
        echo "error: required tool not found on PATH: ${tool}" >&2
        echo "       install tippecanoe (provides tippecanoe + tile-join):" >&2
        echo "       https://github.com/felt/tippecanoe" >&2
        exit 1
    fi
done

if [[ -n "${OSM_PBF}" ]] && ! command -v osmium >/dev/null 2>&1; then
    echo "error: --osm-pbf requires osmium on PATH" >&2
    echo "       https://osmcode.org/osmium-tool/" >&2
    exit 1
fi

mkdir -p "${BUILD_DIR}" "${TILES_OUT}" "${INDEX_OUT}"

# --- 0. fetch any OurAirports CSV not supplied locally --------------------
fetch() {
    local name="$1"
    if ! command -v curl >/dev/null 2>&1; then
        echo "error: curl is required to download ${name} (or pass a local copy)" >&2
        exit 1
    fi
    local dest="${BUILD_DIR}/${name}"
    # This function's stdout is captured by the caller, so progress goes to
    # stderr (curl's meter already does).
    echo ">> downloading OurAirports ${name} (${OURAIRPORTS_BASE_URL}/${name})..." >&2
    curl -fSL --retry 3 -o "${dest}" "${OURAIRPORTS_BASE_URL}/${name}"
    printf '%s' "${dest}"
}

[[ -z "${AIRPORTS}" ]] && AIRPORTS="$(fetch airports.csv)"
[[ -z "${RUNWAYS}" ]] && RUNWAYS="$(fetch runways.csv)"
[[ -z "${NAVAIDS}" ]] && NAVAIDS="$(fetch navaids.csv)"

# --- 1. csv -> geojson + sqlite -------------------------------------------
echo ">> parsing OurAirports data..."
python3 "${SCRIPT_DIR}/parse_ourairports.py" \
    --airports "${AIRPORTS}" \
    --runways "${RUNWAYS}" \
    --navaids "${NAVAIDS}" \
    --out-dir "${BUILD_DIR}"

# --- 1b. OSM taxiways/aprons (optional) -----------------------------------
# OurAirports has no taxiway/apron geometry; OpenStreetMap does
# (aeroway=apron polygons + aeroway=taxiway centrelines, ODbL). From a .pbf we
# filter just those features (with their nodes) and export them as GeoJSONSeq;
# parse_osm_aeroways.py then splits them into the pavement/taxiways layers.
if [[ -n "${OSM_PBF}" ]]; then
    echo ">> extracting aeroways from ${OSM_PBF} (osmium)..."
    osmium tags-filter --overwrite \
        -o "${BUILD_DIR}/aeroways.osm.pbf" \
        "${OSM_PBF}" wr/aeroway=apron,taxiway,terminal,hangar
    osmium export --overwrite \
        -f geojsonseq \
        -o "${BUILD_DIR}/aeroways.geojsonseq" \
        "${BUILD_DIR}/aeroways.osm.pbf"
    OSM_AEROWAYS="${BUILD_DIR}/aeroways.geojsonseq"
fi
if [[ -n "${OSM_AEROWAYS}" ]]; then
    echo ">> splitting OSM aeroways into pavement / taxiway / building layers..."
    python3 "${SCRIPT_DIR}/parse_osm_aeroways.py" \
        "${OSM_AEROWAYS}" --out-dir "${BUILD_DIR}"
fi

# --- 2. geojson -> per-layer pmtiles -------------------------------------
JOIN_INPUTS=()

echo ">> tiling airports (z${APT_MINZOOM}-${MAXZOOM})..."
# Each airport already carries a density-aware tippecanoe.minzoom baked in by
# parse_ourairports.py, which decides exactly when it appears (rank-prioritised,
# so a major hub like EHAM is never dropped while a minor neighbour shows).
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

# Runways are polygons that only matter once zoomed into an airport, so they
# start at a higher zoom.
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

# Taxiways + aprons from OSM (optional). These only matter close in, so they
# start at a high zoom to keep the archive sane.
if [[ -n "${OSM_AEROWAYS}" && -s "${BUILD_DIR}/pavement.geojson" ]]; then
    echo ">> tiling pavement / aprons (z${PAVE_MINZOOM}-${MAXZOOM})..."
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

if [[ -n "${OSM_AEROWAYS}" && -s "${BUILD_DIR}/buildings.geojson" ]]; then
    echo ">> tiling terminals / hangars (z${PAVE_MINZOOM}-${MAXZOOM})..."
    tippecanoe \
        --force \
        --output "${BUILD_DIR}/buildings.pmtiles" \
        --layer buildings \
        --minimum-zoom="${PAVE_MINZOOM}" \
        --maximum-zoom="${MAXZOOM}" \
        --full-detail=12 \
        --no-feature-limit \
        --no-tile-size-limit \
        --coalesce-densest-as-needed \
        "${BUILD_DIR}/buildings.geojson"
    JOIN_INPUTS+=("${BUILD_DIR}/buildings.pmtiles")
fi

if [[ -n "${OSM_AEROWAYS}" && -s "${BUILD_DIR}/taxiways.geojson" ]]; then
    echo ">> tiling taxiway centrelines (z${PAVE_MINZOOM}-${MAXZOOM})..."
    tippecanoe \
        --force \
        --output "${BUILD_DIR}/taxiways.pmtiles" \
        --layer taxiways \
        --minimum-zoom="${PAVE_MINZOOM}" \
        --maximum-zoom="${MAXZOOM}" \
        --full-detail=12 \
        --no-feature-limit \
        --no-tile-size-limit \
        --coalesce-densest-as-needed \
        "${BUILD_DIR}/taxiways.geojson"
    JOIN_INPUTS+=("${BUILD_DIR}/taxiways.pmtiles")
fi

# Radio navaids fill the "waypoints" layer.
if [[ -s "${BUILD_DIR}/waypoints.geojson" ]]; then
    echo ">> tiling waypoints/navaids (z${WPT_MINZOOM}-${MAXZOOM})..."
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
