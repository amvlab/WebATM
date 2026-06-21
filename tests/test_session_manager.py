"""Tests for WebATM.server.session_manager.SessionManager."""

import pytest

from WebATM.server.session_manager import SessionManager


@pytest.fixture
def manager():
    return SessionManager()


class TestAddSession:
    def test_add_new_session(self, manager):
        assert manager.add_session("s1") is True
        assert manager.get_session_count() == 1

    def test_add_duplicate_session_returns_false(self, manager):
        manager.add_session("s1")
        assert manager.add_session("s1") is False
        assert manager.get_session_count() == 1

    def test_session_has_timestamps(self, manager):
        manager.add_session("s1")
        info = manager.active_sessions["s1"]
        assert "start_time" in info and "last_heartbeat" in info


class TestRemoveSession:
    def test_remove_existing(self, manager):
        manager.add_session("s1")
        assert manager.remove_session("s1") is True
        assert manager.get_session_count() == 0

    def test_remove_missing_returns_false(self, manager):
        assert manager.remove_session("nope") is False


class TestHeartbeat:
    def test_update_existing_session(self, manager):
        manager.add_session("s1")
        original = manager.active_sessions["s1"]["last_heartbeat"]
        manager.active_sessions["s1"]["last_heartbeat"] = original - 100
        assert manager.update_heartbeat("s1") is True
        assert manager.active_sessions["s1"]["last_heartbeat"] > original - 100

    def test_update_missing_session_returns_false(self, manager):
        assert manager.update_heartbeat("ghost") is False


class TestReporting:
    def test_session_count(self, manager):
        manager.add_session("a")
        manager.add_session("b")
        assert manager.get_session_count() == 2

    def test_session_info(self, manager):
        manager.add_session("a")
        assert manager.get_session_info() == {"active_sessions": 1}

    def test_config_info_default_heartbeat(self, manager):
        assert manager.get_config_info() == {"heartbeat_interval": 30}

    def test_heartbeat_interval_from_env(self, monkeypatch):
        monkeypatch.setenv("HEARTBEAT_INTERVAL", "5")
        mgr = SessionManager()
        assert mgr.heartbeat_interval == 5
        assert mgr.get_config_info() == {"heartbeat_interval": 5}
