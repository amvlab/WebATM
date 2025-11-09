"""
Basic Flask routes for WebATM.

This module contains routes for the main page, simulation commands,
server configuration, and health/status endpoints.
"""

import json
import socket
import time
from pathlib import Path

from flask import current_app, jsonify, render_template, request

from ..logger import get_logger

logger = get_logger()


def get_webpack_assets():
    """
    Read webpack manifest and return script tags for all bundles in correct order.

    Returns:
        list: Script tags for webpack bundles
    """
    try:
        # Go up one level from server/ to WebATM/ to find static/
        manifest_path = (
            Path(__file__).parent.parent / "static" / "ts" / "dist" / "manifest.json"
        )

        if not manifest_path.exists():
            # Fallback to single bundle.js if manifest doesn't exist
            return ['<script src="/static/ts/dist/bundle.js"></script>']

        with open(manifest_path) as f:
            manifest = json.load(f)

        script_tags = []

        # Check if this is a development build (single bundle) or production build (split bundles)
        if (
            "main.js" in manifest
            and len([k for k in manifest.keys() if k.endswith(".js")]) == 1
        ):
            # Development mode: single bundle
            bundle_file = manifest["main.js"]
            script_tags.append(f'<script src="/static/ts/dist/{bundle_file}"></script>')
        else:
            # Production mode: split bundles - load in correct order
            chunk_order = ["runtime.js", "vendor.js", "app.js", "main.js"]

            for chunk_name in chunk_order:
                if chunk_name in manifest:
                    script_tags.append(
                        f'<script src="/static/ts/dist/{manifest[chunk_name]}"></script>'
                    )

        return (
            script_tags
            if script_tags
            else ['<script src="/static/ts/dist/bundle.js"></script>']
        )

    except Exception as e:
        logger.info(f"Error reading webpack manifest: {e}")
        # Fallback to single bundle.js
        return ['<script src="/static/ts/dist/bundle.js"></script>']


