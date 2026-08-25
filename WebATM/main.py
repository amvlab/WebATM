"""Start the WebATM web server and manage its lifecycle."""

import os

from .app import create_app
from .logger import get_logger

logger = get_logger()


def create_configured_app(bluesky_host=None):
    """Create the app with the default BlueSky server IP set on the proxy.

    Shared bootstrap for every entry point: the dev server
    (:func:`start_WebATM`) and the gunicorn WSGI scripts
    (``script/wsgi.py``, ``script/wsgi_integrated.py``). The proxy is only
    configured, not connected.

    Args:
        bluesky_host (str | None): BlueSky server hostname/IP. Falls back to
            the ``BLUESKY_SERVER_HOST`` environment variable, then
            ``"localhost"``.

    Returns:
        tuple: The ``(app, socketio)`` pair from :func:`WebATM.app.create_app`.
    """
    bluesky_host = bluesky_host or os.environ.get("BLUESKY_SERVER_HOST", "localhost")
    app, socketio = create_app()
    app.bluesky_proxy.server_ip = bluesky_host
    logger.info(f"Default BlueSky server IP set to: {bluesky_host}")
    return app, socketio


def start_WebATM(hostname=None, port=8082, debug=False):
    """Start the WebATM web server.

    Creates the Flask/Socket.IO application, sets the default BlueSky server IP
    on the proxy (without connecting), and runs the web server until it exits,
    at which point the proxy client is stopped.

    The web server bind address is taken from the ``WEB_HOST`` environment
    variable (default ``"localhost"``).

    Args:
        hostname (str | None): BlueSky server hostname/IP to use as the default.
            Falls back to the ``BLUESKY_SERVER_HOST`` environment variable, then
            ``"localhost"``.
        port (int): Web server port. The ``WEB_PORT`` environment variable, if
            set, takes precedence.
        debug (bool): Whether to run the Socket.IO server in debug mode.
    """
    web_port = int(os.environ.get("WEB_PORT", port))
    web_host = os.environ.get("WEB_HOST", "localhost")

    app, socketio = create_configured_app(hostname)
    logger.info("Ready - Connect to BlueSky server via WebATM")

    try:
        logger.info(f"Starting WebATM on http://{web_host}:{web_port}")
        # Suppress Flask development server warning for local use
        os.environ["FLASK_ENV"] = "production"
        socketio.run(
            app,
            host=web_host,
            port=web_port,
            debug=debug,
            use_reloader=False,
            allow_unsafe_werkzeug=True,
        )
    finally:
        logger.info("Shutting down WebATM...")
        app.bluesky_proxy.stop_client("shutdown")
        logger.info("Shutdown complete")


if __name__ == "__main__":
    start_WebATM()
