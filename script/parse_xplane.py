#!/usr/bin/env python3
"""Convert X-Plane navigation data into GeoJSON + a SQLite search index.

This is an *offline* build step. It reads X-Plane's plain-text data files and
produces the artifacts WebATM serves at runtime:

  * ``airports.geojson``  - one Point feature per airport (ICAO + name)
  * ``waypoints.geojson``  - one Point feature per enroute fix (ident + region)
  * ``navdata.sqlite``     - a small searchable index used by the "go to"
                              endpoint (see WebATM/server/routes.py)

The GeoJSON files are intended to be fed to ``tippecanoe`` to build the vector
tile archive (see ``build_navdata_tiles.sh``). They are not served directly.

Supported inputs:

  * ``apt.dat``        - airport data (row codes 1/16/17 + runway rows)
  * ``earth_fix.dat``  - enroute fixes / waypoints

Both are released by Laminar Research under the GNU GPL; the copyright header
at the top of each ``.dat`` file must be preserved if you redistribute the
data. This script never strips those files - it only reads them.

Usage::

    python parse_xplane.py \
        --apt /path/to/apt.dat \
        --fix /path/to/earth_fix.dat \
        --out-dir ./build

Either ``--apt`` or ``--fix`` may be omitted; whatever is supplied is parsed.

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
from dataclasses import dataclass, field
from pathlib import Path

# --- apt.dat row codes we care about -------------------------------------
# https://developer.x-plane.com/article/airport-data-apt-dat-file-format-specification/
AIRPORT_HEADER_CODES = {"1", "16", "17"}  # land airport, seaplane base, heliport
RUNWAY_LAND_CODE = "100"  # land runway: two endpoints, lat/lon at fixed offsets
RUNWAY_WATER_CODE = "101"  # water runway
HELIPAD_CODE = "102"  # helipad: single lat/lon
METADATA_CODE = "1302"  # key/value metadata rows (may carry datum_lat/datum_lon)
PAVEMENT_HEADER_CODE = "110"  # taxiway / apron pavement polygon header
PAVEMENT_NODE_CODES = {"111", "112", "113", "114", "115", "116"}  # boundary nodes
PAVEMENT_CLOSE_CODES = {"113", "114"}  # final node of a contour (closes the ring)
PAVEMENT_BEZIER_CODES = {"112", "114", "116"}  # nodes carrying a control point


@dataclass
class Runway:
    """A single land runway: two thresholds and a paved width (metres)."""

    ident: str  # e.g. "16L/34R"
    lat1: float
    lon1: float
    lat2: float
    lon2: float
    width_m: float


@dataclass
class Airport:
    """Accumulates the data needed to place a single airport point."""

    icao: str
    name: str
    # apt.dat header row code: 1 land airport, 16 seaplane base, 17 heliport.
    header_code: str = "1"
    has_helipad: bool = False
    datum_lat: float | None = None
    datum_lon: float | None = None
    # Coordinates harvested from runway / helipad rows, used as a fallback
    # reference point when no explicit datum is present in the metadata.
    _lats: list[float] = field(default_factory=list)
    _lons: list[float] = field(default_factory=list)
    # Full runway geometry, emitted as polygons.
    runways: list[Runway] = field(default_factory=list)
    # Longest runway (metres) - used as an importance proxy for prioritising
    # major airports in search results and on the map.
    longest_runway_m: float = 0.0

    def add_point(self, lat: float, lon: float) -> None:
        self._lats.append(lat)
        self._lons.append(lon)

    def reference_point(self) -> tuple[float, float] | None:
        """Best-effort airport position.

        Prefers the explicit ``datum_lat``/``datum_lon`` metadata when present
        (this is what X-Plane treats as the airport's official location),
        otherwise falls back to the mean of all runway / helipad endpoints.
        Returns ``None`` if the airport had no usable coordinates at all.
        """
        if self.datum_lat is not None and self.datum_lon is not None:
            return self.datum_lat, self.datum_lon
        if self._lats and self._lons:
            return sum(self._lats) / len(self._lats), sum(self._lons) / len(self._lons)
        return None


def _safe_float(token: str) -> float | None:
    try:
        return float(token)
    except (TypeError, ValueError):
        return None


# Metres per degree of latitude (constant enough for runway-scale geometry).
_M_PER_DEG_LAT = 111320.0


def _distance_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Approximate ground distance in metres (equirectangular; fine at airport
    scale)."""
    lat_mid = math.radians((lat1 + lat2) / 2.0)
    east = (lon2 - lon1) * _M_PER_DEG_LAT * math.cos(lat_mid)
    north = (lat2 - lat1) * _M_PER_DEG_LAT
    return math.hypot(east, north)


# OurAirports `type` -> importance rank (0-5). This is the sole airport
# importance signal: the map style uses it to decide, per zoom, which airports
# to show (zoom thresholds live in NavdataRenderer.ts, tunable without
# re-tiling), and search orders by it. Airports absent from OurAirports get 0.
_OA_CLASS_RANK = {
    "large_airport": 5,
    "medium_airport": 4,
    "small_airport": 3,
    "seaplane_base": 2,
    "heliport": 2,
    "balloonport": 1,
    "closed": 0,
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
    items.sort(key=lambda it: (-it[1], -it[0].get("_sort", 0), it[0]["properties"]["ident"]))

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


def load_ourairports(path: Path) -> dict[str, dict]:
    """Load an OurAirports ``airports.csv`` into a code -> {type, iata} map.

    OurAirports is public domain. We key on every code an airport might be
    matched by (ident / ICAO / GPS / local) so an apt.dat ICAO can find it.
    Parsed by header name (csv.DictReader) to tolerate column additions.
    """
    lookup: dict[str, dict] = {}
    with path.open(encoding="utf-8", newline="") as fh:
        for row in csv.DictReader(fh):
            rec = {
                "type": (row.get("type") or "").strip(),
                "iata": (row.get("iata_code") or "").strip(),
            }
            for key in ("ident", "icao_code", "gps_code", "local_code"):
                code = (row.get(key) or "").strip().upper()
                if code:
                    lookup.setdefault(code, rec)
    return lookup


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


# Straight segments used to approximate each curved pavement edge. Higher =
# smoother but more vertices (pavement is already the bulk of the data).
BEZIER_SAMPLES = 8


def _cubic_point(
    p0: list[float], p1: list[float], p2: list[float], p3: list[float], t: float
) -> list[float]:
    """Evaluate a cubic Bezier at parameter t, in [lon, lat]."""
    mt = 1.0 - t
    a = mt * mt * mt
    b = 3 * mt * mt * t
    c = 3 * mt * t * t
    d = t * t * t
    return [
        a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0],
        a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1],
    ]


