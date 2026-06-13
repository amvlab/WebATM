"""Socket.IO handlers for the integrated build.

Provides live-log history replay for late-joining clients and an optional
socket-based parity for the REST server-control actions.
"""

from __future__ import annotations

from flask_socketio import emit

from .log_streamer import EVENT


def register_integrated_socket_handlers(socketio, manager, streamer):
    """Register integrated Socket.IO event handlers."""

    @socketio.on("request_log_history")
    def on_request_log_history():
        # Reply to the requesting client only (flask_socketio.emit defaults to
        # the sender's room). Clients de-duplicate by `seq`.
        emit(EVENT, {"lines": streamer.history(), "replay": True})

    @socketio.on("server_control")
    def on_server_control(data):
        action = (data or {}).get("action")
        handler = {
            "start": manager.start,
            "stop": manager.stop,
            "restart": manager.restart,
            "kill": manager.kill,
        }.get(action)
        if handler is None:
            emit(
                "server_control_result",
                {"success": False, "message": f"Unknown action: {action}"},
            )
            return
        result = handler()
        # Broadcast status so every client's controls stay in sync.
        socketio.emit("server_control_result", result)
