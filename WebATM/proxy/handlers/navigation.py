"""Navigation handler for DEFWPT (Define Waypoint) events."""

import time

from ...logger import get_logger

logger = get_logger()


def get_bluesky_proxy():
    """Get the current BlueSky proxy instance."""
    from .. import get_bluesky_proxy as _get_proxy

    return _get_proxy()


def on_defwpt_received(data, *args, **kwargs):
    """Handle DEFWPT (Define Waypoint) messages from BlueSky server."""
    proxy = get_bluesky_proxy()
    if not proxy:
        return

    if not proxy.allow_reconnection:
        return

    proxy.last_successful_update = time.time()

    try:
        logger.info(f"DEFWPT data received: {data}")
        # TODO: Implement waypoint definition handling

    except Exception as e:
        logger.error(f"Error processing DEFWPT data: {e}")
