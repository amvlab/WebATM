"""Event handlers for RESET and REQUEST events."""

import time

from ...logger import get_logger
from ...utils import id2str
from ._base import active_proxy

logger = get_logger()


def on_reset_received(data=None, *args, sender_id=None, **kwargs):
    """Handle RESET events from the BlueSky server.

    Clears the stored polygon/polyline shapes for the node that sent the
    reset. Browsers display the active node only, so the map-clearing ``poly``
    and ``polyline`` payloads and the ``reset`` event are emitted solely when
    the resetting node is the active one — a background node's reset must not
    wipe the active node's display. When the sender or active node can't be
    resolved, the reset is accepted so a single-node display still works
    (same fallback as the SIMINFO/ACDATA active-node filter).

    Args:
        data (Any): Optional RESET payload (unused).
        *args (Any): Additional positional payload items (unused).
        sender_id (bytes | str | None): Node that reset, from the message
            header; bytes are converted to a hex string. The shared network
            context is deliberately not consulted — it holds the sender of the
            last shared-state message (usually the active node), not of this
            RESET.
        **kwargs (Any): Additional keyword payload items (unused).
    """
    proxy = active_proxy()
    if not proxy:
        return

    try:
        sender_id = id2str(sender_id)

        active_node_id = proxy._get_safe_active_node()
        reset_node_id = sender_id or active_node_id
        if not reset_node_id:
            return

        # Only the resetting node's stored shapes are stale.
        proxy.poly_data_by_node.pop(reset_node_id, None)
        proxy.polyline_data_by_node.pop(reset_node_id, None)

        is_active_node = (
            active_node_id is None or sender_id is None or sender_id == active_node_id
        )
        if is_active_node and proxy.socketio and proxy.connected_clients > 0:
            proxy.socketio.emit("poly", {"polys": {}})
            proxy.socketio.emit("polyline", {"polys": {}})
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
