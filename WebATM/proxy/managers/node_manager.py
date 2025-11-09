"""Node and server management for BlueSky proxy."""

import threading

from ...bluesky_client import safe_decode, seqid2idx, seqidx2id
from ...logger import get_logger

logger = get_logger()


class NodeManager:
    """Manages BlueSky nodes and servers."""

    def __init__(self, proxy):
        """Initialize NodeManager with reference to parent proxy.

        Args:
            proxy: Parent BlueSkyProxy instance
        """
        self.proxy = proxy

    def _get_safe_active_node(self):
        """Get the active node ID safely, returning None if disconnected or invalid."""
        if (
            not self.proxy.running
            or not self.proxy.was_connected
            or len(self.proxy.tracked_nodes) == 0
            or not hasattr(self.proxy.bluesky_client, "act_id")
            or not self.proxy.bluesky_client.act_id
        ):
            return None

        try:
            # The act_id is stored as raw bytes in the network client
            raw_active_id = self.proxy.bluesky_client.act_id

            # Convert to hex string to match our tracked_nodes keys
            active_id_str = (
                raw_active_id.hex()
                if isinstance(raw_active_id, bytes)
                else str(raw_active_id)
            )

            # Check if this hex string exists in our tracked nodes
            if active_id_str in self.proxy.tracked_nodes:
                return active_id_str
        except Exception:
            pass
        return None

    def _on_actnode_changed(self, node_id):
        """Callback when active node changes."""
        if self.proxy.running:
            # Emit immediately to update web interface
            self._emit_node_info()

            # Emit POLY data for the newly active node
            self._emit_active_node_poly_data()

    def _emit_active_node_poly_data(self):
        """Emit POLY and POLYLINE data for the currently active node."""
        try:
            active_node_id = self._get_safe_active_node()
            logger.debug(
                f"_emit_active_node_poly_data called: active_node={active_node_id}, connected_clients={self.proxy.connected_clients}"
            )

            # Handle POLY data
            if active_node_id and active_node_id in self.proxy.poly_data_by_node:
                poly_data = self.proxy.poly_data_by_node[active_node_id]
                poly_count = len(poly_data.get("polys", {}))
                logger.debug(
                    f"Found {poly_count} polygons for active node {active_node_id}"
                )
                if self.proxy.socketio and self.proxy.connected_clients > 0:
                    self.proxy.socketio.emit("poly", poly_data)
                    logger.info(
                        f"Emitted {poly_count} polygons to {self.proxy.connected_clients} clients"
                    )
                else:
                    logger.warning(
                        f"Cannot emit polygons: socketio={self.proxy.socketio is not None}, connected_clients={self.proxy.connected_clients}"
                    )
            else:
                # No POLY data for active node - emit empty to clear any existing polygons
                logger.debug(f" No polygon data for active node {active_node_id}")
                if self.proxy.socketio and self.proxy.connected_clients > 0:
                    self.proxy.socketio.emit("poly", {})
                    logger.debug(" Emitted empty polygon data to clear")

            # Handle POLYLINE data
            if active_node_id and active_node_id in self.proxy.polyline_data_by_node:
                polyline_data = self.proxy.polyline_data_by_node[active_node_id]
                polyline_count = len(polyline_data.get("polys", {}))
                logger.debug(
                    f"Found {polyline_count} polylines for active node {active_node_id}"
                )
                if self.proxy.socketio and self.proxy.connected_clients > 0:
                    self.proxy.socketio.emit("polyline", polyline_data)
                    logger.info(
                        f"Emitted {polyline_count} polylines to {self.proxy.connected_clients} clients"
                    )
                else:
                    logger.warning(
                        f"Cannot emit polylines: socketio={self.proxy.socketio is not None}, connected_clients={self.proxy.connected_clients}"
                    )
            else:
                # No POLYLINE data for active node - emit empty to clear any existing polylines
                logger.debug(f" No polyline data for active node {active_node_id}")
                if self.proxy.socketio and self.proxy.connected_clients > 0:
                    self.proxy.socketio.emit("polyline", {})
                    logger.debug(" Emitted empty polyline data to clear")

        except Exception as e:
            logger.error(f" Error emitting active node POLY/POLYLINE data: {e}")
            import traceback

            traceback.print_exc()

    def _on_node_added(self, node_id):
        """Callback when a new node is discovered."""
        try:
            # Import connection manager to emit status
            from .connection_manager import ConnectionManager

            # Convert binary node_id to hex string for consistency with SIMINFO
            node_id_str = node_id.hex() if isinstance(node_id, bytes) else str(node_id)

            if node_id_str not in self.proxy.tracked_nodes:
                server_id = node_id[:-1] + seqidx2id(0)
                if (
                    server_id not in self.proxy.bluesky_client.servers
                ):  # Check standalone proxy's known servers
                    server_id = b"0"  # Ungrouped
                if server_id not in self.proxy.tracked_servers:
                    self._on_server_added(server_id)

                node_num = seqid2idx(node_id[-1])

                # Store using hex string key for consistency with SIMINFO
                self.proxy.tracked_nodes[node_id_str] = {
                    "node_id": node_id,  # Keep original binary for internal use
                    "node_id_str": node_id_str,  # Hex string for display
                    "node_num": node_num,
                    "server_id": server_id,
                    "status": "init",
                    "time": "00:00:00",
                }

                logger.info(
                    f"Node {safe_decode(node_id)} added (total: {len(self.proxy.tracked_nodes)})"
                )

                # Update connection status immediately when nodes are detected
                if not self.proxy.was_connected and len(self.proxy.tracked_nodes) > 0:
                    self.proxy.was_connected = True
                    logger.info(" Connection established")
                    # Use connection manager to emit status
                    conn_mgr = ConnectionManager(self.proxy)
                    conn_mgr._emit_connection_status(True)

                # The standalone proxy auto-selects the first node, so we don't need to do it manually here
                # Just ensure the active node info is properly updated
                if self.proxy.bluesky_client.act_id:
                    current_active = safe_decode(self.proxy.bluesky_client.act_id)

                # Emit updated node list to connected clients
                if self.proxy.running:
                    self._emit_node_info()
        except Exception as e:
            logger.error(f" Error in _on_node_added: {e}")
            import traceback

            traceback.print_exc()

    def _on_server_added(self, server_id):
        """Callback when a server is discovered."""
        if server_id not in self.proxy.tracked_servers:
            # Simple server tracking - just store the ID
            self.proxy.tracked_servers[server_id] = {"server_id": server_id}

            # Emit updated server list to connected clients
            if self.proxy.running:
                self._emit_node_info()

    def _on_node_removed(self, node_id):
        """Callback when a node is removed."""
        # Convert binary node_id to hex string for consistency
        node_id_str = node_id.hex() if isinstance(node_id, bytes) else str(node_id)
        if node_id_str in self.proxy.tracked_nodes:
            del self.proxy.tracked_nodes[node_id_str]
            self._emit_node_info()

        # Check if all nodes have been removed - this indicates server shutdown
        # Add a small delay to avoid false positives during normal node transitions
        if (
            len(self.proxy.tracked_nodes) == 0
            and self.proxy.was_connected
            and self.proxy.running
        ):
            logger.warning(" All nodes removed - checking for server shutdown...")
            # Use a timer to check again in a moment to confirm it's really a shutdown
            threading.Timer(1.0, self._check_node_shutdown).start()

    def _check_node_shutdown(self):
        """Check if server is really shut down after all nodes removed."""
        if (
            len(self.proxy.tracked_nodes) == 0
            and self.proxy.was_connected
            and self.proxy.running
        ):
            logger.info("Server shutdown detected")
            # Import connection manager to handle disconnection
            from .connection_manager import ConnectionManager

            conn_mgr = ConnectionManager(self.proxy)
            conn_mgr._handle_disconnection("All nodes removed (server shutdown)")

    def _on_server_removed(self, server_id):
        """Callback when a server is removed."""
        if server_id in self.proxy.tracked_servers:
            del self.proxy.tracked_servers[server_id]
            self._emit_node_info()

    def _emit_node_info(self):
        """Emit current node and server information to connected clients."""
        if self.proxy.socketio and self.proxy.connected_clients > 0:
            try:
                # Convert node data for JSON serialization
                nodes_data = {}
                for k, v in self.proxy.tracked_nodes.items():
                    # k is already a hex string, v contains node data
                    # Make a copy and ensure all values are JSON serializable
                    node_data = v.copy()
                    if "node_id" in node_data:
                        node_data["node_id"] = safe_decode(node_data["node_id"])
                    if "server_id" in node_data:
                        # Include decoded, hex, and raw server ID
                        raw_server_id = node_data["server_id"]
                        node_data["server_id"] = safe_decode(raw_server_id)
                        node_data["server_id_hex"] = (
                            raw_server_id.hex()
                            if isinstance(raw_server_id, bytes)
                            else str(raw_server_id)
                        )
                        node_data["server_id_raw"] = str(
                            raw_server_id
                        )  # Raw byte string representation
                    nodes_data[k] = node_data  # k is already the hex string

                servers_data = {}
                for k, v in self.proxy.tracked_servers.items():
                    key = safe_decode(k)
                    server_data = v.copy()
                    if "server_id" in server_data:
                        server_data["server_id"] = safe_decode(server_data["server_id"])
                    servers_data[key] = server_data

                # Get active node safely
                active_node = self._get_safe_active_node()

                node_info = {
                    "nodes": nodes_data,
                    "servers": servers_data,
                    "active_node": active_node,
                    "total_nodes": len(self.proxy.tracked_nodes),
                }
                self.proxy.socketio.emit("node_info", node_info)
            except Exception as e:
                logger.error(f" Error emitting node info: {e}")
                import traceback

                traceback.print_exc()

    def actnode(self, node_id):
        """Delegate actnode call to network proxy."""
        if self.proxy.bluesky_client is None:
            raise RuntimeError("Network client not initialized")
        return self.proxy.bluesky_client.actnode(node_id)

    def addnodes(self, count, server_id=None):
        """Delegate addnodes call to network proxy."""
        if self.proxy.bluesky_client is None:
            raise RuntimeError("Network client not initialized")
        return self.proxy.bluesky_client.addnodes(count, server_id=server_id)
