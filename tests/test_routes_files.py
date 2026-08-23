"""Tests for the BlueSky file-management HTTP routes (WebATM.server.routes).

These configure a real temporary base directory and exercise the upload,
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


class TestBrowse:
    def test_browse_lists_uploaded_files(self, client):
        _upload(client, "scenario", "one.scn")
        _upload(client, "scenario", "two.scn")
        resp = client.get("/api/bluesky/browse/scenario")
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

    def test_browse_listing_sorted_folders_first(self, client):
        # iterdir() yields raw filesystem order (creation/hash order); the
        # endpoint must return folders first, each group sorted by name
        # case-insensitively, so the file manager doesn't show a jumbled list.
        scenario_dir = client.base_path / "scenario"
        scenario_dir.mkdir(exist_ok=True)
        for name in ("zulu.scn", "alpha.scn", "Mike.scn", "bravo.scn"):
            (scenario_dir / name).write_text("x")
        for folder in ("nested", "Demos"):
            (scenario_dir / folder).mkdir()

        resp = client.get("/api/bluesky/browse/scenario")
        assert resp.status_code == 200
        names = [f["filename"] for f in resp.get_json()["files"]]
        assert names == [
            "Demos",
            "nested",
            "alpha.scn",
            "bravo.scn",
            "Mike.scn",
            "zulu.scn",
        ]

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
    """Browsing matches extensions case-insensitively so uppercase variants
    (e.g. .SCN from BlueSky's bundled demo scenarios) show up too."""

    def test_browse_includes_uppercase_extension(self, client):
        scenario_dir = client.base_path / "scenario"
        scenario_dir.mkdir(exist_ok=True)
        (scenario_dir / "UPPER.SCN").write_text("y")
        (scenario_dir / "lower.scn").write_text("x")
        resp = client.get("/api/bluesky/browse/scenario")
        assert resp.status_code == 200
        names = {f["filename"] for f in resp.get_json()["files"]}
        assert {"UPPER.SCN", "lower.scn"} <= names


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

    def test_delete_file_in_subdirectory(self, client):
        # The browse UI navigates into subdirectories and offers Delete there,
        # so the route must accept a path below the type's base directory.
        sub = client.base_path / "scenario" / "sub"
        sub.mkdir(parents=True)
        (sub / "inner.scn").write_text("x")
        resp = client.delete("/api/bluesky/scenario/sub/inner.scn")
        assert resp.status_code == 200
        assert not (sub / "inner.scn").exists()

    def test_delete_in_subdirectory_never_touches_root_namesake(self, client):
        # Deleting sub/a.scn must not fall back to the root a.scn.
        scenario_dir = client.base_path / "scenario"
        sub = scenario_dir / "sub"
        sub.mkdir(parents=True)
        (scenario_dir / "a.scn").write_text("root")
        (sub / "a.scn").write_text("nested")
        resp = client.delete("/api/bluesky/scenario/sub/a.scn")
        assert resp.status_code == 200
        assert (scenario_dir / "a.scn").exists()
        assert not (sub / "a.scn").exists()

    def test_delete_filename_that_secure_filename_would_mangle(self, client):
        # Files created outside the upload path (e.g. by BlueSky itself) can
        # have names secure_filename() rewrites; they are listed with their
        # real names and must be deletable under those names.
        scenario_dir = client.base_path / "scenario"
        scenario_dir.mkdir(exist_ok=True)
        (scenario_dir / "my test (v2).scn").write_text("x")
        resp = client.delete("/api/bluesky/scenario/my test (v2).scn")
        assert resp.status_code == 200
        assert not (scenario_dir / "my test (v2).scn").exists()

    def test_delete_traversal_is_stripped(self, client):
        outside = client.base_path / "outside.txt"
        outside.write_text("keep me")
        resp = client.delete("/api/bluesky/scenario/../outside.txt")
        assert resp.status_code in (400, 403, 404)
        assert outside.exists()

    def test_delete_symlink_escape_is_blocked(self, client):
        # A symlink resolving outside the type directory must be rejected and
        # its target left untouched (same containment rule as browsing).
        evil = client.base_path / "scenario_evil"
        evil.mkdir()
        secret = evil / "secret.scn"
        secret.write_text("secret")
        scenario_dir = client.base_path / "scenario"
        scenario_dir.mkdir(exist_ok=True)
        (scenario_dir / "link.scn").symlink_to(secret)
        resp = client.delete("/api/bluesky/scenario/link.scn")
        assert resp.status_code == 403
        assert secret.exists()

    def test_delete_directory_rejected(self, client):
        sub = client.base_path / "scenario" / "sub"
        sub.mkdir(parents=True)
        resp = client.delete("/api/bluesky/scenario/sub")
        assert resp.status_code == 404
        assert sub.exists()

    def test_delete_settings_other_name_rejected(self, client):
        resp = client.delete("/api/bluesky/settings/other.cfg")
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

    def test_incremental_read_returns_only_new_content(self, client):
        output_dir = client.base_path / "output"
        output_dir.mkdir(exist_ok=True)
        log = output_dir / "run.log"
        log.write_text("old line\n")

        initial = client.get("/api/bluesky/output/content/run.log").get_json()
        with log.open("a") as f:
            f.write("new line\n")

        resp = client.get(
            f"/api/bluesky/output/content/run.log?offset={initial['offset']}"
        )
        body = resp.get_json()
        assert body["content"] == "new line\n"
        assert body["offset"] == log.stat().st_size

    def test_truncated_file_restarts_stream(self, client):
        # A log rewritten between polls (e.g. a re-run scenario logging to the
        # same filename) shrinks below the poller's offset. The stream must
        # restart with the new contents instead of pinning at end-of-file and
        # silently skipping everything the new file holds.
        output_dir = client.base_path / "output"
        output_dir.mkdir(exist_ok=True)
        log = output_dir / "run.log"
        log.write_text("a much longer first run's worth of log output\n")

        initial = client.get("/api/bluesky/output/content/run.log").get_json()
        log.write_text("second run\n")  # truncating rewrite

        resp = client.get(
            f"/api/bluesky/output/content/run.log?offset={initial['offset']}"
        )
        body = resp.get_json()
        assert "second run" in body["content"]
        assert body["offset"] == log.stat().st_size

    def test_crlf_log_caught_mid_line_does_not_duplicate_newline(self, client):
        # A CRLF log polled between the \r and the \n used to deliver that
        # line ending twice: text-mode reading translated the trailing \r to
        # \n in one poll, then the next poll delivered the real \n again —
        # injecting a spurious blank line into the stream viewer.
        output_dir = client.base_path / "output"
        output_dir.mkdir(exist_ok=True)
        log = output_dir / "run.log"
        log.write_bytes(b"line one\r\nline two\r")

        initial = client.get("/api/bluesky/output/content/run.log").get_json()
        assert initial["offset"] == log.stat().st_size
        assert "line one\nline two" in initial["content"]

        # The writer completes the \r\n and adds another line.
        with log.open("ab") as f:
            f.write(b"\nline three\r\n")
        resp = client.get(
            f"/api/bluesky/output/content/run.log?offset={initial['offset']}"
        ).get_json()
        assert "line three" in resp["content"]
        assert resp["offset"] == log.stat().st_size

        # What the client renders across both polls holds no blank line.
        combined = initial["content"] + resp["content"]
        assert "\n\n" not in combined
        assert combined.replace("\r", "") == "line one\nline two\nline three\n"

    def test_multibyte_char_split_across_polls_is_held_back(self, client):
        # A UTF-8 character split by the poll must be re-read whole on the
        # next poll, not rendered as two replacement characters.
        output_dir = client.base_path / "output"
        output_dir.mkdir(exist_ok=True)
        log = output_dir / "run.log"
        payload = "altitude café".encode()
        log.write_bytes(payload[:-2])  # cut inside the 2-byte "é"

        initial = client.get("/api/bluesky/output/content/run.log").get_json()
        assert initial["content"] == "altitude caf"
        assert "�" not in initial["content"]

        with log.open("ab") as f:
            f.write(payload[-2:] + b"\n")
        resp = client.get(
            f"/api/bluesky/output/content/run.log?offset={initial['offset']}"
        ).get_json()
        assert resp["content"] == "é\n"

    def test_lines_zero_skips_history(self, client):
        # lines=0 used to return the entire file ([-0:] slices everything);
        # it now means "no history — stream from the current end".
        output_dir = client.base_path / "output"
        output_dir.mkdir(exist_ok=True)
        log = output_dir / "run.log"
        log.write_text("a\nb\nc\n")

        body = client.get("/api/bluesky/output/content/run.log?lines=0").get_json()
        assert body["content"] == ""
        assert body["offset"] == log.stat().st_size

    def test_lines_limits_initial_tail(self, client):
        output_dir = client.base_path / "output"
        output_dir.mkdir(exist_ok=True)
        log = output_dir / "run.log"
        log.write_text("a\nb\nc\n")

        body = client.get("/api/bluesky/output/content/run.log?lines=2").get_json()
        assert body["content"] == "b\nc\n"
        assert body["offset"] == log.stat().st_size


class TestFileStatusConfigured:
    def test_filestatus_after_configuration(self, client):
        resp = client.get("/api/bluesky/filestatus")
        body = resp.get_json()
        assert body["configured"] is True
        assert body["path_exists"] is True

    def test_configure_creates_managed_subdirs(self, client):
        # Same set the integrated build pre-creates (bluesky_paths), so the
        # output browser works before BlueSky's first start.
        for sub in ("scenario", "plugins", "output"):
            assert (client.base_path / sub).is_dir(), f"expected {sub}/ created"
