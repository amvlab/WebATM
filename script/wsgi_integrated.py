#!/usr/bin/env python
"""WSGI entry point for the ``webatm-integrated`` build.

Same threaded-worker setup as ``wsgi.py`` (no monkey patching; the
integrated build reads a blocking subprocess pipe in a background thread):

    gunicorn --worker-class gthread --threads 4 -w 1 --bind 0.0.0.0:8082 wsgi_integrated:app
"""

import os

from WebATM.logger import get_logger
from WebATM.main import create_configured_app

logger = get_logger()

# create_configured_app() -> create_app() reads this at call time, so setting
# it here ensures the integrated hook fires even if the orchestrator forgot.
os.environ.setdefault("WEBATM_INTEGRATED", "1")

app, socketio = create_configured_app()
logger.info("Ready - BlueSky server auto-starting (WEBATM_AUTO_START=0 to disable)")

if __name__ == "__main__":
    # Fallback for testing without gunicorn: python wsgi_integrated.py
    web_host = os.environ.get("WEB_HOST", "0.0.0.0")
    web_port = int(os.environ.get("WEB_PORT", 8082))
    logger.info(f"Starting WebATM (integrated) on http://{web_host}:{web_port}")
    socketio.run(app, host=web_host, port=web_port, allow_unsafe_werkzeug=True)
