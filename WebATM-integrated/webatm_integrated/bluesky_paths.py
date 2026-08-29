"""BlueSky file-management path wiring for the integrated build.

In the integrated variant BlueSky runs inside the same container, and a
pip-installed BlueSky keeps its working directory at ``~/bluesky`` (see
BlueSky's ``pathfinder``). This module points WebATM's existing
file-management routes (``/api/bluesky/...``) at that directory and locks
them there, replacing the standalone build's manual "configure base path"
step, so uploads and browsing always land exactly where the running server
reads them. Only reached via ``webatm_integrated.register`` (env-guarded on
``WEBATM_INTEGRATED=1``); the core ``webatm`` package never imports it.
"""

from __future__ import annotations

from pathlib import Path

from WebATM.logger import get_logger
from WebATM.server.routes import MANAGED_SUBDIRS

logger = get_logger()


def resolve_bluesky_workdir() -> Path:
    """Return BlueSky's working directory (where scenario/plugins/output live).

    Deliberately mirrors the pip-package rule (``~/bluesky``) instead of
    exposing a setting, so WebATM and the BlueSky server can never point at
    different directories.

    Returns:
        Path: BlueSky's working directory (``~/bluesky``).
    """
    return Path.home() / "bluesky"


def configure_file_management(app) -> str:
    """Pre-configure WebATM's file-management routes for the integrated build.

    Sets ``app.bluesky_base_path`` -- the same attribute the standalone
    ``/api/bluesky/configure-base-path`` route sets, so every existing file
    route works unchanged -- and locks it (``bluesky_base_path_locked``) so
    that route refuses to repoint it. The managed subdirectories are
    best-effort created so the UI can browse and upload even before the
    BlueSky server's first start.

    Args:
        app (flask.Flask): Flask application instance.

    Returns:
        str: The configured base path (BlueSky's working directory).
    """
    workdir = resolve_bluesky_workdir()
    base_path = str(workdir)
    app.bluesky_base_path = base_path
    app.bluesky_base_path_locked = True

    try:
        workdir.mkdir(parents=True, exist_ok=True)
        for subdir in MANAGED_SUBDIRS:
            (workdir / subdir).mkdir(exist_ok=True)
    except OSError as e:
        # Non-fatal: BlueSky (re)creates these on its first start, and the
        # file routes degrade gracefully when a directory is missing.
        logger.warning(
            f"Could not pre-create BlueSky file directories under {workdir}: {e}"
        )

    logger.info(f"Integrated: BlueSky file management configured at {base_path}")
    return base_path