def _bezier_segment(node_a: dict, node_b: dict) -> list[list[float]]:
    """Tessellate the boundary edge from node_a to node_b.

    Returns the points *after* node_a up to and including node_b. The edge is a
    straight line unless one of the nodes carries a Bezier control handle.

    X-Plane stores one control point per node and treats it as a symmetric
    handle: the handle leaving the node is the point as given; the handle
    entering the node is its mirror through the node (2*node - control).
    """
    a = node_a["pt"]
    b = node_b["pt"]
    ca = node_a["ctrl"]  # handle leaving A (used as given)
    cb = node_b["ctrl"]  # A's mirror of this is the handle entering B
    if ca is None and cb is None:
        return [b]
    p1 = ca if ca is not None else a
    p2 = [2 * b[0] - cb[0], 2 * b[1] - cb[1]] if cb is not None else b
    return [
        _cubic_point(a, p1, p2, b, i / BEZIER_SAMPLES)
        for i in range(1, BEZIER_SAMPLES + 1)
    ]


def tessellate_contour(nodes: list[dict]) -> list[list[float]] | None:
    """Build a closed ring [lon, lat] from pavement boundary nodes, expanding
    Bezier edges into short straight segments. The contour wraps from the last
    node back to the first."""
    if len(nodes) < 3:
        return None
    ring = [nodes[0]["pt"]]
    n = len(nodes)
    for i in range(n):
        ring.extend(_bezier_segment(nodes[i], nodes[(i + 1) % n]))
    if ring[0] != ring[-1]:
        ring.append(ring[0])
    return ring


