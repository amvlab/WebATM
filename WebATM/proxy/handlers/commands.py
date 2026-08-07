"""Handle BlueSky stack-command events (STACK, STACKCMDS).

STACKCMDS carries the server's command dictionary, which is cached on the
proxy and forwarded to browsers as the ``cmddict`` Socket.IO event so the web
console can validate and autocomplete commands. STACK carries command lines
forwarded by the server — commands the simulation did not recognize and
assumes are GUI/client commands (typically PAN/ZOOM lines in scenario files).
They are handled locally and never echoed back to the server.
"""

from ...logger import get_logger
from ._base import active_proxy

logger = get_logger()


def on_stackcmds_received(action, data):
    """Process a BlueSky STACKCMDS event and emit ``cmddict`` to web clients.

    When the payload is a dict, merges its ``cmddict`` mapping into the proxy's
    command dictionary and emits the updated dictionary to connected browsers.
    Other payload shapes are only logged.

    Args:
        action (Any): Action marker delivered with the event (unused).
        data (dict | bytes | str): STACKCMDS payload; a dict is expected to
            contain a ``cmddict`` mapping of command names to metadata.
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

    proxy.cmddict.update(cmddict)
    logger.debug(f"Updated cmddict with {len(cmddict)} commands")

    if proxy.socketio and proxy.connected_clients > 0:
        try:
            proxy.socketio.emit("cmddict", {"cmddict": proxy.cmddict})
        except Exception as e:
            logger.error(f"Error emitting cmddict: {e}")


def on_stack_received(data):
    """Process a BlueSky STACK event carrying server-forwarded command lines.

    Normalizes the payload to a list of command lines and runs each non-empty
    line through ``_process_server_command``, which executes it locally and
    reports the outcome via the proxy's echo channel. Nothing is sent back to
    the BlueSky server.

    Args:
        data (str | list | tuple): One command line, or a sequence of command
            lines, forwarded by the server. Other types are logged and ignored.
    """
    proxy = active_proxy()
    if not proxy:
        return

    if isinstance(data, str):
        commands_to_process = [data]
    elif isinstance(data, (list, tuple)):
        commands_to_process = list(data)
    else:
        logger.warning(f"Unexpected STACK data format: {type(data)}")
        return

    for cmdline in commands_to_process:
        if isinstance(cmdline, str) and cmdline.strip():
            _process_server_command(proxy, cmdline)


def _process_server_command(proxy, cmdline):
    """Execute a server-forwarded command locally without sending it back.

    Runs the command through ``proxy._execute_local_command``. Commands the
    web client does not implement (e.g. desktop-GUI view commands like PAN or
    ZOOM from a scenario file) are benign no-ops here, so they are reported to
    web clients as a warning, not an error.

    Args:
        proxy (BlueSkyProxy): The active proxy used for command execution
            and echoing.
        cmdline (str): The raw command line received from the server.
    """
    cmd, _, argstring = cmdline.strip().partition(" ")
    cmd = cmd.upper()

    try:
        success, echotext = proxy._execute_local_command(cmd, argstring.strip())
    except Exception as e:
        logger.error(f"Error executing server command '{cmd}': {e}")
        proxy._echo_response(f"Error executing server command '{cmd}': {e}", 1)
        return

    if success:
        proxy._echo_response(echotext, 0)
    else:
        proxy._echo_response(f"{cmd}: not supported by the web client (ignored)", 2)
