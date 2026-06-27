"""WebATM integrated extensions.

Shipped ONLY in the ``webatm-integrated`` build variant. Adds BlueSky server
lifecycle control (start/stop/restart/kill), live, in-order log streaming of the
``bluesky --headless`` process tree to the web UI, and -- because BlueSky runs in
this same container -- pre-wires WebATM's file management directly to BlueSky's
own scenario / plugins / output directories (no manual base-path step).

The core ``webatm`` package never imports this package. It is wired in through a
single env-guarded hook in ``WebATM.app.create_app`` that calls
:func:`register` only when ``WEBATM_INTEGRATED=1`` and this package is
installed.
"""

from __future__ import annotations

import atexit

from .log_streamer import LogStreamer
from .process_manager import BlueSkyProcessManager

__all__ = [
    "BlueSkyProcessManager",
    "LogStreamer",
    "register",
]


def register(app, socketio, *, session_manager=None, bluesky_proxy=None):
    """Wire the integrated features into an existing WebATM app.

    Called by ``WebATM.app.create_app`` when ``WEBATM_INTEGRATED=1``.

    Args:
        app: Flask application instance.
        socketio: Flask-SocketIO instance (async_mode="threading").
        session_manager: Core SessionManager (accepted for forward-compat).
        bluesky_proxy: Core BlueSkyProxy (accepted for forward-compat).

    Returns:
        dict with the created ``manager`` and ``streamer`` (handy for tests).
    """
    # Imported lazily so `import webatm_integrated.process_manager` /
    # `.log_streamer` stay Flask-free (importable for unit tests). They are only
    # needed here, where the Flask app + socketio already exist. `bluesky_paths`
    # and `auto_start` import the core `WebATM` package, so they are deferred for
    # the same reason.
    from .auto_start import auto_start_enabled, claim_first_boot, schedule_auto_start
    from .bluesky_paths import configure_file_management
    from .routes import register_integrated_routes
    from .socket_handlers import register_integrated_socket_handlers

    # Point WebATM's file-management routes straight at BlueSky's working
    # directory (scenario/plugins/output). BlueSky runs in this container, so
    # that path is fixed -- the user never configures a base path here (the
    # standalone build keeps its manual base-path step untouched).
    configure_file_management(app)

    streamer = LogStreamer(socketio)
    manager = BlueSkyProcessManager(
        on_line=streamer.feed_line,
        on_exit=streamer.on_process_exit,
        spawn=socketio.start_background_task,
    )

    # Stash on the app so blueprint-free route/handler closures can reach them
    # via flask.current_app if needed.
    app.bluesky_process_manager = manager
    app.bluesky_log_streamer = streamer

    register_integrated_routes(app, manager, streamer)
    register_integrated_socket_handlers(socketio, manager, streamer)

    # Reap the whole bluesky process group if the worker process exits.
    atexit.register(manager.kill)

    # On first boot, auto-start the bundled BlueSky server and connect the proxy
    # so the user lands on a live, connected map. claim_first_boot() guards it to
    # once per boot (a replaced worker re-running register() won't resurrect a
    # manually-stopped server); it runs in the background so app creation returns
    # promptly. Disable with WEBATM_AUTO_START=0 to drive the lifecycle manually.
    if auto_start_enabled() and claim_first_boot():
        schedule_auto_start(socketio, manager, bluesky_proxy)

    return {"manager": manager, "streamer": streamer}
