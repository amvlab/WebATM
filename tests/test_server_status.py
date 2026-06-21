"""Tests for WebATM.server.bluesky_server_status."""

import socket

import pytest

from WebATM.server.bluesky_server_status import check_bluesky_running, is_port_listening


@pytest.fixture
def listening_port():
    """Open a real localhost TCP listener and yield its port number."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("localhost", 0))
    sock.listen(1)
    port = sock.getsockname()[1]
    try:
        yield port
    finally:
        sock.close()


@pytest.fixture
def closed_port():
    """Reserve then immediately release a port so nothing is listening on it."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("localhost", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


class TestIsPortListening:
    def test_open_port_returns_true(self, listening_port):
        assert is_port_listening(listening_port, timeout=1.0) is True

    def test_closed_port_returns_false(self, closed_port):
        assert is_port_listening(closed_port, timeout=0.5) is False

    def test_default_hostname_is_localhost(self, listening_port):
        # Passing hostname=None should default to localhost.
        assert is_port_listening(listening_port, timeout=1.0, hostname=None) is True

    def test_invalid_hostname_returns_false(self):
        assert (
            is_port_listening(80, timeout=0.5, hostname="invalid.host.invalid") is False
        )


class TestCheckBlueSkyRunning:
    def test_returns_tuple(self):
        running, message = check_bluesky_running()
        assert isinstance(running, bool)
        assert isinstance(message, str)

    def test_not_running_message(self, monkeypatch):
        monkeypatch.setattr(
            "WebATM.server.bluesky_server_status.is_port_listening",
            lambda *a, **k: False,
        )
        running, message = check_bluesky_running()
        assert running is False
        assert "not accessible" in message

    def test_running_message_lists_ports(self, monkeypatch):
        monkeypatch.setattr(
            "WebATM.server.bluesky_server_status.is_port_listening",
            lambda port, *a, **k: port == 11000,
        )
        running, message = check_bluesky_running()
        assert running is True
        assert "11000" in message
        assert "11001" not in message
