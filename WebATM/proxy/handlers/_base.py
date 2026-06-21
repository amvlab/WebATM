"""Shared helpers for BlueSky network event handlers.

Every handler in this package needs the same two things: a reference to the
global proxy, and a guard that drops data while disconnected. Centralizing them
here keeps each handler module focused on the event it actually processes.
"""

import time


def get_bluesky_proxy():
    """Return the current BlueSky proxy instance, or None if unset."""
    from .. import get_bluesky_proxy as _get_proxy

    return _get_proxy()


def active_proxy():
    """Return the connected proxy, refreshing its last-update timestamp.

    Returns None when no proxy is registered or the client is disconnected
    (``allow_reconnection`` is False) so handlers can simply early-return.
    """
    proxy = get_bluesky_proxy()
    if not proxy or not proxy.allow_reconnection:
        return None

    proxy.last_successful_update = time.time()
    return proxy
