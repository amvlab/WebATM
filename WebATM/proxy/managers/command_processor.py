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
                # Stack the command for processing
                self.proxy.bluesky_client.stack.stack(command)
                # Process commands using our stack processor
                self._process_stack_commands()
                return True
            else:
                logger.warning("Cannot send command - BlueSky client not running")
                return False
        except Exception as e:
            logger.error(f" Command error for '{command}': {e}")
            return False

    def _process_stack_commands(self):
        """Process stack commands from users/GUI following BlueSky client pattern exactly.

        Note: This processes user commands only. Server commands are handled by on_stack_received().
        """
        if not self.proxy.bluesky_client or not self.proxy.bluesky_client.running:
            return

        # Process stack of commands exactly like BlueSky client
        for cmdline in self.proxy.bluesky_client.stack.commands():
            success = True
            echotext = ""
            echoflags = 0  # BS_OK equivalent

            # Get first argument from command line and check if it's a command
            cmd_parts = cmdline.strip().split()
            if not cmd_parts:
                continue

            cmd = cmd_parts[0].upper()
            argstring = " ".join(cmd_parts[1:]) if len(cmd_parts) > 1 else ""

            # Only execute HELP and ? locally - forward everything else to BlueSky
            # Note: cmddict contains ALL BlueSky commands (for autocomplete), not just local commands
            if cmd in ("HELP", "?"):
                # Execute local help command
                try:
                    success, echotext = self._execute_local_command(cmd, argstring)
                    if not success:
                        if not argstring:
                            echotext = echotext or f"{cmd}: Command help text"
                        else:
                            echoflags = 2  # BS_FUNERR equivalent
                            echotext = f"Syntax error: {echotext or f'Usage: {cmd}'}"
                except Exception as e:
                    success = False
                    echoflags = 3  # BS_ARGERR equivalent
                    header = (
                        "" if not argstring else str(e) if str(e) else "Argument error."
                    )
                    echotext = f"{header}\nUsage: {cmd}"

                # Always return echo for local commands
                if echotext:
                    self._echo_response(echotext, echoflags)
            else:
                # Forward all other commands to BlueSky server
                # BlueSky will handle validation and send back echo response
                self._forward_command(cmdline)
                continue  # Server will echo response (no local echo needed)

    def _forward_command(self, cmdline):
        """Forward command to BlueSky server for validation and execution."""
        try:
            # Send to active node if available (BlueSky client pattern)
            target = (
                self.proxy.bluesky_client.act_id or self.proxy.bluesky_client.server_id
            )
            self.proxy.bluesky_client.send("STACK", cmdline, target)
        except Exception as e:
            logger.error(f" Error forwarding command '{cmdline}': {e}")
            # Send error echo to user
            self._echo_response(f"Error sending command: {e}", 1)

    def forward(self, *cmdlines, target_id=None):
        """Forward one or more stack commands to BlueSky server.

        Similar to BlueSky's stack.forward() method - sends command to active node
        or specified target. Multiple commands can be specified as multiple
        arguments, and/or semicolon-separated within a single string.
        """
        if not cmdlines:
            return

        try:
            # Join multiple command lines with semicolons
            command_str = ";".join(cmdlines)

            # Determine target: use specified target_id, or active node, or server
            if target_id is not None:
                target = target_id
            else:
                target = (
                    self.proxy.bluesky_client.act_id
                    if self.proxy.bluesky_client.act_id
                    else self.proxy.bluesky_client.server_id
                )

            # Send using BlueSky network protocol
            if self.proxy.bluesky_client and self.proxy.bluesky_client.running:
                self.proxy.bluesky_client.send("STACK", command_str, target)
                logger.info(f"Forwarded to {target}: {command_str}")
            else:
                logger.warning(" Cannot forward - BlueSky client not running")

        except Exception as e:
            logger.error(f" Error in forward(): {e}")
            self._echo_response(f"Error forwarding command: {e}", 1)

    def _handle_zoom_command(self, cmd):
        """Handle zoom commands locally."""
        # Basic zoom handling - could emit to web client for map zoom
        if cmd in ("+", "++", "+++", "="):
            zoom_factor = cmd.count("+") + cmd.count("=")
            # Emit zoom in event to web client
            if self.proxy.socketio and self.proxy.connected_clients > 0:
                self.proxy.socketio.emit(
                    "zoom", {"direction": "in", "factor": zoom_factor}
                )
        elif cmd in ("-", "--", "---"):
            zoom_factor = cmd.count("-")
            # Emit zoom out event to web client
            if self.proxy.socketio and self.proxy.connected_clients > 0:
                self.proxy.socketio.emit(
                    "zoom", {"direction": "out", "factor": zoom_factor}
                )

    def _execute_local_command(self, cmd, argstring):
        """Execute local client command (like BlueSky Command.cmddict does)."""
        # For web client, we have limited local commands
        # Most commands should be forwarded to server

        if cmd == "HELP" or cmd == "?":
            if not argstring:
                return True, "BlueSky Web Client: Enter commands to control simulation"
            else:
                return True, f"Help for {argstring}: Command forwarded to server"
        else:
            # Unknown local command - this shouldn't happen if cmddict is correct
            return False, f"Local command {cmd} not implemented in web client"

    def _echo_response(self, text, flags):
        """Send echo response to web proxy."""
        echo_data = {"text": str(text), "flags": int(flags), "timestamp": time.time()}

        # Store for current data
        self.proxy.echo_data = echo_data

        # Emit to connected clients immediately for command responses
        if self.proxy.socketio and self.proxy.connected_clients > 0:
            try:
                self.proxy.socketio.emit("echo", echo_data)
            except Exception:
                pass
