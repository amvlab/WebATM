"""BlueSky proxy gateway for web interface communication."""

import time
from typing import Any

from ..bluesky_client import safe_decode
from ..logger import get_logger
from .managers import CommandProcessor, ConnectionManager, DataManager, NodeManager

logger = get_logger()


class BlueSkyProxy:
    """Bridge between the web interface and the BlueSky network client.

    Owns the network client lifecycle, caches incoming simulation data, and
    relays it to connected web clients over Socket.IO. The actual work is
    delegated to four focused managers following a composition pattern.

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
            BlueSky's STACKCMDS broadcast).
        connection_mgr (ConnectionManager): Connection lifecycle manager.
        node_mgr (NodeManager): Node/server tracking manager.
        command_proc (CommandProcessor): Command processing manager.
        data_mgr (DataManager): Data emission and state manager.
    """

    def __init__(self):
        """Initialize the proxy with empty caches and its manager modules."""
        logger.debug("Initializing BlueSkyProxy()...")

        # Don't initialize BlueSky client in __init__ - create when needed
        # Following ZMQ pattern: create context and sockets only when connecting
        self.bluesky_client = None
        self.zmq_context = None

        self.running = False
        self.network_timer = None
        self.socketio = None

        # Flag to prevent automatic reconnection
        self.allow_reconnection = False

        # Connection monitoring
        self.last_successful_update = time.time()
        self.connection_timeout = 10.0  # 10 seconds without updates = disconnected
        self.health_check_interval = 2.0  # Check connection every 2 seconds
        self.was_connected = False
        self.connection_failures = 0
        self.max_connection_failures = 3  # Max failures before marking disconnected

        # Data caches for web client
        self.traffic_data = {}
        self.sim_data = {}
        self.echo_data = {}
        self.last_update = 0

        # Store POLY data by node ID
        self.poly_data_by_node = {}

        # Store POLYLINE data by node ID
        self.polyline_data_by_node = {}

        # Throttling for data emission
        self.last_siminfo_emit = 0
        self.last_acdata_emit = 0
        self.last_echo_emit = 0
        self.last_node_info_emit = 0
        self.siminfo_interval = 0.1  # 10 Hz for sim info (faster updates)
        self.acdata_interval = 0.1  # 10 Hz for aircraft data (much faster updates!)
        self.node_info_interval = 1.0  # 1 Hz periodic refresh of the Nodes panel
        self.echo_interval = (
            0.01  # 100 Hz for echo messages (near real-time for command responses)
        )

        # Backup timer for data updates
        self.backup_timer = None

        # Track connected clients
        self.connected_clients = 0

        # Track nodes and servers like web client does
        self.tracked_nodes = {}
        self.tracked_servers = {}  # Keep minimal server tracking for compatibility

        # Store current map bounds
        self.current_bbox = None

        # Counter for unique aircraft callsigns
        self.aircraft_counter = 0

        # Store server IP address (default to localhost, will be set by main.py if configured)
        self.server_ip = "localhost"

        # Stack command processing (BlueSky client pattern). Values use the
        # comma-separated arg-signature format that BlueSky's STACKCMDS
        # broadcast ships (e.g. "acid,type,lat,lon,hdg,alt,spd"); these
        # seeds get overwritten the moment STACKCMDS arrives.
        self.cmddict = {
            "HELP": "[command]",
            "?": "[command]",
        }  # Local command dictionary (like Command.cmddict)
        self.echo_signal = None  # Signal for echo responses

        # Initialize managers
        self.connection_mgr = ConnectionManager(self)
        self.node_mgr = NodeManager(self)
        self.command_proc = CommandProcessor(self)
        self.data_mgr = DataManager(self)

        # Connection callbacks will be set up when BlueSky client is initialized

    def _safe_decode(self, data):
        """Safely decode bytes to a string."""
        return safe_decode(data)

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

    def _ensure_clean_zmq_context(self):
        """Ensure we have a clean environment for ZMQ connections."""
        return self.connection_mgr._ensure_clean_zmq_context()

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

    def _start_network_timer(self):
        """Start the network update timer (exactly like web client's timer does)."""
        return self.connection_mgr._start_network_timer()

    def _handle_disconnection(self, reason="Unknown"):
        """Handle disconnection - close connections and clean up state."""
        return self.connection_mgr._handle_disconnection(reason)

    def _cancel_timers(self):
        """Cancel all timers with proper cleanup."""
        return self.connection_mgr._cancel_timers()

    def _close_bluesky_client(self):
        """Close network client following ZMQ pattern: close sockets first, then context."""
        return self.connection_mgr._close_bluesky_client()

    def reconnect(self, hostname=None):
        """Reconnect to BlueSky server following ZMQ pattern."""
        return self.connection_mgr.reconnect(hostname)

    def close(self):
        """Close all network connections and clear state like BlueSky's close() method."""
        return self.connection_mgr.close()

    # ========================================================================
    # Node Management - Delegate to NodeManager
    # ========================================================================

    def _get_safe_active_node(self):
        """Get the active node ID safely, returning None if disconnected or invalid."""
        return self.node_mgr._get_safe_active_node()

    def _on_actnode_changed(self, node_id):
        """Callback when active node changes."""
        return self.node_mgr._on_actnode_changed(node_id)

    def _emit_active_node_poly_data(self):
        """Emit POLY and POLYLINE data for the currently active node."""
        return self.node_mgr._emit_active_node_poly_data()

    def _on_node_added(self, node_id):
        """Callback when a new node is discovered."""
        return self.node_mgr._on_node_added(node_id)

    def _on_server_added(self, server_id):
        """Callback when a server is discovered."""
        return self.node_mgr._on_server_added(server_id)

    def _on_node_removed(self, node_id):
        """Callback when a node is removed."""
        return self.node_mgr._on_node_removed(node_id)

    def _check_node_shutdown(self):
        """Check if server is really shut down after all nodes removed."""
        return self.node_mgr._check_node_shutdown()

    def _on_server_removed(self, server_id):
        """Callback when a server is removed."""
        return self.node_mgr._on_server_removed(server_id)

    def _emit_node_info(self):
        """Emit current node and server information to connected clients."""
        return self.node_mgr._emit_node_info()

    def actnode(self, node_id):
        """Delegate actnode call to network proxy."""
        return self.node_mgr.actnode(node_id)

    def addnodes(self, count, server_id=None):
        """Delegate addnodes call to network proxy."""
        return self.node_mgr.addnodes(count, server_id=server_id)

    # ========================================================================
    # Command Processing - Delegate to CommandProcessor
    # ========================================================================

    def send_command(self, command: str) -> bool:
        """Send a command to the simulation using stack processing."""
        return self.command_proc.send_command(command)

    def _process_stack_commands(self):
        """Process stack commands from users/GUI following BlueSky client pattern exactly."""
        return self.command_proc._process_stack_commands()

    def _forward_command(self, cmdline):
        """Forward command to BlueSky server for validation and execution."""
        return self.command_proc._forward_command(cmdline)

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

    def _emit_cleared_data(self):
        """Emit cleared data to remove all aircraft and simulation info from the map."""
        return self.data_mgr._emit_cleared_data()

    def start_backup_timer(self):
        """Start backup timer to ensure data gets sent regularly."""
        return self.data_mgr.start_backup_timer()

    def backup_data_emit(self):
        """Backup method to emit data if subscribers haven't."""
        return self.data_mgr.backup_data_emit()

    def _clear_state(self, context="disconnect"):
        """Clear all client state data."""
        return self.data_mgr._clear_state(context)

    def get_current_data(self) -> dict[str, Any]:
        """Get current simulation data for initial page load."""
        return self.data_mgr.get_current_data()
