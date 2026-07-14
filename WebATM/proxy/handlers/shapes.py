"""Handle BlueSky POLY shape events and split them into polygons and polylines.

BlueSky publishes all drawn shapes on a single POLY topic. This module stores
them per sending node on the proxy, separates polygons from polylines by their
``shape`` field, and forwards the active node's shapes to browsers as the
``poly`` and ``polyline`` Socket.IO events.
"""

import math

from ...logger import get_logger
from ...utils import id2str, make_json_serializable
from ._base import active_proxy

logger = get_logger()

# Number of segments used to approximate a CIRCLE shape as a polygon ring.
_CIRCLE_SEGMENTS = 72

# Nautical miles per degree of latitude (1 arc-minute == 1 nm).
_NM_PER_DEGREE = 60.0

# BlueSky stores a shape's vertical extent (metres) on ``Shape.top``/``bottom``,
# defaulting to +/-1e9 for "unbounded". amvlab BlueSky additionally publishes
# these on the POLY payload so WebATM can extrude the shape into a 3D volume;
# vanilla BlueSky omits them. Any bound at or beyond this magnitude is treated
# as unbounded (no vertical extent -> flat 2D, the vanilla behaviour).
_ALT_UNBOUNDED = 9e8


def _normalize_altitudes(shape_dict):
    """Keep only finite vertical bounds on a shape dict, in place.

    amvlab BlueSky publishes ``top``/``bottom`` (metres) on each shape so the
    frontend can extrude it; vanilla BlueSky sends neither. BlueSky uses
    +/-1e9 as its "unbounded" sentinel, which must never reach the 3D renderer
    as a literal extrusion height. This keeps ``top`` only when it is a finite
    upper bound and ``bottom`` only when it is a finite lower bound, popping
    anything else (missing, non-numeric, or sentinel) so the shape renders flat.

    The frontend treats the mere presence of ``top`` as "has altitude", so a
    fully-unbounded shape ends up with neither key and renders in 2D, exactly
    like it does against vanilla BlueSky.

    Args:
        shape_dict (dict): A per-shape payload that may carry ``top``/``bottom``.
    """
    top = shape_dict.get("top")
    if (
        not isinstance(top, (int, float))
        or isinstance(top, bool)
        or top >= _ALT_UNBOUNDED
    ):
        shape_dict.pop("top", None)
    bottom = shape_dict.get("bottom")
    if (
        not isinstance(bottom, (int, float))
        or isinstance(bottom, bool)
        or bottom <= -_ALT_UNBOUNDED
    ):
        shape_dict.pop("bottom", None)


def _box_corners(coordinates):
    """Expand a BOX's two opposite corners into a 4-corner polygon ring.

    BlueSky publishes a BOX as ``[lat0, lon0, lat1, lon1]`` - two opposite
    corners of an axis-aligned rectangle. This returns the four corners as
    separate ``lat``/``lon`` lists, or ``None`` when the coordinate list is
    malformed.

    Args:
        coordinates (list): ``[lat0, lon0, lat1, lon1]`` corner pair.

    Returns:
        tuple[list, list] | None: ``(lats, lons)`` for the four corners, or
        None if fewer than four values were provided.
    """
    if not isinstance(coordinates, list) or len(coordinates) < 4:
        return None
    lat0, lon0, lat1, lon1 = (
        coordinates[0],
        coordinates[1],
        coordinates[2],
        coordinates[3],
    )
    lats = [lat0, lat0, lat1, lat1]
    lons = [lon0, lon1, lon1, lon0]
    return lats, lons


