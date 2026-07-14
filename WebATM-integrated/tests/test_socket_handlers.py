"""Tests for the integrated Socket.IO handlers (log-history replay).

Uses flask_socketio's test client against a minimal Flask app, so no real
BlueSky process or browser is needed.
"""

from flask import Flask
from flask_socketio import SocketIO
from webatm_integrated.log_streamer import EVENT
from webatm_integrated.socket_handlers import register_integrated_socket_handlers


class FakeStreamer:
    """Stands in for LogStreamer: returns a fixed history snapshot."""

    def __init__(self, items):
        self._items = items

    def history(self):
        return list(self._items)


def _make_client(items):
    app = Flask(__name__)
    socketio = SocketIO(app, async_mode="threading")
    register_integrated_socket_handlers(socketio, FakeStreamer(items))
    return socketio.test_client(app)


def _replay_payloads(client):
    return [r["args"][0] for r in client.get_received() if r["name"] == EVENT]


def test_request_log_history_replays_buffered_lines_to_requester():
    items = [
        {"seq": 1, "t": 0.0, "line": "one"},
        {"seq": 2, "t": 1.0, "line": "two"},
    ]
    client = _make_client(items)

    client.emit("request_log_history")

    payloads = _replay_payloads(client)
    assert len(payloads) == 1
    assert payloads[0]["replay"] is True
    assert payloads[0]["lines"] == items


def test_request_log_history_with_empty_history():
    client = _make_client([])

    client.emit("request_log_history")

    payloads = _replay_payloads(client)
    assert len(payloads) == 1
    assert payloads[0]["lines"] == []
