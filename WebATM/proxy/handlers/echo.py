"""Echo message handler for command responses."""

from ...utils import id2str
from ._base import active_proxy


def echo(text, flags=None, sender_id=None):
    """Handle ECHO messages (command responses) from the simulation.

    BlueSky's echo flags are an error bitmask (``BS_ARGERR=1``,
    ``BS_FUNERR=2``, ``BS_CMDERR=4`` — see ``bluesky/__init__.py``; its stack
    only ever sets them on failed commands), while the web client renders
    flags as severity levels (0 info, 1 error, 2 warning). Any set bit
    therefore maps to the error level. Delegates to ``_echo_response``, which
    emits immediately — command responses are never throttled.

    Args:
        text (str): The echo text; newlines and formatting are preserved.
        flags (int | None): BlueSky echo flags; nonzero marks an error.
        sender_id (bytes | str | None): ID of the node that sent the echo,
            forwarded in the same hex form as ``node_info`` payloads.
    """
    proxy = active_proxy()
    if not proxy:
        return

    text = str(text) if text is not None else ""
    level = 1 if flags else 0
    proxy._echo_response(text, level, sender=id2str(sender_id))
