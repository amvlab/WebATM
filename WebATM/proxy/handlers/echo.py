"""Echo message handler for command responses."""

import time

from ...bluesky_client import safe_decode
from ...logger import get_logger
from ._base import active_proxy

logger = get_logger()


def echo(text, flags=None, sender_id=None):
    """Handle ECHO messages (command responses) from the simulation.

    Stores the message on the proxy and emits an ``echo`` event to connected
    web clients immediately — command responses are never throttled.

    Args:
        text (str): The echo text; newlines and formatting are preserved.
        flags (int | None): BlueSky echo flags (e.g. error indication).
            Defaults to 0 when None.
        sender_id (bytes | str | None): ID of the node that sent the echo;
            decoded to a readable string for the client.
    """
    proxy = active_proxy()
    if not proxy:
        return

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
