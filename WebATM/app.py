"""
Flask web server and Socket.IO handlers for WebATM.

This web application provides a browser-based interface for BlueSky - The Open Air Traffic
Simulator developed by TU Delft (Delft University of Technology).

This module is separated into different focused modules in the server/ package:
- server/session_manager.py: Session tracking and capacity management
- server/routes.py: Basic Flask routes (index, commands, config, health)
- server/server_status.py: BlueSky server status
- server/socket_handlers.py: Socket.IO event handlers
"""

import logging
import os
from pathlib import Path

from flask import Flask, jsonify
from flask_socketio import SocketIO
from werkzeug.exceptions import HTTPException

from .logger import get_logger
from .proxy import BlueSkyProxy, set_bluesky_proxy
from .server import (
    SessionManager,
    register_basic_routes,
    register_server_status_routes,
    register_socket_handlers,
)


def create_app():
    """Create and configure Flask application with all routes and handlers."""

    # Create Flask app
    app = Flask(
        __name__,
        template_folder=Path(__file__).parent / "templates",
        static_folder=Path(__file__).parent / "static",
    )
    app.config["SECRET_KEY"] = "WebATM_ui_secret_key"

    # Configure Flask and Werkzeug logging to use WebATM logger
    logger = get_logger("app")
    app.logger = logger

    # Configure Werkzeug (Flask's web server) to use WebATM logger for HTTP access logs
    werkzeug_logger = logging.getLogger("werkzeug")
    werkzeug_logger.handlers = []  # Clear default handlers
    werkzeug_logger.setLevel(logging.INFO)
    # Copy handlers from WebATM logger to Werkzeug logger
    for handler in logging.getLogger("WebATM").handlers:
        werkzeug_logger.addHandler(handler)

    # Initialize session manager
    session_manager = SessionManager()

    # Create SocketIO instance
    socketio = SocketIO(
        app,
        cors_allowed_origins="*",
        ping_timeout=60,
        ping_interval=25,
        async_mode="threading",
        logger=False,
        engineio_logger=False,
    )

    # Create and configure the BlueSky proxy instance
    bluesky_proxy = BlueSkyProxy()
    bluesky_proxy.socketio = socketio
    set_bluesky_proxy(bluesky_proxy)  # Set it globally for the subscriber callbacks

    # NB: subscribers are NOT registered here. The proxy creates its network
    # client lazily on connect (ZMQ pattern), so at app-creation time
    # bluesky_client is still None and there is nothing to attach to.
    # register_subscribers() is therefore called on connect instead -- by the
    # /api/server/config route (standalone) and by the auto-start hook
    # (integrated), both right after start_client() builds the client.

    # Store proxy reference in app for access in routes
    app.bluesky_proxy = bluesky_proxy

    # === Error Handlers ===
    @app.errorhandler(Exception)
    def handle_exception(e):
        """Return 500 for unexpected errors, but let HTTP errors keep their
        status (404, 405, ...) instead of masking them all as 500."""
        if isinstance(e, HTTPException):
            return e
        return jsonify({"error": "Internal server error"}), 500

    # === Register Routes and Handlers ===

    # Register basic routes (index, commands, server config, health/status)
    register_basic_routes(app, session_manager)

    # Register BlueSky server control routes (start/stop/restart/status/logs)
    register_server_status_routes(app)

    # Register all Socket.IO event handlers
    register_socket_handlers(socketio, session_manager)

    # Expose the session manager so optional extensions can reach it.
    # Harmless and unused in the default build.
    app.session_manager = session_manager

    # Optional integrated extensions: BlueSky server lifecycle control and
    # live log streaming. This is a no-op in the default build -- the
    # WEBATM_INTEGRATED env var is unset and the webatm_integrated package is
    # not installed, so the import is skipped or caught. The core package
    # never imports webatm_integrated; the dependency points the other way.
    if os.environ.get("WEBATM_INTEGRATED") == "1":
        try:
            import webatm_integrated

            webatm_integrated.register(
                app,
                socketio,
                session_manager=session_manager,
                bluesky_proxy=bluesky_proxy,
            )
            logger.info("Integrated extensions registered (webatm_integrated)")
        except Exception as e:  # best-effort: never break the core app
            logger.warning(f"Integrated extensions not loaded: {e}")

    return app, socketio
