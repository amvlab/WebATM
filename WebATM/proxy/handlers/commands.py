"""Command handlers for STACK and STACKCMDS events."""

import time

from ...logger import get_logger

logger = get_logger()


def get_bluesky_proxy():
    """Get the current BlueSky proxy instance."""
    from .. import get_bluesky_proxy as _get_proxy

    return _get_proxy()


def on_stackcmds_received(action, data):
    """Handle stack commands metadata from server (optional metadata)."""
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
    """Handle incoming STACK commands from BlueSky server."""
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
    """Process a command received from the server - handle locally only, do NOT send back to server."""
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
