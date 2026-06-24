"""Command processing and forwarding for BlueSky proxy."""

import time

from ...logger import get_logger

logger = get_logger()


class CommandProcessor:
    """Handles command processing, forwarding, and echo responses."""

    def __init__(self, proxy):
        """Initialize CommandProcessor with reference to parent proxy.

        Args:
            proxy: Parent BlueSkyProxy instance
        """
        self.proxy = proxy

    def send_command(self, command: str) -> bool:
        """Send a command to the simulation using stack processing."""
        try:
            if self.proxy.bluesky_client and self.proxy.bluesky_client.running:
                self.proxy.bluesky_client.stack.stack(command)
                self._process_stack_commands()
                return True
            else:
                logger.warning("Cannot send command - BlueSky client not running")
                return False
        except Exception as e:
            logger.error(f"Command error for '{command}': {e}")
            return False

    def _resolve_target(self, target_id=None):
        """Resolve the send target: explicit id, else active node, else server."""
        client = self.proxy.bluesky_client
        if target_id is not None:
            return target_id
        return client.act_id or client.server_id

    def _process_stack_commands(self):
        """Process queued user/GUI stack commands.

        HELP and ? are answered locally; every other command is forwarded to
        BlueSky, which validates it and sends back its own echo response.
        Incoming server commands are handled separately by on_stack_received().
        """
        if not self.proxy.bluesky_client or not self.proxy.bluesky_client.running:
            return

        for cmdline in self.proxy.bluesky_client.stack.commands():
            cmd_parts = cmdline.strip().split()
            if not cmd_parts:
                continue

            cmd = cmd_parts[0].upper()
            argstring = " ".join(cmd_parts[1:])

            if cmd in ("HELP", "?"):
                _, echotext = self._execute_local_command(cmd, argstring)
                if echotext:
                    self._echo_response(echotext, 0)
            else:
                self._forward_command(cmdline)

    def _forward_command(self, cmdline):
        """Forward command to BlueSky server for validation and execution."""
        try:
            self.proxy.bluesky_client.send("STACK", cmdline, self._resolve_target())
        except Exception as e:
            logger.error(f"Error forwarding command '{cmdline}': {e}")
            self._echo_response(f"Error sending command: {e}", 1)

    def forward(self, *cmdlines, target_id=None):
        """Forward one or more stack commands to BlueSky server.

        Mirrors BlueSky's stack.forward(): sends to the given target_id, the
        active node, or the server. Multiple commands may be passed as separate
        arguments and/or semicolon-separated within a single string.
        """
        if not cmdlines:
            return

        try:
            command_str = ";".join(cmdlines)
            target = self._resolve_target(target_id)

            if self.proxy.bluesky_client and self.proxy.bluesky_client.running:
                self.proxy.bluesky_client.send("STACK", command_str, target)
                logger.info(f"Forwarded to {target}: {command_str}")
            else:
                logger.warning("Cannot forward - BlueSky client not running")

        except Exception as e:
            logger.error(f"Error in forward(): {e}")
            self._echo_response(f"Error forwarding command: {e}", 1)

    def _handle_zoom_command(self, cmd):
        """Emit a map zoom event to web clients for +/- zoom commands."""
        if cmd in ("+", "++", "+++", "="):
            zoom_factor = cmd.count("+") + cmd.count("=")
            if self.proxy.socketio and self.proxy.connected_clients > 0:
                self.proxy.socketio.emit(
                    "zoom", {"direction": "in", "factor": zoom_factor}
                )
        elif cmd in ("-", "--", "---"):
            zoom_factor = cmd.count("-")
            if self.proxy.socketio and self.proxy.connected_clients > 0:
                self.proxy.socketio.emit(
                    "zoom", {"direction": "out", "factor": zoom_factor}
                )

    def _execute_local_command(self, cmd, argstring):
        """Execute a command the web client handles itself (only HELP/?)."""
        if cmd == "HELP" or cmd == "?":
            if not argstring:
                return True, "BlueSky Web Client: Enter commands to control simulation"
            else:
                return True, f"Help for {argstring}: Command forwarded to server"
        else:
            return False, f"Local command {cmd} not implemented in web client"

    def _echo_response(self, text, flags):
        """Store an echo response and emit it to connected web clients."""
        echo_data = {"text": str(text), "flags": int(flags), "timestamp": time.time()}
        self.proxy.echo_data = echo_data

        if self.proxy.socketio and self.proxy.connected_clients > 0:
            try:
                self.proxy.socketio.emit("echo", echo_data)
            except Exception:
                pass
