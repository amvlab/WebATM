"""Handle BlueSky stack-command events (STACK, STACKCMDS).

STACKCMDS carries the server's command dictionary, which is cached on the
proxy and forwarded to browsers as the ``cmddict`` Socket.IO event so the web
console can validate and autocomplete commands. STACK carries command lines
pushed by the server, which are executed locally (never echoed back to the
server) with their results reported through the proxy's echo channel.
"""

import time

from ...logger import get_logger
from ._base import get_bluesky_proxy

logger = get_logger()


def on_stackcmds_received(action, data):
    """Process a BlueSky STACKCMDS event and emit ``cmddict`` to web clients.

    When the payload is a dict, merges its ``cmddict`` mapping into the proxy's
    command dictionary and emits the updated dictionary to connected browsers.
    Bytes and string payloads are only logged; other types are logged as
    warnings.

    Args:
        action (Any): Action marker delivered with the event (unused).
        data (dict | bytes | str): STACKCMDS payload; a dict is expected to
            contain a ``cmddict`` mapping of command names to metadata.
    """
    proxy = get_bluesky_proxy()
    if not proxy:
        return
    # Mark successful data reception
    proxy.last_successful_update = time.time()

    try:
        # Handle different data formats for STACKCMDS
        if isinstance(data, dict):
            proxy.cmddict.update(data["cmddict"])
            logger.debug(f"Updated cmddict with {len(data['cmddict'])} commands")

            # Emit updated cmddict to connected web clients
            if proxy.socketio and proxy.connected_clients > 0:
                try:
                    proxy.socketio.emit("cmddict", {"cmddict": proxy.cmddict})
                    logger.debug(
                        f"Emitted cmddict to {proxy.connected_clients} web clients"
                    )
                except Exception as e:
                    logger.error(f"Error emitting cmddict: {e}")

        elif isinstance(data, bytes):
            # Try to decode bytes as string first
            try:
                decoded_data = data.decode("utf-8")
                logger.debug(f"STACKCMDS bytes decoded: {decoded_data}")
                # Could be JSON or other format - for now just log it
            except UnicodeDecodeError:
                logger.debug(f"STACKCMDS received as bytes (length: {len(data)})")
        elif isinstance(data, str):
            logger.debug(f"STACKCMDS received as string: {data}")
        else:
            logger.warning(f"Received unexpected STACKCMDS data type: {type(data)}")
            logger.warning(f"STACKCMDS data content: {data}")
    except Exception as e:
        logger.error(f"Error processing STACKCMDS: {e}")
        import traceback

        traceback.print_exc()


def on_stack_received(data):
    """Process a BlueSky STACK event carrying server-pushed command lines.

    Normalizes the payload to a list of command lines and runs each non-empty
    line through ``_process_server_command``, which executes it locally and
    reports the outcome via the proxy's echo channel. Nothing is sent back to
    the BlueSky server.

    Args:
        data (str | list | tuple): One command line, or a sequence of command
            lines, pushed by the server. Other types are logged and ignored.
    """
    proxy = get_bluesky_proxy()
    if not proxy:
        return

    # Mark successful data reception
    proxy.last_successful_update = time.time()

    # Process incoming stack commands from server

    try:
        # Handle incoming stack commands - process them like local commands
        commands_to_process = []

        if isinstance(data, str):
            commands_to_process = [data]
        elif isinstance(data, (list, tuple)):
            commands_to_process = list(data)
        else:
            logger.warning(f"Unexpected STACK data format: {type(data)}")
            return

        # Process each command through our validation system
        for cmdline in commands_to_process:
            if not cmdline or not cmdline.strip():
                continue

            _process_server_command(proxy, cmdline)

    except Exception as e:
        logger.error(f"Error processing incoming STACK: {e}")
        import traceback

        traceback.print_exc()


def _process_server_command(proxy, cmdline):
    """Execute a server-pushed command locally without forwarding it back.

    Parses the command line, and when the command exists in the proxy's command
    dictionary executes it via ``proxy._execute_local_command``. Success,
    failure, unknown-command, and parse-error outcomes are all reported to web
    clients through ``proxy._echo_response``.

    Args:
        proxy (BlueSkyProxy): The active proxy used for command lookup,
            execution, and echoing.
        cmdline (str): The raw command line received from the server.
    """
    try:
        # Parse command like we do for user commands
        cmd_parts = cmdline.strip().split()
        if not cmd_parts:
            return

        cmd = cmd_parts[0].upper()
        argstring = " ".join(cmd_parts[1:]) if len(cmd_parts) > 1 else ""

        # Check if command exists in our local command dictionary
        if cmd in proxy.cmddict:
            try:
                # Execute the local command ONLY - do not forward to server
                success, echotext = proxy._execute_local_command(cmd, argstring)
                if success:
                    proxy._echo_response(f"Server command executed: {echotext}", 0)
                else:
                    proxy._echo_response(f"Server command failed: {echotext}", 2)
            except Exception as e:
                logger.error(f"Error executing server command '{cmd}': {e}")
                proxy._echo_response(f"Server command error: {cmd} - {str(e)}", 3)
        else:
            # Command not recognized by web client - do NOT forward to server
            proxy._echo_response(
                f"Server command '{cmd}' not implemented in web client", 1
            )

    except Exception as e:
        logger.error(f"Error parsing server command '{cmdline}': {e}")
        proxy._echo_response(f"Error parsing server command: {str(e)}", 3)
