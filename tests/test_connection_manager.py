"""Tests for WebATM.proxy.managers.connection_manager.ConnectionManager.

Covers the teardown paths (``close``, ``stop_client``,
``_handle_disconnection``), which all funnel their cached-state clearing
through ``DataManager._reset_cached_state`` so the paths cannot drift apart.
"""


def _seed_cached_state(proxy):
    """Populate every cache a teardown is expected to clear."""
    proxy.tracked_nodes["n1"] = {"node_id": b"NODE\x81"}
    proxy.tracked_servers[b"SRV\x80\x80"] = {"server_id": b"SRV\x80\x80"}
    proxy.traffic_data = {"id": ["AC1"]}
    proxy.sim_data = {"scenname": "demo"}
    proxy.echo_data = {"text": "hello"}
    proxy.poly_data_by_node["n1"] = {"polys": {}}
    proxy.polyline_data_by_node["n1"] = {"polys": {}}
    proxy.last_siminfo_emit = 123.0
    proxy.last_acdata_emit = 123.0
    proxy.last_node_info_emit = 123.0
    proxy.current_bbox = (0.0, 0.0, 1.0, 1.0)
    proxy.was_connected = True


def _assert_cached_state_cleared(proxy):
    assert proxy.tracked_nodes == {}
    assert proxy.tracked_servers == {}
    assert proxy.traffic_data == {}
    assert proxy.sim_data == {}
    assert proxy.echo_data == {}
    assert proxy.poly_data_by_node == {}
    assert proxy.polyline_data_by_node == {}
    assert proxy.last_siminfo_emit == 0
    assert proxy.last_acdata_emit == 0
    assert proxy.last_node_info_emit == 0
    assert proxy.current_bbox is None
    assert proxy.cmddict == {}
    assert proxy.was_connected is False


class TestClose:
    def test_closes_client_and_clears_cached_state(self, proxy, fake_client):
        proxy.bluesky_client = fake_client
        fake_client.act_id = b"NODE\x81"
        _seed_cached_state(proxy)

        proxy.connection_mgr.close()

        assert fake_client.closed is True
        assert fake_client.act_id is None
        assert proxy.allow_reconnection is False
        _assert_cached_state_cleared(proxy)
        # close() keeps the client instance; only stop_client destroys it.
        assert proxy.bluesky_client is fake_client

    def test_without_client_does_not_raise(self, proxy):
        _seed_cached_state(proxy)
        proxy.connection_mgr.close()
        _assert_cached_state_cleared(proxy)

    def test_client_close_error_still_clears_state(self, proxy, fake_client):
        def boom():
            raise RuntimeError("simulated socket failure")

        fake_client.close = boom
        proxy.bluesky_client = fake_client
        _seed_cached_state(proxy)

        proxy.connection_mgr.close()  # must not raise

        _assert_cached_state_cleared(proxy)


class TestStopClient:
    def test_destroys_client_and_clears_state(self, proxy, fake_client):
        proxy.bluesky_client = fake_client
        proxy.running = True
        _seed_cached_state(proxy)

        proxy.connection_mgr.stop_client("manual")

        assert proxy.running is False
        assert proxy.allow_reconnection is False
        assert fake_client.closed is True
        # Unlike close(), stop_client destroys the client instance.
        assert proxy.bluesky_client is None
        _assert_cached_state_cleared(proxy)


class TestHandleDisconnection:
    def test_stops_clears_and_notifies_browsers(
        self, proxy, fake_socketio, fake_client
    ):
        proxy.bluesky_client = fake_client
        proxy.running = True
        _seed_cached_state(proxy)

        proxy.connection_mgr._handle_disconnection("test reason")

        assert proxy.running is False
        assert proxy.allow_reconnection is False
        assert proxy.connection_failures == 0
        assert fake_client.closed is True
        _assert_cached_state_cleared(proxy)

        # Browsers get connection_status(False), the map-clearing payloads,
        # and a node_info reflecting the already-cleared (empty) state.
        assert fake_socketio.last("connection_status")["connected"] is False
        assert fake_socketio.last("acdata")["id"] == []
        assert fake_socketio.count("server_disconnected") == 1
        node_info = fake_socketio.last("node_info")
        assert node_info["nodes"] == {}
        assert node_info["total_nodes"] == 0
        assert node_info["active_node"] is None

    def test_no_emits_without_web_clients(self, proxy, fake_socketio, fake_client):
        proxy.bluesky_client = fake_client
        proxy.running = True
        proxy.connected_clients = 0
        _seed_cached_state(proxy)

        proxy.connection_mgr._handle_disconnection()

        assert fake_socketio.emitted == []
        assert proxy.running is False
        _assert_cached_state_cleared(proxy)

    def test_already_disconnected_does_not_emit_status(self, proxy, fake_socketio):
        proxy.was_connected = False
        proxy.connection_mgr._handle_disconnection()
        # No connection_status flip when we were never connected; the cleared
        # payloads still go out so browsers converge on the empty state.
        assert fake_socketio.count("connection_status") == 0
