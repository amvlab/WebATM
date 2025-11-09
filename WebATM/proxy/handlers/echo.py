"""Echo message handler for command responses."""

import time

from ...bluesky_client import safe_decode
from ...logger import get_logger

logger = get_logger()


def get_bluesky_proxy():
    """Get the current BlueSky proxy instance."""
    from .. import get_bluesky_proxy as _get_proxy

    return _get_proxy()


def echo(text, flags=None, sender_id=None):
    """Handle echo messages from simulation."""
    proxy = get_bluesky_proxy()
    if not proxy:
        return

    # Ignore data if reconnection is not allowed (we're disconnected)
    if not proxy.allow_reconnection:
        return

    # Mark successful data reception
    proxy.last_successful_update = time.time()

    # Mark successful echo reception (minimal logging)

    # Preserve newlines and formatting in the echo data
    formatted_text = str(text) if text is not None else ""

    # Decode sender_id from bytes to readable string
    sender_str = None
    if sender_id is not None:
        if isinstance(sender_id, bytes):
            sender_str = safe_decode(sender_id)
        else:
            sender_str = str(sender_id)

    echo_data = {
        "text": formatted_text,  # Keep original formatting including \n
        "flags": int(flags) if flags is not None else 0,
        "timestamp": time.time(),
        "sender": sender_str,
    }
    proxy.echo_data = echo_data

    # Send echo messages immediately (no throttling for command responses)
    if proxy.socketio and proxy.connected_clients > 0:
        try:
            proxy.socketio.emit("echo", echo_data)
        except Exception as e:
            logger.error(f"Error sending echo to web client: {e}")
