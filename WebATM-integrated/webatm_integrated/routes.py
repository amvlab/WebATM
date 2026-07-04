"""REST control routes for the integrated BlueSky server.

Namespaced under ``/api/integrated/`` so they cannot collide with core routes
and are simply absent from the default build.
"""

from __future__ import annotations

from flask import jsonify

from WebATM.logger import get_logger

logger = get_logger()


def register_integrated_routes(app, manager, streamer):
    """Register server lifecycle-control routes on the Flask app.

    Args:
        app (flask.Flask): Flask application instance.
        manager (BlueSkyProcessManager): Controls the bundled server.
        streamer (LogStreamer): Broadcasts the server's output (unused here;
            kept for signature parity with the socket handlers).
    """

    @app.route("/api/integrated/server/start", methods=["POST"])
    def integrated_server_start():
        """Start the bundled BlueSky server (POST /api/integrated/server/start)."""
        logger.info("Integrated: start BlueSky server requested")
        return jsonify(manager.start())

    @app.route("/api/integrated/server/stop", methods=["POST"])
    def integrated_server_stop():
        """Stop the bundled BlueSky server (POST /api/integrated/server/stop)."""
        logger.info("Integrated: stop BlueSky server requested")
        return jsonify(manager.stop())

    @app.route("/api/integrated/server/restart", methods=["POST"])
    def integrated_server_restart():
        """Restart the bundled BlueSky server (POST /api/integrated/server/restart)."""
        logger.info("Integrated: restart BlueSky server requested")
        return jsonify(manager.restart())

    @app.route("/api/integrated/server/kill", methods=["POST"])
    def integrated_server_kill():
        """Kill the whole BlueSky process group (POST /api/integrated/server/kill)."""
        logger.info("Integrated: kill BlueSky server requested")
        return jsonify(manager.kill())

    @app.route("/api/integrated/server/status", methods=["GET"])
    def integrated_server_status():
        """Report the server process state (GET /api/integrated/server/status)."""
        return jsonify(manager.status())
