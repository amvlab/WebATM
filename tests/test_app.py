"""Integration tests for the Flask application and its HTTP routes.

These build the real app via :func:`WebATM.app.create_app` (which constructs a
``BlueSkyProxy`` but never opens a network connection) and exercise the routes
through Flask's test client.
"""

import pytest

from WebATM.app import create_app
from WebATM.proxy import set_bluesky_proxy


@pytest.fixture
def app_and_client():
    app, socketio = create_app()
    app.config.update(TESTING=True)
    with app.test_client() as client:
        yield app, client
    # create_app registers its proxy globally; reset to avoid cross-test bleed.
    set_bluesky_proxy(None)


@pytest.fixture
def client(app_and_client):
    return app_and_client[1]


class TestAppFactory:
    def test_create_app_returns_app_and_socketio(self):
        app, socketio = create_app()
        assert app is not None
        assert socketio is not None
        assert hasattr(app, "bluesky_proxy")
        set_bluesky_proxy(None)

    def test_app_exposes_session_manager(self):
        from WebATM.server import SessionManager

        app, socketio = create_app()
        try:
            assert isinstance(app.session_manager, SessionManager)
        finally:
            set_bluesky_proxy(None)

    def test_integrated_hook_disabled_by_default(self, monkeypatch):
        # Without WEBATM_INTEGRATED=1 the optional extension package is never
        # imported, so it must not appear in sys.modules just from create_app().
        import sys

        monkeypatch.delenv("WEBATM_INTEGRATED", raising=False)
        sys.modules.pop("webatm_integrated", None)
        app, socketio = create_app()
        try:
            assert "webatm_integrated" not in sys.modules
        finally:
            set_bluesky_proxy(None)

    def test_integrated_hook_enabled_without_package_is_safe(self, monkeypatch):
        # With the flag on but the (separate) package not installed, the hook is
        # best-effort: it logs a warning and never breaks app construction.
        monkeypatch.setenv("WEBATM_INTEGRATED", "1")
        app, socketio = create_app()
        try:
            assert app is not None
            assert hasattr(app, "session_manager")
        finally:
            set_bluesky_proxy(None)


class TestHealthAndStatus:
    def test_health_returns_200(self, client):
        resp = client.get("/health")
        assert resp.status_code == 200
        assert resp.get_json()["status"] == "healthy"

    def test_status_returns_200(self, client):
        resp = client.get("/status")
        assert resp.status_code == 200
        body = resp.get_json()
        assert body["status"] == "healthy"
        assert "bluesky_server" in body
        assert "session_info" in body

    def test_status_reports_session_config(self, client):
        body = client.get("/status").get_json()
        assert body["config"]["heartbeat_interval"] == 30


class TestServerConfigRoutes:
    def test_get_server_config(self, client):
        resp = client.get("/api/server/config")
        assert resp.status_code == 200
        body = resp.get_json()
        assert body["server_ip"] == "localhost"
        assert body["is_connected"] is False

    def test_server_status_route(self, client):
        resp = client.get("/api/server/status")
        assert resp.status_code == 200
        body = resp.get_json()
        assert body["status"] == "success"
        assert "running" in body
        assert body["hostname"] == "localhost"

    def test_server_status_with_explicit_hostname(self, client):
        resp = client.get("/api/server/status?hostname=example.test")
        assert resp.status_code == 200
        assert resp.get_json()["hostname"] == "example.test"


class TestCommandRoute:
    def test_send_command_returns_result(self, client):
        # No BlueSky client connected, so send_command returns success=False.
        resp = client.post("/api/simulation/command", json={"command": "CRE KL204"})
        assert resp.status_code == 200
        body = resp.get_json()
        assert body["command"] == "CRE KL204"
        assert body["success"] is False

    def test_send_command_with_empty_json(self, client):
        resp = client.post("/api/simulation/command", json={})
        assert resp.status_code == 200
        assert resp.get_json()["command"] == ""


class TestNavdataSearch:
    def test_empty_query_returns_empty_results(self, client):
        resp = client.get("/api/navdata/search?q=")
        assert resp.status_code == 200
        body = resp.get_json()
        assert body["success"] is True
        assert body["results"] == []

    def test_missing_db_returns_503(self, client):
        # The navdata sqlite index is not built in the test environment.
        resp = client.get("/api/navdata/search?q=KSEA")
        assert resp.status_code == 503
        assert resp.get_json()["success"] is False


class TestAircraftModels:
    def test_models_route(self, client):
        resp = client.get("/api/aircraft/models")
        # Either the directory is missing (404) or it lists models (200).
        assert resp.status_code in (200, 404)
        assert "models" in resp.get_json()


class TestBlueSkyFileStatus:
    def test_filestatus_unconfigured(self, client):
        resp = client.get("/api/bluesky/filestatus")
        assert resp.status_code == 200
        assert resp.get_json()["configured"] is False

    def test_upload_without_base_path_configured(self, client):
        resp = client.post("/api/bluesky/upload/scenario")
        assert resp.status_code == 400
        assert resp.get_json()["success"] is False

    def test_list_without_base_path_configured(self, client):
        resp = client.get("/api/bluesky/list/scenario")
        assert resp.status_code == 400

    def test_invalid_file_type_after_configuring(self, client, tmp_path):
        # Configure a real base path, then probe an invalid file type.
        resp = client.post(
            "/api/bluesky/configure-base-path", json={"base_path": str(tmp_path)}
        )
        assert resp.status_code == 200
        bad = client.get("/api/bluesky/list/bogustype")
        assert bad.status_code == 400


class TestConfigureBasePath:
    def test_missing_base_path(self, client):
        resp = client.post("/api/bluesky/configure-base-path", json={})
        assert resp.status_code == 400

    def test_nonexistent_path(self, client):
        resp = client.post(
            "/api/bluesky/configure-base-path",
            json={"base_path": "/no/such/path/exists/xyz"},
        )
        assert resp.status_code == 400

    def test_valid_path_creates_subdirs(self, client, tmp_path):
        resp = client.post(
            "/api/bluesky/configure-base-path", json={"base_path": str(tmp_path)}
        )
        assert resp.status_code == 200
        body = resp.get_json()
        assert body["success"] is True
        assert (tmp_path / "scenario").is_dir()
        assert (tmp_path / "plugins").is_dir()


class TestErrorHandling:
    def test_unknown_route_returns_404(self, client):
        # The catch-all exception handler must not mask routine HTTP errors:
        # an unmatched route stays a 404, not a 500.
        resp = client.get("/no/such/route/xyz")
        assert resp.status_code == 404

    def test_wrong_method_returns_405(self, client):
        # /health is GET-only; POSTing it is a 405, not a 500.
        resp = client.post("/health")
        assert resp.status_code == 405


class TestDisconnect:
    def test_disconnect_when_not_running(self, client):
        resp = client.post("/api/server/disconnect")
        assert resp.status_code == 200
        assert resp.get_json()["success"] is True
