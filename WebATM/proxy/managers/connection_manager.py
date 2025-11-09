"""Connection management for BlueSky proxy."""

import gc
import threading
import time

from ...bluesky_client import BlueSkyClient, safe_decode
from ...logger import get_logger

logger = get_logger()


class ConnectionManager:
    """Manages BlueSky client connections and reconnections."""

    def __init__(self, proxy):
        """Initialize ConnectionManager with reference to parent proxy.

        Args:
            proxy: Parent BlueSkyProxy instance
        """
        self.proxy = proxy

    def _ensure_clean_zmq_context(self):
        """Ensure we have a clean environment for ZMQ connections."""
        try:
            logger.debug("Preparing clean environment for ZMQ connection...")

            # Force garbage collection to clean up any lingering references
            gc.collect()

            # Small delay to ensure cleanup completes
            time.sleep(0.2)

            logger.info("Environment cleanup complete - ready for new FixedClient")

        except Exception as e:
            logger.warning(f" Warning during cleanup: {e}")
            # Continue anyway - the FixedClient might still work

    def _connect_bluesky_client_signals(self):
        """Connect BlueSky client signals to our handlers."""
        if self.proxy.bluesky_client is None:
            logger.warning("Cannot connect signals - BlueSky client not initialized")
            return

        try:
            # Import node manager for signal handlers
            from .node_manager import NodeManager

            # Create a node manager instance for signal handling
            node_mgr = NodeManager(self.proxy)

            logger.debug("Connecting BlueSky client signals...")

            # Check which signals are available and connect them safely
            if hasattr(self.proxy.bluesky_client, "node_added"):
                self.proxy.bluesky_client.node_added.connect(node_mgr._on_node_added)
                logger.debug("node_added signal connected")
            else:
                logger.warning("node_added signal not available")

            if hasattr(self.proxy.bluesky_client, "server_added"):
                self.proxy.bluesky_client.server_added.connect(
                    node_mgr._on_server_added
                )
                logger.debug("server_added signal connected")
            else:
                logger.warning("server_added signal not available")

            if hasattr(self.proxy.bluesky_client, "node_removed"):
                self.proxy.bluesky_client.node_removed.connect(
                    node_mgr._on_node_removed
                )
                logger.debug("node_removed signal connected")
            else:
                logger.warning("node_removed signal not available")

            if hasattr(self.proxy.bluesky_client, "server_removed"):
                self.proxy.bluesky_client.server_removed.connect(
                    node_mgr._on_server_removed
                )
                logger.debug("server_removed signal connected")
            else:
                logger.warning("server_removed signal not available")

            if hasattr(self.proxy.bluesky_client, "actnode_changed"):
                self.proxy.bluesky_client.actnode_changed.connect(
                    node_mgr._on_actnode_changed
                )
                logger.debug("actnode_changed signal connected")
            else:
                logger.warning("actnode_changed signal not available")

        except Exception as e:
            logger.error(f" Error connecting signals: {e}")
            logger.debug(
                f"Available attributes: {[attr for attr in dir(self.proxy.bluesky_client) if not attr.startswith('_')]}"
            )
            # Continue without signals - basic functionality might still work

    def start_client(self, hostname=None):
        """Start the network client with fresh state - following ZMQ pattern."""
        # Following ZMQ pattern: create context and sockets when connecting
        if self.proxy.bluesky_client is None:
            logger.debug(" Creating BlueSky network client...")
            try:
                # Create the BlueSky network client
                self.proxy.bluesky_client = BlueSkyClient()
                self._connect_bluesky_client_signals()
                logger.info(" BlueSky network client created successfully")
            except Exception as e:
                logger.error(f" Error creating BlueSky network client: {e}")
                raise

        # Ensure we start with a clean state
        if self.proxy.running:
            logger.info("Stopping existing connection before starting new one")
            self.stop_client()
            # Wait for cleanup to complete
            time.sleep(0.2)

        if hostname:
            self.proxy.server_ip = hostname
        logger.info(
            "Attempting to connect to BlueSky remote server hosted by amvlab..."
        )

        try:
            # Enable reconnection for this explicit connection attempt
            self.proxy.allow_reconnection = True

            logger.info(f"Connecting standalone proxy to '{self.proxy.server_ip}'...")
            try:
                success = self.proxy.bluesky_client.connect(
                    hostname=self.proxy.server_ip
                )
                if not success:
                    raise RuntimeError("Failed to connect to BlueSky server")
                logger.info(
                    f"Network connection established with node ID: {safe_decode(self.proxy.bluesky_client.node_id)}"
                )
                logger.info("Waiting for BlueSky nodes to be detected...")
            except Exception as e:
                logger.error(f" Error in network connect(): {e}")
                raise

            # Initialize connection monitoring
            self.proxy.last_successful_update = time.time()
            self.proxy.was_connected = (
                False  # Will be set to True when nodes are detected
            )

            self.proxy.running = True

            # Start network timer (like web client does with timer)
            self._start_network_timer()

            # Start backup data emission timer
            from .data_manager import DataManager

            data_mgr = DataManager(self.proxy)
            data_mgr.start_backup_timer()

            logger.debug(
                f"Node detection started (timeout: {self.proxy.connection_timeout}s)"
            )
        except Exception as e:
            logger.error(
                f"Failed to connect to BlueSky remote server hosted by amvlab: {e}"
            )
            self.proxy.running = False
            self.proxy.allow_reconnection = False
            self.proxy.was_connected = False
            raise

    def _start_network_timer(self):
        """Start the network update timer (exactly like web client's timer does)."""

        def network_timer_callback():
            if (
                self.proxy.running
                and self.proxy.allow_reconnection
                and self.proxy.bluesky_client
            ):
                try:
                    # This is exactly what web client does: network_timer.timeout.connect(proxy.update)
                    self.proxy.bluesky_client.update()

                    # Reset connection failures on successful update
                    self.proxy.connection_failures = 0

                    # Update connection monitoring
                    current_time = time.time()
                    has_active_nodes = len(self.proxy.tracked_nodes) > 0

                    if has_active_nodes and not self.proxy.was_connected:
                        self.proxy.was_connected = True
                        logger.info(
                            "Connection established to BlueSky remote server hosted by amvlab"
                        )
                        self._emit_connection_status(True)
                    elif not has_active_nodes and self.proxy.was_connected:
                        # Check if we should still wait for nodes or mark as disconnected
                        if (
                            current_time - self.proxy.last_successful_update
                            > self.proxy.connection_timeout
                        ):
                            self.proxy.was_connected = False
                            logger.info(
                                "No active nodes detected after timeout - BlueSky server disconnected"
                            )
                            self._emit_connection_status(False)
                            self._handle_disconnection(
                                "No nodes detected after timeout"
                            )
                            return

                    # Check for connection timeout (more aggressive)
                    if (
                        self.proxy.was_connected
                        and current_time - self.proxy.last_successful_update
                        > self.proxy.connection_timeout
                    ):
                        timeout_duration = (
                            current_time - self.proxy.last_successful_update
                        )
                        logger.info(
                            f"Connection timeout detected ({timeout_duration:.1f}s since last data)"
                        )
                        self._handle_disconnection("Connection timeout")
                        return  # Don't schedule next timer

                except Exception as e:
                    self.proxy.connection_failures += 1
                    logger.info(
                        f"Network error detected ({self.proxy.connection_failures}/{self.proxy.max_connection_failures}): {e}"
                    )

                    if (
                        self.proxy.connection_failures
                        >= self.proxy.max_connection_failures
                    ):
                        logger.info(
                            "Max connection failures reached - marking as disconnected"
                        )
                        self._handle_disconnection("Network error (max failures)")
                        return  # Don't schedule next timer

                # Schedule next update (like web client's 20ms timer)
                if self.proxy.running and self.proxy.allow_reconnection:
                    self.proxy.network_timer = threading.Timer(
                        0.02, network_timer_callback
                    )
                    self.proxy.network_timer.daemon = True
                    self.proxy.network_timer.start()

        # Start the timer
        self.proxy.network_timer = threading.Timer(0.02, network_timer_callback)
        self.proxy.network_timer.daemon = True
        self.proxy.network_timer.start()

    def _handle_disconnection(self, reason="Unknown"):
        """Handle disconnection - close connections and clean up state."""
        if self.proxy.was_connected:
            logger.info(f"BlueSky server disconnected - Reason: {reason}")
            logger.debug(" Cleaning up connection state and closing sockets")
            self.proxy.was_connected = False
            self._emit_connection_status(False)

        # Don't try to reconnect - just stop running and close
        self.proxy.running = False
        self.proxy.allow_reconnection = False

        # Reset connection failure counter
        self.proxy.connection_failures = 0

        # Clear active node reference immediately to prevent showing corrupted data
        if self.proxy.bluesky_client and hasattr(self.proxy.bluesky_client, "act_id"):
            self.proxy.bluesky_client.act_id = None

        # Clear all tracked nodes and servers immediately
        self.proxy.tracked_nodes.clear()
        self.proxy.tracked_servers.clear()

        # Clear all cached data
        self.proxy.traffic_data = {}
        self.proxy.sim_data = {}
        self.proxy.echo_data = {}
        self.proxy.poly_data_by_node.clear()
        self.proxy.polyline_data_by_node.clear()

        # Clear all screen data and emit updates to show disconnected state
        if self.proxy.socketio and self.proxy.connected_clients > 0:
            try:
                # Import data manager to emit cleared data
                from .data_manager import DataManager
                from .node_manager import NodeManager

                data_mgr = DataManager(self.proxy)
                node_mgr = NodeManager(self.proxy)

                # Emit cleared data to remove all aircraft and simulation info from screen
                data_mgr._emit_cleared_data()
                node_mgr._emit_node_info()
                logger.debug(
                    f"Sent disconnection updates to {self.proxy.connected_clients} web clients"
                )
            except Exception as e:
                logger.warning(f" Error sending disconnection updates: {e}")

        # Close connections and clear state (we might reconnect with same client)
        self.close()

        logger.info("Disconnection cleanup complete - Ready for new connection")
        logger.info("Use web interface settings to reconnect to BlueSky server")

    def _emit_connection_status(self, connected):
        """Emit connection status to connected web clients."""
        if self.proxy.socketio and self.proxy.connected_clients > 0:
            try:
                self.proxy.socketio.emit(
                    "connection_status",
                    {
                        "connected": connected,
                        "server_ip": self.proxy.server_ip,
                        "timestamp": time.time(),
                    },
                )
            except Exception:
                pass

    def close(self):
        """Close all network connections and clear state like BlueSky's close() method."""
        # Disable reconnection first
        self.proxy.allow_reconnection = False

        # Just close the network client - don't destroy ZMQ context
        # The app creates a completely new BlueSkyProxy instance for reconnection
        try:
            logger.debug(" Closing network client...")
            if self.proxy.bluesky_client:
                self.proxy.bluesky_client.close()
            logger.info(" Network client closed successfully")
        except Exception as e:
            logger.error(f" Error closing network client: {e}")

        # We reuse the same network client instance - just close its sockets

        # Reset connection monitoring
        self.proxy.was_connected = False
        self.proxy.last_successful_update = time.time()

        # Clear all tracked state
        self.proxy.tracked_nodes.clear()
        self.proxy.tracked_servers.clear()

        # Clear active node reference to prevent showing corrupted data
        if hasattr(self.proxy.bluesky_client, "act_id"):
            self.proxy.bluesky_client.act_id = None

        # Clear data caches
        self.proxy.traffic_data = {}
        self.proxy.sim_data = {}
        self.proxy.echo_data = {}
        self.proxy.last_update = 0

        # Reset emission timestamps
        self.proxy.last_siminfo_emit = 0
        self.proxy.last_acdata_emit = 0
        self.proxy.last_echo_emit = 0

        # Clear current map bounds
        self.proxy.current_bbox = None

        # Reset aircraft counter
        self.proxy.aircraft_counter = 0

        # Clear command dictionary
        self.proxy.cmddict.clear()

        # Following ZMQ pattern: clear client reference after closing
        # (new client will be created when reconnecting)

        logger.debug(" Client state cleared and connections closed")

    def stop_client(self, context="disconnect"):
        """Stop the client with improved cleanup and proper ZMQ error handling.

        Args:
            context: 'disconnect' for reconnection, 'manual' for user disconnect, 'shutdown' for app termination
        """
        if self.proxy.running:
            logger.info("Stopping BlueSky client connection")

        self.proxy.running = False
        self.proxy.allow_reconnection = False  # Disable reconnection when stopping

        # Cancel timers with proper cleanup
        self._cancel_timers()

        # Close network client with proper ZMQ error handling
        self._close_bluesky_client()

        # Clear remaining state
        from .data_manager import DataManager

        data_mgr = DataManager(self.proxy)
        data_mgr._clear_state(context)

    def _cancel_timers(self):
        """Cancel all timers with proper cleanup."""
        if self.proxy.network_timer:
            try:
                self.proxy.network_timer.cancel()
                # Wait briefly to let any active timer callback complete
                time.sleep(0.05)
                logger.info(" Network timer cancelled")
            except Exception as e:
                logger.warning(f" Warning cancelling network timer: {e}")
            finally:
                self.proxy.network_timer = None

        if self.proxy.backup_timer:
            try:
                self.proxy.backup_timer.cancel()
                logger.info(" Backup timer cancelled")
            except Exception as e:
                logger.warning(f" Warning cancelling backup timer: {e}")
            finally:
                self.proxy.backup_timer = None

    def _close_bluesky_client(self):
        """Close network client following ZMQ pattern: close sockets first, then context."""
        if self.proxy.bluesky_client:
            try:
                logger.debug(" Closing network client sockets...")
                # Close the client (this closes all sockets)
                self.proxy.bluesky_client.close()
                logger.info(" Network client sockets closed successfully")
            except Exception as e:
                import zmq

                if hasattr(zmq, "ZMQError") and isinstance(e, zmq.ZMQError):
                    if e.errno == zmq.ENOTSOCK:
                        logger.warning(" Socket already closed, ignoring")
                    else:
                        logger.warning(f" ZMQ error during client close: {e}")
                else:
                    logger.warning(f" Error during client close: {e}")
            finally:
                # Following ZMQ pattern: destroy client instance after closing sockets
                self.proxy.bluesky_client = None
                logger.info("Network client instance destroyed")

    def reconnect(self, hostname=None):
        """Reconnect to BlueSky server following ZMQ pattern."""
        logger.info("Reconnecting to BlueSky server...")

        # Following ZMQ pattern: close sockets and destroy context first
        self.stop_client("disconnect")

        # Wait briefly for ZMQ cleanup to complete
        time.sleep(0.2)

        # Clear state and prepare for fresh connection
        from .data_manager import DataManager

        data_mgr = DataManager(self.proxy)
        data_mgr._clear_state()

        # Following ZMQ pattern: create fresh context and sockets
        try:
            self.start_client(hostname=hostname)
            logger.info(" Reconnection successful with fresh ZMQ resources")
        except Exception as e:
            logger.error(f" Reconnection failed: {e}")
            raise
            raise
