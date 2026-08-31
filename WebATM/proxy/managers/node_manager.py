"""Node and server management for the BlueSky proxy."""

import threading
import traceback

from ...bluesky_client import safe_decode, seqid2idx, seqidx2id
from ...logger import get_logger
from ...utils import empty_traffic_data, id2str

logger = get_logger()


class NodeManager:
    """Track BlueSky simulation nodes and servers.

    Reacts to node/server discovery and removal callbacks from the network
    client, keeps the proxy's ``tracked_nodes``/``tracked_servers`` maps in
    sync, detects server shutdown when all nodes disappear, and emits
    ``node_info`` updates to connected web clients.
    """

    def __init__(self, proxy):
        """Initialize the node manager.

        Args:
            proxy (BlueSkyProxy): Parent proxy instance.
        """
        self.proxy = proxy

    def _get_safe_active_node(self):
        """Get the active node ID safely, returning None if disconnected or invalid."""
        if (
            not self.proxy.is_connected
            or not hasattr(self.proxy.bluesky_client, "act_id")
            or not self.proxy.bluesky_client.act_id
        ):
            return None

        try:
            # act_id is raw bytes; tracked_nodes is keyed by hex strings.
            active_id_str = id2str(self.proxy.bluesky_client.act_id)
            if active_id_str in self.proxy.tracked_nodes:
                return active_id_str
        except Exception:
            pass
        return None

    def _on_actnode_changed(self, node_id):
        """Callback when active node changes."""
        if self.proxy.running:
            # The cached traffic and sim info belong to the previous node;
            # drop both (and clear browsers) so the backup timer and the
            # initial_data snapshot can't re-serve them while the new node's
            # streams spin up. Same idea as the shape clear below.
            cleared = empty_traffic_data()
            self.proxy.traffic_data = cleared
            self.proxy.sim_data = {}
            if self.proxy.socketio and self.proxy.connected_clients > 0:
                self.proxy.socketio.emit("acdata", cleared)

            self._emit_node_info()
            self._emit_active_node_poly_data()

    def _emit_active_node_poly_data(self):
        """Emit POLY and POLYLINE data for the currently active node."""
        try:
            active_node_id = self._get_safe_active_node()
            self._emit_shapes(active_node_id, self.proxy.poly_data_by_node, "poly")
            self._emit_shapes(
                active_node_id, self.proxy.polyline_data_by_node, "polyline"
            )
        except Exception as e:
            logger.error(f" Error emitting active node POLY/POLYLINE data: {e}")
            traceback.print_exc()

    def _emit_shapes(self, active_node_id, data_by_node, event):
        """Emit the active node's shapes for one event, or empty data to clear stale ones."""
        if not (self.proxy.socketio and self.proxy.connected_clients > 0):
            return

        if active_node_id and active_node_id in data_by_node:
            data = data_by_node[active_node_id]
            count = len(data.get("polys", {}))
            self.proxy.socketio.emit(event, data)
            logger.info(
                f"Emitted {count} {event} shapes to {self.proxy.connected_clients} clients"
            )
        else:
            # Nothing for the active node: emit the authoritative empty set so
            # the previous node's shapes leave the map. A bare {} would be
            # parsed as a legacy single-shape payload and ignored by browsers.
            self.proxy.socketio.emit(event, {"polys": {}})
            logger.debug(f"Emitted empty {event} data to clear")

    def _on_node_added(self, node_id):
        """Callback when a new node is discovered.

        Tracks the node (keyed by hex string, matching SIMINFO sender IDs),
        flips the proxy to connected on the first node, and re-activates the
        client when its recorded active node no longer exists.
        """
        try:
            node_id_str = id2str(node_id)

            if node_id_str not in self.proxy.tracked_nodes:
                server_id = node_id[:-1] + seqidx2id(0)
                if server_id not in self.proxy.bluesky_client.servers:
                    server_id = b"0"  # Ungrouped
                if server_id not in self.proxy.tracked_servers:
                    self._on_server_added(server_id)

                self.proxy.tracked_nodes[node_id_str] = {
                    "node_id": node_id,  # original binary, for internal use
                    "node_id_str": node_id_str,
                    "node_num": seqid2idx(node_id[-1]),
                    "server_id": server_id,
                    "status": "init",
                    "time": "00:00:00",
                }

                logger.info(
                    f"Node {safe_decode(node_id)} added (total: {len(self.proxy.tracked_nodes)})"
                )

                self._reactivate_if_active_node_gone(node_id)

                self.proxy.connection_mgr.mark_connected()

                if self.proxy.running:
                    self._emit_node_info()
        except Exception as e:
            logger.error(f" Error in _on_node_added: {e}")
            traceback.print_exc()

    def _reactivate_if_active_node_gone(self, node_id):
        """Activate a newly discovered node if the client's active node is dead.

        When the last node vanishes there is no survivor for
        ``_failover_active_node`` to pick: ``act_id`` keeps pointing at the
        dead node, so a node added later would never be activated and the
        actonly topics (ACDATA/ROUTEDATA) would stay subscribed to the dead
        node until the data-flow timeout tore down a live connection.
        """
        client = self.proxy.bluesky_client
        if client.act_id is None or client.act_id not in client.nodes:
            logger.info(
                f"No live active node; activating new node {safe_decode(node_id)}"
            )
            client.actnode(node_id)

    def _on_server_added(self, server_id):
        """Callback when a server is discovered."""
        if server_id not in self.proxy.tracked_servers:
            self.proxy.tracked_servers[server_id] = {"server_id": server_id}
            if self.proxy.running:
                self._emit_node_info()

    def _on_node_removed(self, node_id):
        """Callback when a node is removed."""
        node_id_str = id2str(node_id)
        if node_id_str in self.proxy.tracked_nodes:
            del self.proxy.tracked_nodes[node_id_str]
            # The node is gone for good (IDs are never reused), so its cached
            # shapes can never be served again.
            self.proxy.poly_data_by_node.pop(node_id_str, None)
            self.proxy.polyline_data_by_node.pop(node_id_str, None)
            self._failover_active_node(node_id)
            self._emit_node_info()

        # All nodes gone usually means server shutdown; re-check after a short
        # delay to avoid false positives during normal node transitions.
        if (
            len(self.proxy.tracked_nodes) == 0
            and self.proxy.was_connected
            and self.proxy.running
        ):
            logger.warning(" All nodes removed - checking for server shutdown...")
            shutdown_check = threading.Timer(1.0, self._check_node_shutdown)
            shutdown_check.daemon = True
            shutdown_check.start()

    def _failover_active_node(self, removed_node_id):
        """Re-activate a surviving node when the active node disappears.

        Without this, deleting the active node (e.g. via DELNODE) leaves the
        client subscribed to a dead node: data stops flowing, the header
        eventually flips to disconnected, and the map freezes even though the
        server and its other nodes are alive.
        """
        try:
            client = self.proxy.bluesky_client
            if client is None or client.act_id != removed_node_id:
                return
            for node_data in self.proxy.tracked_nodes.values():
                replacement = node_data.get("node_id")
                if replacement:
                    logger.info(
                        f"Active node {safe_decode(removed_node_id)} removed; "
                        f"switching to {safe_decode(replacement)}"
                    )
                    client.actnode(replacement)
                    return
        except Exception as e:
            logger.error(f" Error failing over active node: {e}")

    def _check_node_shutdown(self):
        """Check if server is really shut down after all nodes removed."""
        if (
            len(self.proxy.tracked_nodes) == 0
            and self.proxy.was_connected
            and self.proxy.running
        ):
            logger.info("Server shutdown detected")
            self.proxy.connection_mgr._handle_disconnection(
                "All nodes removed (server shutdown)"
            )

    def _on_server_removed(self, server_id):
        """Callback when a server is removed."""
        if server_id in self.proxy.tracked_servers:
            del self.proxy.tracked_servers[server_id]
            self._emit_node_info()

    def serialize_node_info(self):
        """Build the JSON-serializable ``node_info`` payload.

        Decodes the binary node/server IDs kept in ``tracked_nodes`` and
        ``tracked_servers`` into the string forms the frontend expects
        (``NodeData`` in ``frontend/src/data/types.ts``). Used for both the
        ``node_info`` Socket.IO event and the ``initial_data`` snapshot.

        Returns:
            dict: ``nodes``, ``servers``, ``active_node`` and ``total_nodes``.
        """
        # Iterate over snapshots: the network-timer thread mutates these maps
        # while Socket.IO threads (get_nodes, initial_data) serialize them.
        nodes_data = {}
        for node_id_str, tracked in list(self.proxy.tracked_nodes.items()):
            node_data = tracked.copy()
            if "node_id" in node_data:
                node_data["node_id"] = safe_decode(node_data["node_id"])
            if "server_id" in node_data:
                raw_server_id = node_data["server_id"]
                node_data["server_id"] = safe_decode(raw_server_id)
                node_data["server_id_hex"] = id2str(raw_server_id)
            nodes_data[node_id_str] = node_data

        servers_data = {}
        for server_id, tracked in list(self.proxy.tracked_servers.items()):
            server_data = tracked.copy()
            if "server_id" in server_data:
                server_data["server_id"] = safe_decode(server_data["server_id"])
            servers_data[safe_decode(server_id)] = server_data

        return {
            "nodes": nodes_data,
            "servers": servers_data,
            "active_node": self._get_safe_active_node(),
            "total_nodes": len(nodes_data),
        }

    def _emit_node_info(self):
        """Emit current node and server information to connected clients."""
        if not (self.proxy.socketio and self.proxy.connected_clients > 0):
            return
        try:
            self.proxy.socketio.emit("node_info", self.serialize_node_info())
        except Exception as e:
            logger.error(f" Error emitting node info: {e}")
            traceback.print_exc()

    def actnode(self, node_id):
        """Select the active simulation node via the network client.

        Args:
            node_id (bytes): ID of the node to make active.

        Returns:
            Any: The result of ``BlueSkyClient.actnode``.

        Raises:
            RuntimeError: If the network client is not initialized.
        """
        if self.proxy.bluesky_client is None:
            raise RuntimeError("Network client not initialized")
        return self.proxy.bluesky_client.actnode(node_id)

    def addnodes(self, count, server_id=None):
        """Request new simulation nodes from a BlueSky server.

        Args:
            count (int): Number of nodes to add.
            server_id (bytes | None): Server to add the nodes on. When None,
                the network client picks its default server.

        Returns:
            Any: The result of ``BlueSkyClient.addnodes``.

        Raises:
            RuntimeError: If the network client is not initialized.
        """
        if self.proxy.bluesky_client is None:
            raise RuntimeError("Network client not initialized")
        return self.proxy.bluesky_client.addnodes(count, server_id=server_id)

    def delnode(self, node_id):
        """Request termination of a single simulation node via DELNODE.

        Args:
            node_id (bytes): ID of the node to terminate.

        Returns:
            Any: The result of ``BlueSkyClient.delnode``.

        Raises:
            RuntimeError: If the network client is not initialized.
        """
        if self.proxy.bluesky_client is None:
            raise RuntimeError("Network client not initialized")
        return self.proxy.bluesky_client.delnode(node_id)
