"""Tests for the BlueSky file-management HTTP routes (WebATM.server.routes).

These configure a real temporary base directory and exercise the upload, list,
browse, delete, and output-reading endpoints end-to-end through Flask's test
client.
"""

import io

import pytest

from WebATM.app import create_app
from WebATM.proxy import set_bluesky_proxy


@pytest.fixture
def client(tmp_path):
    app, socketio = create_app()
    app.config.update(TESTING=True)
    with app.test_client() as c:
        # Configure the base path so file routes are active.
        resp = c.post(
            "/api/bluesky/configure-base-path", json={"base_path": str(tmp_path)}
        )
        assert resp.status_code == 200
        c.base_path = tmp_path  # type: ignore[attr-defined]
        yield c
    set_bluesky_proxy(None)


def _upload(client, file_type, filename, content=b"data"):
    return client.post(
        f"/api/bluesky/upload/{file_type}",
        data={"file": (io.BytesIO(content), filename)},
        content_type="multipart/form-data",
    )


class TestUpload:
    def test_upload_scenario_file(self, client):
        resp = _upload(client, "scenario", "demo.scn", b"00:00:00>CRE KL204")
        assert resp.status_code == 200
        body = resp.get_json()
        assert body["success"] is True
        assert (client.base_path / "scenario" / "demo.scn").exists()

    def test_upload_wrong_extension_rejected(self, client):
        resp = _upload(client, "scenario", "demo.txt")
        assert resp.status_code == 400
        assert "extension" in resp.get_json()["error"].lower()

    def test_upload_no_file_rejected(self, client):
        resp = client.post(
            "/api/bluesky/upload/scenario",
            data={},
            content_type="multipart/form-data",
        )
        assert resp.status_code == 400

    def test_upload_invalid_file_type(self, client):
        resp = _upload(client, "bogus", "demo.scn")
        assert resp.status_code == 400

    def test_duplicate_filenames_get_suffixed(self, client):
        _upload(client, "scenario", "dup.scn")
        resp = _upload(client, "scenario", "dup.scn")
        assert resp.status_code == 200
        # The second upload should have been renamed rather than overwriting.
        assert resp.get_json()["filename"] != "dup.scn"

    def test_upload_plugin_file(self, client):
        resp = _upload(client, "plugins", "myplugin.py", b"# plugin")
        assert resp.status_code == 200
        assert (client.base_path / "plugins" / "myplugin.py").exists()


class TestListAndBrowse:
    def test_list_scenario_files(self, client):
        _upload(client, "scenario", "one.scn")
        _upload(client, "scenario", "two.scn")
        resp = client.get("/api/bluesky/list/scenario")
        assert resp.status_code == 200
        names = {f["filename"] for f in resp.get_json()["files"]}
        assert {"one.scn", "two.scn"} <= names

    def test_browse_scenario_root(self, client):
        _upload(client, "scenario", "a.scn")
        resp = client.get("/api/bluesky/browse/scenario")
        assert resp.status_code == 200
        body = resp.get_json()
        assert body["success"] is True
        assert any(b["name"] == "scenario" for b in body["breadcrumbs"])

    def test_browse_directory_traversal_is_blocked(self, client):
        # Attempting to escape the scenario directory should not error out
        # with file contents from outside; the handler strips .. segments.
        resp = client.get("/api/bluesky/browse/scenario/../../etc")
        # Either sanitized to the scenario root or rejected - never a 500.
        assert resp.status_code in (200, 400, 403)

    def test_browse_nested_subdirectory(self, client):
        # A legitimate subdirectory under the base must still be browsable
        # (guards against the containment check over-rejecting).
        nested = client.base_path / "scenario" / "sub"
        nested.mkdir(parents=True)
        (nested / "inner.scn").write_text("x")
        resp = client.get("/api/bluesky/browse/scenario/sub")
        assert resp.status_code == 200
        names = {f["filename"] for f in resp.get_json()["files"]}
        assert "inner.scn" in names

    def test_browse_symlink_to_sibling_is_blocked(self, client):
        # A symlink whose resolved target is a *sibling* sharing the base name
        # as a string prefix (".../scenario_evil") must be rejected. A naive
        # str.startswith containment check would wrongly allow it.
        evil = client.base_path / "scenario_evil"
        evil.mkdir()
        (evil / "secret.scn").write_text("secret")
        scenario_dir = client.base_path / "scenario"
        scenario_dir.mkdir(exist_ok=True)
        (scenario_dir / "link").symlink_to(evil, target_is_directory=True)

        resp = client.get("/api/bluesky/browse/scenario/link")
        assert resp.status_code == 403
        # The outside file must never leak into the listing.
        body = resp.get_json()
        assert "secret.scn" not in {f["filename"] for f in body.get("files", [])}

    def test_output_symlink_escape_is_blocked(self, client):
        # An output symlink resolving to a sibling directory sharing the base
        # name prefix (".../output_evil") must not be readable.
        evil = client.base_path / "output_evil"
        evil.mkdir()
        (evil / "secret.txt").write_text("top secret")
        output_dir = client.base_path / "output"
        output_dir.mkdir(exist_ok=True)
        (output_dir / "leak.txt").symlink_to(evil / "secret.txt")

        resp = client.get("/api/bluesky/output/content/leak.txt")
        assert resp.status_code == 403
        assert "top secret" not in (resp.get_json().get("content") or "")


