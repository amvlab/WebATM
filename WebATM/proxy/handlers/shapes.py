"""Handle BlueSky POLY shape events and split them into polygons and polylines.

BlueSky publishes all drawn shapes on a single POLY topic as shared-state
updates: the network client strips the ``[action, payload]`` wrapper and
records the action (Update/Delete/Replace/...) on its context before
dispatching here. This module applies each action to the per-node shape stores
on the proxy, separates polygons from polylines by their ``shape`` field, and
forwards the active node's shapes to browsers as the ``poly`` and ``polyline``
Socket.IO events.
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

# Shared-state action markers (bluesky.network.common.ActionType values,
# decoded to str). Replace/Reset/ActChange overwrite a node's stored shapes;
# Delete removes the named shapes; anything else merges. The RESET/ACTCHANGE
# spellings cover the client's translated context constants.
_REPLACE_ACTIONS = {"R", "X", "C", "RESET", "ACTCHANGE"}
_DELETE_ACTION = "D"

# Cap on stored shapes per node and kind (demo limit): oldest are dropped.
_MAX_SHAPES_PER_KIND = 5


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


def _coords_to_latlon(shape_dict, name, min_values):
    """Split a flat ``coordinates`` array into ``lat``/``lon`` lists, in place.

    BlueSky sends shape outlines as one flat ``[lat1, lon1, lat2, lon2, ...]``
    array; the web client wants separate ``lat`` and ``lon`` lists. Shapes that
    already carry ``lat``/``lon``, or whose coordinate array is missing or too
    short, are left untouched.

    Args:
        shape_dict (dict): Per-shape payload, modified in place.
        name (str): Shape name, stamped onto the payload for the frontend.
        min_values (int): Minimum coordinate-array length (2 values per point).
    """
    if "lat" in shape_dict and "lon" in shape_dict:
        return
    coords = shape_dict.get("coordinates")
    if isinstance(coords, list) and len(coords) >= min_values:
        shape_dict["lat"] = coords[0::2]
        shape_dict["lon"] = coords[1::2]
        shape_dict["name"] = name


def _context_info(proxy):
    """Return the (sender, action) the network client recorded for this message.

    The client sets ``context.sender_id`` and ``context.action`` just before
    dispatching each POLY shared-state message (the ``[action, payload]``
    wrapper itself is stripped before the handler is called).

    Args:
        proxy (BlueSkyProxy): The active proxy.

    Returns:
        tuple[str | None, str | None]: Hex sender ID and action marker, either
        of which may be None when no context is available.
    """
    ctx = getattr(proxy.bluesky_client, "context", None)
    if ctx is None:
        return None, None
    action = ctx.action
    if isinstance(action, bytes):
        action = action.decode("charmap", errors="replace")
    return id2str(ctx.sender_id), action


def _shapes_of(separated):
    """Return the ``polys`` mapping from one side of the separated data.

    Args:
        separated (Any): The ``polygons`` or ``polylines`` value produced by
            ``_separate_poly_and_polyline_data`` (which falls back to the raw
            payload on unexpected formats).

    Returns:
        dict: The shape mapping, or an empty dict when absent or malformed.
    """
    if isinstance(separated, dict):
        polys = separated.get("polys", {})
        if isinstance(polys, dict):
            return polys
    return {}


def _deleted_names(poly_data):
    """Extract the shape names listed in a Delete-action payload.

    BlueSky's ``send_delete(polys=[name, ...])`` arrives as
    ``{"polys": [name, ...]}``.

    Args:
        poly_data (Any): The JSON-serializable Delete payload.

    Returns:
        list: The shape names to remove (empty for malformed payloads).
    """
    if isinstance(poly_data, dict):
        names = poly_data.get("polys")
        if isinstance(names, (list, tuple)):
            return [n for n in names if isinstance(n, str)]
        if isinstance(names, dict):
            return list(names)
    return []


def _merge_shape(target, name, info):
    """Merge one shape payload into a store, patching partial updates in place.

    An Update action may carry only the changed fields (e.g. a COLOR change
    sends ``{"color": ...}`` without coordinates); replacing the stored entry
    would wipe the shape's geometry, so dict payloads are merged into the
    existing dict instead.

    Args:
        target (dict): Shape store (name -> shape info) to merge into.
        name (str): Shape name.
        info (Any): New shape payload.
    """
    existing = target.get(name)
    if isinstance(existing, dict) and isinstance(info, dict):
        existing.update(info)
    else:
        target[name] = info


def _merge_shapes(store_polys, store_lines, new_polys, new_lines):
    """Merge separated new shapes into a node's polygon and polyline stores.

    Args:
        store_polys (dict): Stored polygon mapping for the node.
        store_lines (dict): Stored polyline mapping for the node.
        new_polys (dict): Newly received polygon shapes.
        new_lines (dict): Newly received polyline shapes.
    """
    for name, info in new_polys.items():
        # A partial update carries no 'shape' field and lands in the polygon
        # bucket by default; route it to the store that already holds the shape
        # so a polyline's update doesn't create a phantom polygon.
        if name in store_lines and name not in store_polys:
            _merge_shape(store_lines, name, info)
        else:
            _merge_shape(store_polys, name, info)
    for name, info in new_lines.items():
        _merge_shape(store_lines, name, info)


def _trim_shape_store(polys, kind):
    """Drop the oldest shapes beyond the per-kind cap, in place.

    Args:
        polys (dict): Shape mapping (insertion-ordered) to trim.
        kind (str): "polygons" or "polylines", for logging.
    """
    if len(polys) > _MAX_SHAPES_PER_KIND:
        for name in list(polys.keys())[:-_MAX_SHAPES_PER_KIND]:
            del polys[name]
        logger.debug(
            f"Demo limit: keeping the {_MAX_SHAPES_PER_KIND} most recent {kind}"
        )


def on_poly_received(data, *args, **kwargs):
    """Process a BlueSky POLY event and emit ``poly``/``polyline`` to web clients.

    Resolves the sending node and shared-state action from the BlueSky network
    context and applies the message to that node's stored shapes: Delete
    removes the named shapes, Replace/Reset/ActChange overwrite the stored
    sets, and updates merge into them (patching partial per-shape updates such
    as a colour change). At most the five most recent polygons and polylines
    are kept per node. The complete stored shape sets are emitted only when
    the sender is the currently active node.

    Args:
        data (dict): POLY payload from the BlueSky server (the shared-state
            action wrapper is already stripped by the network client): a
            ``polys`` mapping of shape name to shape info, or a list of shape
            names for a Delete action.
        *args (Any): Extra positional arguments from the network dispatch (unused).
        **kwargs (Any): Extra keyword arguments from the network dispatch (unused).
    """
    proxy = active_proxy()
    if not proxy:
        return

    try:
        sender_id, action = _context_info(proxy)
        poly_data = make_json_serializable(data)

        if sender_id:
            poly_store = proxy.poly_data_by_node.setdefault(sender_id, {"polys": {}})
            line_store = proxy.polyline_data_by_node.setdefault(
                sender_id, {"polys": {}}
            )

            if action == _DELETE_ACTION:
                for name in _deleted_names(poly_data):
                    poly_store["polys"].pop(name, None)
                    line_store["polys"].pop(name, None)
            else:
                separated = _separate_poly_and_polyline_data(poly_data)
                new_polys = _shapes_of(separated["polygons"])
                new_lines = _shapes_of(separated["polylines"])

                if action in _REPLACE_ACTIONS:
                    poly_store["polys"] = new_polys
                    line_store["polys"] = new_lines
                else:
                    _merge_shapes(
                        poly_store["polys"], line_store["polys"], new_polys, new_lines
                    )

                _trim_shape_store(poly_store["polys"], "polygons")
                _trim_shape_store(line_store["polys"], "polylines")

        # Only the active node's shapes are displayed; emit the complete stored
        # sets (not just this message's shapes).
        active_node_id = proxy._get_safe_active_node()
        if sender_id and active_node_id and sender_id == active_node_id:
            if proxy.socketio:
                proxy.socketio.emit(
                    "poly", proxy.poly_data_by_node.get(sender_id, {"polys": {}})
                )
                proxy.socketio.emit(
                    "polyline",
                    proxy.polyline_data_by_node.get(sender_id, {"polys": {}}),
                )

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
        if isinstance(poly_data, dict) and "polys" in poly_data:
            polygons_polys = {}
            polylines_polys = {}

            for name, poly_info in poly_data["polys"].items():
                if not isinstance(poly_info, dict):
                    # Fallback: assume it's a polygon if no shape info.
                    polygons_polys[name] = poly_info
                    continue

                info = poly_info.copy()
                shape = info.get("shape", "POLY")

                if shape == "LINE":
                    _coords_to_latlon(info, name, min_values=4)  # >= 2 points
                    polylines_polys[name] = info
                    continue

                if shape == "BOX":
                    # Two opposite corners; expand into a 4-corner POLY ring
                    # (the flat-pair path below can't - a box has only 2 points).
                    info["shape"] = "POLY"
                    if not ("lat" in info and "lon" in info):
                        corners = _box_corners(info.get("coordinates"))
                        if corners:
                            info["lat"], info["lon"] = corners
                            info["name"] = name
                elif shape == "CIRCLE":
                    # Centre + radius (nm); tessellate into a POLY ring.
                    info["shape"] = "POLY"
                    if not ("lat" in info and "lon" in info):
                        ring = _circle_ring(info.get("coordinates"))
                        if ring:
                            info["lat"], info["lon"] = ring
                            info["name"] = name
                else:  # POLY, POLYALT, or anything else
                    if shape == "POLYALT":
                        info["shape"] = "POLY"
                    _coords_to_latlon(info, name, min_values=6)  # >= 3 points

                polygons_polys[name] = info

            # Keep any finite vertical bounds (amvlab BlueSky) and drop the
            # unbounded sentinels, so 3D extrusion only kicks in for shapes
            # that actually have an extent.
            for entry in polygons_polys.values():
                if isinstance(entry, dict):
                    _normalize_altitudes(entry)

            if polygons_polys:
                polygons_data = {"polys": polygons_polys}
            if polylines_polys:
                polylines_data = {"polys": polylines_polys}

        else:
            # Not in the expected format - treat the whole payload as polygons.
            polygons_data = poly_data

    except Exception as e:
        logger.error(f"Error separating POLY data: {e}")
        polygons_data = poly_data
        polylines_data = {}

    return {"polygons": polygons_data, "polylines": polylines_data}
