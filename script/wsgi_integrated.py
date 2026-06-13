#!/usr/bin/env python
"""WSGI entry point for the ``webatm-integrated`` build.

Unlike ``wsgi.py``, this entry point does NOT monkey-patch eventlet: the
integrated build reads a blocking subprocess pipe in a background thread, which
is incompatible with eventlet's cooperative scheduler. Run it with a threaded
worker, e.g.::

    gunicorn --worker-class gthread --threads 4 -w 1 --bind 0.0.0.0:8082 wsgi_integrated:app

The core SocketIO is created with ``async_mode="threading"``, which is correct
under a gthread worker.
"""

import os

from WebATM.app import create_app
from WebATM.logger import get_logger

logger = get_logger()

# Ensure the integrated hook in WebATM.app.create_app() fires even if the
# orchestrator forgot to set it. create_app() reads this at call time (below),
# so setting it here is sufficient.
os.environ.setdefault("WEBATM_INTEGRATED", "1")

# Get configuration from environment variables
bluesky_host = os.environ.get("BLUESKY_SERVER_HOST", "localhost")
web_port = int(os.environ.get("WEB_PORT", 8082))
web_host = os.environ.get("WEB_HOST", "0.0.0.0")

# Create the Flask app and SocketIO instance (integrated extensions register here)
app, socketio = create_app()

# Set default server IP on the client but don't connect
app.bluesky_proxy.server_ip = bluesky_host
logger.info("WebATM (integrated) initialized")
logger.info(f"Default BlueSky server IP set to: {bluesky_host}")
logger.info("Ready - Start the BlueSky server from the web UI")

if __name__ == "__main__":
    # Not used by gunicorn, but allows testing with `python wsgi_integrated.py`.
    logger.info(f"Starting WebATM (integrated) on http://{web_host}:{web_port}")
    socketio.run(app, host=web_host, port=web_port)
