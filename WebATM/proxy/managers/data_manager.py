"""Data emission and state management for the BlueSky proxy."""

import threading
import time
from typing import Any

from ...logger import get_logger
from ...utils import empty_traffic_data

logger = get_logger()


class DataManager:
    """Manage Socket.IO data emission, backup timers, and state clearing.

    Emits connection status, cleared-state payloads and periodic backup data
    to connected web clients, and provides the initial-page-load snapshot of
    the proxy's cached simulation state.
    """

    def __init__(self, proxy):
        """Initialize the data manager.

        Args:
            proxy (BlueSkyProxy): Parent proxy instance.
        """
        self.proxy = proxy

    def _emit_connection_status(self, connected):
        """Emit a ``connection_status`` event to connected web clients.

        Args:
            connected (bool): Whether the proxy is connected to BlueSky.
        """
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
        """Emit empty payloads to clear aircraft, sim info and shapes.

        Sends a ``server_disconnected`` event followed by empty ``acdata``,
        ``siminfo``, ``poly`` and ``polyline`` events so the map fully resets
        when the BlueSky server goes away. ``server_disconnected`` goes FIRST:
        it opens the browser's deliberate-disconnect grace window, so the
        clearing payloads that follow cannot be mistaken for live data and
        flap the status back to connected for a moment.
        """
        if self.proxy.socketio and self.proxy.connected_clients > 0:
            try:
                self.proxy.socketio.emit(
                    "server_disconnected",
                    {"timestamp": time.time(), "reason": "BlueSky server disconnected"},
                )

                self.proxy.socketio.emit("acdata", empty_traffic_data())

                # Same shape the SIMINFO handler emits, so clients always see
                # a complete siminfo payload.
                empty_sim_data = {
                    "speed": 0.0,
                    "simdt": 0.0,
                    "simt": 0.0,
                    "simutc": "",
                    "ntraf": 0,
                    "state": 0,
                    "scenname": "disconnected",
                    "sender_id": None,
                }
                self.proxy.socketio.emit("siminfo", empty_sim_data)

                self.proxy.socketio.emit("poly", {"polys": {}})
                self.proxy.socketio.emit("polyline", {"polys": {}})

                logger.info(
                    "Sent cleared data (aircraft, sim data, and shapes) to web clients"
                )
            except Exception as e:
                logger.error(f"Error emitting cleared data: {e}")

    def start_backup_timer(self):
        """Start (or restart) the 0.5 s backup emission timer."""
        if self.proxy.backup_timer:
            self.proxy.backup_timer.cancel()
        self.proxy.backup_timer = threading.Timer(0.5, self.backup_data_emit)
        self.proxy.backup_timer.daemon = True
        self.proxy.backup_timer.start()

    def backup_data_emit(self):
        """Re-emit cached sim/traffic data and reschedule the backup timer.

        Safety net for web clients that connect between subscriber emissions:
        pushes the latest cached ``siminfo`` and ``acdata`` payloads, then
        schedules the next backup tick while the proxy is running.
        """
        if not self.proxy.running:
            return

        if self.proxy.socketio and self.proxy.connected_clients > 0:
            try:
                if self.proxy.sim_data:
                    self.proxy.socketio.emit("siminfo", self.proxy.sim_data)
                if self.proxy.traffic_data:
                    self.proxy.socketio.emit("acdata", self.proxy.traffic_data)
            except Exception:
                pass

        self.start_backup_timer()

    def _reset_cached_state(self):
        """Reset connection monitoring and drop all cached BlueSky state.

        The single implementation of "forget everything we knew about the
        server": tracked nodes/servers, data caches, emission throttles, map
        bounds and the command dictionary. Shared by every teardown path
        (``stop_client``, ``ConnectionManager.close`` and
        ``_handle_disconnection``) so the paths cannot drift apart.
        """
        self.proxy.was_connected = False
        self.proxy.connection_failures = 0
        self.proxy.last_successful_update = time.time()

        self.proxy.tracked_nodes.clear()
        self.proxy.tracked_servers.clear()

        self.proxy.traffic_data = {}
        self.proxy.sim_data = {}
        self.proxy.echo_data = {}
        self.proxy.poly_data_by_node.clear()
        self.proxy.polyline_data_by_node.clear()

        self.proxy.last_siminfo_emit = 0
        self.proxy.last_acdata_emit = 0
        self.proxy.last_node_info_emit = 0

        self.proxy.current_bbox = None
        self.proxy.cmddict.clear()

    def _emit_disconnected_state(self, was_connected):
        """Tell browsers the BlueSky link is gone.

        Always refreshes the (now empty) node list. When the proxy had
        actually been connected, also flips ``connection_status`` and sends
        the map-clearing payloads, so every browser — not just the one that
        initiated the disconnect — drops the stale traffic instead of
        showing a frozen "connected" map until its no-data timeout fires.

        Args:
            was_connected (bool): Whether the proxy was connected before the
                teardown began (captured before the state reset clears it).
        """
        if was_connected:
            self._emit_connection_status(False)
            self._emit_cleared_data()
        self.proxy.node_mgr._emit_node_info()

    def _clear_state(self, context="disconnect"):
        """Clear all cached client state after a stop or disconnect.

        Args:
            context (str): Cleanup context — ``"disconnect"`` for
                reconnection, ``"manual"`` for a user-initiated disconnect,
                ``"shutdown"`` for app termination. Only affects the final
                log message.
        """
        was_connected = self.proxy.was_connected
        self._reset_cached_state()
        self._emit_disconnected_state(was_connected)

        if context == "shutdown":
            logger.info("Shutdown complete")
        elif context == "manual":
            logger.info("Disconnected from BlueSky server")
        else:
            logger.info("Client stopped - Ready for new connection")

    def get_current_data(self) -> dict[str, Any]:
        """Build the simulation state snapshot for an initial page load.

        Shapes (polygons/polylines) are only included for the currently
        active node.

        Returns:
            dict[str, Any]: Snapshot with ``traffic_data``, ``sim_data``,
                ``echo_data``, ``poly_data``, ``polyline_data``, ``cmddict``,
                ``connection_status``, ``node_info`` and a ``timestamp``.
        """
        active_node_id = self.proxy.node_mgr._get_safe_active_node()

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
            logger.debug("No active node - not including any shapes in initial data")

        return {
            "traffic_data": self.proxy.traffic_data,
            "sim_data": self.proxy.sim_data,
            "echo_data": self.proxy.echo_data,
            "poly_data": poly_data,
            "polyline_data": polyline_data,
            "cmddict": self.proxy.cmddict,
            "connection_status": {
                "connected": self.proxy.is_connected,
                "server_ip": self.proxy.server_ip,
                "last_update": self.proxy.last_successful_update,
            },
            # Same serialized shape as the node_info event (no raw bytes).
            "node_info": self.proxy.node_mgr.serialize_node_info(),
            "timestamp": time.time(),
        }
