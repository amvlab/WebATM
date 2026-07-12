"""Tests for WebATM.proxy.managers.data_manager.DataManager."""


class TestEmitConnectionStatus:
    def test_emits_when_clients_connected(self, proxy, fake_socketio):
        proxy.data_mgr._emit_connection_status(True)
        payload = fake_socketio.last("connection_status")
        assert payload["connected"] is True
        assert payload["server_ip"] == "localhost"

    def test_no_emit_without_clients(self, proxy, fake_socketio):
        proxy.connected_clients = 0
        proxy.data_mgr._emit_connection_status(True)
        assert fake_socketio.count("connection_status") == 0

    def test_socket_error_is_swallowed(self, proxy):
        from tests.conftest import FakeSocketIO

        proxy.socketio = FakeSocketIO(raise_on_emit=True)
        # Should not raise even though emit fails.
        proxy.data_mgr._emit_connection_status(False)


class TestEmitClearedData:
    def test_emits_empty_traffic_sim_and_shapes(self, proxy, fake_socketio):
        proxy.data_mgr._emit_cleared_data()
        ac = fake_socketio.last("acdata")
        assert ac["id"] == [] and ac["nconf_cur"] == 0
        # Same canonical shape as the reset clear path, including actype.
        assert ac["actype"] == []
        sim = fake_socketio.last("siminfo")
        assert sim["scenname"] == "disconnected"
        assert sim["ntraf"] == 0
        # Same shape as SIMINFO-handler emissions (sender_id always present).
        assert sim["sender_id"] is None
        assert fake_socketio.last("poly") == {"polys": {}}
        assert fake_socketio.last("polyline") == {"polys": {}}
        assert fake_socketio.count("server_disconnected") == 1

    def test_no_emit_without_clients(self, proxy, fake_socketio):
        proxy.connected_clients = 0
        proxy.data_mgr._emit_cleared_data()
        assert fake_socketio.emitted == []


class TestBackupDataEmit:
    def test_does_nothing_when_not_running(self, proxy, fake_socketio):
        proxy.running = False
        proxy.data_mgr.backup_data_emit()
        assert fake_socketio.emitted == []

    def test_emits_cached_data_when_running(self, proxy, fake_socketio):
        proxy.running = True
        proxy.sim_data = {"scenname": "test"}
        proxy.traffic_data = {"id": ["AC1"]}
        proxy.data_mgr.backup_data_emit()
        # Cancel the rescheduled timer to avoid leaking threads.
        if proxy.backup_timer:
            proxy.backup_timer.cancel()
        assert fake_socketio.last("siminfo") == {"scenname": "test"}
        assert fake_socketio.last("acdata") == {"id": ["AC1"]}


class TestClearState:
    def test_resets_caches_and_tracking(self, proxy):
        proxy.tracked_nodes["n1"] = {"x": 1}
        proxy.tracked_servers["s1"] = {"y": 2}
        proxy.traffic_data = {"id": ["AC1"]}
        proxy.sim_data = {"scenname": "x"}
        proxy.was_connected = True
        proxy.aircraft_counter = 5
        proxy.poly_data_by_node["n1"] = {"polys": {}}

        proxy.data_mgr._clear_state()

        assert proxy.tracked_nodes == {}
        assert proxy.tracked_servers == {}
        assert proxy.traffic_data == {}
        assert proxy.sim_data == {}
        assert proxy.was_connected is False
        assert proxy.aircraft_counter == 0
        assert proxy.poly_data_by_node == {}
        assert proxy.cmddict == {}

    def test_clear_state_context_variants_do_not_raise(self, proxy):
        for context in ("disconnect", "manual", "shutdown"):
            proxy.data_mgr._clear_state(context)


class TestGetCurrentData:
    def test_structure(self, proxy):
        proxy.sim_data = {"scenname": "demo"}
        proxy.traffic_data = {"id": ["AC1"]}
        data = proxy.data_mgr.get_current_data()
        assert data["sim_data"] == {"scenname": "demo"}
        assert data["traffic_data"] == {"id": ["AC1"]}
        assert "connection_status" in data
        assert "node_info" in data
        assert data["node_info"]["total_nodes"] == 0

    def test_connection_status_false_when_disconnected(self, proxy):
        data = proxy.data_mgr.get_current_data()
        assert data["connection_status"]["connected"] is False
        assert data["connection_status"]["server_ip"] == "localhost"

    def test_no_active_node_returns_empty_shapes(self, proxy):
        data = proxy.data_mgr.get_current_data()
        assert data["poly_data"] == {}
        assert data["polyline_data"] == {}


class TestUsesPersistentManagers:
    """The data manager must reuse the proxy's persistent manager instances
    rather than constructing throwaway ones, so monkeypatching them takes
    effect and no redundant objects are created."""

    def test_clear_state_uses_proxy_node_mgr(self, proxy, monkeypatch):
        called = []
        monkeypatch.setattr(proxy.node_mgr, "_emit_node_info", lambda: called.append(1))
        proxy.data_mgr._clear_state()
        assert called == [1]

    def test_get_current_data_uses_proxy_node_mgr(self, proxy, monkeypatch):
        monkeypatch.setattr(
            proxy.node_mgr, "_get_safe_active_node", lambda: "deadbeef81"
        )
        data = proxy.data_mgr.get_current_data()
        assert data["node_info"]["active_node"] == "deadbeef81"
