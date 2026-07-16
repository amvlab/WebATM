"""Tests for WebATM.server.bluesky_server_status."""

import socket

import pytest

from WebATM.server.bluesky_server_status import is_port_listening, probe_bluesky_ports


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

    def test_socket_closed_when_connect_raises(self, monkeypatch):
        """The probe socket must be closed even when connect_ex raises.

        Regression test: the old implementation only reached ``close()`` on
        the success path, so a probe against an unresolvable hostname left the
        socket to be reclaimed by garbage collection (a ResourceWarning, and
        an fd leak on runtimes without refcounting).
        """
        closed = []

        class FakeSocket:
            def settimeout(self, timeout):
                pass

            def connect_ex(self, address):
                raise socket.gaierror("name resolution failed")

            def close(self):
                closed.append(True)

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                self.close()
                return False

        monkeypatch.setattr(socket, "socket", lambda *a, **k: FakeSocket())
        assert is_port_listening(80, timeout=0.5, hostname="nope.invalid") is False
        assert closed, "probe socket leaked after connect_ex raised"


class TestProbeBlueSkyPorts:
    def test_no_ports_listening(self, monkeypatch):
        monkeypatch.setattr(
            "WebATM.server.bluesky_server_status.is_port_listening",
            lambda *a, **k: False,
        )
        listening, message = probe_bluesky_ports()
        assert listening == []
        assert "not accessible" in message

    def test_running_message_lists_ports(self, monkeypatch):
        monkeypatch.setattr(
            "WebATM.server.bluesky_server_status.is_port_listening",
            lambda port, *a, **k: port == 11000,
        )
        listening, message = probe_bluesky_ports()
        assert listening == [11000]
        assert "11000" in message
        assert "11001" not in message

    def test_forwards_hostname_and_timeout(self, monkeypatch):
        probes = []

        def fake_lister(port, timeout, hostname):
            probes.append((port, timeout, hostname))
            return True

        monkeypatch.setattr(
            "WebATM.server.bluesky_server_status.is_port_listening", fake_lister
        )
        listening, message = probe_bluesky_ports("example.org", timeout=0.25)
        assert listening == [11000, 11001]
        assert probes == [(11000, 0.25, "example.org"), (11001, 0.25, "example.org")]


class TestServerStatusRoute:
    @pytest.fixture
    def client(self, monkeypatch):
        from WebATM.app import create_app
        from WebATM.proxy import set_bluesky_proxy

        app, _socketio = create_app()
        app.config.update(TESTING=True)
        with app.test_client() as test_client:
            yield test_client
        set_bluesky_proxy(None)

    @pytest.fixture(autouse=True)
    def no_real_probes(self, monkeypatch):
        """Keep the route tests off the network."""
        monkeypatch.setattr(
            "WebATM.server.bluesky_server_status.is_port_listening",
            lambda *a, **k: False,
        )

    def test_get_defaults_to_localhost(self, client):
        response = client.get("/api/server/status")
        data = response.get_json()
        assert response.status_code == 200
        assert data["status"] == "success"
        assert data["running"] is False
        assert data["hostname"] == "localhost"

    def test_post_with_json_hostname(self, client):
        response = client.post("/api/server/status", json={"hostname": "example.org"})
        data = response.get_json()
        assert response.status_code == 200
        assert data["hostname"] == "example.org"

    def test_post_without_json_body_is_not_an_error(self, client):
        """Regression test: a JSON-less POST must not surface as HTTP 500.

        The old handler touched ``request.json``, which raises
        ``UnsupportedMediaType`` for non-JSON content types; the broad except
        then masked it as a 500 with a confusing message.
        """
        response = client.post("/api/server/status", data="hostname=example.org")
        data = response.get_json()
        assert response.status_code == 200
        assert data["status"] == "success"
        assert data["hostname"] == "localhost"
