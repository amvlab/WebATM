"""Tests for the integrated BlueSky file-management path wiring.

These verify that the integrated build pre-configures WebATM's file manager to
BlueSky's own working directory (``~/bluesky``) and creates the
scenario/plugins/output subdirectories the UI browses, so the user never has to
configure a base path.
"""

import types
from pathlib import Path

from webatm_integrated.bluesky_paths import (
    configure_file_management,
    resolve_bluesky_workdir,
)


def test_workdir_is_home_bluesky(monkeypatch, tmp_path):
    """The working directory mirrors BlueSky's pip-package default of ~/bluesky."""
    monkeypatch.setenv("HOME", str(tmp_path))  # Path.home() honors $HOME on POSIX
    assert resolve_bluesky_workdir() == tmp_path / "bluesky"


def test_configure_sets_base_path_and_creates_dirs(monkeypatch, tmp_path):
    """configure_file_management sets app.bluesky_base_path and makes the dirs."""
    monkeypatch.setenv("HOME", str(tmp_path))
    app = types.SimpleNamespace()

    base = configure_file_management(app)

    workdir = tmp_path / "bluesky"
    assert base == str(workdir)
    # Same attribute the standalone configure-base-path route sets, so every
    # existing /api/bluesky/... route works unchanged.
    assert app.bluesky_base_path == str(workdir)
    for sub in ("scenario", "plugins", "output"):
        assert (workdir / sub).is_dir(), f"expected {sub}/ to be created"


def test_configure_is_idempotent(monkeypatch, tmp_path):
    """Re-running against already-existing directories must not raise."""
    monkeypatch.setenv("HOME", str(tmp_path))
    app = types.SimpleNamespace()

    configure_file_management(app)
    configure_file_management(app)  # second run: dirs already exist

    assert (tmp_path / "bluesky" / "scenario").is_dir()


def test_configure_survives_uncreatable_workdir(monkeypatch, tmp_path):
    """If the directories can't be created, base_path is still set (non-fatal)."""
    monkeypatch.setenv("HOME", str(tmp_path))
    app = types.SimpleNamespace()

    def _boom(*args, **kwargs):
        raise OSError("read-only filesystem")

    monkeypatch.setattr(Path, "mkdir", _boom)

    base = configure_file_management(app)

    # The path is reported even though pre-creation failed; BlueSky creates the
    # dirs itself on first start.
    assert base == str(tmp_path / "bluesky")
    assert app.bluesky_base_path == str(tmp_path / "bluesky")
