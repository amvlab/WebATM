"""Provide BlueSky server status monitoring routes.

This module checks whether a BlueSky server is reachable by probing its
command (11000) and data (11001) ports, and registers the Flask route that
exposes this status to the web client.
"""

import socket

from flask import current_app, jsonify, request

from ..logger import get_logger

logger = get_logger()

# BlueSky's fixed command and data ports (not configurable, per project docs).
BLUESKY_PORTS = (11000, 11001)


def is_port_listening(
    port: int, timeout: float = 1.0, hostname: str | None = None
) -> bool:
    """Check if a TCP port is listening for connections.

    Args:
        port (int): Port number to check.
        timeout (float): Connection timeout in seconds.
        hostname (str | None): Hostname to check. Defaults to ``localhost``
            when ``None``.

    Returns:
        bool: True if the port is listening, False otherwise.
    """
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.settimeout(timeout)
            return sock.connect_ex((hostname or "localhost", port)) == 0
    except OSError:
        # e.g. DNS failure (socket.gaierror) for an unresolvable hostname;
        # the context manager still closes the socket.
        return False


def probe_bluesky_ports(
    hostname: str | None = None, timeout: float = 0.5
) -> tuple[list[int], str]:
    """Probe the BlueSky ports and summarize the result.

    The server is considered running when at least one port is listening.

    Args:
        hostname (str | None): Host to probe. Defaults to ``localhost`` when
            ``None``.
        timeout (float): Per-port connection timeout in seconds.

    Returns:
        tuple[list[int], str]: The listening ports (empty when none) and a
            human-readable status message.
    """
    listening = [p for p in BLUESKY_PORTS if is_port_listening(p, timeout, hostname)]
    if listening:
        message = f"Server running (Ports: {', '.join(map(str, listening))})"
    else:
        message = "Server not accessible (Ports not listening)"
    return listening, message


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
            if request.method == "POST":
                hostname = (request.get_json(silent=True) or {}).get("hostname")
            else:
                hostname = request.args.get("hostname")

            if not hostname:
                hostname = getattr(current_app.bluesky_proxy, "server_ip", None)
            if not hostname:
                hostname = "localhost"

            listening, message = probe_bluesky_ports(hostname)
            return jsonify(
                {
                    "status": "success",
                    "running": bool(listening),
                    "message": message,
                    "hostname": hostname,
                }
            )
        except Exception as e:
            return jsonify({"status": "error", "message": str(e)}), 500
