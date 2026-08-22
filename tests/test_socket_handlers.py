"""Tests for WebATM.server.socket_handlers via the Socket.IO test client."""

import pytest

from WebATM.app import create_app
from WebATM.proxy import set_bluesky_proxy


@pytest.fixture
def sio():
    app, socketio = create_app()
    app.config.update(TESTING=True)
    client = socketio.test_client(app)
    try:
        yield app, socketio, client
    finally:
        if client.is_connected():
            client.disconnect()
        set_bluesky_proxy(None)


class TestConnectDisconnect:
    def test_connect_sends_initial_data(self, sio):
        app, socketio, client = sio
        assert client.is_connected()
        events = {pkt["name"] for pkt in client.get_received()}
        assert "initial_data" in events

    def test_connect_increments_client_count(self, sio):
        app, socketio, client = sio
        assert app.bluesky_proxy.connected_clients == 1

    def test_disconnect_decrements_client_count(self, sio):
        app, socketio, client = sio
        client.disconnect()
        assert app.bluesky_proxy.connected_clients == 0

    def test_disconnect_untracked_session_does_not_decrement(self, sio):
        """A connection whose session was never tracked (rejected at connect)
        must not decrement the counter another client incremented."""
        app, socketio, client = sio
        assert app.bluesky_proxy.connected_clients == 1
        app.session_manager.active_sessions.clear()
        client.disconnect()
        assert app.bluesky_proxy.connected_clients == 1


class TestConnectShapeEnvelopes:
    def test_connect_sends_scoped_shape_envelopes(self, sio):
        """Every new connection gets complete poly/polyline envelopes (empty
        here — no active node) so a reconnecting browser can prune shapes
        deleted while it was away."""
        app, socketio, client = sio
        received = {pkt["name"]: pkt["args"] for pkt in client.get_received()}
        assert received["poly"][0] == {"polys": {}}
        assert received["polyline"][0] == {"polys": {}}

    def test_connect_sends_active_node_shapes_to_new_client(self, sio):
        """The connecting client receives the active node's stored shapes."""
        app, socketio, client = sio
        proxy = app.bluesky_proxy

        class FakeClient:
            act_id = b"\x01\x02"

        proxy.bluesky_client = FakeClient()
        proxy.running = True
        proxy.was_connected = True
        node_id = FakeClient.act_id.hex()
        proxy.tracked_nodes[node_id] = {"node_id": FakeClient.act_id}
        shapes = {"polys": {"zone1": {"lat": [52.0], "lon": [4.0]}}}
        proxy.poly_data_by_node[node_id] = shapes

        second = socketio.test_client(app)
        try:
            received = {pkt["name"]: pkt["args"] for pkt in second.get_received()}
            assert received["poly"][0] == shapes
            assert received["polyline"][0] == {"polys": {}}
        finally:
            second.disconnect()

    def test_connect_does_not_broadcast_shapes_to_other_clients(self, sio):
        """A client connecting must not re-send (or clear) shape data on
        every other connected client."""
        app, socketio, client = sio
        client.get_received()  # drain this client's own connect envelopes

        second = socketio.test_client(app)
        try:
            assert second.is_connected()
            events = [pkt["name"] for pkt in client.get_received()]
            assert "poly" not in events
            assert "polyline" not in events
        finally:
            second.disconnect()


class TestCommandEvent:
    def test_command_returns_result(self, sio):
        app, socketio, client = sio
        client.get_received()  # drain initial data
        client.emit("command", {"command": "CRE KL204"})
        received = client.get_received()
        results = [p for p in received if p["name"] == "command_result"]
        assert results
        assert results[0]["args"][0]["command"] == "CRE KL204"


class TestNodeEvents:
    def test_get_nodes_does_not_error(self, sio):
        app, socketio, client = sio
        client.get_received()
        # No clients tracked, but the handler should run without raising.
        client.emit("get_nodes")
        assert client.is_connected()

    def test_add_nodes_without_connection(self, sio):
        app, socketio, client = sio
        client.get_received()
        # addnodes raises internally (no client) but the handler swallows it.
        client.emit("add_nodes", {"count": 2})
        assert client.is_connected()

    def test_set_active_node_unknown_id(self, sio):
        app, socketio, client = sio
        client.get_received()
        client.emit("set_active_node", {"node_id": "deadbeef"})
        # Unknown node id is logged and ignored; connection stays up.
        assert client.is_connected()

    def test_set_active_node_without_network_client(self, sio):
        """A tracked node but no network client (disconnected) raises
        RuntimeError inside actnode; the handler must swallow it."""
        app, socketio, client = sio
        client.get_received()
        app.bluesky_proxy.tracked_nodes["abcd1234"] = {"node_id": b"\x01\x02"}
        client.emit("set_active_node", {"node_id": "abcd1234"})
        assert client.is_connected()

    def test_del_node_unknown_id(self, sio):
        app, socketio, client = sio
        client.get_received()
        client.emit("del_node", {"node_id": "deadbeef"})
        # Unknown node id is logged and ignored; connection stays up.
        assert client.is_connected()

    def test_del_node_without_network_client(self, sio):
        """A tracked node but no network client (disconnected) raises
        RuntimeError inside delnode; the handler must swallow it."""
        app, socketio, client = sio
        client.get_received()
        app.bluesky_proxy.tracked_nodes["abcd1234"] = {"node_id": b"\x01\x02"}
        client.emit("del_node", {"node_id": "abcd1234"})
        assert client.is_connected()

    def test_command_with_malformed_payload(self, sio):
        app, socketio, client = sio
        client.get_received()
        client.emit("command", None)
        received = client.get_received()
        results = [p for p in received if p["name"] == "command_result"]
        assert results and results[0]["args"][0]["success"] is False
