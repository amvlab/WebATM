#!/usr/bin/env python
"""WSGI entry point for production deployment with gunicorn.

Run it with a threaded worker — the SocketIO instance is created with
``async_mode="threading"`` (see ``WebATM.app.create_app``):

    gunicorn --worker-class gthread --threads 4 -w 1 --bind 0.0.0.0:8082 wsgi:app
"""

import os

from WebATM.logger import get_logger
from WebATM.main import create_configured_app

logger = get_logger()

app, socketio = create_configured_app()
logger.info("Ready - Connect to BlueSky server via WebATM")

if __name__ == "__main__":
    # Fallback for testing without gunicorn: python wsgi.py
    web_host = os.environ.get("WEB_HOST", "0.0.0.0")
    web_port = int(os.environ.get("WEB_PORT", 8082))
    logger.info(f"Starting WebATM on http://{web_host}:{web_port}")
    socketio.run(app, host=web_host, port=web_port, allow_unsafe_werkzeug=True)
