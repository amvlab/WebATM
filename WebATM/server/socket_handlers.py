"""Socket.IO event handlers for WebATM.

Handles all WebSocket communication between the web client and the Flask
server, including connection management, commands, node management,
heartbeat, and BlueSky events.
"""

import time
import uuid

from flask import current_app, session
from flask_socketio import disconnect, emit

from ..logger import get_logger

logger = get_logger()

# Global variable to track streaming threads per client
_log_streaming_threads = {}


def register_socket_handlers(socketio, session_manager):
    """Register all Socket.IO event handlers.

    Args:
        socketio (SocketIO): The Flask-SocketIO instance.
        session_manager (SessionManager): Session manager for tracking and
            capacity enforcement.
    """

    @socketio.on("connect")
    def on_connect(auth):
        """Handle a new web client connection (``connect`` event).

        Creates a session, enforces the capacity limit (disconnecting the
        client when full), increments the connected-client counter, and
        sends the ``initial_data`` snapshot, ``heartbeat_config``, and the
        active node's shapes.

        Args:
            auth: Socket.IO auth payload (unused).

        Returns:
            False to reject the connection when capacity is reached,
            otherwise None.
        """

        # Accept connection and track session
        session_id = str(uuid.uuid4())
        session["session_id"] = session_id

        if not session_manager.add_session(session_id):
            logger.info(f"Failed to add session {session_id} - capacity reached")
            disconnect()
            return False

        current_app.bluesky_proxy.connected_clients += 1
        logger.info(
            f"Web client connected: {session_id} (total: {current_app.bluesky_proxy.connected_clients})"
        )

        # Send initial data
        try:
            emit("initial_data", current_app.bluesky_proxy.get_current_data())
            # Note: We don't emit node_info immediately here to avoid showing
            # "Connected (No Data)" before the user actually connects.
            # node_info will be emitted naturally when data flows through the system.
            # Send heartbeat configuration to client
            emit("heartbeat_config", {"interval": session_manager.heartbeat_interval})

            # Emit shapes for the active node (if any exist)
            # This ensures shapes created before the client connected are visible
            current_app.bluesky_proxy._emit_active_node_poly_data()
        except Exception as e:
            # Handle emission errors gracefully
            logger.info(f"Error sending initial data to {session_id}: {e}")
            pass

    @socketio.on("disconnect")
    def on_disconnect(auth):
        """Handle a web client disconnect (``disconnect`` event).

        Removes the session from the session manager, decrements the
        connected-client counter, and stops any log-streaming threads.

        Args:
            auth: Socket.IO auth payload (unused).
        """
        try:
            session_id = session.get("session_id")

            if session_id:
                # Clean up session tracking
                if session_manager.remove_session(session_id):
                    logger.debug(
                        f"Web client disconnected and session cleaned up: {session_id}"
                    )
                else:
                    logger.debug(
                        f"Web client disconnected (session not found): {session_id}"
                    )
            else:
                logger.debug("Web client disconnected (no session ID found)")
        except Exception as e:
            logger.error(f"Error getting session ID during disconnect: {e}")

        current_app.bluesky_proxy.connected_clients = max(
            0, current_app.bluesky_proxy.connected_clients - 1
        )
        logger.info(
            f"Total connected clients: {current_app.bluesky_proxy.connected_clients}"
        )

        # Clean up all log streaming threads as a safeguard
        for client_id in list(_log_streaming_threads.keys()):
            _log_streaming_threads[client_id]["stop"] = True
            del _log_streaming_threads[client_id]

    @socketio.on("command")
    def on_command(data):
        """Forward a stack command from the web client (``command`` event).

        Args:
            data (dict): Payload with a ``command`` string.

        Emits a ``command_result`` event with the success flag back to the
        sender.
        """
        command = data.get("command", "")
        success = current_app.bluesky_proxy.send_command(command)
        try:
            emit("command_result", {"success": success, "command": command})
        except Exception:
            # Handle emission errors gracefully
            pass

    @socketio.on("set_active_node")
    def on_set_active_node(data):
        """Switch the active simulation node (``set_active_node`` event).

        The frontend sends hex-string node IDs; the handler looks up the
        original binary ID in the proxy's tracked nodes before delegating to
        ``actnode``.

        Args:
            data (dict): Payload with the hex-string ``node_id``.
        """
        node_id = data.get("node_id")
        if node_id:
            # The frontend now sends hex string node IDs
            # We need to convert back to binary for the standalone client
            if node_id in current_app.bluesky_proxy.tracked_nodes:
                # Get the original binary node_id from tracked_nodes
                node_data = current_app.bluesky_proxy.tracked_nodes[node_id]
                binary_node_id = node_data.get("node_id")  # This is the original binary

                logger.info(
                    f"Setting active node to: {node_id} (binary: {binary_node_id})"
                )
                current_app.bluesky_proxy.actnode(binary_node_id)
                return

            logger.debug(f"Could not find node ID for: {node_id}")
            logger.debug(
                f"Available nodes: {list(current_app.bluesky_proxy.tracked_nodes.keys())}"
            )

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
            count = data.get("count", 1)
            server_id = data.get("server_id")
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
            current_time = time.time()

            if session_id and session_manager.update_heartbeat(session_id):
                emit("heartbeat_ack", {"timestamp": current_time})
            else:
                # Session not found - this shouldn't happen but handle gracefully
                logger.info(f"Heartbeat received from unknown session: {session_id}")
                emit("session_error", {"message": "Session not found"})
        except Exception as e:
            logger.info(f"Error handling heartbeat: {e}")
