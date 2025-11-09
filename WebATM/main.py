"""Main entry point for WebATM."""

import os

from .app import create_app
from .logger import get_logger

logger = get_logger()


def start_WebATM(hostname=None, port=8082, debug=False):
    """Start WebATM."""
    # Get BlueSky server hostname from environment variable or parameter
    bluesky_host = hostname or os.environ.get("BLUESKY_SERVER_HOST", "localhost")
    web_port = int(os.environ.get("WEB_PORT", port))
    web_host = os.environ.get("WEB_HOST", "localhost")

    # create the app
    app, socketio = create_app()

    # Set default server IP on the client but don't connect - wait for user to configure
    app.bluesky_proxy.server_ip = bluesky_host
    logger.info("BlueSky Proxy initialized (not connected to BlueSky server)")
    logger.info(f"Default BlueSky server IP set to: {bluesky_host}")
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
