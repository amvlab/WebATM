# script/

Utility scripts for building, checking, running and releasing WebATM.

## Inventory

| Script | What it does |
| --- | --- |
| `run_webatm.sh` | Start the dev server (`python WebATM.py`) from the repo root. |
| `wsgi.py` | Gunicorn entry point; used by the Docker image and any production deploy. |
| `build_frontend.sh` | Production webpack build of `frontend/` → `WebATM/static/dist/` + vendored assets. Re-runs `npm ci` only when `package-lock.json` is newer than `node_modules/`. |
| `check_frontend.sh` | Mirror of the GitHub Actions frontend job: type-check, lint, unit tests. Shares the conditional-install guard. |
| `build_docker.sh` | Build the WebATM image locally (`webatm:latest`). |
| `build_release_tarball.sh` | Bundle `WebATM/static/{vendor,dist}` into `webatm-prebuilt-<version>.tar.gz` for a per-version GitHub release. Version comes from `pyproject.toml`. |
| `build_assets_tarball.sh` | Bundle `WebATM/static/{tiles,glyphs,navdata}` into `webatm-assets-<tag>.tar.gz` for the long-lived **assets** release. Tag comes from `.assets-version` at the repo root. |
| `build_navdata_tiles.sh` | End-to-end navdata pipeline (see [below](#navdata-pipeline)). |
| `parse_xplane.py` | The X-Plane → GeoJSON parser invoked by the navdata pipeline; runnable on its own. |
| `build/` | Output dir for the navdata pipeline (gitignored intermediates + `.pmtiles`). Created on demand. |

## Common tasks

```bash
# Start the dev server
./run_webatm.sh

# Build the frontend bundle (skips install when up to date)
./build_frontend.sh

# Run the frontend checks (type-check + lint + tests)
./check_frontend.sh

# Build the Docker image locally
./build_docker.sh
```

## Release tarballs

WebATM ships two GitHub releases that the runtime depends on, kept on **separate
cadences**:

- **Per-version code release** (rebuilt each version bump). Contains the webpack
  bundle and vendored CSS/fonts.
  ```bash
  ./build_release_tarball.sh           # → webatm-prebuilt-<version>.tar.gz
  ```
- **Assets release** (rebuilt rarely — when tiles, glyphs or navdata change).
  Pinned via `.assets-version` at the repo root; the Docker publish workflow
  reads that file to hydrate static assets before building the image.
  ```bash
  ./build_assets_tarball.sh            # → webatm-assets-<tag>.tar.gz
  # bump .assets-version, then:
  # gh release create <tag> webatm-assets-<tag>.tar.gz
  ```

## Navdata pipeline

Builds the airport / heliport / waypoint / runway overlay that WebATM renders
on the map, from X-Plane navigation data. This is an **offline** build step —
its outputs are served at runtime but the pipeline itself is never run by the
app.

```
apt.dat / earth_fix.dat
        │  parse_xplane.py
        ▼
airports.geojson  waypoints.geojson  navdata.sqlite
        │  tippecanoe + tile-join              │
        ▼                                      ▼
WebATM/static/tiles/navdata.pmtiles    WebATM/static/navdata/navdata.sqlite
   (vector tiles, rendered via            (search index, used by
    the pmtiles:// protocol)               /api/navdata/search)
```

### What you need

1. **The X-Plane data files** — `apt.dat` and `earth_fix.dat`. Get them from
   an X-Plane install (incl. the free demo):
   - `apt.dat`: `…/X-Plane 12/Global Scenery/Global Airports/Earth nav data/apt.dat`
   - `earth_fix.dat`: `…/X-Plane 12/Resources/default data/earth_fix.dat`

   These are released by Laminar Research under the **GNU GPL**. You may use and
   redistribute them, but **must preserve the copyright header** at the top of
   each file. Do **not** use Navigraph/Aerosoft subscription data here — that is
   proprietary and not redistributable.

2. **tippecanoe** (provides both `tippecanoe` and `tile-join`):
   <https://github.com/felt/tippecanoe>. `python3` (3.9+, stdlib only) is the
   only other requirement.

### Build

```bash
cd script/
./build_navdata_tiles.sh \
    --apt "/path/to/apt.dat" \
    --fix "/path/to/earth_fix.dat"
```

Outputs:
- `WebATM/static/tiles/navdata.pmtiles` — the vector-tile archive.
- `WebATM/static/navdata/navdata.sqlite` — the search index.

Both are **gitignored** (large/binary). Deploy them alongside the app — the same
way `world.pmtiles` is handled (see the note in the repo `.gitignore`).

You can also run the parser on its own (e.g. to inspect the GeoJSON or to skip
tiling):

```bash
python3 parse_xplane.py --apt /path/to/apt.dat --fix /path/to/earth_fix.dat --out-dir ./build
```

### Tuning

`build_navdata_tiles.sh` flags:
- `--apt-minzoom N`  (default 2)  — lowest zoom airports are tiled at.
- `--wpt-minzoom N`  (default 6)  — lowest zoom waypoints are tiled at; keeps the
  ~hundreds of thousands of global fixes out of low-zoom tiles.
- `--maxzoom N`      (default 12).

- `--rwy-minzoom N`  (default 10) — lowest zoom runways are tiled at; they are
  small polygons only worth drawing once zoomed into an airport.
- `--pave-minzoom N` (default 11) — lowest zoom taxiways/aprons are tiled at.
  These are the bulk of `apt.dat`, so the higher floor keeps the archive sane.

The vector-tile **source-layers** are named `airports`, `heliports`,
`waypoints`, `runways`, and `pavement`; these names are referenced in
`frontend/src/ui/map/navdata/NavdataRenderer.ts`. If you rename them here,
update the renderer too. Runways, taxiways and aprons all come from the same
`apt.dat` parse:
- a runway becomes a paved-rectangle polygon from its two thresholds + width,
  plus a `textrot` property so the designator label reads along the strip;
- each airport carries an importance `rank` (0-5). The **map style** (not the
  tiles) gates airports by `rank` per zoom, so important airports appear when
  zoomed far out and minor ones only when zoomed in - thresholds are tunable
  without rebuilding the tiles (see `importanceOpacity()` in
  `NavdataRenderer.ts`). Rank also orders search results and decides which
  airport label wins when they collide.

### Airport importance (OurAirports data)

Airport rank comes **solely** from the [OurAirports](https://ourairports.com/data/)
class (public domain): `large_airport` 5, `medium_airport` 4, `small_airport`
3, `seaplane_base` 2, `balloonport` 1, `closed` 0. Airports **not** present in
OurAirports default to rank 0 (least important - only shown when zoomed right
in), so building **with** OurAirports is strongly recommended. Runway length is
no longer used for ranking. OurAirports' **IATA code** is also folded into the
search index, so you can search e.g. `LAX`.

Search results follow a strict kind order - airports, then heliports, then
waypoints - and within each, by rank.

```bash
# fetch it automatically as part of the build:
./build_navdata_tiles.sh --apt apt.dat --fix earth_fix.dat --download-ourairports

# or point at a local copy:
./build_navdata_tiles.sh --apt apt.dat --fix earth_fix.dat \
    --ourairports /path/to/airports.csv
```

Matching is by ICAO/GPS/local code, so an apt.dat airport finds its
OurAirports record. Airports with no match fall back to a runway-length rank.
Class -> rank lives in `parse_xplane.py` (`_OA_CLASS_RANK`, `_runway_rank`);
the rank -> zoom thresholds live in the style (`NavdataRenderer.ts`).

Note: apt.dat contains thousands of minor fields and heliports with synthetic
`X...` idents (no official ICAO code). These are split out:

- **Heliports** (apt.dat heliport headers, OurAirports `heliport`, or runway-less
  helipad fields) go to their own `heliports` source-layer, drawn as a distinct
  "H" marker with its own toggle (off by default).
- Remaining **airports** are pushed to a minzoom based on importance, and each
  carries a `rank` (0-5) the renderer uses to size its dot - so a major airport
  reads as a bigger symbol than a small strip.
- each taxiway/apron (row 110) becomes a polygon from its boundary nodes.
  `apt.dat` doesn't distinguish taxiways from aprons, so both land in the one
  `pavement` layer. Bezier control points (nodes 112/114/116) are expanded into
  smooth curves - `BEZIER_SAMPLES` in `parse_xplane.py` controls how many
  straight segments approximate each curved edge (default 8; lower it to shrink
  the archive, raise it for smoother fillets).

### How it surfaces in the app

- **Rendering**: `NavdataRenderer` is the single source of truth for the
  overlay. It adds the `pmtiles://` vector source + layers for airports
  (circles), heliports ("H" markers), waypoints (circles), runways and
  taxiways/aprons (filled polygons) onto whatever basemap is active (online or
  the offline styles). Visibility is controlled by the toggles in the Display
  Options panel.
- **Zoom control** lives in `NavdataRenderer.ts`: `LABEL_MINZOOM` (when each
  label layer starts) and `AIRPORT_IMPORTANCE_BY_ZOOM` (which `rank` of airport
  shows at which zoom). These are style expressions, so tuning them only needs
  a frontend rebuild - no re-tiling.
- **Labels**: the label layers need map glyphs. Hosted basemaps ship their own,
  so labels work there out of the box; for the **offline** basemap you must
  populate `WebATM/static/glyphs/` (see its README). The layers request the
  `Open Sans Regular` fontstack.
- **Search ("go to")**: the search box on the map queries
  `GET /api/navdata/search?q=…`, which reads `navdata.sqlite`. If the index is
  missing the box reports "Navdata not available (run the offline build)".
