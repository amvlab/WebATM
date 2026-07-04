"""Event handlers for RESET and REQUEST events."""

import time

from ...logger import get_logger
from ._base import active_proxy

logger = get_logger()


def on_reset_received(data=None, *args, **kwargs):
    """Handle RESET events from the BlueSky server.

    Clears the stored polygon/polyline shapes for the node that sent the
    reset (and the active node, if different), then emits empty ``poly`` and
    ``polyline`` payloads plus a ``reset`` event so web clients clear their
    maps.

    Args:
        data (Any): Optional RESET payload (unused).
        *args (Any): Additional positional payload items (unused).
        **kwargs (Any): Additional keyword payload items (unused).
    """
    proxy = active_proxy()
    if not proxy:
        return

    try:
        # Get sender_id from BlueSky context (same pattern as on_poly_received)
        sender_id = None
        if proxy.bluesky_client and hasattr(proxy.bluesky_client, "context"):
            ctx = proxy.bluesky_client.context
            if ctx.sender_id:
                sender_id = (
                    ctx.sender_id.hex()
                    if isinstance(ctx.sender_id, bytes)
                    else str(ctx.sender_id)
                )

        active_node_id = proxy._get_safe_active_node()
        reset_node_id = (
            sender_id or active_node_id
        )  # Use sender_id if available, otherwise active node

        if reset_node_id:
            # Clear stored shapes for the node that sent the reset
            if reset_node_id in proxy.poly_data_by_node:
                del proxy.poly_data_by_node[reset_node_id]

            if reset_node_id in proxy.polyline_data_by_node:
                del proxy.polyline_data_by_node[reset_node_id]

            # Also clear for active node if different
            active_node_id = proxy._get_safe_active_node()
            if active_node_id and active_node_id != reset_node_id:
                if active_node_id in proxy.poly_data_by_node:
                    del proxy.poly_data_by_node[active_node_id]

                if active_node_id in proxy.polyline_data_by_node:
                    del proxy.polyline_data_by_node[active_node_id]

            # Emit empty data to clear shapes from map
            if proxy.socketio and proxy.connected_clients > 0:
                proxy.socketio.emit("poly", {"polys": {}})
                proxy.socketio.emit("polyline", {"polys": {}})
                # Also emit reset event to frontend
                proxy.socketio.emit(
                    "reset",
                    {"reason": "BlueSky simulation reset", "timestamp": time.time()},
                )

    except Exception as e:
        logger.error(f"Error processing RESET data: {e}")


def on_request_received(data, *args, **kwargs):
    """Handle REQUEST events from the BlueSky server.

    Currently only logs the payload; specific request handling is not yet
    implemented.

    Args:
        data (Any): The REQUEST payload.
        *args (Any): Additional positional payload items (unused).
        **kwargs (Any): Additional keyword payload items (unused).
    """
    if not active_proxy():
        return

    try:
        logger.debug(f"REQUEST data received: {data}")
        # TODO: Implement specific request handling logic
    except Exception as e:
        logger.error(f"Error processing REQUEST data: {e}")