def parse_apt_dat(
    path: Path, oa_lookup: dict[str, dict] | None = None
) -> Iterator[dict]:
    """Yield GeoJSON features for each airport in an apt.dat file.

    Emits, per airport: one ``kind: "airport"`` Point, a ``kind: "runway"``
    Polygon for each land runway, and a ``kind: "pavement"`` Polygon for each
    taxiway / apron (row code 110). Bezier control points on pavement nodes are
    expanded into smooth curves (see ``tessellate_contour``).

    If ``oa_lookup`` (from ``load_ourairports``) is given, an airport's class
    drives its importance score and map minzoom; otherwise the longest runway
    is used as the fallback proxy.
    """
    current: Airport | None = None

    # Pavement (taxiway/apron) accumulation state. A 110 row opens a polygon;
    # 111/112 add boundary nodes (112 carries a bezier handle); 113/114 add the
    # final node of a contour and close it. The first contour is the outer ring;
    # any further contours are holes. A pavement polygon spans many rows, so
    # this state persists across loop iterations until a non-node row flushes
    # it. Nodes are kept as {"pt": [lon, lat], "ctrl": [lon, lat] | None} so the
    # closed contour can be tessellated with its curves intact.
    pave_active = False
    pave_surface = 0
    pave_rings: list[list[list[float]]] = []
    pave_nodes: list[dict] = []

    def flush_pavement() -> list[dict]:
        nonlocal pave_active, pave_surface, pave_rings, pave_nodes
        out: list[dict] = []
        if pave_active:
            # A contour left open (no closing 113/114) is still usable.
            if len(pave_nodes) >= 3:
                ring = tessellate_contour(pave_nodes)
                if ring is not None:
                    pave_rings.append(ring)
            rings = [r for r in pave_rings if len(r) >= 4]
            if rings and current is not None:
                out.append(
                    {
                        "type": "Feature",
                        "geometry": {"type": "Polygon", "coordinates": rings},
                        "properties": {
                            "kind": "pavement",
                            "airport": current.icao,
                            "surface": pave_surface,
                        },
                    }
                )
        pave_active = False
        pave_surface = 0
        pave_rings = []
        pave_nodes = []
        return out

    def finalize(airport: Airport | None) -> Iterator[dict]:
        if airport is None:
            return
        ref = airport.reference_point()
        if ref is not None:
            lat, lon = ref
            runway_m = airport.longest_runway_m
            oa = oa_lookup.get(airport.icao.upper()) if oa_lookup else None
            oa_type = oa["type"] if oa else ""
            # Importance rank comes purely from the OurAirports class; airports
            # not present in OurAirports default to 0 (least important). Runway
            # length is no longer used for ranking - only to detect heliports.
            rank = _OA_CLASS_RANK.get(oa_type, 0)
            score = rank
            # Heliports: explicit apt.dat heliport headers, OurAirports
            # heliports, or runway-less fields that only have helipads.
            is_heliport = (
                airport.header_code == "17"
                or oa_type == "heliport"
                or (runway_m == 0 and airport.has_helipad)
            )
            props = {
                "kind": "heliport" if is_heliport else "airport",
                "ident": airport.icao,
                "name": airport.name,
                "score": score,
                "rank": rank,
            }
            if oa and oa["iata"]:
                props["iata"] = oa["iata"]
            feat = {
                "type": "Feature",
                # tippecanoe.minzoom is baked in later by assign_airport_minzooms
                # (density-aware, rank-prioritised) so tippecanoe's geographic
                # dot-dropping can't drop a major hub while keeping a minor one.
                "geometry": {"type": "Point", "coordinates": [lon, lat]},
                "properties": props,
            }
            if not is_heliport:
                # Transient importance tie-break for the declutter; stripped
                # before the feature is written out.
                feat["_sort"] = round(runway_m)
            yield feat
        for rwy in airport.runways:
            ring = runway_polygon(rwy)
            if ring is None:
                continue
            yield {
                "type": "Feature",
                "geometry": {"type": "Polygon", "coordinates": ring},
                "properties": {
                    "kind": "runway",
                    "ident": rwy.ident,
                    "airport": airport.icao,
                    "textrot": round(runway_label_rotation(rwy), 1),
                },
            }

    with path.open(encoding="utf-8", errors="replace") as fh:
        for raw in fh:
            line = raw.strip()
            if not line:
                continue
            tokens = line.split()
            code = tokens[0]

            # --- pavement nodes are handled first; a polygon spans many rows ---
            if code == PAVEMENT_HEADER_CODE:
                yield from flush_pavement()
                if current is not None:
                    pave_active = True
                    surf = _safe_float(tokens[1]) if len(tokens) > 1 else None
                    pave_surface = int(surf) if surf is not None else 0
                continue
            if code in PAVEMENT_NODE_CODES:
                if pave_active and len(tokens) >= 3:
                    lat = _safe_float(tokens[1])
                    lon = _safe_float(tokens[2])
                    if lat is not None and lon is not None:
                        # Only 112/114/116 carry a bezier control point (tok
                        # 3/4); on plain nodes any trailing tokens are line
                        # attributes and must not be read as coordinates.
                        ctrl = None
                        if code in PAVEMENT_BEZIER_CODES and len(tokens) >= 5:
                            clat = _safe_float(tokens[3])
                            clon = _safe_float(tokens[4])
                            if clat is not None and clon is not None:
                                ctrl = [clon, clat]
                        pave_nodes.append({"pt": [lon, lat], "ctrl": ctrl})
                        if code in PAVEMENT_CLOSE_CODES:
                            ring = tessellate_contour(pave_nodes)
                            if ring is not None:
                                pave_rings.append(ring)
                            pave_nodes = []
                continue

            # Any other row ends an in-progress pavement polygon.
            yield from flush_pavement()

            if code in AIRPORT_HEADER_CODES:
                # New airport header closes out the previous one.
                yield from finalize(current)
                # `1 <elev_ft> <deprecated> <deprecated> <ICAO> <name...>`
                icao = tokens[4] if len(tokens) > 4 else ""
                name = " ".join(tokens[5:]) if len(tokens) > 5 else ""
                current = Airport(icao=icao, name=name, header_code=code)

            elif current is None:
                # Header / version lines before the first airport: ignore.
                continue

            elif code == RUNWAY_LAND_CODE and len(tokens) > 18:
                # Land runway: endpoint 1 lat/lon at 9/10, endpoint 2 at 18/19,
                # width (metres) at 1, end designators at 8 and 17.
                lat1 = _safe_float(tokens[9])
                lon1 = _safe_float(tokens[10])
                lat2 = _safe_float(tokens[18])
                lon2 = _safe_float(tokens[19])
                width = _safe_float(tokens[1])
                for lat, lon in ((lat1, lon1), (lat2, lon2)):
                    if lat is not None and lon is not None:
                        current.add_point(lat, lon)
                if None not in (lat1, lon1, lat2, lon2) and width:
                    ident = f"{tokens[8]}/{tokens[17]}"
                    current.runways.append(
                        Runway(ident, lat1, lon1, lat2, lon2, width)
                    )
                    current.longest_runway_m = max(
                        current.longest_runway_m,
                        _distance_m(lat1, lon1, lat2, lon2),
                    )

            elif code == RUNWAY_WATER_CODE and len(tokens) > 8:
                # Water runway: `101 width buoys 1 lat1 lon1 2 lat2 lon2`.
                wlat1 = _safe_float(tokens[4])
                wlon1 = _safe_float(tokens[5])
                wlat2 = _safe_float(tokens[7])
                wlon2 = _safe_float(tokens[8])
                for lat, lon in ((wlat1, wlon1), (wlat2, wlon2)):
                    if lat is not None and lon is not None:
                        current.add_point(lat, lon)
                if None not in (wlat1, wlon1, wlat2, wlon2):
                    current.longest_runway_m = max(
                        current.longest_runway_m,
                        _distance_m(wlat1, wlon1, wlat2, wlon2),
                    )

            elif code == HELIPAD_CODE and len(tokens) > 3:
                # Helipad: `102 designator lat lon ...`.
                current.has_helipad = True
                lat = _safe_float(tokens[2])
                lon = _safe_float(tokens[3])
                if lat is not None and lon is not None:
                    current.add_point(lat, lon)

            elif code == METADATA_CODE and len(tokens) >= 3:
                # `1302 <key> <value...>` - capture the official datum if given.
                key = tokens[1]
                if key == "datum_lat":
                    current.datum_lat = _safe_float(tokens[2])
                elif key == "datum_lon":
                    current.datum_lon = _safe_float(tokens[2])

        # Flush any trailing pavement, then the final airport in the file.
        yield from flush_pavement()
        yield from finalize(current)


