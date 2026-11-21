"""Connection management for the BlueSky proxy."""

import threading
import time

import zmq

from ...bluesky_client import BlueSkyClient, safe_decode
from ...logger import get_logger

logger = get_logger()


class ConnectionManager:
    """Manage the BlueSky client connection lifecycle.

    Owns creation and teardown of the network client, the 20 ms network
    update timer, data-flow timeout detection, and disconnection cleanup,
    following the ZMQ create-on-connect / destroy-on-close pattern.
    """

    def __init__(self, proxy):
        """Initialize the connection manager.

        Args:
            proxy (BlueSkyProxy): Parent proxy instance.
        """
        self.proxy = proxy

    def _connect_bluesky_client_signals(self):
        """Connect BlueSky client signals to our node-manager handlers."""
        client = self.proxy.bluesky_client
        if client is None:
            logger.warning("Cannot connect signals - BlueSky client not initialized")
            return

        node_mgr = self.proxy.node_mgr
        # Each BlueSky client signal -> the node-manager handler it feeds.
        signal_handlers = {
            "node_added": node_mgr._on_node_added,
            "server_added": node_mgr._on_server_added,
            "node_removed": node_mgr._on_node_removed,
            "server_removed": node_mgr._on_server_removed,
            "actnode_changed": node_mgr._on_actnode_changed,
        }

        logger.debug("Connecting BlueSky client signals...")
        for name, handler in signal_handlers.items():
            signal = getattr(client, name, None)
            if signal is None:
                logger.warning(f"{name} signal not available")
                continue
            signal.connect(handler)

    def start_client(self, hostname=None):
        """Start the network client with fresh state, following the ZMQ pattern.

        Stops any existing connection first, creates the BlueSky network
        client if needed, wires its node/server signals to the node manager,
        connects to the server, registers the data subscribers, and starts
        the network update and backup emission timers.

        Subscribers are registered here — after ``connect()`` (the network-
        level subscriptions need the sockets) but before the network timer
        starts — so the client is never pumped while the subscriber registry
        is empty. Discovery of the first node broadcasts a REQUEST whose
        answers (the initial POLY shapes and STACKCMDS command dictionary)
        are one-shot: if they arrived before handlers were attached they were
        silently dropped, and nothing re-requests them until the active node
        changes.

        Args:
            hostname (str | None): BlueSky server hostname/IP. When None, the
                proxy's currently configured ``server_ip`` is used.

        Raises:
            RuntimeError: If the connection to the BlueSky server fails.
            Exception: If the network client cannot be created.
        """
        # Ensure we start from a clean state. stop_client() destroys the client
        # instance, so this must run *before* we (re)create it below -- otherwise
        # we would connect() on a client that was just torn down.
        if self.proxy.running:
            logger.info("Stopping existing connection before starting new one")
            self.stop_client()
            time.sleep(0.2)

        # Following ZMQ pattern: create context and sockets when connecting
        if self.proxy.bluesky_client is None:
            logger.debug("Creating BlueSky network client...")
            try:
                self.proxy.bluesky_client = BlueSkyClient()
                self._connect_bluesky_client_signals()
                logger.info("BlueSky network client created successfully")
            except Exception as e:
                logger.error(f"Error creating BlueSky network client: {e}")
                raise

        if hostname:
            self.proxy.server_ip = hostname

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
                logger.error(f"Error in network connect(): {e}")
                raise

            # Deferred import: this module is loaded during WebATM.proxy
            # package init, before .subscribers exists.
            from ..subscribers import register_subscribers

            register_subscribers(self.proxy)

            # Initialize connection monitoring; was_connected flips to True
            # once the first node is detected.
            self.proxy.last_successful_update = time.time()
            self.proxy.was_connected = False

            self.proxy.running = True

            self._start_network_timer()
            self.proxy.data_mgr.start_backup_timer()

            logger.debug(
                f"Node detection started (timeout: {self.proxy.connection_timeout}s)"
            )
        except Exception as e:
            logger.error(
                f"Failed to connect to BlueSky server at '{self.proxy.server_ip}': {e}"
            )
            self.proxy.running = False
            self.proxy.allow_reconnection = False
            self.proxy.was_connected = False
            raise

    def mark_connected(self):
        """Flip the proxy to connected once the first node is detected.

        Restarts the data-flow timeout clock from "first node appeared" — no
        data can arrive before nodes exist, so a slow cold start must not
        count against ``connection_timeout``. Called from both the node-added
        signal and the network timer (whichever sees the first node first);
        a no-op when already connected.
        """
        if self.proxy.was_connected:
            return
        self.proxy.was_connected = True
        self.proxy.last_successful_update = time.time()
        logger.info(
            f"Connection established to BlueSky server '{self.proxy.server_ip}'"
        )
        self.proxy._emit_connection_status(True)

    def _start_network_timer(self):
        """Start the recurring 20 ms network update timer.

        Each tick runs ``_network_tick``; the timer reschedules itself while
        the proxy is running and no disconnect has been detected.
        """
        self._schedule_network_tick()

    def _schedule_network_tick(self):
        """Arm the timer for the next ``_network_tick`` in 20 ms."""
        self.proxy.network_timer = threading.Timer(0.02, self._network_timer_callback)
        self.proxy.network_timer.daemon = True
        self.proxy.network_timer.start()

    def _network_timer_callback(self):
        """Run one tick and reschedule while the proxy keeps running."""
        if (
            self._network_tick()
            and self.proxy.running
            and self.proxy.allow_reconnection
        ):
            self._schedule_network_tick()

    def _network_tick(self):
        """Pump the network client once and track connection health.

        ``BlueSkyClient.update()`` reports trouble by returning False — it
        never raises — so a False return counts toward
        ``max_connection_failures``. A healthy tick resets that count, flips
        the proxy to connected once nodes exist, and enforces the data-flow
        timeout (nothing received within ``connection_timeout`` counts as a
        disconnect, whether nodes are still listed or all gone).

        Returns:
            bool: True when the next tick should be scheduled, False when the
                proxy is no longer running or this tick triggered
                disconnection handling.
        """
        proxy = self.proxy
        if not (proxy.running and proxy.allow_reconnection and proxy.bluesky_client):
            return False

        try:
            update_ok = proxy.bluesky_client.update()
        except Exception as e:
            logger.info(f"Network update raised: {e}")
            update_ok = False

        if not update_ok:
            proxy.connection_failures += 1
            logger.info(
                f"Network error detected "
                f"({proxy.connection_failures}/{proxy.max_connection_failures})"
            )
            if proxy.connection_failures >= proxy.max_connection_failures:
                logger.info("Max connection failures reached - marking as disconnected")
                self._handle_disconnection("Network error (max failures)")
                return False
            return True

        proxy.connection_failures = 0

        if len(proxy.tracked_nodes) > 0:
            self.mark_connected()

        idle_time = time.time() - proxy.last_successful_update
        if proxy.was_connected and idle_time > proxy.connection_timeout:
            logger.info(
                f"Connection timeout detected ({idle_time:.1f}s since last data)"
            )
            self._handle_disconnection("Connection timeout")
            return False

        return True

    def _handle_disconnection(self, reason="Unknown"):
        """Close connections and clean up state after a detected disconnect.

        Args:
            reason (str): Human-readable reason logged and used for
                diagnostics (e.g. "Connection timeout").
        """
        was_connected = self.proxy.was_connected
        if was_connected:
            logger.info(f"BlueSky server disconnected - Reason: {reason}")

        # Don't try to reconnect - just stop running and close
        self.proxy.running = False
        self.proxy.allow_reconnection = False

        # Clear the cached state BEFORE emitting, so browsers receive the
        # disconnected (empty) node/traffic picture, not the stale one.
        self.proxy.data_mgr._reset_cached_state()
        self.proxy.data_mgr._emit_disconnected_state(was_connected)

        # Close the network client's sockets and clear remaining state
        self.close()

        logger.info("Disconnection cleanup complete - Ready for new connection")
        logger.info("Use web interface settings to reconnect to BlueSky server")

    def close(self):
        """Close the network client's sockets and clear cached proxy state.

        The client instance itself is kept (only ``stop_client`` destroys it);
        the app reconnects by creating a fresh ``BlueSkyProxy``, so this only
        has to release the sockets and forget the cached server state.
        """
        self.proxy.allow_reconnection = False

        client = self.proxy.bluesky_client
        if client is not None:
            try:
                client.close()
                logger.info("Network client closed successfully")
            except Exception as e:
                logger.error(f"Error closing network client: {e}")
            # Clear the active node so no stale data can be attributed to it.
            if hasattr(client, "act_id"):
                client.act_id = None

        self.proxy.data_mgr._reset_cached_state()
        logger.debug("Client state cleared and connections closed")

    def stop_client(self, context="disconnect"):
        """Stop the client with full cleanup and proper ZMQ error handling.

        Cancels the network/backup timers, closes and destroys the network
        client, and clears remaining proxy state.

        Args:
            context (str): Cleanup context — ``"disconnect"`` for
                reconnection, ``"manual"`` for a user-initiated disconnect,
                ``"shutdown"`` for app termination.
        """
        if self.proxy.running:
            logger.info("Stopping BlueSky client connection")

        self.proxy.running = False
        self.proxy.allow_reconnection = False

        self._cancel_timers()
        self._close_bluesky_client()
        self.proxy.data_mgr._clear_state(context)

    def _cancel_timers(self):
        """Cancel the network and backup timers."""
        cancelled = False
        for attr in ("network_timer", "backup_timer"):
            timer = getattr(self.proxy, attr)
            if timer is not None:
                timer.cancel()
                setattr(self.proxy, attr, None)
                cancelled = True
        if cancelled:
            # Give an in-flight network tick a moment to finish before the
            # sockets are torn down underneath it.
            time.sleep(0.05)
            logger.info("Timers cancelled")

    def _close_bluesky_client(self):
        """Close network client following ZMQ pattern: close sockets first, then context."""
        if self.proxy.bluesky_client:
            try:
                logger.debug("Closing network client sockets...")
                self.proxy.bluesky_client.close()
                logger.info("Network client sockets closed successfully")
            except zmq.ZMQError as e:
                if e.errno == zmq.ENOTSOCK:
                    logger.warning("Socket already closed, ignoring")
                else:
                    logger.warning(f"ZMQ error during client close: {e}")
            except Exception as e:
                logger.warning(f"Error during client close: {e}")
            finally:
                # Following ZMQ pattern: destroy client instance after closing sockets
                self.proxy.bluesky_client = None
                logger.info("Network client instance destroyed")
