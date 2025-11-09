"""Data emission and state management for BlueSky proxy."""

import threading
import time
from typing import Any, Dict

from ...logger import get_logger

logger = get_logger()


class DataManager:
    """Manages data emission, backup timers, and state clearing."""

    def __init__(self, proxy):
        """Initialize DataManager with reference to parent proxy.

        Args:
            proxy: Parent BlueSkyProxy instance
        """
        self.proxy = proxy

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

    def _emit_cleared_data(self):
        """Emit cleared data to remove all aircraft and simulation info from the map."""
        if self.proxy.socketio and self.proxy.connected_clients > 0:
            try:
                # Emit empty traffic data to clear all aircraft from the map
                empty_traffic_data = {
                    "id": [],
                    "lat": [],
                    "lon": [],
                    "alt": [],
                    "tas": [],
                    "trk": [],
                    "vs": [],
                    "inconf": [],
                    "tcpamax": [],
                    "nconf_cur": 0,
                    "nconf_tot": 0,
                    "nlos_cur": 0,
                    "nlos_tot": 0,
                }
                self.proxy.socketio.emit("acdata", empty_traffic_data)

                # Emit empty simulation data
                empty_sim_data = {
                    "speed": 0.0,
                    "simdt": 0.0,
                    "simt": 0.0,
                    "simutc": "",
                    "ntraf": 0,
                    "state": 0,
                    "scenname": "disconnected",
                }
                self.proxy.socketio.emit("siminfo", empty_sim_data)

                # Emit empty shape data to clear all polygons and polylines
                empty_shape_data = {"polys": {}}
                self.proxy.socketio.emit("poly", empty_shape_data)
                self.proxy.socketio.emit("polyline", empty_shape_data)

                # Emit disconnection event for map clearing
                self.proxy.socketio.emit(
                    "server_disconnected",
                    {"timestamp": time.time(), "reason": "BlueSky server disconnected"},
                )

                logger.info(
                    "Sent cleared data (aircraft, sim data, and shapes) to web clients"
                )
            except Exception as e:
                logger.error(f" Error emitting cleared data: {e}")

    def start_backup_timer(self):
        """Start backup timer to ensure data gets sent regularly."""
        if self.proxy.backup_timer:
            self.proxy.backup_timer.cancel()
        self.proxy.backup_timer = threading.Timer(
            0.5, self.backup_data_emit
        )  # More frequent backup
        self.proxy.backup_timer.daemon = True
        self.proxy.backup_timer.start()

    def backup_data_emit(self):
        """Backup method to emit data if subscribers haven't."""
        if not self.proxy.running:
            return

        if self.proxy.socketio and self.proxy.connected_clients > 0:
            try:
                # Force emit current data
                if self.proxy.sim_data:
                    self.proxy.socketio.emit("siminfo", self.proxy.sim_data)
                if self.proxy.traffic_data:
                    self.proxy.socketio.emit("acdata", self.proxy.traffic_data)
            except Exception:
                # Handle emission errors gracefully (e.g., disconnected clients)
                pass

        # Schedule next backup emission
        self.start_backup_timer()

    def _clear_state(self, context="disconnect"):
        """Clear all client state data.

        Args:
            context: 'disconnect' for reconnection, 'manual' for user disconnect, 'shutdown' for app termination
        """
        # Reset connection monitoring
        self.proxy.was_connected = False
        self.proxy.last_successful_update = time.time()

        # Clear all tracked state
        self.proxy.tracked_nodes.clear()
        self.proxy.tracked_servers.clear()

        # Clear data caches
        self.proxy.traffic_data = {}
        self.proxy.sim_data = {}
        self.proxy.echo_data = {}
        self.proxy.last_update = 0

        # Clear POLY data by node
        self.proxy.poly_data_by_node.clear()

        # Clear POLYLINE data by node
        self.proxy.polyline_data_by_node.clear()

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

        # Emit updated node info to show disconnection
        if self.proxy.socketio and self.proxy.connected_clients > 0:
            try:
                # Import to avoid circular dependency
                from .node_manager import NodeManager

                # Create temporary instance just for emitting
                node_mgr = NodeManager(self.proxy)
                node_mgr._emit_node_info()
            except Exception:
                pass

        if context == "shutdown":
            logger.info(" Shutdown complete")
        elif context == "manual":
            logger.info(" Disconnected from BlueSky server")
        else:
            logger.info(" Client stopped - Ready for new connection")

    def get_current_data(self) -> Dict[str, Any]:
        """Get current simulation data for initial page load."""
        # Import helper methods from node manager
        from .node_manager import NodeManager

        # Create temporary instance to access helper method
        node_mgr = NodeManager(self.proxy)
        active_node_id = node_mgr._get_safe_active_node()

        poly_data = {}
        polyline_data = {}

        if active_node_id:
            # Only include shapes from the active node
            if active_node_id in self.proxy.poly_data_by_node:
                poly_data = self.proxy.poly_data_by_node[active_node_id]

            if active_node_id in self.proxy.polyline_data_by_node:
                polyline_data = self.proxy.polyline_data_by_node[active_node_id]

            poly_count = len(poly_data.get("polys", {}))
            polyline_count = len(polyline_data.get("polys", {}))
            if poly_count > 0 or polyline_count > 0:
                logger.info(
                    f"Including shapes from active node '{active_node_id}' in initial data: {poly_count} polygons, {polyline_count} polylines"
                )
        else:
            logger.debug(" No active node - not including any shapes in initial data")

        # Import safe_decode helper
        from ...bluesky_client import safe_decode

        def _safe_decode(data):
            """Helper to safely decode bytes to string."""
            return safe_decode(data)

        return {
            "traffic_data": self.proxy.traffic_data,
            "sim_data": self.proxy.sim_data,
            "echo_data": self.proxy.echo_data,
            "poly_data": poly_data,
            "polyline_data": polyline_data,
            "cmddict": self.proxy.cmddict,
            "connection_status": {
                "connected": self.proxy.was_connected
                and self.proxy.running
                and len(self.proxy.tracked_nodes) > 0,
                "server_ip": self.proxy.server_ip,
                "last_update": self.proxy.last_successful_update,
            },
            "node_info": {
                "nodes": self.proxy.tracked_nodes.copy(),
                "servers": {
                    _safe_decode(k): v for k, v in self.proxy.tracked_servers.items()
                },
                "active_node": active_node_id,
                "total_nodes": len(self.proxy.tracked_nodes),
            },
            "timestamp": time.time(),
        }