def _circle_ring(coordinates, segments=_CIRCLE_SEGMENTS):
    """Tessellate a CIRCLE (centre + radius) into a polygon ring.

    BlueSky publishes a CIRCLE as ``[clat, clon, radius_nm]``. This offsets
    ``segments`` evenly-spaced points around the centre using an
    equirectangular approximation (accurate at the radii used for ATM areas),
    returning them as separate ``lat``/``lon`` lists, or ``None`` when the
    coordinate list is malformed.

    Args:
        coordinates (list): ``[clat, clon, radius_nm]`` centre and radius.
        segments (int): Number of points used to approximate the circle.

    Returns:
        tuple[list, list] | None: ``(lats, lons)`` around the ring, or None if
        fewer than three values were provided.
    """
    if not isinstance(coordinates, list) or len(coordinates) < 3:
        return None
    clat, clon, radius_nm = coordinates[0], coordinates[1], coordinates[2]
    dlat = radius_nm / _NM_PER_DEGREE
    cos_lat = math.cos(math.radians(clat))
    lats = []
    lons = []
    for i in range(segments):
        theta = 2.0 * math.pi * i / segments
        lats.append(clat + dlat * math.cos(theta))
        # Near the poles cos(lat) -> 0; fall back to the centre longitude
        # rather than dividing by ~0 and producing an absurd offset.
        if abs(cos_lat) > 1e-9:
            lons.append(clon + (dlat * math.sin(theta)) / cos_lat)
        else:
            lons.append(clon)
    return lats, lons


def on_poly_received(data, *args, **kwargs):
    """Process a BlueSky POLY event and emit ``poly``/``polyline`` to web clients.

    Resolves the sending node from the BlueSky network context, splits the
    incoming shapes into polygons and polylines, and stores them per node on
    the proxy. Reset/replace/change action types ("R", "X", "C") overwrite the
    node's stored shapes; other messages merge into them. At most the five most
    recent polygons and five most recent polylines are kept per node. The
    complete stored shape sets are emitted only when the sender is the
    currently active node.

    Args:
        data (dict | list): POLY payload from the BlueSky server, typically a
            dict with a ``polys`` mapping; list payloads may carry a leading
            action-type marker.
        *args (Any): Extra positional arguments from the network dispatch (unused).
        **kwargs (Any): Extra keyword arguments from the network dispatch (unused).
    """
    proxy = active_proxy()
    if not proxy:
        return

    try:
        # Get sender_id from BlueSky context
        sender_id = None
        if proxy.bluesky_client and hasattr(proxy.bluesky_client, "context"):
            sender_id = id2str(proxy.bluesky_client.context.sender_id)

        # Convert to JSON serializable format
        poly_data = make_json_serializable(data)

        # Separate polygons and polylines based on shape
        separated_data = _separate_poly_and_polyline_data(poly_data)

        # Store both POLY and POLYLINE data by node ID
        if sender_id:
            # Initialize storage if it doesn't exist
            if sender_id not in proxy.poly_data_by_node:
                proxy.poly_data_by_node[sender_id] = {"polys": {}}
            if sender_id not in proxy.polyline_data_by_node:
                proxy.polyline_data_by_node[sender_id] = {"polys": {}}

            # Check if we need to handle RESET/REPLACE action types differently
            action_type = None
            if isinstance(data, list) and len(data) >= 2:
                action_type = data[0] if isinstance(data[0], (str, bytes)) else None
                if isinstance(action_type, bytes):
                    action_type = (
                        action_type.decode("utf-8")
                        if len(action_type) == 1
                        else action_type.hex()
                    )

            # Handle different action types
            if action_type in [
                "R",
                "X",
                "C",
            ]:  # Reset/Replace/Change - clear existing data
                if separated_data["polygons"] and separated_data["polygons"].get(
                    "polys"
                ):
                    proxy.poly_data_by_node[sender_id] = separated_data["polygons"]
                else:
                    proxy.poly_data_by_node[sender_id] = {"polys": {}}

                if separated_data["polylines"] and separated_data["polylines"].get(
                    "polys"
                ):
                    proxy.polyline_data_by_node[sender_id] = separated_data["polylines"]
                else:
                    proxy.polyline_data_by_node[sender_id] = {"polys": {}}
            else:  # Update/Append - merge with existing data
                # Merge polygons if any exist in the new data
                if separated_data["polygons"] and separated_data["polygons"].get(
                    "polys"
                ):
                    proxy.poly_data_by_node[sender_id]["polys"].update(
                        separated_data["polygons"]["polys"]
                    )

                # Merge polylines if any exist in the new data
                if separated_data["polylines"] and separated_data["polylines"].get(
                    "polys"
                ):
                    proxy.polyline_data_by_node[sender_id]["polys"].update(
                        separated_data["polylines"]["polys"]
                    )

            # Apply 5-shape limit for polygons
            if len(proxy.poly_data_by_node[sender_id]["polys"]) > 5:
                # Get shape names sorted by creation order (keep most recent 5)
                poly_names = list(proxy.poly_data_by_node[sender_id]["polys"].keys())
                shapes_to_remove = poly_names[:-5]  # Remove all but last 5
                for shape_name in shapes_to_remove:
                    del proxy.poly_data_by_node[sender_id]["polys"][shape_name]
                logger.debug(
                    f"Demo limit: Removed {len(shapes_to_remove)} polygons, keeping 5 most recent"
                )

            # Apply 5-shape limit for polylines
            if len(proxy.polyline_data_by_node[sender_id]["polys"]) > 5:
                # Get shape names sorted by creation order (keep most recent 5)
                polyline_names = list(
                    proxy.polyline_data_by_node[sender_id]["polys"].keys()
                )
                shapes_to_remove = polyline_names[:-5]  # Remove all but last 5
                for shape_name in shapes_to_remove:
                    del proxy.polyline_data_by_node[sender_id]["polys"][shape_name]
                logger.debug(
                    f"Demo limit: Removed {len(shapes_to_remove)} polylines, keeping 5 most recent"
                )

        # Only emit data if it's from the currently active node
        active_node_id = proxy._get_safe_active_node()
        if sender_id and active_node_id and sender_id == active_node_id:
            if proxy.socketio:
                # Emit the complete stored data (not just the separated data from this message)
                complete_poly_data = proxy.poly_data_by_node.get(
                    sender_id, {"polys": {}}
                )
                complete_polyline_data = proxy.polyline_data_by_node.get(
                    sender_id, {"polys": {}}
                )

                proxy.socketio.emit("poly", complete_poly_data)
                proxy.socketio.emit("polyline", complete_polyline_data)

    except Exception as e:
        logger.error(f"Error processing POLY data: {e}")
        import traceback

        traceback.print_exc()


