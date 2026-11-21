"""Tests for the integrated REST lifecycle routes (webatm_integrated.routes).

The routes are a thin delegation layer over BlueSkyProcessManager; these verify
each endpoint calls the matching manager method and returns its result as JSON,
and that an unexpected manager exception comes back as the same structured
error shape (not Flask's generic error payload, which the UI cannot read).
"""

import pytest
from flask import Flask
from webatm_integrated.routes import register_integrated_routes


class FakeManager:
    """Stands in for BlueSkyProcessManager: records calls, returns canned dicts."""

    def __init__(self):
        self.calls = []

    def _record(self, name):
        self.calls.append(name)
        return {"success": True, "status": "stopped", "message": name}

    def start(self):
        return self._record("start")

    def stop(self):
        return self._record("stop")

    def restart(self):
        return self._record("restart")

    def kill(self):
        return self._record("kill")

    def status(self):
        return self._record("status")


@pytest.fixture
def client_and_manager():
    app = Flask(__name__)
    manager = FakeManager()
    register_integrated_routes(app, manager)
    with app.test_client() as client:
        yield client, manager


@pytest.mark.parametrize("action", ["start", "stop", "restart", "kill"])
def test_lifecycle_action_delegates_to_manager(client_and_manager, action):
    client, manager = client_and_manager
    resp = client.post(f"/api/integrated/server/{action}")
    assert resp.status_code == 200
    assert resp.get_json() == {"success": True, "status": "stopped", "message": action}
    assert manager.calls == [action]


def test_status_is_get_only(client_and_manager):
    client, manager = client_and_manager
    resp = client.get("/api/integrated/server/status")
    assert resp.status_code == 200
    assert resp.get_json()["message"] == "status"
    assert manager.calls == ["status"]


@pytest.mark.parametrize("action", ["start", "stop", "restart", "kill"])
def test_lifecycle_actions_reject_get(client_and_manager, action):
    client, manager = client_and_manager
    resp = client.get(f"/api/integrated/server/{action}")
    assert resp.status_code == 405
    assert manager.calls == []


class RaisingManager:
    """Manager whose every method blows up, like an unexpected runtime fault."""

    def _boom(self):
        raise RuntimeError("wait() lost the process")

    start = stop = restart = kill = status = _boom


@pytest.fixture
def raising_client():
    app = Flask(__name__)
    register_integrated_routes(app, RaisingManager())
    with app.test_client() as client:
        yield client


@pytest.mark.parametrize("action", ["start", "stop", "restart", "kill"])
def test_lifecycle_action_exception_returns_structured_error(raising_client, action):
    resp = raising_client.post(f"/api/integrated/server/{action}")
    assert resp.status_code == 500
    data = resp.get_json()
    assert data["success"] is False
    assert data["status"] == "error"
    assert action in data["message"]
    assert "wait() lost the process" in data["message"]


def test_status_exception_returns_structured_error(raising_client):
    resp = raising_client.get("/api/integrated/server/status")
    assert resp.status_code == 500
    data = resp.get_json()
    assert data["success"] is False
    assert data["status"] == "error"
