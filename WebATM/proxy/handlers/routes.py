"""Route data handler for aircraft route visualization."""

import time

from ...logger import get_logger
from ...utils import make_json_serializable
from ._base import get_bluesky_proxy

logger = get_logger()


def on_routedata_received(data):
    """Handle route data updates for aircraft."""
    proxy = get_bluesky_proxy()
    if not proxy:
        return

    # Ignore data if reconnection is not allowed (we're disconnected)
    if not proxy.allow_reconnection:
        return

    # Only emit route data for aircraft from the active node
    # This prevents flickering when switching between nodes
    active_node_id = proxy._get_safe_active_node()
    if not active_node_id:
        logger.debug("Route data ignored - no active node available")
        return

    # Filter on the aircraft ID, supporting both attribute- and dict-style data.
    route_aircraft_id = getattr(data, "acid", None)
    if route_aircraft_id is None and hasattr(data, "get"):
        route_aircraft_id = data.get("acid")
    if not route_aircraft_id:
        logger.debug("Route data ignored - no aircraft ID found")
        return

    # Check if we have current aircraft data and if this aircraft is in the active node's data
    if hasattr(proxy, "traffic_data") and proxy.traffic_data:
        aircraft_ids = proxy.traffic_data.get("id", [])
        if route_aircraft_id not in aircraft_ids:
            return

    # Mark successful data reception
    proxy.last_successful_update = time.time()

    # Convert to JSON-serializable format
    route_data = make_json_serializable(data)

    # Emit to connected clients
    if proxy.socketio and proxy.connected_clients > 0:
        try:
            proxy.socketio.emit("routedata", route_data)
        except Exception:
            # Handle emission errors gracefully (e.g., disconnected clients)
            pass