def _separate_poly_and_polyline_data(poly_data):
    """Split combined POLY data into polygons and polylines by ``shape`` field.

    Shapes marked ``LINE`` become polylines; ``POLYALT`` shapes are rewritten
    as ``POLY`` polygons; ``BOX`` (two opposite corners) and ``CIRCLE`` (centre
    plus radius in nautical miles) are expanded into ``POLY`` polygon rings;
    everything else is treated as a polygon. Flat ``coordinates`` arrays
    (``[lat1, lon1, lat2, lon2, ...]``) are converted to separate ``lat``/``lon``
    lists for web-client compatibility. Finite ``top``/``bottom`` vertical
    bounds (metres) are passed through so the frontend can extrude the shape in
    3D; BlueSky's unbounded +/-1e9 sentinels (and vanilla BlueSky's absent
    altitudes) are dropped so those shapes stay flat. On errors or unexpected
    formats the whole payload is treated as polygons.

    Args:
        poly_data (dict): JSON-serializable POLY payload, expected to contain a
            ``polys`` mapping of shape name to shape info.

    Returns:
        dict: ``{"polygons": ..., "polylines": ...}`` where each value is a
        ``{"polys": {...}}`` structure (or empty when no shapes of that kind
        were present).
    """
    polygons_data = {}
    polylines_data = {}

    try:
        # Handle the BlueSky POLY data format
        if isinstance(poly_data, dict) and "polys" in poly_data:
            polys = poly_data["polys"]

            # Separate by shape field
            polygons_polys = {}
            polylines_polys = {}

            for name, poly_info in polys.items():
                if isinstance(poly_info, dict):
                    shape = poly_info.get(
                        "shape", "POLY"
                    )  # Default to POLY if no shape specified
                    if shape == "LINE":
                        # BlueSky sends polylines with a flat 'coordinates' array: [lat1, lon1, lat2, lon2, ...]
                        # Convert to separate lat/lon arrays for web client compatibility
                        poly_info_converted = poly_info.copy()

                        if "coordinates" in poly_info and not (
                            "lat" in poly_info and "lon" in poly_info
                        ):
                            coords = poly_info["coordinates"]
                            if (
                                isinstance(coords, list) and len(coords) >= 4
                            ):  # At least 2 points (lat1,lon1,lat2,lon2)
                                # Split flat array into separate lat/lon arrays
                                lats = [coords[i] for i in range(0, len(coords), 2)]
                                lons = [coords[i] for i in range(1, len(coords), 2)]

                                poly_info_converted["lat"] = lats
                                poly_info_converted["lon"] = lons
                                poly_info_converted["name"] = name

                        polylines_polys[name] = poly_info_converted
                    elif shape == "POLYALT":
                        # Convert POLYALT to POLY for web display
                        poly_info_copy = poly_info.copy()
                        poly_info_copy["shape"] = "POLY"

                        # Handle coordinates conversion for POLYALT too
                        if "coordinates" in poly_info_copy and not (
                            "lat" in poly_info_copy and "lon" in poly_info_copy
                        ):
                            coords = poly_info_copy["coordinates"]
                            if (
                                isinstance(coords, list) and len(coords) >= 6
                            ):  # At least 3 points for polygon
                                lats = [coords[i] for i in range(0, len(coords), 2)]
                                lons = [coords[i] for i in range(1, len(coords), 2)]
                                poly_info_copy["lat"] = lats
                                poly_info_copy["lon"] = lons
                                poly_info_copy["name"] = name

                        polygons_polys[name] = poly_info_copy
                    elif shape == "BOX":
                        # BlueSky sends a BOX as two opposite corners; expand it
                        # into a 4-corner POLY so the existing polygon renderer
                        # can draw it (the flat-pair path below can't - a box
                        # has only 4 coordinate values, i.e. 2 points).
                        poly_info_copy = poly_info.copy()
                        poly_info_copy["shape"] = "POLY"
                        if not ("lat" in poly_info and "lon" in poly_info):
                            corners = _box_corners(poly_info.get("coordinates"))
                            if corners:
                                poly_info_copy["lat"], poly_info_copy["lon"] = corners
                                poly_info_copy["name"] = name
                        polygons_polys[name] = poly_info_copy
                    elif shape == "CIRCLE":
                        # BlueSky sends a CIRCLE as centre + radius (nm);
                        # tessellate it into a POLY ring so the existing polygon
                        # renderer can draw it.
                        poly_info_copy = poly_info.copy()
                        poly_info_copy["shape"] = "POLY"
                        if not ("lat" in poly_info and "lon" in poly_info):
                            ring = _circle_ring(poly_info.get("coordinates"))
                            if ring:
                                poly_info_copy["lat"], poly_info_copy["lon"] = ring
                                poly_info_copy["name"] = name
                        polygons_polys[name] = poly_info_copy
                    else:  # 'POLY' or any other shape
                        poly_info_copy = poly_info.copy()

                        # Handle coordinates conversion for POLY too
                        if "coordinates" in poly_info_copy and not (
                            "lat" in poly_info_copy and "lon" in poly_info_copy
                        ):
                            coords = poly_info_copy["coordinates"]
                            if (
                                isinstance(coords, list) and len(coords) >= 6
                            ):  # At least 3 points for polygon
                                lats = [coords[i] for i in range(0, len(coords), 2)]
                                lons = [coords[i] for i in range(1, len(coords), 2)]
                                poly_info_copy["lat"] = lats
                                poly_info_copy["lon"] = lons
                                poly_info_copy["name"] = name

                        polygons_polys[name] = poly_info_copy
                else:
                    # Fallback: assume it's a polygon if no shape info
                    polygons_polys[name] = poly_info

            # Keep any finite vertical bounds (amvlab BlueSky) and drop the
            # unbounded sentinels / vanilla-BlueSky's absent altitudes, so 3D
            # extrusion only kicks in for shapes that actually have an extent.
            for entry in polygons_polys.values():
                if isinstance(entry, dict):
                    _normalize_altitudes(entry)

            # Create separated data structures
            if polygons_polys:
                polygons_data = {"polys": polygons_polys}
            if polylines_polys:
                polylines_data = {"polys": polylines_polys}

        else:
            # If not in expected format, treat as polygons
            polygons_data = poly_data

    except Exception as e:
        logger.error(f"Error separating POLY data: {e}")
        # Fallback: treat all as polygons
        polygons_data = poly_data
        polylines_data = {}

    return {"polygons": polygons_data, "polylines": polylines_data}
