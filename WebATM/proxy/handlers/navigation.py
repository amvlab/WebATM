"""Navigation handler for DEFWPT (Define Waypoint) events."""

from ...logger import get_logger
from ._base import active_proxy

logger = get_logger()


def on_defwpt_received(data=None, *args, **kwargs):
    """Log DEFWPT events; waypoint rendering is not yet implemented.

    Args:
        data (Any): Unwrapped DEFWPT shared-state payload describing the
            waypoint(s).
        *args (Any): Additional positional payload items (unused).
        **kwargs (Any): Additional keyword payload items (unused).
    """
    if not active_proxy():
        return

    logger.info(f"DEFWPT data received: {data}")
