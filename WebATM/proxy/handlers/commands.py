"""Handle BlueSky stack-command events (STACK, STACKCMDS).

STACKCMDS carries the server's command dictionary, which is cached on the
proxy and forwarded to browsers as the ``cmddict`` Socket.IO event so the web
console can validate and autocomplete commands. STACK carries command lines
forwarded by the simulation — commands it did not recognize and assumes are
GUI/client commands (typically PAN/ZOOM lines in scenario files). They are
forwarded to browsers as ``stack_command`` events, where the frontend's
CommandHandler executes the ones it implements (PAN, ZOOM, ...) exactly as if
they had been typed into the console — matching BlueSky's own GUIs, which run
forwarded commands through their client stack. Nothing is ever sent back to
the server (that would loop: the simulation forwarded the line precisely
because it cannot execute it).
"""

import time

from ...logger import get_logger
from ._base import REPLACE_ACTIONS, active_proxy, is_active_node, shared_context

logger = get_logger()


def on_stackcmds_received(data):
    """Process a BlueSky STACKCMDS event and emit ``cmddict`` to web clients.

    BlueSky publishes STACKCMDS with replace semantics: each node answers a
    REQUEST with a full Replace of *its own* command dictionary (plugins can
    register extra commands per node). The console sends commands to the
    active node, so only the active node's dictionary is accepted — a
    background node's answer must not overwrite (or leak commands into) the
    set the console validates against. A Replace action rebuilds the stored
    dictionary; other actions merge. Other payload shapes are only logged.

    Args:
        data (dict | bytes | str): Unwrapped STACKCMDS shared-state payload; a
            dict is expected to contain a ``cmddict`` mapping of command names
            to metadata.
    """
    proxy = active_proxy()
    if not proxy:
        return

    if not isinstance(data, dict):
        logger.debug(f"Ignoring non-dict STACKCMDS payload of type {type(data)}")
        return

    cmddict = data.get("cmddict")
    if not isinstance(cmddict, dict):
        logger.warning(f"STACKCMDS payload without a cmddict mapping: {data.keys()}")
        return

    sender_id, action = shared_context(proxy)
    if not is_active_node(proxy, sender_id):
        logger.debug(f"STACKCMDS from background node {sender_id} ignored")
        return

    if action in REPLACE_ACTIONS:
        proxy.cmddict.clear()
    proxy.cmddict.update(cmddict)
    logger.debug(f"Updated cmddict with {len(cmddict)} commands (action={action})")

    if proxy.socketio and proxy.connected_clients > 0:
        try:
            proxy.socketio.emit("cmddict", {"cmddict": proxy.cmddict})
        except Exception as e:
            logger.error(f"Error emitting cmddict: {e}")


def on_stack_received(data):
    """Process a BlueSky STACK event carrying sim-forwarded command lines.

    Normalizes the payload to individual command lines — BlueSky's
    ``stack.forward()`` joins multiple commands into one semicolon-separated
    string, and its reference client splits them back apart (``stack()`` in
    ``bluesky.stack.stackbase``), so the same split happens here — and
    forwards each non-empty line to browsers via ``_forward_to_browsers``.

    Args:
        data (str | list | tuple): One command line (possibly
            semicolon-joined), or a sequence of such lines. Other types are
            logged and ignored.
    """
    proxy = active_proxy()
    if not proxy:
        return

    if isinstance(data, str):
        received = [data]
    elif isinstance(data, (list, tuple)):
        received = list(data)
    else:
        logger.warning(f"Unexpected STACK data format: {type(data)}")
        return

    for cmdline in received:
        if not isinstance(cmdline, str):
            continue
        for line in cmdline.split(";"):
            line = line.strip()
            if line:
                _forward_to_browsers(proxy, line)


def _forward_to_browsers(proxy, cmdline):
    """Emit one sim-forwarded command line to browsers as ``stack_command``.

    The frontend executes the line through its CommandHandler (so PAN/ZOOM
    lines from scenario files move the map, like they move BlueSky's own
    GUIs) and reports unsupported commands itself. With no browser connected
    there is nothing to act on the command, so it is only logged.

    Args:
        proxy (BlueSkyProxy): The active proxy.
        cmdline (str): A single, stripped command line from the server.
    """
    if not (proxy.socketio and proxy.connected_clients > 0):
        logger.debug(f"No browsers connected; dropping forwarded command: {cmdline}")
        return
    try:
        proxy.socketio.emit(
            "stack_command", {"command": cmdline, "timestamp": time.time()}
        )
    except Exception as e:
        logger.error(f"Error forwarding '{cmdline}' to browsers: {e}")
