"""BlueSky proxy package for web interface communication.

This package provides the BlueSky proxy gateway that bridges the web interface
with the BlueSky network client. It includes:
- Core proxy class for client management
- Event handlers for simulation data
- Subscriber registration for network events
"""

from .core import BlueSkyProxy
from .subscribers import register_subscribers

# Global BlueSky proxy instance to be set by the app
_bluesky_proxy = None


def get_bluesky_proxy():
    """Get the current BlueSky proxy instance."""
    return _bluesky_proxy


def set_bluesky_proxy(proxy):
    """Set the BlueSky proxy instance."""
    global _bluesky_proxy
    _bluesky_proxy = proxy


__all__ = [
    "BlueSkyProxy",
    "register_subscribers",
    "get_bluesky_proxy",
    "set_bluesky_proxy",
]
