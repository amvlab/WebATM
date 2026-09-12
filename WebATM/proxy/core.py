"""BlueSky proxy gateway for web interface communication."""

import time
from typing import Any

from ..logger import get_logger
from .managers import CommandProcessor, ConnectionManager, DataManager, NodeManager

logger = get_logger()


class BlueSkyProxy:
    """Bridge between the web interface and the BlueSky network client.

    Owns the network client lifecycle, caches incoming simulation data, and
    relays it to connected web clients over Socket.IO. The actual work is
    delegated to four focused managers following a composition pattern; only
    the methods that routes, Socket.IO handlers, network-event handlers or
    tests actually call through the proxy are re-exposed here — manager
    internals are reached via ``connection_mgr``/``node_mgr``/
    ``command_proc``/``data_mgr`` directly.

    Attributes:
        bluesky_client (BlueSkyClient | None): Active network client; created
            when connecting and destroyed on close.
        running (bool): Whether the network update loop is active.
        socketio: Flask-SocketIO instance used to emit events to web clients.
        traffic_data (dict): Latest ACDATA payload, cached for new clients.
        sim_data (dict): Latest SIMINFO payload, cached for new clients.
        echo_data (dict): Latest echo message, cached for new clients.
        tracked_nodes (dict): Known simulation nodes keyed by hex node ID.
        tracked_servers (dict): Known servers keyed by raw server ID.
        cmddict (dict): Command dictionary mapping command names to their
            comma-separated argument signatures (seeded locally, replaced by
            the active node's STACKCMDS answer).
        connection_mgr (ConnectionManager): Connection lifecycle manager.
        node_mgr (NodeManager): Node/server tracking manager.
        command_proc (CommandProcessor): Command processing manager.
        data_mgr (DataManager): Data emission and state manager.
    """

    def __init__(self):
        """Initialize the proxy with empty caches and its manager modules."""
        logger.debug("Initializing BlueSkyProxy()...")

        # ZMQ pattern: the client is created on connect and destroyed on close.
        self.bluesky_client = None

        self.running = False
        self.network_timer = None
        self.socketio = None

        # Flag to prevent automatic reconnection
        self.allow_reconnection = False

        # Connection monitoring
        self.last_successful_update = time.time()
        self.connection_timeout = 10.0  # 10 seconds without updates = disconnected
        self.was_connected = False
        self.connection_failures = 0
        self.max_connection_failures = 3  # Max failures before marking disconnected

        # Data caches for web client
        self.traffic_data = {}
        self.sim_data = {}
        self.echo_data = {}

        # Per-node shape stores (only the active node's shapes are displayed)
        self.poly_data_by_node = {}
        self.polyline_data_by_node = {}

        # Throttling for data emission (echo messages are never throttled)
        self.last_siminfo_emit = 0
        self.last_acdata_emit = 0
        self.last_node_info_emit = 0
        self.siminfo_interval = 0.1  # 10 Hz for sim info
        self.acdata_interval = 0.1  # 10 Hz for aircraft data
        self.node_info_interval = 1.0  # 1 Hz periodic refresh of the Nodes panel

        # Backup timer for data updates
        self.backup_timer = None

        # Track connected clients
        self.connected_clients = 0

        # Track nodes and servers like web client does
        self.tracked_nodes = {}
        self.tracked_servers = {}  # Keep minimal server tracking for compatibility

        # Store current map bounds
        self.current_bbox = None

        # Server IP address (overridden by main.py / the connect routes)
        self.server_ip = "localhost"

        # Command dictionary seeds, in the arg-signature format BlueSky's
        # STACKCMDS answers ship; replaced by the active node's STACKCMDS.
        self.cmddict = {
            "HELP": "[command]",
            "?": "[command]",
        }

        # Initialize managers
        self.connection_mgr = ConnectionManager(self)
        self.node_mgr = NodeManager(self)
        self.command_proc = CommandProcessor(self)
        self.data_mgr = DataManager(self)

    # ========================================================================
    # Connection Management - Delegate to ConnectionManager
    # ========================================================================

    @property
    def is_connected(self) -> bool:
        """Single source of truth for "are we connected to BlueSky".

        True once the client is running, has previously detected at least one
        node, and still has active nodes. Every consumer (Socket.IO payloads,
        REST routes) should read this instead of re-deriving the formula.

        Returns:
            bool: True when connected to a BlueSky server with active nodes.
        """
        return self.was_connected and self.running and len(self.tracked_nodes) > 0

    def _connect_bluesky_client_signals(self):
        """Connect BlueSky client signals to our handlers."""
        return self.connection_mgr._connect_bluesky_client_signals()

    def start_client(self, hostname=None):
        """Start the network client with fresh state, following the ZMQ pattern.

        Args:
            hostname (str, optional): BlueSky server hostname or IP address.
                Defaults to the previously configured server address.

        Raises:
            RuntimeError: If the connection to the BlueSky server fails.
        """
        return self.connection_mgr.start_client(hostname)

    def stop_client(self, context="disconnect"):
        """Stop the client with improved cleanup and proper ZMQ error handling.

        Args:
            context (str): Reason for stopping — "disconnect" for reconnection,
                "manual" for user disconnect, or "shutdown" for app termination.
        """
        return self.connection_mgr.stop_client(context)

    def close(self):
        """Close all network connections and clear state like BlueSky's close() method."""
        return self.connection_mgr.close()

    # ========================================================================
    # Node Management - Delegate to NodeManager
    # ========================================================================

    def _get_safe_active_node(self):
        """Get the active node ID safely, returning None if disconnected or invalid."""
        return self.node_mgr._get_safe_active_node()

    def _emit_node_info(self):
        """Emit current node and server information to connected clients."""
        return self.node_mgr._emit_node_info()

    def actnode(self, node_id):
        """Delegate actnode call to network proxy."""
        return self.node_mgr.actnode(node_id)

    def addnodes(self, count, server_id=None):
        """Delegate addnodes call to network proxy."""
        return self.node_mgr.addnodes(count, server_id=server_id)

    def delnode(self, node_id):
        """Delegate delnode call to network proxy."""
        return self.node_mgr.delnode(node_id)

    # ========================================================================
    # Command Processing - Delegate to CommandProcessor
    # ========================================================================

    def send_command(self, command: str) -> bool:
        """Send a command to the simulation using stack processing."""
        return self.command_proc.send_command(command)

    def forward(self, *cmdlines, target_id=None):
        """Forward one or more stack commands to BlueSky server."""
        return self.command_proc.forward(*cmdlines, target_id=target_id)

    def _execute_local_command(self, cmd, argstring):
        """Execute local client command (like BlueSky Command.cmddict does)."""
        return self.command_proc._execute_local_command(cmd, argstring)

    def _echo_response(self, text, flags):
        """Send echo response to web proxy."""
        return self.command_proc._echo_response(text, flags)

    # ========================================================================
    # Data Management - Delegate to DataManager
    # ========================================================================

    def _emit_connection_status(self, connected):
        """Emit connection status to connected web clients."""
        return self.data_mgr._emit_connection_status(connected)

    def get_current_data(self) -> dict[str, Any]:
        """Get current simulation data for initial page load."""
        return self.data_mgr.get_current_data()