def parse_fix_dat(path: Path) -> Iterator[dict]:
    """Yield GeoJSON Point features for each enroute fix in earth_fix.dat.

    Row layout (XP 1101+): ``<lat> <lon> <ident> <terminal> <region> <type>``.
    Older files only carry ``<lat> <lon> <ident>``; both are handled.
    """
    with path.open(encoding="utf-8", errors="replace") as fh:
        for raw in fh:
            line = raw.strip()
            if not line:
                continue
            # File terminator.
            if line == "99":
                break
            tokens = line.split()
            if len(tokens) < 3:
                # Header / version lines (e.g. "I", "1101 Version ...").
                continue
            lat = _safe_float(tokens[0])
            lon = _safe_float(tokens[1])
            if lat is None or lon is None:
                # Non-data line that happened to have 3+ tokens.
                continue
            ident = tokens[2]
            region = tokens[4] if len(tokens) > 4 else ""
            yield {
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [lon, lat]},
                "properties": {
                    "kind": "waypoint",
                    "ident": ident,
                    "region": region,
                },
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


def write_apt_layers(
    features: Iterable[dict], out_dir: Path
) -> tuple[dict[str, int], list[dict]]:
    """Split the apt.dat feature stream into per-kind GeoJSON files in one pass.

    ``parse_apt_dat`` interleaves airport/heliport points, runway polygons and
    pavement polygons. Pavement is the bulk of the file (potentially millions
    of vertices), so rather than materialise everything we stream each feature
    to its layer file as it arrives, retaining only the (small) airport and
    heliport points in memory for the search index.

    Returns ``(counts_by_kind, point_features)`` where point_features are the
    searchable airport + heliport points.
    """
    fnames = {
        "airport": out_dir / "airports.geojson",
        "heliport": out_dir / "heliports.geojson",
        "runway": out_dir / "runways.geojson",
        "pavement": out_dir / "pavement.geojson",
    }
    # Airports are buffered (not streamed) so a density-aware tippecanoe.minzoom
    # can be computed across all of them before writing. The rest stream, since
    # pavement in particular is far too large to hold in memory.
    stream_kinds = ("heliport", "runway", "pavement")
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
    for typeahead search by identifier *or* airport name. Returns
    (airport_count, waypoint_count).
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
                iata  TEXT NOT NULL DEFAULT ''  -- IATA code, when known
            )
            """
        )
        # Full-text index over ident + name. content='navaids' makes this an
        # external-content table so the text is not duplicated; we populate it
        # from the base table below.
        conn.execute(
            """
            CREATE VIRTUAL TABLE navaids_fts USING fts5(
                ident, name, iata,
                content='navaids', content_rowid='id',
                tokenize='unicode61'
            )
            """
        )

        def rows(features: Iterable[dict]) -> Iterator[tuple]:
            for feat in features:
                props = feat["properties"]
                lon, lat = feat["geometry"]["coordinates"]
                name = props.get("name") or props.get("region") or ""
                score = props.get("score", 0)
                rank = props.get("rank", 0)
                iata = props.get("iata", "")
                yield (props["kind"], props["ident"], name, lat, lon, score, rank, iata)

        airport_rows = list(rows(airports))
        waypoint_rows = list(rows(waypoints))
        insert_sql = (
            "INSERT INTO navaids (kind, ident, name, lat, lon, score, rank, iata) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        )
        conn.executemany(insert_sql, airport_rows)
        conn.executemany(insert_sql, waypoint_rows)
        # Populate the FTS index from the base table.
        conn.execute(
            "INSERT INTO navaids_fts (rowid, ident, name, iata) "
            "SELECT id, ident, name, iata FROM navaids"
        )
        conn.commit()
        return len(airport_rows), len(waypoint_rows)
    finally:
        conn.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apt", type=Path, help="Path to apt.dat")
    parser.add_argument("--fix", type=Path, help="Path to earth_fix.dat")
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=Path("build"),
        help="Directory for generated artifacts (default: ./build)",
    )
    parser.add_argument(
        "--ourairports",
        type=Path,
        help="Path to an OurAirports airports.csv for class-based importance",
    )
    parser.add_argument(
        "--no-index",
        action="store_true",
        help="Skip building the SQLite search index",
    )
    args = parser.parse_args(argv)

    if not args.apt and not args.fix:
        parser.error("provide at least one of --apt or --fix")

    oa_lookup: dict[str, dict] | None = None
    if args.ourairports:
        if not args.ourairports.exists():
            print(f"error: OurAirports CSV not found: {args.ourairports}", file=sys.stderr)
            return 1
        oa_lookup = load_ourairports(args.ourairports)
        print(f"OurAirports: {len(oa_lookup)} codes loaded from {args.ourairports}")

    args.out_dir.mkdir(parents=True, exist_ok=True)

    # Parse once into memory so the features can feed both GeoJSON and the
    # SQLite index. Global datasets are a few hundred thousand small dicts,
    # which is comfortably in range for a build machine.
    airports: list[dict] = []
    waypoints: list[dict] = []

    if args.apt:
        if not args.apt.exists():
            print(f"error: apt.dat not found: {args.apt}", file=sys.stderr)
            return 1
        # parse_apt_dat interleaves airports, runways and pavement; stream each
        # to its own GeoJSON / tile layer. Only the airport points (retained by
        # write_apt_layers) feed the search index.
        counts, airports = write_apt_layers(
            parse_apt_dat(args.apt, oa_lookup), args.out_dir
        )
        print(f"airports: {counts['airport']} features -> {args.out_dir / 'airports.geojson'}")
        print(f"heliports: {counts['heliport']} features -> {args.out_dir / 'heliports.geojson'}")
        print(f"runways: {counts['runway']} features -> {args.out_dir / 'runways.geojson'}")
        print(f"pavement: {counts['pavement']} features -> {args.out_dir / 'pavement.geojson'}")

    if args.fix:
        if not args.fix.exists():
            print(f"error: earth_fix.dat not found: {args.fix}", file=sys.stderr)
            return 1
        waypoints = list(parse_fix_dat(args.fix))
        n = write_geojson(waypoints, args.out_dir / "waypoints.geojson")
        print(f"waypoints: {n} features -> {args.out_dir / 'waypoints.geojson'}")

    if not args.no_index:
        db_path = args.out_dir / "navdata.sqlite"
        a, w = build_search_index(db_path, airports, waypoints)
        print(
            f"search index: {a + w} rows "
            f"({a} airports/heliports, {w} waypoints) -> {db_path}"
        )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
