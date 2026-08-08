# Navdata pipeline (airports + navaids)

Builds the airport/navaid overlay that WebATM renders on the map, from the
public-domain [OurAirports](https://ourairports.com/data/) open data. This is
an **offline** build step — its outputs are served at runtime but the pipeline
itself is never run by the app.

```
airports.csv / runways.csv / navaids.csv
        │  parse_ourairports.py
        ▼
airports.geojson  heliports.geojson  runways.geojson  waypoints.geojson  navdata.sqlite
        │  tippecanoe + tile-join                                             │
        ▼                                                                     ▼
WebATM/static/tiles/navdata.pmtiles                     WebATM/static/navdata/navdata.sqlite
   (vector tiles, rendered via                             (search index, used by
    the pmtiles:// protocol)                                /api/navdata/search)
```

## What you need

1. **The OurAirports CSVs** — `airports.csv`, `runways.csv`, `navaids.csv`.
   The build downloads them automatically (they are only a few MB each) from
   the daily snapshot at
   <https://davidmegginson.github.io/ourairports-data/>, or you can point it
   at local copies. The data is released into the **public domain** — no
   attribution or redistribution constraints.

2. **tippecanoe** (provides both `tippecanoe` and `tile-join`):
   <https://github.com/felt/tippecanoe>. `python3` (3.9+, stdlib only) is the
   only other requirement (`curl` too, when downloading).

## Build

```bash
cd script/navdata
./build_navdata_tiles.sh                 # downloads the CSVs, then tiles

# or with local copies:
./build_navdata_tiles.sh \
    --airports /path/to/airports.csv \
    --runways /path/to/runways.csv \
    --navaids /path/to/navaids.csv
```

Outputs:
- `WebATM/static/tiles/navdata.pmtiles` — the vector-tile archive.
- `WebATM/static/navdata/navdata.sqlite` — the search index.

Both are **gitignored** (large/binary). Deploy them alongside the app — the same
way `world.pmtiles` is handled (see the note in the repo `.gitignore`).

You can also run the parser on its own (e.g. to inspect the GeoJSON or to skip
tiling):

```bash
python3 parse_ourairports.py --airports airports.csv --runways runways.csv \
    --navaids navaids.csv --out-dir ./build
```

## What each dataset provides

- **`airports.csv`** → the `airports` and `heliports` source-layers and the
  bulk of the search index. Airports with type `closed` are skipped. Each
  airport carries an importance `rank` (0-5) derived from the OurAirports
  class: `large_airport` 5, `medium_airport` 4, `small_airport` 3,
  `seaplane_base` 2, `heliport` 2, `balloonport` 1. The IATA code and
  municipality are folded into the search index, so you can search e.g. `LAX`
  or `Rotterdam`.
- **`runways.csv`** → the `runways` source-layer. A runway becomes a
  paved-rectangle polygon from its two thresholds + width, plus a `textrot`
  property so the designator label reads along the strip. Runways missing a
  surveyed threshold coordinate (common for small strips) are skipped, as are
  closed runways; runway *length* still feeds the airport declutter
  tie-break either way.
- **`navaids.csv`** → the `waypoints` source-layer and search kind: radio
  navaids (VOR / NDB / DME / TACAN …) with their class in `type` and
  frequency (kHz) in `freq`.

Enroute RNAV fixes are not part of OurAirports, so the waypoint layer
contains radio navaids rather than the full fix database.

## Taxiways & aprons (OpenStreetMap)

OurAirports has no taxiway/apron geometry; that comes from OpenStreetMap
(`aeroway=apron` polygons and `aeroway=taxiway` centrelines, ODbL —
attribution required, already credited in the app), through **either** of two
routes:

1. **Straight from the basemap — no build needed.** OpenMapTiles-schema
   basemaps (the default OpenFreeMap styles, MapTiler, ...) already carry an
   `aeroway` source-layer in their tiles. `NavdataRenderer` detects it at
   runtime and styles aprons + taxiways from it, under the same
   "Taxiways & Aprons" toggle. If you only use the hosted basemaps, you are
   done — skip the next point. (The offline Protomaps basemap gets partial
   coverage this way too: a deep-zoom regional extract — `--maxzoom=13`+ —
   contains taxiway centrelines that the renderer picks up, but Protomaps
   builds have no apron polygons; see
   [docs/offline-pmtiles.md](../../docs/offline-pmtiles.md).)

2. **Baked into `navdata.pmtiles` — for the offline basemap.** The offline
   Protomaps basemap has no apron/taxiway data, so for fully-offline
   deployments pass an OSM extract to the build:

   ```bash
   # any .osm.pbf covering your area of interest, e.g. from Geofabrik:
   ./build_navdata_tiles.sh --osm-pbf netherlands-latest.osm.pbf
   ```

   This needs [osmium](https://osmcode.org/osmium-tool/) on the PATH: the
   script filters `aeroway=apron/taxiway/terminal/hangar` out of the extract,
   exports them as GeoJSON, and `parse_osm_aeroways.py` splits them into the
   `pavement` (polygons), `taxiways` (centrelines, with the `ref` designator
   kept for labels) and `buildings` (terminals/hangars) source-layers, tiled
   from `--pave-minzoom` (default 11) upward. A pre-extracted GeoJSON(-Seq)
   aeroway file can be supplied directly with `--osm-aeroways`. When the
   archive contains these layers the renderer prefers them over the basemap's
   `aeroway`, so the same geometry is never drawn twice.

   For **worldwide** coverage without planet-sized disk needs, download the
   Geofabrik continent extracts one at a time, keep only their (small)
   aeroway filtrate, and merge:

   ```bash
   for c in europe north-america asia africa south-america \
            australia-oceania central-america antarctica; do
       curl -sL -O "https://download.geofabrik.de/$c-latest.osm.pbf"
       osmium tags-filter "$c-latest.osm.pbf" nwr/aeroway -o "$c-aeroways.osm.pbf"
       rm "$c-latest.osm.pbf"          # delete-as-you-go: peak disk = 1 continent
   done
   osmium merge ./*-aeroways.osm.pbf -o world-aeroways.osm.pbf
   osmium export world-aeroways.osm.pbf -f geojsonseq -o world-aeroways.geojsonseq
   ./build_navdata_tiles.sh --osm-aeroways world-aeroways.geojsonseq
   ```

## Tuning

`build_navdata_tiles.sh` flags:
- `--apt-minzoom N`  (default 2)  — lowest zoom airports are tiled at.
- `--hel-minzoom N`  (default 7)  — lowest zoom heliports are tiled at.
- `--wpt-minzoom N`  (default 6)  — lowest zoom navaids are tiled at.
- `--rwy-minzoom N`  (default 10) — lowest zoom runways are tiled at; they are
  small polygons only worth drawing once zoomed into an airport.
- `--pave-minzoom N` (default 11) — lowest zoom OSM taxiways/aprons are tiled
  at (only with `--osm-pbf`/`--osm-aeroways`).
- `--maxzoom N`      (default 14).

The vector-tile **source-layers** are named `airports`, `heliports`,
`waypoints`, and `runways` (plus `pavement` and `taxiways` when built with
OSM data); these names are referenced in
`frontend/src/ui/map/navdata/NavdataRenderer.ts`. If you rename them here,
update the renderer too.

The **map style** (not the tiles) gates airports by `rank` per zoom, so
important airports appear when zoomed far out and minor ones only when zoomed
in — thresholds are tunable without rebuilding the tiles (see
`importanceOpacity()` in `NavdataRenderer.ts`). Rank also orders search
results and decides which airport label wins when they collide. On top of
that, `parse_ourairports.py` bakes a density-aware, rank-prioritised
`tippecanoe.minzoom` into each airport point (`assign_airport_minzooms` /
`DECLUTTER_SPACING_PX`), so dense clusters of minor airports reveal
progressively as you zoom while an important hub is never hidden behind a
lesser neighbour. Class → rank lives in `parse_ourairports.py`
(`_OA_CLASS_RANK`); the rank → zoom thresholds live in the style
(`NavdataRenderer.ts`).

Search results follow a strict kind order — airports, then heliports, then
waypoints — and within each, by rank.

## How it surfaces in the app

- **Rendering**: `NavdataRenderer` is the single source of truth for the
  overlay. It adds the `pmtiles://` vector source + layers for airports
  (circles), heliports ("H" markers), waypoints/navaids (circles), and
  runways (filled polygons) onto whatever basemap is active (online or the
  offline styles). Visibility is controlled by the toggles in the Display
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
