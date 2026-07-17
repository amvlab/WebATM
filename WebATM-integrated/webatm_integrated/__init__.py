"""Provide the WebATM integrated extensions.

Shipped ONLY in the ``webatm-integrated`` build variant. Adds BlueSky server
lifecycle control (start/stop/restart/kill), live, in-order log streaming of the
``bluesky --headless`` process tree to the web UI, and -- because BlueSky runs in
this same container -- pre-wires WebATM's file management directly to BlueSky's
own scenario / plugins / output directories (no manual base-path step).

The core ``webatm`` package never imports this package. It is wired in through a
single env-guarded hook in ``WebATM.app.create_app`` that calls ``register``
only when ``WEBATM_INTEGRATED=1`` and this package is installed.
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

    Called by ``WebATM.app.create_app`` when ``WEBATM_INTEGRATED=1``. Points the
    file-management routes at BlueSky's fixed working directory, creates the
    process manager and log streamer (stashed on ``app`` as
    ``bluesky_process_manager`` / ``bluesky_log_streamer``), registers the
    integrated REST routes and Socket.IO handlers, and arranges for the whole
    BlueSky process group to be reaped when the worker exits. On the first boot
    only (guarded by ``claim_first_boot()``, so a replaced gunicorn worker never
    resurrects a manually-stopped server) it also schedules the background
    auto-start of the bundled BlueSky server; disable that with
    ``WEBATM_AUTO_START=0``.

    Args:
        app (flask.Flask): Flask application instance.
        socketio (flask_socketio.SocketIO): Flask-SocketIO instance
            (``async_mode="threading"``).
        session_manager (SessionManager): Core session manager (accepted for
            forward-compat; currently unused).
        bluesky_proxy (BlueSkyProxy): Core proxy, used for the first-boot
            auto-connect.

    Returns:
        dict: The created ``manager`` (BlueSkyProcessManager) and ``streamer``
            (LogStreamer), handy for tests.
    """
    # Imported lazily so the Flask-importing modules stay out of flask-free
    # unit-test imports of process_manager / log_streamer.
    from .auto_start import auto_start_enabled, claim_first_boot, schedule_auto_start
    from .bluesky_paths import configure_file_management
    from .routes import register_integrated_routes
    from .socket_handlers import register_integrated_socket_handlers

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

    register_integrated_routes(app, manager)
    register_integrated_socket_handlers(socketio, streamer)

    # Reap the whole bluesky process group if the worker process exits.
    atexit.register(manager.kill)

    # First boot only (see the docstring above): auto-start BlueSky and connect
    # the proxy in the background so app creation returns promptly.
    if auto_start_enabled() and claim_first_boot():
        schedule_auto_start(socketio, manager, bluesky_proxy)

    return {"manager": manager, "streamer": streamer}
