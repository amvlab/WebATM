"""Tests for WebATM.proxy.managers.node_manager.NodeManager."""

import time

import pytest


class TestGetSafeActiveNode:
    def test_none_when_not_running(self, proxy, fake_client):
        proxy.bluesky_client = fake_client
        proxy.running = False
        assert proxy.node_mgr._get_safe_active_node() is None

    def test_none_when_no_tracked_nodes(self, proxy, fake_client):
        proxy.bluesky_client = fake_client
        proxy.running = True
        proxy.was_connected = True
        fake_client.act_id = b"\x01\x02\x03\x04\x81"
        assert proxy.node_mgr._get_safe_active_node() is None

    def test_returns_hex_when_active_node_tracked(self, proxy, fake_client):
        node_bytes = b"\x01\x02\x03\x04\x81"
        node_hex = node_bytes.hex()
        proxy.bluesky_client = fake_client
        proxy.running = True
        proxy.was_connected = True
        fake_client.act_id = node_bytes
        proxy.tracked_nodes[node_hex] = {"node_id": node_bytes}
        assert proxy.node_mgr._get_safe_active_node() == node_hex

    def test_none_when_act_id_not_tracked(self, proxy, fake_client):
        proxy.bluesky_client = fake_client
        proxy.running = True
        proxy.was_connected = True
        fake_client.act_id = b"\x09\x09\x09\x09\x81"
        proxy.tracked_nodes["deadbeef"] = {"node_id": b"x"}
        assert proxy.node_mgr._get_safe_active_node() is None


class TestServerTracking:
    def test_on_server_added(self, proxy):
        proxy.node_mgr._on_server_added(b"SRV01")
        assert b"SRV01" in proxy.tracked_servers

    def test_on_server_added_is_idempotent(self, proxy):
        proxy.node_mgr._on_server_added(b"SRV01")
        proxy.tracked_servers[b"SRV01"]["marker"] = True
        proxy.node_mgr._on_server_added(b"SRV01")
        # Existing entry not overwritten.
        assert proxy.tracked_servers[b"SRV01"].get("marker") is True

    def test_on_server_removed(self, proxy):
        proxy.tracked_servers[b"SRV01"] = {"server_id": b"SRV01"}
        proxy.node_mgr._on_server_removed(b"SRV01")
        assert b"SRV01" not in proxy.tracked_servers

    def test_on_server_removed_missing_is_noop(self, proxy):
        proxy.node_mgr._on_server_removed(b"GHOST")  # should not raise


class TestNodeAddedConnectionClock:
    """The first node appearing flips ``was_connected`` *and* restarts the
    data-flow timeout clock.

    Regression test for a demo-deploy disconnect: under a slow cold-start the
    node can take ~60s to spawn after ``start_client()``. ``_on_node_added``
    runs synchronously inside ``bluesky_client.update()`` and wins the race to
    set ``was_connected = True`` before the network timer can, so the timer's
    clock reset (guarded on ``not was_connected``) is skipped. If this handler
    doesn't reset the clock too, the stale ``start_client()`` timestamp is
    already older than ``connection_timeout`` and the connection is dropped the
    instant the node shows up.
    """

    def test_first_node_refreshes_last_successful_update(self, proxy, fake_client):
        proxy.bluesky_client = fake_client
        proxy.running = True
        proxy.was_connected = False
        # Clock as it would look after a slow cold start: further in the past
        # than connection_timeout allows.
        proxy.last_successful_update = time.time() - (proxy.connection_timeout + 60)

        before = time.time()
        proxy.node_mgr._on_node_added(b"\x01\x02\x03\x04\x81")

        assert proxy.was_connected is True
        # Clock restarted from "now" rather than left at the stale value.
        assert proxy.last_successful_update >= before
        # And the connection is no longer past the timeout window.
        assert time.time() - proxy.last_successful_update <= proxy.connection_timeout

    def test_clock_not_touched_when_already_connected(self, proxy, fake_client):
        # A second node arriving must not reset the clock — only the
        # False->True transition does, mirroring the network-timer guard.
        proxy.bluesky_client = fake_client
        proxy.running = True
        proxy.was_connected = True
        proxy.tracked_nodes["aabbccdd81"] = {"node_id": b"\xaa\xbb\xcc\xdd\x81"}
        sentinel = time.time() - 5
        proxy.last_successful_update = sentinel

        proxy.node_mgr._on_node_added(b"\x01\x02\x03\x04\x81")

        assert proxy.last_successful_update == sentinel