def register_basic_routes(app, session_manager):
    """
    Register basic Flask routes with the application.

    Args:
        app: Flask application instance
        session_manager: SessionManager instance for capacity checking
    """

    @app.route("/")
    def index():
        """Main page."""
        try:
            webpack_scripts = get_webpack_assets()
            return render_template("index.html", webpack_scripts=webpack_scripts)
        except Exception as e:
            return f"Error loading page: {str(e)}", 500

    @app.route("/api/simulation/command", methods=["POST"])
    def send_command():
        """Send command to simulation."""
        try:
            command = request.json.get("command", "") if request.json else ""
            success = current_app.bluesky_proxy.send_command(command)
            return jsonify({"success": success, "command": command})
        except Exception:
            return jsonify({"error": "Failed to send command"}), 500

    @app.route("/api/server/config", methods=["GET"])
    def get_server_config():
        """Get current server configuration."""
        try:
            return jsonify(
                {
                    "server_ip": getattr(
                        current_app.bluesky_proxy, "server_ip", "localhost"
                    ),
                    "is_connected": getattr(
                        current_app.bluesky_proxy, "running", False
                    ),
                }
            )
        except Exception:
            return jsonify({"error": "Failed to get server config"}), 500

    @app.route("/api/server/config", methods=["POST"])
    def update_server_config():
        """Update server configuration and reconnect."""
        try:
            data = request.json if request.json else {}
            server_ip = data.get("server_ip", "localhost").strip() or "localhost"

            # Always create a completely fresh client instance - like restarting the server
            logger.info(f"User requested connection to BlueSky server at {server_ip}")
            logger.info(
                "Completely destroying current client and creating fresh instance..."
            )

            # Store important state before deletion
            old_socketio = (
                current_app.bluesky_proxy.socketio
                if hasattr(current_app, "bluesky_proxy")
                else None
            )
            old_connected_clients = (
                current_app.bluesky_proxy.connected_clients
                if hasattr(current_app, "bluesky_proxy")
                else 0
            )

            # Stop current client if it exists and is running
            if (
                hasattr(current_app, "bluesky_proxy")
                and current_app.bluesky_proxy.running
            ):
                logger.info("Stopping existing client...")
                current_app.bluesky_proxy.stop_client()
                time.sleep(0.3)

            # Completely delete the old client reference with full context destruction
            if hasattr(current_app, "bluesky_proxy"):
                logger.info("Completely destroying client with ZMQ context...")
                current_app.bluesky_proxy.close()  # Close network client
                del current_app.bluesky_proxy

            # Force garbage collection to clean up the old client
            try:
                import gc

                logger.debug("Forcing garbage collection to clean up old client...")
                gc.collect()  # Force garbage collection
                logger.info("Memory cleaned")
            except Exception as e:
                logger.warning(f"Cleanup note: {e}")

            # Create completely fresh client instance (let BlueSky create its own ZMQ context)
            from ..proxy import BlueSkyProxy, register_subscribers, set_bluesky_proxy

            logger.info("Creating brand new BlueSky Proxy instance...")

            try:
                current_app.bluesky_proxy = BlueSkyProxy()
                # Note: network_client will be initialized when user connects
                logger.info("BlueSky Proxy instance created successfully")

                current_app.bluesky_proxy.socketio = old_socketio
                current_app.bluesky_proxy.connected_clients = old_connected_clients
                set_bluesky_proxy(current_app.bluesky_proxy)  # Update global reference
                logger.info("Client configured with socketio and connected_clients")

            except Exception as e:
                logger.error(f"Error creating {e}")
                import traceback

                traceback.print_exc()
                raise

            # Network client already initialized in BlueSkyProxy.__init__

            # Connect with fresh client FIRST
            current_app.bluesky_proxy.server_ip = server_ip
            current_app.bluesky_proxy.start_client(hostname=server_ip)

            # Re-register subscribers AFTER successful connection
            logger.info("Re-registering data subscribers after connection...")
            register_subscribers()
            logger.info("Data subscribers registered successfully")

            # Wait for node detection to confirm BlueSky server is actually running
            logger.debug("Waiting for BlueSky nodes to be detected...")

            timeout = 10.0  # 10 seconds timeout
            start_time = time.time()

            while time.time() - start_time < timeout:
                if len(current_app.bluesky_proxy.tracked_nodes) > 0:
                    logger.info("BlueSky nodes detected - connection confirmed")
                    return jsonify(
                        {
                            "success": True,
                            "server_ip": server_ip,
                            "message": "Connected to BlueSky remote server hosted by amvlab",
                        }
                    )
                time.sleep(0.1)  # Check every 100ms

            # Timeout reached - no nodes detected
            logger.info(
                f"No BlueSky nodes detected after {timeout}s - server may be offline"
            )
            current_app.bluesky_proxy.stop_client()
            return (
                jsonify(
                    {
                        "success": False,
                        "error": f"No BlueSky nodes detected on server {server_ip}. Server may be offline or not configured properly.",
                    }
                ),
                500,
            )
        except Exception as e:
            logger.info(f"Error updating server config: {e}")
            return (
                jsonify(
                    {
                        "success": False,
                        "error": f"Failed to connect to server: {str(e)}",
                    }
                ),
                500,
            )

    @app.route("/api/server/disconnect", methods=["POST"])
    def disconnect_server():
        """Disconnect from current server."""
        try:
            if current_app.bluesky_proxy.running:
                logger.info("User requested manual disconnection from BlueSky server")
                current_app.bluesky_proxy.stop_client("manual")
                # Wait a moment for cleanup to complete
                time.sleep(0.5)
                logger.info("BlueSky server disconnected successfully")
            else:
                logger.info(
                    "User requested disconnection, but client was already disconnected"
                )

            return jsonify({"success": True, "message": "Disconnected from server"})
        except Exception as e:
            logger.info(f"Error disconnecting from server: {e}")
            return (
                jsonify({"success": False, "error": f"Failed to disconnect: {str(e)}"}),
                500,
            )

    @app.route("/health")
    def health_check():
        """Health check endpoint for Traefik - always returns 200 if Flask is running."""
        try:
            response_data = {
                "status": "healthy",
                "message": "Flask application is running",
                "timestamp": time.time(),
            }

            return jsonify(response_data), 200

        except Exception as e:
            return jsonify({"status": "unhealthy", "error": str(e)}), 503

    @app.route("/status")
    def status_check():
        """Status endpoint with capacity information - returns 503 when at capacity."""
        try:
            # Check BlueSky connectivity using the same approach as check_bluesky_running
            def is_port_listening(port):
                hostname = getattr(current_app.bluesky_proxy, "server_ip", "localhost")
                try:
                    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                    sock.settimeout(0.5)  # Quick check for status endpoint
                    result = sock.connect_ex((hostname, port))
                    sock.close()
                    return result == 0
                except:
                    return False

            # Check if BlueSky ports are accessible (same logic as server_control.py)
            port_11000_listening = is_port_listening(11000)
            port_11001_listening = is_port_listening(11001)
            bluesky_running = port_11000_listening or port_11001_listening

            # Additional check: if we have a proxy connection, see if it's receiving data
            proxy_connected = False
            has_active_nodes = False
            if hasattr(current_app, "bluesky_proxy"):
                proxy_connected = getattr(current_app.bluesky_proxy, "running", False)
                tracked_nodes = getattr(current_app.bluesky_proxy, "tracked_nodes", [])
                has_active_nodes = len(tracked_nodes) > 0

            # Get session information from session manager
            session_info = session_manager.get_session_info()

            response_data = {
                "status": "healthy",
                "bluesky_server": {
                    "ports_accessible": bluesky_running,
                    "port_11000": port_11000_listening,
                    "port_11001": port_11001_listening,
                    "proxy_connected": proxy_connected,
                    "has_active_nodes": has_active_nodes,
                },
                "session_info": session_info,
                "config": session_manager.get_config_info(),
                "timestamp": time.time(),
            }

            return jsonify(response_data), 200

        except Exception as e:
            return jsonify({"status": "unhealthy", "error": str(e)}), 503
