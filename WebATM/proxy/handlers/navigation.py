"""Navigation handler for DEFWPT (Define Waypoint) events."""

from ...logger import get_logger
from ._base import active_proxy

logger = get_logger()


def on_defwpt_received(data, *args, **kwargs):
    """Handle DEFWPT (Define Waypoint) messages from BlueSky server."""
    if not active_proxy():
        return

    try:
        logger.info(f"DEFWPT data received: {data}")
        # TODO: Implement waypoint definition handling
    except Exception as e:
        logger.error(f"Error processing DEFWPT data: {e}")