class TestUsesPersistentManagers:
    """The node manager must reuse the proxy's persistent ``connection_mgr``
    rather than constructing throwaway instances, so monkeypatching it takes
    effect and no redundant objects are created."""

    def test_first_node_emits_via_proxy_connection_mgr(
        self, proxy, fake_client, monkeypatch
    ):
        proxy.bluesky_client = fake_client
        proxy.running = True
        proxy.was_connected = False
        statuses = []
        monkeypatch.setattr(
            proxy.connection_mgr,
            "_emit_connection_status",
            lambda connected: statuses.append(connected),
        )
        proxy.node_mgr._on_node_added(b"\x01\x02\x03\x04\x81")
        assert statuses == [True]

    def test_check_node_shutdown_uses_proxy_connection_mgr(self, proxy, monkeypatch):
        proxy.running = True
        proxy.was_connected = True
        proxy.tracked_nodes.clear()
        reasons = []
        monkeypatch.setattr(
            proxy.connection_mgr,
            "_handle_disconnection",
            lambda reason: reasons.append(reason),
        )
        proxy.node_mgr._check_node_shutdown()
        assert reasons == ["All nodes removed (server shutdown)"]


class TestNodeRemoval:
    def test_on_node_removed_deletes_tracked_node(self, proxy):
        node_bytes = b"\x01\x02\x03\x04\x81"
        node_hex = node_bytes.hex()
        proxy.tracked_nodes[node_hex] = {"node_id": node_bytes}
        proxy.node_mgr._on_node_removed(node_bytes)
        assert node_hex not in proxy.tracked_nodes

    def test_on_node_removed_unknown_is_noop(self, proxy):
        proxy.node_mgr._on_node_removed(b"\xaa\xbb\xcc\xdd\x81")  # should not raise


class TestEmitNodeInfo:
    def test_emits_node_info_payload(self, proxy, fake_socketio):
        node_bytes = b"\x01\x02\x03\x04\x81"
        node_hex = node_bytes.hex()
        proxy.tracked_nodes[node_hex] = {
            "node_id": node_bytes,
            "node_id_str": node_hex,
            "node_num": 1,
            "server_id": b"SRV\x80\x80",
            "status": "init",
            "time": "00:00:00",
        }
        proxy.tracked_servers[b"SRV\x80\x80"] = {"server_id": b"SRV\x80\x80"}

        proxy.node_mgr._emit_node_info()

        payload = fake_socketio.last("node_info")
        assert payload is not None
        assert payload["total_nodes"] == 1
        assert node_hex in payload["nodes"]
        # server_id should be decoded and carry hex/raw variants.
        node_entry = payload["nodes"][node_hex]
        assert "server_id_hex" in node_entry

    def test_no_emit_without_clients(self, proxy, fake_socketio):
        proxy.connected_clients = 0
        proxy.node_mgr._emit_node_info()
        assert fake_socketio.count("node_info") == 0


class TestDelegationToNetworkClient:
    def test_actnode_raises_without_client(self, proxy):
        proxy.bluesky_client = None
        with pytest.raises(RuntimeError):
            proxy.node_mgr.actnode(b"node")

    def test_actnode_delegates(self, proxy, fake_client):
        proxy.bluesky_client = fake_client
        proxy.node_mgr.actnode(b"node")
        assert fake_client.act_id == b"node"

    def test_addnodes_raises_without_client(self, proxy):
        proxy.bluesky_client = None
        with pytest.raises(RuntimeError):
            proxy.node_mgr.addnodes(2)

    def test_addnodes_delegates(self, proxy, fake_client):
        proxy.bluesky_client = fake_client
        proxy.node_mgr.addnodes(3, server_id=b"SRV")
        assert ("ADDNODES", {"count": 3}, b"SRV") in fake_client.sent
