"""REST control routes for the integrated BlueSky server.

Namespaced under ``/api/integrated/`` so they cannot collide with core routes
and are simply absent from the default build.
"""

from __future__ import annotations

from flask import jsonify

from WebATM.logger import get_logger

logger = get_logger()


def register_integrated_routes(app, manager, streamer):
    """Register start/stop/restart/kill/status routes on the Flask app."""

    @app.route("/api/integrated/server/start", methods=["POST"])
    def integrated_server_start():
        logger.info("Integrated: start BlueSky server requested")
        return jsonify(manager.start())

    @app.route("/api/integrated/server/stop", methods=["POST"])
    def integrated_server_stop():
        logger.info("Integrated: stop BlueSky server requested")
        return jsonify(manager.stop())

    @app.route("/api/integrated/server/restart", methods=["POST"])
    def integrated_server_restart():
        logger.info("Integrated: restart BlueSky server requested")
        return jsonify(manager.restart())

    @app.route("/api/integrated/server/kill", methods=["POST"])
    def integrated_server_kill():
        logger.info("Integrated: kill BlueSky server requested")
        return jsonify(manager.kill())

    @app.route("/api/integrated/server/status", methods=["GET"])
    def integrated_server_status():
        return jsonify(manager.status())
