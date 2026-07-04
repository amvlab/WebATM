"""Navigation handler for DEFWPT (Define Waypoint) events."""

from ...logger import get_logger
from ._base import active_proxy

logger = get_logger()


def on_defwpt_received(data, *args, **kwargs):
    """Handle DEFWPT (define waypoint) events from the BlueSky server.

    Currently only logs the payload; waypoint rendering in the web client is
    not yet implemented.

    Args:
        data (Any): The DEFWPT payload describing the waypoint.
        *args (Any): Additional positional payload items (unused).
        **kwargs (Any): Additional keyword payload items (unused).
    """
    if not active_proxy():
        return

    try:
        logger.info(f"DEFWPT data received: {data}")
        # TODO: Implement waypoint definition handling
    except Exception as e:
        logger.error(f"Error processing DEFWPT data: {e}")
