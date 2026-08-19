"""BlueSky proxy package for web interface communication.

This package provides the BlueSky proxy gateway that bridges the web interface
with the BlueSky network client. It includes:

- Core proxy class for client management
- Event handlers for simulation data
- Subscriber registration for network events
"""

import threading

from .core import BlueSkyProxy
from .subscribers import register_subscribers

# Global BlueSky proxy instance to be set by the app
_bluesky_proxy = None

# Serializes replacing and connecting the global proxy. Held by the manual
# /api/server/config route and by the integrated auto-start's connect step, so
# one of them can never revive a proxy the other has just replaced/closed
# (which would leave a second, subscriber-less ZMQ client alive).
connect_lock = threading.Lock()


def get_bluesky_proxy():
    """Get the current BlueSky proxy instance.

    Returns:
        BlueSkyProxy | None: The globally registered proxy instance, or None if
            no proxy has been set yet.
    """
    return _bluesky_proxy


def set_bluesky_proxy(proxy):
    """Set the global BlueSky proxy instance.

    Args:
        proxy (BlueSkyProxy | None): Proxy instance to register globally, or
            None to clear the current one.
    """
    global _bluesky_proxy
    _bluesky_proxy = proxy


__all__ = [
    "BlueSkyProxy",
    "register_subscribers",
    "get_bluesky_proxy",
    "set_bluesky_proxy",
    "connect_lock",
]
