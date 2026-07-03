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


class _FakeSignal:
    """Minimal stand-in for a BlueSky client signal that records connections."""

    def __init__(self):
        self.connected = []

    def connect(self, handler):
        self.connected.append(handler)


class _FakeClient:
    """Fake BlueSky client exposing only the requested signal attributes."""

    def __init__(self, signal_names):
        for name in signal_names:
            setattr(self, name, _FakeSignal())


ALL_SIGNALS = (
    "node_added",
    "server_added",
    "node_removed",
    "server_removed",
    "actnode_changed",
)


class TestConnectBlueSkyClientSignals:
    """The signal wiring is data-driven; verify it still connects every signal
    to the matching node-manager handler and degrades gracefully."""

    def test_connects_every_available_signal_to_its_handler(self):
        proxy = BlueSkyProxy()
        proxy.bluesky_client = _FakeClient(ALL_SIGNALS)

        proxy._connect_bluesky_client_signals()

        node_mgr = proxy.node_mgr
        expected = {
            "node_added": node_mgr._on_node_added,
            "server_added": node_mgr._on_server_added,
            "node_removed": node_mgr._on_node_removed,
            "server_removed": node_mgr._on_server_removed,
            "actnode_changed": node_mgr._on_actnode_changed,
        }
        for name, handler in expected.items():
            assert getattr(proxy.bluesky_client, name).connected == [handler]

    def test_missing_signal_is_skipped_without_blocking_others(self):
        # A client missing one signal must still wire up the remaining four.
        present = [n for n in ALL_SIGNALS if n != "server_removed"]
        proxy = BlueSkyProxy()
        proxy.bluesky_client = _FakeClient(present)

        proxy._connect_bluesky_client_signals()

        assert not hasattr(proxy.bluesky_client, "server_removed")
        for name in present:
            assert getattr(proxy.bluesky_client, name).connected


class TestStartClientRecreatesClient:
    def test_recreates_client_after_stopping_a_running_connection(self, monkeypatch):
        # Regression: start_client() called while a connection is still running
        # used to tear the client down (stop_client sets it to None) and then
        # dereference it, crashing with AttributeError. The teardown must happen
        # before the client is (re)created so connect() always has a live client.
        import WebATM.proxy.managers.connection_manager as cm_mod

        proxy = BlueSkyProxy()
        cm = proxy.connection_mgr

        # Simulate a live connection with a stale client instance.
        proxy.running = True
        proxy.bluesky_client = object()

        def fake_stop(context="disconnect"):
            proxy.running = False
            proxy.bluesky_client = None  # mirrors _close_bluesky_client

        monkeypatch.setattr(cm, "stop_client", fake_stop)

        created = []

        class FakeClient:
            node_id = b"X"

            def __init__(self):
                created.append(self)

            def connect(self, hostname=None):
                return True

        monkeypatch.setattr(cm_mod, "BlueSkyClient", FakeClient)
        monkeypatch.setattr(cm, "_connect_bluesky_client_signals", lambda: None)
        monkeypatch.setattr(cm, "_start_network_timer", lambda: None)
        monkeypatch.setattr(proxy.data_mgr, "start_backup_timer", lambda: None)

        # Must not raise (previously: None.connect()).
        cm.start_client(hostname="127.0.0.1")

        assert len(created) == 1
        assert proxy.bluesky_client is created[0]
        assert proxy.running is True
