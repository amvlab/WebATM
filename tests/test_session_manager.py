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


class TestRemoveSession:
    def test_remove_existing(self, manager):
        manager.add_session("s1")
        assert manager.remove_session("s1") is True
        assert manager.get_session_count() == 0

    def test_remove_missing_returns_false(self, manager):
        assert manager.remove_session("nope") is False


class TestReporting:
    def test_session_count(self, manager):
        manager.add_session("a")
        manager.add_session("b")
        assert manager.get_session_count() == 2

    def test_session_info(self, manager):
        """/status contract: demo-deploy reads session_info.active_sessions."""
        manager.add_session("a")
        assert manager.get_session_info() == {"active_sessions": 1}
