"""Socket.IO event handlers for WebATM.

Handles all WebSocket communication between the web client and the Flask
server, including connection management, commands, node management,
heartbeat, and BlueSky events.
"""

import time
import uuid

from flask import current_app, session
from flask_socketio import emit

from ..logger import get_logger

logger = get_logger()


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
        counter, and sends the ``initial_data`` snapshot,
        ``heartbeat_config``, and the active node's shapes.

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
            emit("initial_data", current_app.bluesky_proxy.get_current_data())
            emit("heartbeat_config", {"interval": session_manager.heartbeat_interval})
            # Shapes created before this client connected. node_info is NOT
            # sent here: it would show "Connected (No Data)" before the user
            # connects; it flows naturally once data arrives.
            current_app.bluesky_proxy._emit_active_node_poly_data()
        except Exception as e:
            logger.info(f"Error sending initial data to {session_id}: {e}")

    @socketio.on("disconnect")
    def on_disconnect(reason):
        """Handle a web client disconnect (``disconnect`` event).

        Removes the session from the session manager and decrements the
        connected-client counter. The counter is only decremented for
        connections whose session was actually tracked, keeping it
        symmetric with ``on_connect`` (a connection rejected there never
        incremented it).

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

        The frontend sends hex-string node IDs; the handler looks up the
        original binary ID in the proxy's tracked nodes before delegating to
        ``actnode``.

        Args:
            data (dict): Payload with the hex-string ``node_id``.
        """
        node_id = (data or {}).get("node_id")
        if not node_id:
            return

        node_data = current_app.bluesky_proxy.tracked_nodes.get(node_id)
        if node_data is None:
            logger.debug(
                f"Could not find node ID for: {node_id} "
                f"(available: {list(current_app.bluesky_proxy.tracked_nodes.keys())})"
            )
            return

        binary_node_id = node_data.get("node_id")
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
                ``server_id`` string, encoded to bytes before delegation.
        """
        try:
            count = (data or {}).get("count", 1)
            server_id = (data or {}).get("server_id")
            if server_id and isinstance(server_id, str):
                server_id = server_id.encode()
            current_app.bluesky_proxy.addnodes(count, server_id=server_id)
            logger.info(f"Added {count} nodes to server {server_id}")
        except Exception as e:
            logger.info(f"Error adding nodes: {e}")

    @socketio.on("heartbeat")
    def on_heartbeat():
        """Keep the client's session alive (``heartbeat`` event).

        Updates the session's heartbeat timestamp and answers with
        ``heartbeat_ack``, or ``session_error`` if the session is unknown.
        """
        try:
            session_id = session.get("session_id")
            if session_id and session_manager.update_heartbeat(session_id):
                emit("heartbeat_ack", {"timestamp": time.time()})
            else:
                logger.info(f"Heartbeat received from unknown session: {session_id}")
                emit("session_error", {"message": "Session not found"})
        except Exception as e:
            logger.info(f"Error handling heartbeat: {e}")
