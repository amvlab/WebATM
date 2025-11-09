"""
BlueSky server status routes.

This module handles the  monitoring BlueSky servers.
"""

import socket

from flask import jsonify, request

from ..logger import get_logger

logger = get_logger()


def is_port_listening(port: int, timeout: float = 1.0, hostname: str = None) -> bool:
    """
    Check if a port is listening for connections.

    Args:
        port: Port number to check
        hostname: Hostname to check (defaults to localhost)
        timeout: Connection timeout in seconds

    Returns:
        bool: True if port is listening, False otherwise
    """
    if hostname is None:
        hostname = "localhost"

    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(timeout)
        result = sock.connect_ex((hostname, port))
        sock.close()
        return result == 0
    except:
        return False


def check_bluesky_running() -> tuple[bool, str]:
    """
    Check if BlueSky server is running with improved reliability.

    Returns:
        tuple: (is_running, status_message)
    """

    # Check if BlueSky ports are accessible (same logic as routes.py)
    port_11000_listening = is_port_listening(11000, 0.5)  # Use consistent timeout
    port_11001_listening = is_port_listening(11001, 0.5)  # Use consistent timeout

    if port_11000_listening or port_11001_listening:
        # At least one BlueSky port is listening - server is functional
        ports_info = []
        if port_11000_listening:
            ports_info.append("11000")
        if port_11001_listening:
            ports_info.append("11001")

        return True, f"Server running (Ports: {', '.join(ports_info)})"
    else:
        # No ports are accessible - server is not running or not ready
        return False, "Server not accessible (Ports not listening)"


def register_server_status_routes(app):
    """
    Register BlueSky server status routes with the Flask app.

    Args:
        app: Flask application instance
    """

    @app.route("/api/server/status", methods=["GET", "POST"])
    def get_server_status():
        """
        Get current server status with improved reliability.
        Accepts optional hostname parameter via query string (GET) or JSON body (POST).
        If no hostname provided, uses the currently configured server.
        """
        try:
            # Get hostname from request (supports both GET query param and POST JSON body)
            hostname = None

            if request.method == "POST" and request.json:
                hostname = request.json.get("hostname")
            elif request.method == "GET":
                hostname = request.args.get("hostname")

            # If no hostname specified, use current server IP from proxy
            if not hostname:
                from flask import current_app
                hostname = getattr(current_app.bluesky_proxy, "server_ip", None)

            # If still no hostname, default to localhost
            if not hostname:
                hostname = "localhost"

            # Check both BlueSky ports
            port_11000_listening = is_port_listening(11000, 0.5, hostname)
            port_11001_listening = is_port_listening(11001, 0.5, hostname)
            running = port_11000_listening or port_11001_listening

            if running:
                # At least one BlueSky port is listening - server is functional
                ports_info = []
                if port_11000_listening:
                    ports_info.append("11000")
                if port_11001_listening:
                    ports_info.append("11001")
                message = f"Server running (Ports: {', '.join(ports_info)})"
            else:
                # No ports are accessible - server is not running or not ready
                message = "Server not accessible (Ports not listening)"

            return jsonify(
                {
                    "status": "success",
                    "running": running,
                    "message": message,
                    "hostname": hostname,
                }
            )
        except Exception as e:
            return jsonify({"status": "error", "message": str(e)}), 500
