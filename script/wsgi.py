#!/usr/bin/env python
"""
WSGI entry point for production deployment with gunicorn.

Usage:
    gunicorn --worker-class eventlet -w 1 --bind 0.0.0.0:8082 wsgi:app
"""

# CRITICAL: eventlet monkey patching must happen before any other imports
import eventlet

eventlet.monkey_patch()

import os

from WebATM.app import create_app
from WebATM.logger import get_logger

logger = get_logger()

# Get configuration from environment variables
bluesky_host = os.environ.get("BLUESKY_SERVER_HOST", "localhost")
web_port = int(os.environ.get("WEB_PORT", 8082))
web_host = os.environ.get("WEB_HOST", "0.0.0.0")

# Create the Flask app and SocketIO instance
app, socketio = create_app()

# Set default server IP on the client but don't connect
app.bluesky_proxy.server_ip = bluesky_host
logger.info("BlueSky Proxy initialized (not connected to BlueSky server)")
logger.info(f"Default BlueSky server IP set to: {bluesky_host}")
logger.info("Ready - Connect to BlueSky server via WebATM")

# Note: When using gunicorn with eventlet workers, Flask-SocketIO handles
# everything automatically. We just expose the Flask app, not socketio.

if __name__ == "__main__":
    # This won't be used by gunicorn, but allows testing with python wsgi.py
    logger.info(f"Starting WebATM on http://{web_host}:{web_port}")
    socketio.run(app, host=web_host, port=web_port)
