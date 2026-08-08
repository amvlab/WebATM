#!/usr/bin/env python3
"""Split an OSM aeroway export into pavement / taxiway / building layers.

This is an *offline* build step, complementing ``parse_ourairports.py``:
OurAirports has no taxiway/apron/terminal geometry, so that comes from
OpenStreetMap (ODbL - attribution required). The expected input is the GeoJSON
(or GeoJSONSeq) produced by ``osmium export`` over an ``osmium tags-filter``
extract of ``aeroway=apron/taxiway/terminal/hangar`` -
``build_navdata_tiles.sh`` runs those steps when given ``--osm-pbf``.

Outputs, ready for tippecanoe (see ``build_navdata_tiles.sh``):

  * ``pavement.geojson``  - Polygon features: aprons, plus taxiways mapped as
                            areas. Closed apron *ways* that osmium exported as
                            LineStrings are promoted to polygons here.
  * ``taxiways.geojson``  - LineString features: taxiway centrelines, keeping
                            the ``ref`` designator (e.g. "A4") when tagged.
  * ``buildings.geojson`` - Polygon features: terminals and hangars, keeping
                            ``name`` when tagged, so airports read like the
                            familiar OSM rendering close in.

Stdlib only - no third-party dependencies - so it runs anywhere Python 3.9+ is
available.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Iterator
from pathlib import Path


def read_features(path: Path) -> Iterator[dict]:
    """Yield features from a GeoJSON FeatureCollection or a GeoJSONSeq file.

    ``osmium export -f geojsonseq`` writes one RS-prefixed feature per line
    (RFC 8142), which streams nicely; plain FeatureCollections are supported
    too so hand-made extracts also work.
    """
    with path.open(encoding="utf-8") as fh:
        head = fh.read(1)
        fh.seek(0)
        if head == "{":
            # A whole FeatureCollection (osmium's default -f geojson).
            yield from json.load(fh).get("features", [])
            return
        for line in fh:
            line = line.strip().lstrip("\x1e")
            if not line:
                continue
            obj = json.loads(line)
            if obj.get("type") == "Feature":
                yield obj


def _close_ring(coords: list) -> list | None:
    """Return ``coords`` as a closed ring, or None if it cannot form one."""
    if len(coords) < 3:
        return None
    if coords[0] != coords[-1]:
        coords = [*coords, coords[0]]
    return coords if len(coords) >= 4 else None


_BUILDING_AEROWAYS = ("terminal", "hangar")


def split_features(features: Iterator[dict]) -> Iterator[tuple[str, dict]]:
    """Classify each aeroway feature into its output layer.

    * ``aeroway=apron``: polygons pass through to the pavement layer; closed
      LineStrings (aprons mapped as plain closed ways, which osmium may not
      assemble into areas) are promoted to polygons.
    * ``aeroway=taxiway``: polygons (taxiways mapped as areas) join the
      pavement layer; LineStrings are the centreline layer.
    * ``aeroway=terminal`` / ``aeroway=hangar``: polygons (closed LineStrings
      promoted, as for aprons) form the buildings layer, with ``name`` kept
      for possible labelling.

    Anything else - other aeroway values, unusable geometry - is dropped.
    """
    for feat in features:
        props = feat.get("properties") or {}
        aeroway = props.get("aeroway")
        if aeroway not in ("apron", "taxiway", *_BUILDING_AEROWAYS):
            continue
        geom = feat.get("geometry") or {}
        gtype = geom.get("type")

        if aeroway in _BUILDING_AEROWAYS:
            if gtype == "LineString":
                ring = _close_ring(list(geom.get("coordinates") or []))
                if ring is None:
                    continue
                geom = {"type": "Polygon", "coordinates": [ring]}
            elif gtype not in ("Polygon", "MultiPolygon"):
                continue
            out_props = {"kind": aeroway}
            name = (props.get("name") or "").strip()
            if name:
                out_props["name"] = name
            yield (
                "building",
                {
                    "type": "Feature",
                    "geometry": geom,
                    "properties": out_props,
                },
            )
        elif gtype in ("Polygon", "MultiPolygon"):
            yield (
                "pavement",
                {
                    "type": "Feature",
                    "geometry": geom,
                    "properties": {"kind": "pavement", "aeroway": aeroway},
                },
            )
        elif gtype == "LineString":
            if aeroway == "apron":
                ring = _close_ring(list(geom.get("coordinates") or []))
                if ring is None:
                    continue
                yield (
                    "pavement",
                    {
                        "type": "Feature",
                        "geometry": {"type": "Polygon", "coordinates": [ring]},
                        "properties": {"kind": "pavement", "aeroway": aeroway},
                    },
                )
            else:
                out_props = {"kind": "taxiway"}
                ref = (props.get("ref") or "").strip()
                if ref:
                    out_props["ref"] = ref
                yield (
                    "taxiway",
                    {
                        "type": "Feature",
                        "geometry": geom,
                        "properties": out_props,
                    },
                )


def write_layers(
    classified: Iterator[tuple[str, dict]], out_dir: Path
) -> dict[str, int]:
    """Stream the classified features into their per-layer GeoJSON files."""
    fnames = {
        "pavement": out_dir / "pavement.geojson",
        "taxiway": out_dir / "taxiways.geojson",
        "building": out_dir / "buildings.geojson",
    }
    handles = {k: p.open("w", encoding="utf-8") for k, p in fnames.items()}
    counts = dict.fromkeys(fnames, 0)
    try:
        for h in handles.values():
            h.write('{"type":"FeatureCollection","features":[')
        for layer, feat in classified:
            handle = handles[layer]
            if counts[layer]:
                handle.write(",")
            json.dump(feat, handle, separators=(",", ":"))
            counts[layer] += 1
    finally:
        for h in handles.values():
            h.write("]}")
            h.close()
    return counts


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "aeroways",
        type=Path,
        help="GeoJSON / GeoJSONSeq aeroway export (from osmium export)",
    )
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=Path("build"),
        help="Directory for generated artifacts (default: ./build)",
    )
    args = parser.parse_args(argv)

    if not args.aeroways.exists():
        print(f"error: aeroway export not found: {args.aeroways}", file=sys.stderr)
        return 1

    args.out_dir.mkdir(parents=True, exist_ok=True)
    counts = write_layers(split_features(read_features(args.aeroways)), args.out_dir)
    print(
        f"pavement: {counts['pavement']} features -> {args.out_dir / 'pavement.geojson'}"
    )
    print(
        f"taxiways: {counts['taxiway']} features -> {args.out_dir / 'taxiways.geojson'}"
    )
    print(
        f"buildings: {counts['building']} features -> {args.out_dir / 'buildings.geojson'}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