class TestCaseInsensitiveExtension:
    """Listing/browsing match extensions case-insensitively so uppercase
    variants (e.g. .SCN from BlueSky's bundled demo scenarios) show up too."""

    def test_list_includes_uppercase_extension(self, client):
        scenario_dir = client.base_path / "scenario"
        scenario_dir.mkdir(exist_ok=True)
        (scenario_dir / "DEMO.SCN").write_text("00:00:00>CRE KL204")
        (scenario_dir / "lower.scn").write_text("x")
        resp = client.get("/api/bluesky/list/scenario")
        assert resp.status_code == 200
        names = {f["filename"] for f in resp.get_json()["files"]}
        assert {"DEMO.SCN", "lower.scn"} <= names

    def test_browse_includes_uppercase_extension(self, client):
        scenario_dir = client.base_path / "scenario"
        scenario_dir.mkdir(exist_ok=True)
        (scenario_dir / "UPPER.SCN").write_text("y")
        resp = client.get("/api/bluesky/browse/scenario")
        assert resp.status_code == 200
        names = {f["filename"] for f in resp.get_json()["files"]}
        assert "UPPER.SCN" in names


class TestDelete:
    def test_delete_scenario_file(self, client):
        _upload(client, "scenario", "gone.scn")
        resp = client.delete("/api/bluesky/scenario/gone.scn")
        assert resp.status_code == 200
        assert not (client.base_path / "scenario" / "gone.scn").exists()

    def test_delete_missing_file(self, client):
        resp = client.delete("/api/bluesky/scenario/missing.scn")
        assert resp.status_code == 404

    def test_delete_invalid_file_type(self, client):
        resp = client.delete("/api/bluesky/bogus/x.scn")
        assert resp.status_code == 400


class TestOutputContent:
    def test_read_output_file_content(self, client):
        output_dir = client.base_path / "output"
        output_dir.mkdir(exist_ok=True)
        log = output_dir / "run.log"
        log.write_text("line1\nline2\nline3\n")

        resp = client.get("/api/bluesky/output/content/run.log")
        assert resp.status_code == 200
        body = resp.get_json()
        assert body["success"] is True
        assert "line3" in body["content"]

    def test_read_missing_output_file(self, client):
        resp = client.get("/api/bluesky/output/content/nope.log")
        assert resp.status_code == 404


class TestFileStatusConfigured:
    def test_filestatus_after_configuration(self, client):
        resp = client.get("/api/bluesky/filestatus")
        body = resp.get_json()
        assert body["configured"] is True
        assert body["path_exists"] is True
