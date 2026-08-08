#!/usr/bin/env python3
"""Convert OurAirports open data into GeoJSON + a SQLite search index.

This is an *offline* build step. It reads the public-domain CSV datasets
published by OurAirports (https://ourairports.com/data/) and produces the
artifacts WebATM serves at runtime:

  * ``airports.geojson``   - one Point feature per airport (ident + name)
  * ``heliports.geojson``  - one Point feature per heliport
  * ``runways.geojson``    - one paved-rectangle Polygon per runway
  * ``waypoints.geojson``  - one Point feature per radio navaid (VOR/NDB/DME)
  * ``navdata.sqlite``     - a small searchable index used by the "go to"
                              endpoint (see WebATM/server/routes.py)

The GeoJSON files are intended to be fed to ``tippecanoe`` to build the vector
tile archive (see ``build_navdata_tiles.sh``). They are not served directly.

Supported inputs (all from https://davidmegginson.github.io/ourairports-data/):

  * ``airports.csv``  - airports, heliports, seaplane bases, balloonports
  * ``runways.csv``   - runway thresholds + dimensions (optional)
  * ``navaids.csv``   - radio navaids: VOR / NDB / DME etc. (optional)

All OurAirports data is released into the public domain - no attribution or
licensing constraints on redistribution.

Usage::

    python parse_ourairports.py \
        --airports /path/to/airports.csv \
        --runways /path/to/runways.csv \
        --navaids /path/to/navaids.csv \
        --out-dir ./build

``--airports`` is required; the other datasets are optional.

Stdlib only - no third-party dependencies - so it runs anywhere Python 3.9+ is
available.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import sqlite3
import sys
from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from pathlib import Path


@dataclass
class Runway:
    """A single runway: two thresholds and a paved width (metres)."""

    ident: str  # e.g. "16L/34R"
    lat1: float
    lon1: float
    lat2: float
    lon2: float
    width_m: float


def _safe_float(token: str | None) -> float | None:
    try:
        return float(token)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None


# Metres per degree of latitude (constant enough for runway-scale geometry).
_M_PER_DEG_LAT = 111320.0
_FT_TO_M = 0.3048
# Fallback paved width when runways.csv has no width for a runway.
_DEFAULT_RUNWAY_WIDTH_M = 30.0


# OurAirports `type` -> importance rank (0-5). This is the sole airport
# importance signal: the map style uses it to decide, per zoom, which airports
# to show (zoom thresholds live in NavdataRenderer.ts, tunable without
# re-tiling), and search orders by it. ``closed`` airports are skipped
# entirely (see ``parse_airports``).
_OA_CLASS_RANK = {
    "large_airport": 5,
    "medium_airport": 4,
    "small_airport": 3,
    "seaplane_base": 2,
    "heliport": 2,
    "balloonport": 1,
}


# --- airport declutter -> per-feature tippecanoe minzoom -----------------
# Airport visibility is thinned at build time by baking a per-feature
# tippecanoe ``minzoom`` into each airport point. This is the one tile mechanism
# that behaves identically in both mapbox/tippecanoe and the felt fork: a
# feature with an explicit ``minzoom`` is preserved at that zoom and above "even
# if dot-dropping with -r would otherwise have dropped it". tippecanoe's own
# point dropping is *geographic* (blind to importance) and would silently drop a
# major hub like EHAM while keeping a minor neighbour, so we compute the
# thinning ourselves here where rank is known.
#
# Per-rank floor zooms mirror AIRPORT_IMPORTANCE_BY_ZOOM in NavdataRenderer.ts -
# keep the two in sync. An airport never appears below its rank's floor zoom.
_RANK_FLOOR_ZOOM = {5: 3, 4: 5, 3: 7, 2: 8, 1: 9, 0: 11}
# Highest zoom the declutter runs to; every airport is revealed by here.
DECLUTTER_MAX_ZOOM = 11
# Approximate minimum on-screen spacing between airport dots, in 256px tile
# pixels: the declutter grid cell at each zoom is this many pixels across.
# Larger = sparser low/mid zooms.
DECLUTTER_SPACING_PX = 50


def _mercator_xy(lat: float, lon: float) -> tuple[float, float]:
    """Project to web-mercator, normalised to [0, 1] (x east, y south)."""
    x = (lon + 180.0) / 360.0
    s = math.sin(math.radians(lat))
    s = min(max(s, -0.9999), 0.9999)
    y = 0.5 - math.log((1.0 + s) / (1.0 - s)) / (4.0 * math.pi)
    return x, y


def assign_airport_minzooms(
    features: list[dict],
    base_zoom: int = 2,
    spacing_px: int = DECLUTTER_SPACING_PX,
    max_zoom: int = DECLUTTER_MAX_ZOOM,
) -> None:
    """Bake a density-aware, rank-prioritised ``tippecanoe.minzoom`` into each
    airport Point feature (mutates ``features`` in place).

    Greedy by zoom: from each rank's floor zoom upward, lay airports onto a
    pixel-spacing grid in importance order (rank desc, then longest runway). The
    first airport to claim a grid cell at a zoom "wins" it and is revealed from
    that zoom; lower-importance airports sharing the cell are pushed to the next
    zoom. So a spatially isolated hub - and any airport that outranks its
    neighbours, like EHAM among EHRD/EHHV/EHLV - is revealed early and is never
    hidden while a lesser neighbour shows, whereas dense clusters of minor
    airports reveal progressively as you zoom in.
    """
    if not features:
        return

    # [feature, rank, mercator_x, mercator_y, floor_zoom] in importance order.
    items: list[list] = []
    for f in features:
        lon, lat = f["geometry"]["coordinates"]
        rank = int(f["properties"].get("rank", 0) or 0)
        mx, my = _mercator_xy(lat, lon)
        items.append([f, rank, mx, my, _RANK_FLOOR_ZOOM.get(rank, max_zoom)])
    # rank desc, then longest runway desc (a real size proxy so the bigger hub
    # wins a shared low-zoom cell), then ident for a deterministic tie-break.
    items.sort(
        key=lambda it: (-it[1], -it[0].get("_sort", 0), it[0]["properties"]["ident"])
    )

    assigned: dict[int, int] = {}
    for z in range(base_zoom, max_zoom + 1):
        # The world is 2**z tiles * 256px across; one grid cell is spacing_px.
        cells = (2**z) * 256.0 / spacing_px
        occupied: set = set()
        for f, _rank, mx, my, floor in items:
            if z < floor:
                continue
            cell = (int(mx * cells), int(my * cells))
            fid = id(f)
            if fid in assigned:
                # A winner keeps blocking its cell at finer zooms so a lower-rank
                # neighbour cannot claim the same spot.
                occupied.add(cell)
                continue
            if cell not in occupied:
                occupied.add(cell)
                assigned[fid] = z

    for f, _rank, _mx, _my, floor in items:
        f.setdefault("tippecanoe", {})["minzoom"] = assigned.get(
            id(f), max(floor, max_zoom)
        )
        f.pop("_sort", None)  # transient sort key, not part of the output


def runway_polygon(rwy: Runway) -> list[list[list[float]]] | None:
    """Build the paved-rectangle ring for a runway as GeoJSON [lon, lat].

    Uses a local equirectangular approximation: offset each threshold
    perpendicular to the runway by half the width. More than accurate enough
    at runway scale (a few km), and avoids any geospatial dependency.
    """
    lat_mid = math.radians((rwy.lat1 + rwy.lat2) / 2.0)
    m_per_deg_lon = _M_PER_DEG_LAT * math.cos(lat_mid)
    if m_per_deg_lon == 0:  # at the poles; nothing sensible to draw
        return None

    # Runway direction in metres (east, north).
    dx = (rwy.lon2 - rwy.lon1) * m_per_deg_lon
    dy = (rwy.lat2 - rwy.lat1) * _M_PER_DEG_LAT
    length = math.hypot(dx, dy)
    if length == 0:
        return None

    # Perpendicular offset (rotate the unit direction 90 degrees), scaled to
    # half the runway width, expressed in metres.
    half = rwy.width_m / 2.0
    off_e = -dy / length * half  # eastward metres
    off_n = dx / length * half  # northward metres

    def corner(lat: float, lon: float, sign: float) -> list[float]:
        return [
            lon + sign * off_e / m_per_deg_lon,
            lat + sign * off_n / _M_PER_DEG_LAT,
        ]

    ring = [
        corner(rwy.lat1, rwy.lon1, 1.0),
        corner(rwy.lat1, rwy.lon1, -1.0),
        corner(rwy.lat2, rwy.lon2, -1.0),
        corner(rwy.lat2, rwy.lon2, 1.0),
    ]
    ring.append(ring[0])  # close the ring
    return [ring]


def runway_label_rotation(rwy: Runway) -> float:
    """Text rotation (degrees) to make a label read *along* the runway.

    Returned as a value for MapLibre's ``text-rotate`` with map-aligned
    rotation. Normalised to [-90, 90] so the label never renders upside down.
    """
    lat_mid = math.radians((rwy.lat1 + rwy.lat2) / 2.0)
    east = (rwy.lon2 - rwy.lon1) * math.cos(lat_mid)
    north = rwy.lat2 - rwy.lat1
    # Compass bearing (0 = north, clockwise), then -90 so text lies along the
    # strip rather than across it.
    bearing = math.degrees(math.atan2(east, north))
    rot = bearing - 90.0
    while rot > 90.0:
        rot -= 180.0
    while rot < -90.0:
        rot += 180.0
    return rot


def parse_runways(path: Path) -> dict[str, dict]:
    """Read ``runways.csv`` into a per-airport map.

    Returns ``{airport_ident: {"runways": [Runway, ...], "longest_m": float}}``.
    A runway only yields a polygon when both thresholds carry coordinates
    (many small strips only have one end surveyed); its *length* still counts
    towards the airport's longest-runway importance tie-break either way.
    Closed runways (``closed`` = 1) are skipped.
    """
    by_airport: dict[str, dict] = {}
    with path.open(encoding="utf-8", newline="") as fh:
        for row in csv.DictReader(fh):
            apt = (row.get("airport_ident") or "").strip().upper()
            if not apt or (row.get("closed") or "").strip() == "1":
                continue
            entry = by_airport.setdefault(apt, {"runways": [], "longest_m": 0.0})

            length_ft = _safe_float(row.get("length_ft"))
            if length_ft:
                entry["longest_m"] = max(entry["longest_m"], length_ft * _FT_TO_M)

            lat1 = _safe_float(row.get("le_latitude_deg"))
            lon1 = _safe_float(row.get("le_longitude_deg"))
            lat2 = _safe_float(row.get("he_latitude_deg"))
            lon2 = _safe_float(row.get("he_longitude_deg"))
            if None in (lat1, lon1, lat2, lon2):
                continue
            width_ft = _safe_float(row.get("width_ft"))
            width_m = width_ft * _FT_TO_M if width_ft else _DEFAULT_RUNWAY_WIDTH_M
            le = (row.get("le_ident") or "").strip()
            he = (row.get("he_ident") or "").strip()
            ident = f"{le}/{he}" if le and he else (le or he)
            entry["runways"].append(Runway(ident, lat1, lon1, lat2, lon2, width_m))
    return by_airport


def parse_airports(
    path: Path, runways_by_airport: dict[str, dict] | None = None
) -> Iterator[dict]:
    """Yield GeoJSON features for each open airport/heliport in airports.csv.

    Emits, per airport: one ``kind: "airport"`` (or ``"heliport"``) Point and,
    when ``runways_by_airport`` (from ``parse_runways``) has geometry for it, a
    ``kind: "runway"`` Polygon per runway. Airports with ``type`` = ``closed``
    are skipped entirely.

    The OurAirports ``type`` class drives the importance ``rank`` (0-5) used
    for map decluttering and search ordering; the longest runway serves only
    as a declutter tie-break between equally-ranked airports.
    """
    runways_by_airport = runways_by_airport or {}
    with path.open(encoding="utf-8", newline="") as fh:
        for row in csv.DictReader(fh):
            oa_type = (row.get("type") or "").strip()
            if oa_type == "closed":
                continue
            ident = (row.get("ident") or "").strip().upper()
            lat = _safe_float(row.get("latitude_deg"))
            lon = _safe_float(row.get("longitude_deg"))
            if not ident or lat is None or lon is None:
                continue
            name = (row.get("name") or "").strip()
            iata = (row.get("iata_code") or "").strip().upper()
            muni = (row.get("municipality") or "").strip()
            rank = _OA_CLASS_RANK.get(oa_type, 0)
            rwy_info = runways_by_airport.get(ident, {})

            props = {
                "kind": "heliport" if oa_type == "heliport" else "airport",
                "ident": ident,
                "name": name,
                "score": rank,
                "rank": rank,
            }
            if iata:
                props["iata"] = iata
            if muni:
                props["muni"] = muni
            feat = {
                "type": "Feature",
                # tippecanoe.minzoom is baked in later by assign_airport_minzooms
                # (density-aware, rank-prioritised) so tippecanoe's geographic
                # dot-dropping can't drop a major hub while keeping a minor one.
                "geometry": {"type": "Point", "coordinates": [lon, lat]},
                "properties": props,
            }
            if props["kind"] == "airport":
                # Transient importance tie-break for the declutter; stripped
                # before the feature is written out.
                feat["_sort"] = round(rwy_info.get("longest_m", 0.0))
            yield feat

            for rwy in rwy_info.get("runways", []):
                ring = runway_polygon(rwy)
                if ring is None:
                    continue
                yield {
                    "type": "Feature",
                    "geometry": {"type": "Polygon", "coordinates": ring},
                    "properties": {
                        "kind": "runway",
                        "ident": rwy.ident,
                        "airport": ident,
                        "textrot": round(runway_label_rotation(rwy), 1),
                    },
                }


def parse_navaids(path: Path) -> Iterator[dict]:
    """Yield GeoJSON Point features for each radio navaid in navaids.csv.

    These populate the ``waypoints`` layer / search kind (VOR, NDB, DME,
    TACAN, ...). The navaid class goes into ``type`` and the frequency (kHz)
    into ``freq`` for potential display use.
    """
    with path.open(encoding="utf-8", newline="") as fh:
        for row in csv.DictReader(fh):
            ident = (row.get("ident") or "").strip().upper()
            lat = _safe_float(row.get("latitude_deg"))
            lon = _safe_float(row.get("longitude_deg"))
            if not ident or lat is None or lon is None:
                continue
            props = {
                "kind": "waypoint",
                "ident": ident,
                "name": (row.get("name") or "").strip(),
                "type": (row.get("type") or "").strip(),
            }
            freq = _safe_float(row.get("frequency_khz"))
            if freq:
                props["freq"] = freq
            yield {
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [lon, lat]},
                "properties": props,
            }


def write_geojson(features: Iterable[dict], out_path: Path) -> int:
    """Stream features into a GeoJSON FeatureCollection. Returns the count."""
    count = 0
    with out_path.open("w", encoding="utf-8") as fh:
        fh.write('{"type":"FeatureCollection","features":[')
        for feature in features:
            if count:
                fh.write(",")
            json.dump(feature, fh, separators=(",", ":"))
            count += 1
        fh.write("]}")
    return count


def write_airport_layers(
    features: Iterable[dict], out_dir: Path
) -> tuple[dict[str, int], list[dict]]:
    """Split the airports.csv feature stream into per-kind GeoJSON files.

    ``parse_airports`` interleaves airport/heliport points and runway polygons.
    Heliports and runways stream straight to their layer files; airports are
    buffered so a density-aware ``tippecanoe.minzoom`` can be computed across
    all of them (``assign_airport_minzooms``) before writing.

    Returns ``(counts_by_kind, point_features)`` where point_features are the
    searchable airport + heliport points.
    """
    fnames = {
        "airport": out_dir / "airports.geojson",
        "heliport": out_dir / "heliports.geojson",
        "runway": out_dir / "runways.geojson",
    }
    stream_kinds = ("heliport", "runway")
    handles = {kind: fnames[kind].open("w", encoding="utf-8") for kind in stream_kinds}
    counts = dict.fromkeys(fnames, 0)
    airport_features: list[dict] = []
    point_features: list[dict] = []
    try:
        for h in handles.values():
            h.write('{"type":"FeatureCollection","features":[')
        for feat in features:
            kind = feat["properties"]["kind"]
            if kind == "airport":
                airport_features.append(feat)
                point_features.append(feat)
                counts["airport"] += 1
                continue
            handle = handles.get(kind)
            if handle is None:
                continue
            if counts[kind]:
                handle.write(",")
            json.dump(feat, handle, separators=(",", ":"))
            counts[kind] += 1
            if kind == "heliport":
                point_features.append(feat)
    finally:
        for h in handles.values():
            h.write("]}")
            h.close()

    # Density-aware, rank-prioritised reveal: bake tippecanoe.minzoom per airport
    # (this also strips the transient _sort key), then write the airports layer.
    assign_airport_minzooms(airport_features)
    with fnames["airport"].open("w", encoding="utf-8") as fh:
        fh.write('{"type":"FeatureCollection","features":[')
        for i, feat in enumerate(airport_features):
            if i:
                fh.write(",")
            json.dump(feat, fh, separators=(",", ":"))
        fh.write("]}")

    return counts, point_features


def build_search_index(
    db_path: Path,
    airports: Iterable[dict],
    waypoints: Iterable[dict],
) -> tuple[int, int]:
    """Build the SQLite search index used by the /api/navdata/search endpoint.

    A base ``navaids`` table holds the returnable fields (with real REAL
    lat/lon), and an external-content FTS5 table indexes ``ident`` + ``name``
    + ``iata`` + ``muni`` (municipality) so the typeahead matches identifiers,
    airport names and cities alike. Returns (airport_count, waypoint_count).
    """
    if db_path.exists():
        db_path.unlink()
    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            """
            CREATE TABLE navaids (
                id    INTEGER PRIMARY KEY,
                kind  TEXT NOT NULL,   -- 'airport' | 'heliport' | 'waypoint'
                ident TEXT NOT NULL,
                name  TEXT NOT NULL DEFAULT '',
                lat   REAL NOT NULL,
                lon   REAL NOT NULL,
                score REAL NOT NULL DEFAULT 0,  -- importance score
                rank  INTEGER NOT NULL DEFAULT 0,  -- importance rank 0-5
                iata  TEXT NOT NULL DEFAULT '',  -- IATA code, when known
                muni  TEXT NOT NULL DEFAULT ''   -- municipality, when known
            )
            """
        )
        # Full-text index over ident + name + iata + muni. content='navaids'
        # makes this an external-content table so the text is not duplicated;
        # we populate it from the base table below.
        conn.execute(
            """
            CREATE VIRTUAL TABLE navaids_fts USING fts5(
                ident, name, iata, muni,
                content='navaids', content_rowid='id',
                tokenize='unicode61'
            )
            """
        )

        def rows(features: Iterable[dict]) -> Iterator[tuple]:
            for feat in features:
                props = feat["properties"]
                lon, lat = feat["geometry"]["coordinates"]
                name = props.get("name") or ""
                score = props.get("score", 0)
                rank = props.get("rank", 0)
                iata = props.get("iata", "")
                muni = props.get("muni", "")
                yield (
                    props["kind"],
                    props["ident"],
                    name,
                    lat,
                    lon,
                    score,
                    rank,
                    iata,
                    muni,
                )

        airport_rows = list(rows(airports))
        waypoint_rows = list(rows(waypoints))
        insert_sql = (
            "INSERT INTO navaids (kind, ident, name, lat, lon, score, rank, iata, muni) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        conn.executemany(insert_sql, airport_rows)
        conn.executemany(insert_sql, waypoint_rows)
        # Populate the FTS index from the base table.
        conn.execute(
            "INSERT INTO navaids_fts (rowid, ident, name, iata, muni) "
            "SELECT id, ident, name, iata, muni FROM navaids"
        )
        conn.commit()
        return len(airport_rows), len(waypoint_rows)
    finally:
        conn.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--airports", type=Path, required=True, help="Path to OurAirports airports.csv"
    )
    parser.add_argument("--runways", type=Path, help="Path to OurAirports runways.csv")
    parser.add_argument("--navaids", type=Path, help="Path to OurAirports navaids.csv")
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=Path("build"),
        help="Directory for generated artifacts (default: ./build)",
    )
    parser.add_argument(
        "--no-index",
        action="store_true",
        help="Skip building the SQLite search index",
    )
    args = parser.parse_args(argv)

    for label, p in (
        ("airports.csv", args.airports),
        ("runways.csv", args.runways),
        ("navaids.csv", args.navaids),
    ):
        if p is not None and not p.exists():
            print(f"error: {label} not found: {p}", file=sys.stderr)
            return 1

    args.out_dir.mkdir(parents=True, exist_ok=True)

    runways_by_airport: dict[str, dict] = {}
    if args.runways:
        runways_by_airport = parse_runways(args.runways)
        print(f"runways.csv: geometry for {len(runways_by_airport)} airports")

    counts, airports = write_airport_layers(
        parse_airports(args.airports, runways_by_airport), args.out_dir
    )
    print(
        f"airports: {counts['airport']} features -> {args.out_dir / 'airports.geojson'}"
    )
    print(
        f"heliports: {counts['heliport']} features -> {args.out_dir / 'heliports.geojson'}"
    )
    print(f"runways: {counts['runway']} features -> {args.out_dir / 'runways.geojson'}")

    waypoints: list[dict] = []
    if args.navaids:
        waypoints = list(parse_navaids(args.navaids))
        n = write_geojson(waypoints, args.out_dir / "waypoints.geojson")
        print(
            f"waypoints (navaids): {n} features -> {args.out_dir / 'waypoints.geojson'}"
        )

    if not args.no_index:
        db_path = args.out_dir / "navdata.sqlite"
        a, w = build_search_index(db_path, airports, waypoints)
        print(
            f"search index: {a + w} rows "
            f"({a} airports/heliports, {w} navaids) -> {db_path}"
        )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
