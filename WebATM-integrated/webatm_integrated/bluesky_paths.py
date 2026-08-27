"""BlueSky file-management path wiring for the integrated build.

In the integrated variant BlueSky runs inside the same container as the WebATM
backend, at a fixed, known location: a pip-installed BlueSky keeps its working
directory at ``~/bluesky`` with ``scenario``, ``plugins`` and ``output``
subdirectories under it (see BlueSky's ``pathfinder``). This module points
WebATM's existing file-management routes (``/api/bluesky/...``) straight at
that directory and locks it there, replacing the manual "configure base path"
step of the standalone build, so uploads and browsing always land exactly
where the running server reads them.

The core ``webatm`` package never imports this module; it is reached only via
``webatm_integrated.register`` (env-guarded on ``WEBATM_INTEGRATED=1``).
"""

from __future__ import annotations

from pathlib import Path

from WebATM.logger import get_logger

logger = get_logger()

# Subdirectories BlueSky maintains under its working directory that WebATM's
# file manager browses / uploads into. (The "settings" file type maps to the
# sibling ``settings.cfg`` rather than a directory, so it needs no pre-creation.)
_MANAGED_SUBDIRS = ("scenario", "plugins", "output")


def resolve_bluesky_workdir() -> Path:
    """Return BlueSky's working directory (where scenario/plugins/output live).

    Deliberately mirrors the pip-package rule (``~/bluesky``) rather than
    exposing a separate, overridable setting, so WebATM and the BlueSky server
    can never point at different directories.

    Returns:
        Path: BlueSky's working directory (``~/bluesky``).
    """
    return Path.home() / "bluesky"


def configure_file_management(app) -> str:
    """Pre-configure WebATM's file-management routes for the integrated build.

    Sets ``app.bluesky_base_path`` -- the very same attribute the standalone
    build's ``/api/bluesky/configure-base-path`` route sets -- so every existing
    file route (filestatus, upload, browse, download, delete) keeps working
    unchanged, just pre-wired to BlueSky's working directory. The path is also
    locked (``bluesky_base_path_locked``) so that route refuses to repoint it:
    the whole point of the fixed path is that uploads land exactly where the
    bundled server reads them. The managed subdirectories are best-effort
    created so the UI can browse and upload even before the BlueSky server's
    first start.

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
        for subdir in _MANAGED_SUBDIRS:
            (workdir / subdir).mkdir(exist_ok=True)
    except OSError as e:
        # Non-fatal: BlueSky itself (re)creates these on its first start, and the
        # file routes degrade gracefully when a directory is missing. We still
        # keep base_path set so the UI reports the correct, fixed location.
        logger.warning(
            f"Could not pre-create BlueSky file directories under {workdir}: {e}"
        )

    logger.info(f"Integrated: BlueSky file management configured at {base_path}")
    return base_path
