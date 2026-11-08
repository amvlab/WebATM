"""Navigation handler for DEFWPT (Define Waypoint) events."""

from ...logger import get_logger
from ._base import active_proxy

logger = get_logger()


def on_defwpt_received(data=None, *args, **kwargs):
    """Log DEFWPT events; waypoint rendering is not yet implemented."""
    if not active_proxy():
        return

    logger.debug(f"DEFWPT data received: {data}")
