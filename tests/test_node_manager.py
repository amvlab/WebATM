"""Tests for WebATM.proxy.managers.node_manager.NodeManager."""

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
