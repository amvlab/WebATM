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
from pathlib import Path

from flask import Flask, jsonify, request
from flask_socketio import SocketIO

from .logger import get_logger
from .proxy import BlueSkyProxy, register_subscribers, set_bluesky_proxy
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

    # Register subscriber callbacks after client is fully initialized
    register_subscribers()

    # Store proxy reference in app for access in routes
    app.bluesky_proxy = bluesky_proxy

    # === Request Middleware ===
    @app.before_request
    def filter_requests():
        """Filter requests to skip certain endpoints."""
        # Skip processing for health, status endpoints and static files
        if request.endpoint in [
            "health_check",
            "status_check",
        ] or request.path.startswith("/static/"):
            return

        # Skip for API endpoints that don't create new sessions (existing session operations)
        if request.endpoint in [
            "get_data",
            "send_command",
            "get_server_config",
            "update_server_config",
            "disconnect_server",
        ]:
            return

    # === Error Handlers ===
    @app.errorhandler(Exception)
    def handle_exception(e):
        """Handle uncaught exceptions."""
        try:
            return jsonify({"error": "Internal server error"}), 500
        except:
            return "Internal server error", 500

    # === Register Routes and Handlers ===

    # Register basic routes (index, commands, server config, health/status)
    register_basic_routes(app, session_manager)

    # Register BlueSky server control routes (start/stop/restart/status/logs)
    register_server_status_routes(app)

    # Register all Socket.IO event handlers
    register_socket_handlers(socketio, session_manager)

    return app, socketio
