"""Socket.IO handlers for the integrated build.

Provides live-log history replay for late-joining clients. The lifecycle
actions themselves are REST-only (see :mod:`.routes`).
"""

from __future__ import annotations

from flask_socketio import emit

from .log_streamer import EVENT


def register_integrated_socket_handlers(socketio, streamer):
    """Register the integrated build's Socket.IO event handlers.

    Args:
        socketio (flask_socketio.SocketIO): The Flask-SocketIO instance.
        streamer (LogStreamer): Holds the server-log history.
    """

    @socketio.on("request_log_history")
    def on_request_log_history():
        """Replay buffered server-log lines (``request_log_history`` event).

        Emits the log history to the requesting client only (flask_socketio's
        ``emit`` defaults to the sender's room), marked with ``replay: True``;
        clients de-duplicate by ``seq``.
        """
        emit(EVENT, {"lines": streamer.history(), "replay": True})
