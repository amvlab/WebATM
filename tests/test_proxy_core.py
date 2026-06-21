"""Tests for the BlueSkyProxy delegation layer (WebATM.proxy.core)."""

from WebATM.proxy import (
    BlueSkyProxy,
    get_bluesky_proxy,
    set_bluesky_proxy,
)
from WebATM.proxy.managers import (
    CommandProcessor,
    ConnectionManager,
    DataManager,
    NodeManager,
)


class TestProxyInitialization:
    def test_defaults(self):
        proxy = BlueSkyProxy()
        assert proxy.bluesky_client is None
        assert proxy.running is False
        assert proxy.allow_reconnection is False
        assert proxy.connected_clients == 0
        assert proxy.server_ip == "localhost"
        assert proxy.tracked_nodes == {}
        assert proxy.tracked_servers == {}

    def test_seed_command_dictionary(self):
        proxy = BlueSkyProxy()
        assert "HELP" in proxy.cmddict
        assert "?" in proxy.cmddict

    def test_managers_wired_up(self):
        proxy = BlueSkyProxy()
        assert isinstance(proxy.connection_mgr, ConnectionManager)
        assert isinstance(proxy.node_mgr, NodeManager)
        assert isinstance(proxy.command_proc, CommandProcessor)
        assert isinstance(proxy.data_mgr, DataManager)

    def test_managers_reference_back_to_proxy(self):
        proxy = BlueSkyProxy()
        assert proxy.connection_mgr.proxy is proxy
        assert proxy.node_mgr.proxy is proxy
        assert proxy.command_proc.proxy is proxy
        assert proxy.data_mgr.proxy is proxy

    def test_throttle_intervals_set(self):
        proxy = BlueSkyProxy()
        assert proxy.siminfo_interval > 0
        assert proxy.acdata_interval > 0
        assert proxy.echo_interval > 0


class TestSafeDecodeHelper:
    def test_delegates_to_module_helper(self):
        proxy = BlueSkyProxy()
        assert proxy._safe_decode(b"ABC") == "ABC"


class TestGlobalProxyAccessors:
    def test_set_and_get(self):
        proxy = BlueSkyProxy()
        set_bluesky_proxy(proxy)
        try:
            assert get_bluesky_proxy() is proxy
        finally:
            set_bluesky_proxy(None)

    def test_get_returns_none_when_unset(self):
        set_bluesky_proxy(None)
        assert get_bluesky_proxy() is None


class TestDelegation:
    """The core class exposes flat methods that delegate to the managers."""

    def test_send_command_delegates(self, monkeypatch):
        proxy = BlueSkyProxy()
        calls = []
        monkeypatch.setattr(
            proxy.command_proc, "send_command", lambda cmd: calls.append(cmd) or True
        )
        assert proxy.send_command("CRE KL204") is True
        assert calls == ["CRE KL204"]

    def test_emit_node_info_delegates(self, monkeypatch):
        proxy = BlueSkyProxy()
        called = []
        monkeypatch.setattr(proxy.node_mgr, "_emit_node_info", lambda: called.append(1))
        proxy._emit_node_info()
        assert called == [1]

    def test_get_current_data_delegates(self, monkeypatch):
        proxy = BlueSkyProxy()
        monkeypatch.setattr(proxy.data_mgr, "get_current_data", lambda: {"ok": True})
        assert proxy.get_current_data() == {"ok": True}

    def test_close_delegates(self, monkeypatch):
        proxy = BlueSkyProxy()
        called = []
        monkeypatch.setattr(proxy.connection_mgr, "close", lambda: called.append(1))
        proxy.close()
        assert called == [1]
