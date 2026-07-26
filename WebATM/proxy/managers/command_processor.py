"""Command processing and forwarding for the BlueSky proxy."""

import time

from ...logger import get_logger

logger = get_logger()


class CommandProcessor:
    """Handle command processing, forwarding, and echo responses.

    Queues user/GUI commands on the network client's stack, forwards them to
    the BlueSky server (answering bare HELP/? locally), and emits echo
    responses back to connected web clients.
    """

    def __init__(self, proxy):
        """Initialize the command processor.

        Args:
            proxy (BlueSkyProxy): Parent proxy instance.
        """
        self.proxy = proxy

    def send_command(self, command: str) -> bool:
        """Send a command to the simulation using stack processing.

        Queues the command on the client stack and immediately processes the
        queue, forwarding to the BlueSky server as appropriate.

        Args:
            command (str): The stack command line to send (e.g. ``"CRE KL123
                A320 52.3 4.7 90 FL100 250"``).

        Returns:
            bool: True if the command was queued and processed, False if the
                BlueSky client is not running or an error occurred.
        """
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

        A bare HELP or ? is answered locally; every other command — including
        ``HELP <cmd>``, whose help text lives on the server — is forwarded to
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

            if cmd in ("HELP", "?") and not argstring:
                _, echotext = self._execute_local_command(cmd, argstring)
                if echotext:
                    self._echo_response(echotext, 0)
            else:
                self._forward_command(cmdline)

    def _forward_command(self, cmdline):
        """Forward command to BlueSky server for validation and execution."""
        try:
            sent = self.proxy.bluesky_client.send(
                "STACK", cmdline, self._resolve_target()
            )
            if not sent:
                # Full outbound ZMQ buffer or dead socket — tell the user
                # instead of dropping the command silently.
                logger.warning(f"Command not sent (send failed): {cmdline}")
                self._echo_response(f"Command dropped (server busy): {cmdline}", 1)
        except Exception as e:
            logger.error(f"Error forwarding command '{cmdline}': {e}")
            self._echo_response(f"Error sending command: {e}", 1)

    def forward(self, *cmdlines, target_id=None):
        """Forward one or more stack commands to the BlueSky server.

        Mirrors BlueSky's ``stack.forward()``: sends to the given target, the
        active node, or the server. Multiple commands may be passed as
        separate arguments and/or semicolon-separated within a single string.

        Args:
            *cmdlines (str): One or more stack command lines to forward.
            target_id (bytes | None): Explicit node/server ID to address. When
                None, falls back to the active node, then the server.
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

    def _execute_local_command(self, cmd, argstring):
        """Execute a command the web client handles itself (bare HELP/? only)."""
        if cmd in ("HELP", "?") and not argstring:
            return True, "BlueSky Web Client: Enter commands to control simulation"
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
