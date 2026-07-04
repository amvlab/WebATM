"""Provide BlueSky server status monitoring routes.

This module checks whether a BlueSky server is reachable by probing its
command (11000) and data (11001) ports, and registers the Flask route that
exposes this status to the web client.
"""

import socket

from flask import jsonify, request

from ..logger import get_logger

logger = get_logger()


def is_port_listening(port: int, timeout: float = 1.0, hostname: str = None) -> bool:
    """Check if a TCP port is listening for connections.

    Args:
        port (int): Port number to check.
        timeout (float): Connection timeout in seconds.
        hostname (str): Hostname to check. Defaults to ``localhost`` when
            ``None``.

    Returns:
        bool: True if the port is listening, False otherwise.
    """
    if hostname is None:
        hostname = "localhost"

    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(timeout)
        result = sock.connect_ex((hostname, port))
        sock.close()
        return result == 0
    except Exception:
        return False


def check_bluesky_running() -> tuple[bool, str]:
    """Check if a local BlueSky server is running.

    Probes the BlueSky command (11000) and data (11001) ports on localhost; the
    server is considered running when at least one port is listening.

    Returns:
        tuple[bool, str]: A ``(is_running, status_message)`` pair, where the
            message lists the listening ports or explains that the server is
            not accessible.
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
    """Register BlueSky server status routes with the Flask app.

    Args:
        app (Flask): Flask application instance.
    """

    @app.route("/api/server/status", methods=["GET", "POST"])
    def get_server_status():
        """Report whether the BlueSky server is reachable.

        Handles ``GET``/``POST /api/server/status``. Accepts an optional
        ``hostname`` via query string (GET) or JSON body (POST); when omitted,
        falls back to the proxy's currently configured server IP, then to
        ``localhost``. Probes the BlueSky command (11000) and data (11001)
        ports on that host.

        Returns:
            Response: JSON with ``status`` (``"success"``), ``running`` (bool),
                ``message`` (listening ports or failure reason), and
                ``hostname`` (the host that was probed). On unexpected errors,
                JSON with ``status`` (``"error"``) and ``message``, with HTTP
                500.
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
