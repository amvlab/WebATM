"""Route data handler for aircraft route visualization."""

import time

from ...logger import get_logger
from ...utils import make_json_serializable
from ._base import get_bluesky_proxy

logger = get_logger()


def on_routedata_received(data):
    """Handle ROUTEDATA events carrying an aircraft's route.

    Serializes the route and emits a ``routedata`` event to connected web
    clients. Frames that carry waypoints are only forwarded when the aircraft
    is part of the active node's traffic, preventing flicker when switching
    between nodes. Waypoint-less frames are BlueSky's route-clear broadcasts
    (route display toggled off, or the aircraft was deleted) and are always
    forwarded — the aircraft they refer to may already be gone from the
    traffic, and clients need them to drop their cached route.

    Args:
        data (dict): ROUTEDATA payload with the aircraft ID (``acid``) and,
            for route updates, waypoint arrays (``wplat``, ``wplon``, ...).
    """
    proxy = get_bluesky_proxy()
    if not proxy or not proxy.allow_reconnection:
        return

    if not proxy._get_safe_active_node():
        logger.debug("Route data ignored - no active node available")
        return

    route_aircraft_id = data.get("acid") if isinstance(data, dict) else None
    if not route_aircraft_id:
        logger.debug("Route data ignored - no aircraft ID found")
        return

    wplat = data.get("wplat")
    has_waypoints = wplat is not None and len(wplat) > 0
    if has_waypoints and proxy.traffic_data:
        if route_aircraft_id not in proxy.traffic_data.get("id", []):
            return

    proxy.last_successful_update = time.time()

    route_data = make_json_serializable(data)

    if proxy.socketio and proxy.connected_clients > 0:
        try:
            proxy.socketio.emit("routedata", route_data)
        except Exception:
            # Emission errors (e.g. disconnected clients) are non-fatal
            pass
