"""Shared helpers for BlueSky network event handlers.

Every handler in this package needs the same two things: a reference to the
global proxy, and a guard that drops data while disconnected. Centralizing them
here keeps each handler module focused on the event it actually processes.
"""

import time


def get_bluesky_proxy():
    """Return the globally registered BlueSky proxy instance.

    Returns:
        BlueSkyProxy | None: The current proxy, or None if no proxy has been
        registered yet.
    """
    from .. import get_bluesky_proxy as _get_proxy

    return _get_proxy()


def active_proxy():
    """Return the connected proxy, refreshing its last-update timestamp.

    Looks up the global proxy and, when it is present and reconnection is
    allowed, records the current wall-clock time as its last successful update
    so connection-liveness monitoring stays accurate.

    Returns:
        BlueSkyProxy | None: The connected proxy, or None when no proxy is
        registered or the client is disconnected (``allow_reconnection`` is
        False) so handlers can simply early-return.
    """
    proxy = get_bluesky_proxy()
    if not proxy or not proxy.allow_reconnection:
        return None

    proxy.last_successful_update = time.time()
    return proxy


def is_active_node(proxy, sender_id_str):
    """Check whether a message belongs to the currently active node.

    Browsers display the active node only, so per-node data (the header
    clock/rate/state, traffic frames, resets) must follow the ACTIVE node,
    not whichever node sent the latest message. When the active node can't
    be resolved yet (e.g. early in connection setup) or the sender is
    unknown, the message is accepted so a single-node display still works.

    Args:
        proxy (BlueSkyProxy): The active proxy.
        sender_id_str (str | None): Hex sender ID from the message header.

    Returns:
        bool: True when the message should be treated as the active node's.
    """
    active_node = proxy._get_safe_active_node()
    return active_node is None or sender_id_str is None or sender_id_str == active_node
