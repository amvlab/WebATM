"""Socket.IO event handlers for WebATM.

Handles all WebSocket communication between the web client and the Flask
server, including connection management, commands, node management, and
BlueSky events.
"""

import uuid

from flask import current_app, session
from flask_socketio import emit

from ..bluesky_client import safe_decode
from ..logger import get_logger
from ..utils import id2str

logger = get_logger()


def _tracked_binary_server_id(proxy, server_id):
    """Map a frontend server-ID string to the tracked server's binary ID.

    ``node_info`` serializes server IDs as hex (``server_id_hex``) or decoded
    (``server_id``) strings, so re-encoding the string with ``str.encode``
    would not restore the original bytes.

    Args:
        proxy (BlueSkyProxy): The current BlueSky proxy.
        server_id (str): Server ID string as sent by the frontend.

    Returns:
        bytes | None: The original binary server ID, or None when the server
            is not tracked.
    """
    for raw_id in list(proxy.tracked_servers):
        if server_id in (id2str(raw_id), safe_decode(raw_id)):
            return raw_id
    logger.debug(f"Could not find server ID for: {server_id}")
    return None


def _tracked_binary_node_id(proxy, node_id):
    """Map a frontend hex node ID to the tracked node's binary ID.

    Args:
        proxy (BlueSkyProxy): The current BlueSky proxy.
        node_id (str): Hex-string node ID as sent by the frontend.

    Returns:
        bytes | None: The original binary node ID, or None when the node is
            not tracked.
    """
    node_data = proxy.tracked_nodes.get(node_id)
    if node_data is None:
        logger.debug(
            f"Could not find node ID for: {node_id} "
            f"(available: {list(proxy.tracked_nodes.keys())})"
        )
        return None
    return node_data.get("node_id")


def register_socket_handlers(socketio, session_manager):
    """Register all Socket.IO event handlers.

    Args:
        socketio (SocketIO): The Flask-SocketIO instance.
        session_manager (SessionManager): Session manager for tracking
            connected web clients.
    """

    @socketio.on("connect")
    def on_connect(auth):
        """Handle a new web client connection (``connect`` event).

        Creates and tracks a session, increments the connected-client
        counter, and sends this client the ``initial_data`` snapshot and the
        active node's shape envelopes.

        Args:
            auth: Socket.IO auth payload (unused).

        Returns:
            False to reject the connection if the session cannot be
            tracked, otherwise None.
        """
        session_id = str(uuid.uuid4())
        session["session_id"] = session_id

        if not session_manager.add_session(session_id):
            logger.info(f"Rejected connection with duplicate session id {session_id}")
            return False

        current_app.bluesky_proxy.connected_clients += 1
        logger.info(
            f"Web client connected: {session_id} (total: {current_app.bluesky_proxy.connected_clients})"
        )

        try:
            snapshot = current_app.bluesky_proxy.get_current_data()
            emit("initial_data", snapshot)
            # Complete shape envelopes for this client only. A reconnecting
            # browser needs them to prune shapes deleted while it was away
            # (initial_data only ever adds shapes); other clients are already
            # in sync, so this must not broadcast. node_info is NOT sent
            # here: it would show "Connected (No Data)" before the user
            # connects; it flows naturally once data arrives.
            emit("poly", snapshot["poly_data"] or {"polys": {}})
            emit("polyline", snapshot["polyline_data"] or {"polys": {}})
        except Exception as e:
            logger.info(f"Error sending initial data to {session_id}: {e}")

    @socketio.on("disconnect")
    def on_disconnect(reason):
        """Handle a web client disconnect (``disconnect`` event).

        Removes the session and decrements the connected-client counter —
        but only for connections whose session was actually tracked, keeping
        the counter symmetric with ``on_connect``.

        Args:
            reason: Disconnect reason supplied by Flask-SocketIO.
        """
        session_id = session.get("session_id")
        if not (session_id and session_manager.remove_session(session_id)):
            logger.debug(f"Web client disconnected (untracked session): {session_id}")
            return

        current_app.bluesky_proxy.connected_clients = max(
            0, current_app.bluesky_proxy.connected_clients - 1
        )
        logger.info(
            f"Web client disconnected: {session_id} "
            f"(total: {current_app.bluesky_proxy.connected_clients}, reason: {reason})"
        )

    @socketio.on("command")
    def on_command(data):
        """Forward a stack command from the web client (``command`` event).

        Args:
            data (dict): Payload with a ``command`` string.

        Emits a ``command_result`` event with the success flag back to the
        sender.
        """
        command = (data or {}).get("command", "")
        success = current_app.bluesky_proxy.send_command(command)
        try:
            emit("command_result", {"success": success, "command": command})
        except Exception as e:
            logger.info(f"Error emitting command result: {e}")

    @socketio.on("set_active_node")
    def on_set_active_node(data):
        """Switch the active simulation node (``set_active_node`` event).

        Args:
            data (dict): Payload with the hex-string ``node_id``.
        """
        node_id = (data or {}).get("node_id")
        if not node_id:
            return

        binary_node_id = _tracked_binary_node_id(current_app.bluesky_proxy, node_id)
        if binary_node_id is None:
            return

        logger.info(f"Setting active node to: {node_id} (binary: {binary_node_id})")
        try:
            current_app.bluesky_proxy.actnode(binary_node_id)
        except Exception as e:
            logger.info(f"Error setting active node {node_id}: {e}")

    @socketio.on("get_nodes")
    def on_get_nodes():
        """Emit current node information (``get_nodes`` event).

        Triggers a ``node_info`` broadcast with the tracked nodes/servers.
        """
        try:
            current_app.bluesky_proxy._emit_node_info()
        except Exception as e:
            logger.info(f"Error getting nodes: {e}")

    @socketio.on("add_nodes")
    def on_add_nodes(data):
        """Add simulation nodes to a server (``add_nodes`` event).

        Args:
            data (dict): Payload with ``count`` (default 1) and an optional
                ``server_id`` string, resolved to the tracked server's
                binary ID before delegation.
        """
        try:
            count = (data or {}).get("count", 1)
            server_id = (data or {}).get("server_id")
            if server_id and isinstance(server_id, str):
                server_id = _tracked_binary_server_id(
                    current_app.bluesky_proxy, server_id
                )
                if server_id is None:
                    return
            current_app.bluesky_proxy.addnodes(count, server_id=server_id)
            logger.info(f"Requested {count} new node(s) on server {server_id}")
        except Exception as e:
            logger.info(f"Error adding nodes: {e}")

    @socketio.on("del_node")
    def on_del_node(data):
        """Terminate a single simulation node (``del_node`` event).

        Sends a DELNODE message to the owning server; the node's removal
        flows back through the normal node-removed pipeline (tracked-nodes
        cleanup, active-node failover, ``node_info`` emission).

        Args:
            data (dict): Payload with the hex-string ``node_id``.
        """
        node_id = (data or {}).get("node_id")
        if not node_id:
            return

        binary_node_id = _tracked_binary_node_id(current_app.bluesky_proxy, node_id)
        if binary_node_id is None:
            return

        logger.info(
            f"Requesting node termination: {node_id} (binary: {binary_node_id})"
        )
        try:
            current_app.bluesky_proxy.delnode(binary_node_id)
        except Exception as e:
            logger.info(f"Error deleting node {node_id}: {e}")
