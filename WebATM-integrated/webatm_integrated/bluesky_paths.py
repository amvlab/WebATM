"""BlueSky file-management path wiring for the integrated build.

In the integrated variant BlueSky runs inside the same container as the WebATM
backend, so its scenario / plugins / output directories live on the same
filesystem and at a *fixed*, known location -- there is nothing for a user to
configure. This module resolves that location and points WebATM's existing
file-management routes (``/api/bluesky/...``) straight at it, replacing the
manual "configure base path" step the standalone build relies on.

BlueSky, installed as a pip package (which is exactly how the integrated image
ships it), keeps its working directory at ``~/bluesky`` and maintains
``scenario``, ``plugins`` and ``output`` subdirectories under it (see BlueSky's
``pathfinder``). Pointing the file manager at that same working directory means
uploads and browsing land precisely where the running server reads them, with no
chance of the two disagreeing.

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

    For a pip-package install -- the only way the integrated build ships BlueSky
    -- BlueSky uses ``~/bluesky`` as its working directory. We deliberately
    mirror that exact rule (rather than expose a separate, overridable setting)
    so WebATM and the BlueSky server can never point at different directories.

    Returns:
        Path: BlueSky's working directory (``~/bluesky``).
    """
    return Path.home() / "bluesky"


def configure_file_management(app) -> str:
    """Pre-configure WebATM's file-management routes for the integrated build.

    Sets ``app.bluesky_base_path`` -- the very same attribute the standalone
    build's ``/api/bluesky/configure-base-path`` route sets -- so every existing
    file route (filestatus, upload, browse, list, delete, output) keeps working
    unchanged, just pre-wired to BlueSky's working directory. The managed
    subdirectories are best-effort created so the UI can browse and upload even
    before the BlueSky server's first start.

    Args:
        app (flask.Flask): Flask application instance.

    Returns:
        str: The configured base path (BlueSky's working directory).
    """
    workdir = resolve_bluesky_workdir()
    base_path = str(workdir)
    app.bluesky_base_path = base_path

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
