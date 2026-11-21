"""REST control routes for the integrated BlueSky server.

Namespaced under ``/api/integrated/`` so they cannot collide with core routes
and are simply absent from the default build.
"""

from __future__ import annotations

from functools import partial

from flask import jsonify

from WebATM.logger import get_logger

logger = get_logger()

# Lifecycle actions exposed as POST /api/integrated/server/<action>, each
# delegating to the BlueSkyProcessManager method of the same name.
LIFECYCLE_ACTIONS = ("start", "stop", "restart", "kill")


def register_integrated_routes(app, manager):
    """Register server lifecycle-control routes on the Flask app.

    Registers ``POST /api/integrated/server/{start,stop,restart,kill}`` and
    ``GET /api/integrated/server/status``, each returning the manager's result
    dict as JSON. An unexpected exception is logged with its traceback and
    returned in the same ``{"success": False, "status": "error", "message"}``
    shape the manager itself uses for failures — never Flask's generic error
    payload, which the frontend status display cannot interpret.

    Args:
        app (flask.Flask): Flask application instance.
        manager (BlueSkyProcessManager): Controls the bundled server.
    """

    def invoke(action):
        if action != "status":  # status is polled; logging it would be noise
            logger.info(f"Integrated: {action} BlueSky server requested")
        try:
            return jsonify(getattr(manager, action)())
        except Exception as e:
            logger.exception(f"Integrated: BlueSky server {action} failed")
            return jsonify(
                {
                    "success": False,
                    "status": "error",
                    "message": f"BlueSky server {action} failed: {e}",
                }
            ), 500

    for action in LIFECYCLE_ACTIONS:
        app.add_url_rule(
            f"/api/integrated/server/{action}",
            endpoint=f"integrated_server_{action}",
            view_func=partial(invoke, action),
            methods=["POST"],
        )
    app.add_url_rule(
        "/api/integrated/server/status",
        endpoint="integrated_server_status",
        view_func=partial(invoke, "status"),
        methods=["GET"],
    )
