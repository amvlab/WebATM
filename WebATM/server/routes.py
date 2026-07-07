"""Basic Flask routes for WebATM.

Contains routes for the main page, simulation commands, server
configuration, health/status endpoints, and BlueSky file management
(uploads, listings, directory browsing, downloads, and deletion).
"""

import json
import os
import socket
import time
from pathlib import Path

from flask import current_app, jsonify, render_template, request, send_file
from werkzeug.utils import secure_filename

from ..logger import get_logger

logger = get_logger()


def get_webpack_assets():
    """Read the webpack manifest and build script tags in load order.

    Reads ``static/dist/manifest.json`` and returns one ``<script>`` tag per
    bundle — a single bundle in development builds, or the split
    runtime/vendor/app/main chunks in the correct order for production
    builds. Falls back to ``bundle.js`` when the manifest is missing or
    unreadable.

    Returns:
        list[str]: HTML ``<script>`` tags for the webpack bundles.
    """
    try:
        # Go up one level from server/ to WebATM/ to find static/
        manifest_path = (
            Path(__file__).parent.parent / "static" / "dist" / "manifest.json"
        )

        if not manifest_path.exists():
            # Fallback to single bundle.js if manifest doesn't exist
            return ['<script src="/static/dist/bundle.js"></script>']

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
            script_tags.append(f'<script src="/static/dist/{bundle_file}"></script>')
        else:
            # Production mode: split bundles - load in correct order
            chunk_order = ["runtime.js", "vendor.js", "app.js", "main.js"]

            for chunk_name in chunk_order:
                if chunk_name in manifest:
                    script_tags.append(
                        f'<script src="/static/dist/{manifest[chunk_name]}"></script>'
                    )

        return (
            script_tags
            if script_tags
            else ['<script src="/static/dist/bundle.js"></script>']
        )

    except Exception as e:
        logger.info(f"Error reading webpack manifest: {e}")
        # Fallback to single bundle.js
        return ['<script src="/static/dist/bundle.js"></script>']


def register_basic_routes(app, session_manager):
    """Register the basic Flask routes with the application.

    Args:
        app (Flask): Flask application instance.
        session_manager (SessionManager): Session manager used by the status
            endpoint for capacity information.
    """

    @app.route("/")
    def index():
        """Serve the main web interface page (GET /).

        Returns:
            The rendered ``index.html`` template with webpack script tags and
            the WebATM version, or a 500 error message on failure.
        """
        try:
            from .. import __version__

            webpack_scripts = get_webpack_assets()
            return render_template(
                "index.html",
                webpack_scripts=webpack_scripts,
                webatm_version=__version__,
            )
        except Exception as e:
            return f"Error loading page: {str(e)}", 500

    @app.route("/api/simulation/command", methods=["POST"])
    def send_command():
        """Send a stack command to the simulation (POST /api/simulation/command).

        Expects a JSON body with a ``command`` string, which is forwarded to
        the BlueSky proxy.

        Returns:
            JSON with ``success`` and the echoed ``command``, or a 500 error
            payload on failure.
        """
        try:
            command = request.json.get("command", "") if request.json else ""
            success = current_app.bluesky_proxy.send_command(command)
            return jsonify({"success": success, "command": command})
        except Exception:
            return jsonify({"error": "Failed to send command"}), 500

    @app.route("/api/server/config", methods=["GET"])
    def get_server_config():
        """Get the current server configuration (GET /api/server/config).

        Returns:
            JSON with the proxy's ``server_ip`` and ``is_connected`` state,
            or a 500 error payload on failure.
        """
        try:
            return jsonify(
                {
                    "server_ip": getattr(
                        current_app.bluesky_proxy, "server_ip", "localhost"
                    ),
                    "is_connected": getattr(
                        current_app.bluesky_proxy, "is_connected", False
                    ),
                }
            )
        except Exception:
            return jsonify({"error": "Failed to get server config"}), 500

    @app.route("/api/server/config", methods=["POST"])
    def update_server_config():
        """Update server config and reconnect (POST /api/server/config).

        Expects a JSON body with ``server_ip``. Tears down the existing
        BlueSky proxy completely (stop, close, delete, garbage-collect),
        creates a fresh proxy instance preserving the Socket.IO wiring,
        connects it to the requested server, re-registers the data
        subscribers, then waits up to 10 seconds for BlueSky nodes to be
        detected before confirming.

        Returns:
            JSON with ``success: True`` and the ``server_ip`` once nodes are
            detected, or a 500 error payload if the connection fails or no
            nodes appear before the timeout.
        """
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
        """Disconnect from the BlueSky server (POST /api/server/disconnect).

        Stops the proxy's client with the ``"manual"`` context; the BlueSky
        server itself is left running.

        Returns:
            JSON with ``success`` and a message, or a 500 error payload on
            failure.
        """
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

    @app.route("/api/aircraft/models", methods=["GET"])
    def get_aircraft_models():
        """List available 3D aircraft models (GET /api/aircraft/models).

        Scans ``static/models/aircraft`` for ``.gltf``/``.glb`` files and
        maps known filenames to friendly display names.

        Returns:
            JSON with ``models`` (filename, displayName, description,
            fileSize, isDefault) sorted with the default model first, or a
            404/500 error payload.
        """
        try:
            models_dir = Path(__file__).parent.parent / "static" / "models" / "aircraft"

            if not models_dir.exists():
                logger.warning("Aircraft models directory not found")
                return jsonify(
                    {
                        "success": False,
                        "error": "3D aircraft models directory not found",
                        "models": [],
                    }
                ), 404

            # Scan for supported model files
            supported_extensions = {".gltf", ".glb"}
            models = []

            for model_file in models_dir.iterdir():
                if (
                    model_file.is_file()
                    and model_file.suffix.lower() in supported_extensions
                ):
                    # Create display name from filename
                    display_name = model_file.stem

                    # Map common aircraft model names to better display names
                    display_name_map = {
                        "737": "Boeing 737",
                        "a320": "Airbus A320",
                        "drone": "Generic Drone",
                        "tie": "TIE Fighter",
                    }

                    if display_name.lower() in display_name_map:
                        display_name = display_name_map[display_name.lower()]

                    # Get file size
                    file_size = model_file.stat().st_size

                    models.append(
                        {
                            "filename": model_file.name,
                            "displayName": display_name,
                            "description": f"{display_name} 3D model",
                            "fileSize": file_size,
                            "isDefault": model_file.name == "737.gltf",
                        }
                    )

            # Sort by display name, but put default model first
            models.sort(key=lambda m: (not m["isDefault"], m["displayName"]))

            logger.debug(
                f"Found {len(models)} aircraft models: {[m['filename'] for m in models]}"
            )

            return jsonify({"success": True, "models": models, "count": len(models)})

        except Exception as e:
            logger.error(f"Error fetching aircraft models: {e}")
            return jsonify(
                {
                    "success": False,
                    "error": f"Failed to fetch aircraft models: {str(e)}",
                    "models": [],
                }
            ), 500

    @app.route("/api/navdata/search", methods=["GET"])
    def search_navdata():
        """Search airports and waypoints by identifier (GET /api/navdata/search).

        Powers the map "go to" box. Backed by the SQLite FTS5 index built
        offline from X-Plane data (see ``scripts/navdata/``). Query
        parameters:

        - ``q``: identifier/name prefix to match (required).
        - ``limit``: maximum results (default 10, capped at 50).
        - ``kind``: optional filter — ``airport``, ``heliport`` or
          ``waypoint``.

        Returns:
            JSON with ``results`` (kind, ident, name, lat, lon, rank, score,
            iata) ordered by exact match, kind, and importance; a 503 payload
            when the navdata index has not been built; or a 500 payload on
            search failure.
        """
        try:
            query = (request.args.get("q") or "").strip()
            if not query:
                return jsonify({"success": True, "results": []})

            limit = request.args.get("limit", type=int, default=10)
            limit = max(1, min(limit, 50))
            kind = request.args.get("kind")

            db_path = (
                Path(__file__).parent.parent / "static" / "navdata" / "navdata.sqlite"
            )
            if not db_path.exists():
                # Index hasn't been built yet - degrade gracefully so the UI
                # can show "navdata not available" rather than erroring.
                return jsonify(
                    {
                        "success": False,
                        "error": "navdata index not built",
                        "results": [],
                    }
                ), 503

            # Build a safe FTS5 prefix query: keep only alphanumeric tokens
            # (this also strips any FTS syntax the user might type) and turn
            # each into a prefix term so "heath" matches "Heathrow" and "kse"
            # matches "KSEA". Multiple tokens are implicitly AND-ed.
            import re

            tokens = re.findall(r"[A-Za-z0-9]+", query)
            if not tokens:
                return jsonify({"success": True, "results": []})
            match_expr = " ".join(f"{t}*" for t in tokens)

            import sqlite3

            # Open read-only so a concurrent rebuild can't be corrupted.
            conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
            try:
                conn.row_factory = sqlite3.Row
                sql = (
                    "SELECT n.kind, n.ident, n.name, n.lat, n.lon, n.score, n.rank, "
                    "n.iata, "
                    "(n.ident = ? COLLATE NOCASE) AS exact "
                    "FROM navaids_fts JOIN navaids n ON n.id = navaids_fts.rowid "
                    "WHERE navaids_fts MATCH ?"
                )
                params: list = [query, match_expr]
                if kind in ("airport", "heliport", "waypoint"):
                    sql += " AND n.kind = ?"
                    params.append(kind)
                # Exact ident match first, then a strict kind hierarchy
                # (airports, then heliports, then waypoints), then importance
                # (score), then FTS relevance and shorter idents.
                sql += (
                    " ORDER BY exact DESC, "
                    "CASE n.kind WHEN 'airport' THEN 0 "
                    "WHEN 'heliport' THEN 1 ELSE 2 END, "
                    "n.score DESC, navaids_fts.rank, length(n.ident) LIMIT ?"
                )
                params.append(limit)
                rows = conn.execute(sql, params).fetchall()
            finally:
                conn.close()

            results = [
                {
                    "kind": r["kind"],
                    "ident": r["ident"],
                    "name": r["name"],
                    "lat": r["lat"],
                    "lon": r["lon"],
                    "rank": r["rank"],
                    "score": r["score"],
                    "iata": r["iata"],
                }
                for r in rows
            ]
            return jsonify({"success": True, "results": results})

        except Exception as e:
            logger.error(f"Error searching navdata: {e}")
            return jsonify(
                {"success": False, "error": "navdata search failed", "results": []}
            ), 500

    @app.route("/health")
    def health_check():
        """Health check endpoint for Traefik (GET /health).

        Returns:
            A 200 JSON payload whenever Flask is running, or 503 with the
            error if the handler itself fails.
        """
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
        """Report server, BlueSky and session status (GET /status).

        Probes the BlueSky command/data ports (11000/11001) with a short
        socket timeout, inspects the proxy's connection state and tracked
        nodes, and includes session/capacity information from the session
        manager.

        Returns:
            A 200 JSON payload with ``bluesky_server``, ``session_info`` and
            ``config`` sections, or 503 with the error on failure.
        """
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
                except Exception:
                    return False

            # Check if BlueSky ports are accessible (same logic as server_control.py)
            port_11000_listening = is_port_listening(11000)
            port_11001_listening = is_port_listening(11001)
            bluesky_running = port_11000_listening or port_11001_listening

            # Additional check: if we have a proxy connection, see if it's receiving data
            proxy_running = False
            proxy_connected = False
            has_active_nodes = False
            if hasattr(current_app, "bluesky_proxy"):
                proxy_running = getattr(current_app.bluesky_proxy, "running", False)
                proxy_connected = getattr(
                    current_app.bluesky_proxy, "is_connected", False
                )
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
                    "proxy_running": proxy_running,
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

    # BlueSky File Upload System Routes

    @app.route("/api/bluesky/configure-base-path", methods=["POST"])
    def configure_bluesky_base_path():
        """Configure the BlueSky base directory (POST /api/bluesky/configure-base-path).

        Expects a JSON body with ``base_path``. Validates that the path
        exists, is a directory and is writable, stores it on the app, and
        creates the ``scenario/`` and ``plugins/`` subdirectories if needed.

        Returns:
            JSON with the accepted ``base_path`` and ``derived_paths``
            (scenario, plugins, settings, output), or a 400/500 error
            payload.
        """
        try:
            data = request.json if request.json else {}
            base_path = data.get("base_path", "").strip()

            if not base_path:
                return jsonify(
                    {"success": False, "error": "Base path is required"}
                ), 400

            # Normalize path for cross-platform compatibility
            path_obj = Path(base_path).expanduser().resolve()

            if not path_obj.exists():
                return jsonify(
                    {"success": False, "error": f"Path does not exist: {path_obj}"}
                ), 400

            if not path_obj.is_dir():
                return jsonify(
                    {"success": False, "error": f"Path is not a directory: {path_obj}"}
                ), 400

            # Check if writable (cross-platform)
            if not os.access(str(path_obj), os.W_OK):
                return jsonify(
                    {"success": False, "error": f"Path is not writable: {path_obj}"}
                ), 400

            # Store in app config (in production, consider using a database or session)
            current_app.bluesky_base_path = str(path_obj)

            # Create subdirectories if they don't exist
            scenario_dir = path_obj / "scenario"
            plugins_dir = path_obj / "plugins"

            try:
                scenario_dir.mkdir(exist_ok=True)
                plugins_dir.mkdir(exist_ok=True)
                logger.info(
                    f"BlueSky base path configured: {current_app.bluesky_base_path}"
                )

                return jsonify(
                    {
                        "success": True,
                        "base_path": current_app.bluesky_base_path,
                        "derived_paths": {
                            "scenario": str(scenario_dir),
                            "plugins": str(plugins_dir),
                            "settings": str(path_obj / "settings.cfg"),
                            "output": str(path_obj / "output"),
                        },
                    }
                )

            except Exception as e:
                return jsonify(
                    {
                        "success": False,
                        "error": f"Could not create subdirectories: {str(e)}",
                    }
                ), 500

        except Exception as e:
            logger.error(f"Error configuring BlueSky base path: {e}")
            return jsonify(
                {"success": False, "error": f"Failed to configure path: {str(e)}"}
            ), 500

    @app.route("/api/bluesky/upload/<file_type>", methods=["POST"])
    def upload_bluesky_file(file_type):
        """Upload a file to a BlueSky directory (POST /api/bluesky/upload/<file_type>).

        Accepts a multipart upload for one of the configured file types —
        ``scenario`` (``.scn``), ``plugins`` (``.py``) or ``settings``
        (``settings.cfg``). Validates the extension and size (50 MB for
        scenarios, 10 MB otherwise), sanitizes the filename, and
        auto-renames on conflicts for types that allow multiple files.

        Args:
            file_type (str): One of ``scenario``, ``plugins``, ``settings``.

        Returns:
            JSON with the stored ``filename`` and ``target_path``, or a
            400/500 error payload.
        """
        try:
            # Check if base path is configured
            if not hasattr(current_app, "bluesky_base_path"):
                return jsonify(
                    {"success": False, "error": "BlueSky base path not configured"}
                ), 400

            base_path = Path(current_app.bluesky_base_path)

            # Validate file type
            file_type_config = {
                "scenario": {
                    "extension": ".scn",
                    "directory": "scenario",
                    "allow_multiple": True,
                },
                "plugins": {
                    "extension": ".py",
                    "directory": "plugins",
                    "allow_multiple": True,
                },
                "settings": {
                    "extension": ".cfg",
                    "filepath": "settings.cfg",
                    "allow_multiple": False,
                },
            }

            if file_type not in file_type_config:
                return jsonify(
                    {"success": False, "error": f"Invalid file type: {file_type}"}
                ), 400

            # Check if file is present
            if "file" not in request.files:
                return jsonify({"success": False, "error": "No file provided"}), 400

            file = request.files["file"]
            if file.filename == "":
                return jsonify({"success": False, "error": "No file selected"}), 400

            config = file_type_config[file_type]

            # Validate file extension
            if not file.filename.lower().endswith(config["extension"]):
                return jsonify(
                    {
                        "success": False,
                        "error": f"Invalid file extension. Expected {config['extension']}",
                    }
                ), 400

            # File size validation (max 50MB for scenario files, 10MB for others)
            max_size = (
                50 * 1024 * 1024 if file_type == "scenario" else 10 * 1024 * 1024
            )  # 50MB or 10MB
            file.seek(0, 2)  # Seek to end of file
            file_size = file.tell()
            file.seek(0)  # Reset file pointer

            if file_size > max_size:
                max_size_mb = max_size // (1024 * 1024)
                return jsonify(
                    {
                        "success": False,
                        "error": f"File too large. Maximum size: {max_size_mb}MB",
                    }
                ), 400

            # Secure filename (cross-platform)
            filename = secure_filename(file.filename)
            if not filename:
                return jsonify({"success": False, "error": "Invalid filename"}), 400

            # Determine target path
            if file_type == "settings":
                target_path = base_path / config["filepath"]
            else:
                target_dir = base_path / config["directory"]
                target_dir.mkdir(exist_ok=True)

                # Handle filename conflicts for multiple files
                if config["allow_multiple"]:
                    counter = 1
                    original_path = target_dir / filename
                    target_path = original_path

                    while target_path.exists():
                        name_part = Path(filename).stem
                        ext_part = Path(filename).suffix
                        new_filename = f"{name_part}_{counter}{ext_part}"
                        target_path = target_dir / new_filename
                        counter += 1

                    if target_path != original_path:
                        filename = target_path.name
                else:
                    target_path = target_dir / filename

            # Save file (cross-platform compatible)
            file.save(str(target_path))

            logger.info(f"File uploaded successfully: {target_path}")

            return jsonify(
                {
                    "success": True,
                    "filename": filename,
                    "file_type": file_type,
                    "target_path": str(target_path),
                    "message": f"{file_type.title()} file uploaded successfully",
                }
            )

        except Exception as e:
            logger.error(f"Error uploading {file_type} file: {e}")
            return jsonify(
                {"success": False, "error": f"Failed to upload file: {str(e)}"}
            ), 500

    @app.route("/api/bluesky/list/<file_type>", methods=["GET"])
    def list_bluesky_files(file_type):
        """List files in a BlueSky directory (GET /api/bluesky/list/<file_type>).

        Lists folders and files (extension matched case-insensitively) for
        ``scenario``, ``plugins``, ``settings`` or ``output``.

        Args:
            file_type (str): One of ``scenario``, ``plugins``, ``settings``,
                ``output``.

        Returns:
            JSON with ``files`` entries (filename, size, modified, type),
            or a 400/500 error payload.
        """
        try:
            # Check if base path is configured
            if not hasattr(current_app, "bluesky_base_path"):
                return jsonify(
                    {"success": False, "error": "BlueSky base path not configured"}
                ), 400

            base_path = Path(current_app.bluesky_base_path)

            # Validate file type
            file_type_config = {
                "scenario": {"extension": ".scn", "directory": "scenario"},
                "plugins": {"extension": ".py", "directory": "plugins"},
                "settings": {"extension": ".cfg", "filepath": "settings.cfg"},
                "output": {"extension": "", "directory": "output"},
            }

            if file_type not in file_type_config:
                return jsonify(
                    {"success": False, "error": f"Invalid file type: {file_type}"}
                ), 400

            config = file_type_config[file_type]
            files = []

            if file_type == "settings":
                settings_path = base_path / config["filepath"]
                if settings_path.exists():
                    stat_info = settings_path.stat()
                    files.append(
                        {
                            "filename": "settings.cfg",
                            "size": stat_info.st_size,
                            "modified": stat_info.st_mtime,
                            "type": "file",
                        }
                    )
            else:
                target_dir = base_path / config["directory"]
                if target_dir.exists():
                    # Add folders first
                    for folder_path in target_dir.iterdir():
                        if folder_path.is_dir():
                            stat_info = folder_path.stat()
                            files.append(
                                {
                                    "filename": folder_path.name,
                                    "size": 0,  # Folders don't have a meaningful size
                                    "modified": stat_info.st_mtime,
                                    "type": "folder",
                                }
                            )

                    # Add files. Match the extension case-insensitively so
                    # uppercase variants (e.g. .SCN from BlueSky's bundled demo
                    # scenarios) are listed too -- Path.glob is case-sensitive.
                    if config["extension"]:
                        ext = config["extension"].lower()
                        file_iter = (
                            p for p in target_dir.iterdir() if p.suffix.lower() == ext
                        )
                    else:
                        file_iter = target_dir.iterdir()
                    for file_path in file_iter:
                        if file_path.is_file():
                            stat_info = file_path.stat()
                            files.append(
                                {
                                    "filename": file_path.name,
                                    "size": stat_info.st_size,
                                    "modified": stat_info.st_mtime,
                                    "type": "file",
                                }
                            )

            return jsonify(
                {
                    "success": True,
                    "file_type": file_type,
                    "files": files,
                    "base_path": str(base_path),
                }
            )

        except Exception as e:
            logger.error(f"Error listing {file_type} files: {e}")
            return jsonify(
                {"success": False, "error": f"Failed to list files: {str(e)}"}
            ), 500

    @app.route("/api/bluesky/browse/<file_type>", methods=["GET"])
    @app.route("/api/bluesky/browse/<file_type>/<path:subpath>", methods=["GET"])
    def browse_bluesky_directory(file_type, subpath=""):
        """Browse a BlueSky directory tree (GET /api/bluesky/browse/<file_type>[/<subpath>]).

        Like the list endpoint but with subdirectory navigation and
        breadcrumbs. The subpath is sanitized (no ``..`` components) and
        resolved paths are verified to stay inside the allowed base
        directory to prevent traversal.

        Args:
            file_type (str): One of ``scenario``, ``plugins``, ``settings``,
                ``output``.
            subpath (str): Optional subdirectory path below the file type's
                base directory.

        Returns:
            JSON with ``files``, ``current_path`` and ``breadcrumbs``, or a
            400/403/500 error payload.
        """
        try:
            # Check if base path is configured
            if not hasattr(current_app, "bluesky_base_path"):
                return jsonify(
                    {"success": False, "error": "BlueSky base path not configured"}
                ), 400

            base_path = Path(current_app.bluesky_base_path)

            # Validate file type
            file_type_config = {
                "scenario": {"extension": ".scn", "directory": "scenario"},
                "plugins": {"extension": ".py", "directory": "plugins"},
                "settings": {"extension": ".cfg", "filepath": "settings.cfg"},
                "output": {"extension": "", "directory": "output"},
            }

            if file_type not in file_type_config:
                return jsonify(
                    {"success": False, "error": f"Invalid file type: {file_type}"}
                ), 400

            config = file_type_config[file_type]

            # For settings, just return the single file (no directory browsing)
            if file_type == "settings":
                files = []
                settings_path = base_path / config["filepath"]
                if settings_path.exists():
                    stat_info = settings_path.stat()
                    files.append(
                        {
                            "filename": "settings.cfg",
                            "size": stat_info.st_size,
                            "modified": stat_info.st_mtime,
                            "type": "file",
                        }
                    )

                return jsonify(
                    {
                        "success": True,
                        "file_type": file_type,
                        "files": files,
                        "current_path": "",
                        "breadcrumbs": [],
                        "base_path": str(base_path),
                    }
                )

            # Build the target directory path
            target_base = base_path / config["directory"]

            # Clean and validate the subpath to prevent directory traversal attacks
            if subpath:
                # Normalize the path and remove any .. components
                normalized_subpath = Path(subpath).as_posix()
                # Split into parts and filter out dangerous components
                path_parts = [
                    part
                    for part in normalized_subpath.split("/")
                    if part and part != "." and part != ".."
                ]

                if path_parts:
                    target_dir = target_base
                    for part in path_parts:
                        target_dir = target_dir / part
                else:
                    target_dir = target_base
            else:
                target_dir = target_base

            # Security check: ensure the target directory is within the allowed
            # base. Resolve symlinks first, then compare on path components
            # (not string prefixes, which would wrongly accept a sibling like
            # ".../scenario_evil").
            try:
                resolved_target = target_dir.resolve()
                resolved_base = target_base.resolve()

                if not resolved_target.is_relative_to(resolved_base):
                    return jsonify(
                        {
                            "success": False,
                            "error": "Access denied: Path outside allowed directory",
                        }
                    ), 403

            except (OSError, ValueError):
                return jsonify({"success": False, "error": "Invalid path"}), 400

            files = []
            current_path_parts = []

            if target_dir.exists() and target_dir.is_dir():
                # Calculate the current path relative to the base directory
                try:
                    relative_path = target_dir.relative_to(target_base)
                    if relative_path != Path("."):
                        current_path_parts = list(relative_path.parts)
                except ValueError:
                    # If we can't calculate relative path, something is wrong
                    return jsonify(
                        {"success": False, "error": "Invalid path structure"}
                    ), 400

                # Add folders first
                for folder_path in target_dir.iterdir():
                    if folder_path.is_dir():
                        stat_info = folder_path.stat()
                        files.append(
                            {
                                "filename": folder_path.name,
                                "size": 0,  # Folders don't have a meaningful size
                                "modified": stat_info.st_mtime,
                                "type": "folder",
                            }
                        )

                # Add files. Match the extension case-insensitively so uppercase
                # variants (e.g. .SCN from BlueSky's bundled demo scenarios) are
                # listed too -- Path.glob is case-sensitive.
                if config["extension"]:
                    ext = config["extension"].lower()
                    file_iter = (
                        p for p in target_dir.iterdir() if p.suffix.lower() == ext
                    )
                else:
                    file_iter = target_dir.iterdir()
                for file_path in file_iter:
                    if file_path.is_file():
                        stat_info = file_path.stat()
                        files.append(
                            {
                                "filename": file_path.name,
                                "size": stat_info.st_size,
                                "modified": stat_info.st_mtime,
                                "type": "file",
                            }
                        )

            # Build breadcrumbs for navigation
            breadcrumbs = []
            breadcrumb_path = ""

            # Add root breadcrumb
            breadcrumbs.append({"name": config["directory"], "path": ""})

            # Add intermediate breadcrumbs
            for i, part in enumerate(current_path_parts):
                if i == 0:
                    breadcrumb_path = part
                else:
                    breadcrumb_path = f"{breadcrumb_path}/{part}"

                breadcrumbs.append({"name": part, "path": breadcrumb_path})

            current_path = "/".join(current_path_parts) if current_path_parts else ""

            return jsonify(
                {
                    "success": True,
                    "file_type": file_type,
                    "files": files,
                    "current_path": current_path,
                    "breadcrumbs": breadcrumbs,
                    "base_path": str(base_path),
                }
            )

        except Exception as e:
            logger.error(f"Error browsing {file_type} directory: {e}")
            return jsonify(
                {"success": False, "error": f"Failed to browse directory: {str(e)}"}
            ), 500

    def _validate_output_path(filepath):
        """Validate and resolve a filepath within the output directory.

        Sanitizes the path (no ``..`` components) and verifies the resolved
        target stays inside the output directory and points to an existing
        file.

        Args:
            filepath (str): Requested path relative to the output directory.

        Returns:
            tuple: ``(resolved_path, error_response)``. On failure
                ``resolved_path`` is None and ``error_response`` holds the
                Flask (json, status) response to return.
        """
        if not hasattr(current_app, "bluesky_base_path"):
            return None, (
                jsonify(
                    {"success": False, "error": "BlueSky base path not configured"}
                ),
                400,
            )

        base_path = Path(current_app.bluesky_base_path)
        output_base = base_path / "output"

        # Clean and validate the path
        normalized = Path(filepath).as_posix()
        path_parts = [
            part
            for part in normalized.split("/")
            if part and part != "." and part != ".."
        ]

        if not path_parts:
            return None, (
                jsonify({"success": False, "error": "No file specified"}),
                400,
            )

        target = output_base
        for part in path_parts:
            target = target / part

        # Security check: resolve symlinks, then verify containment by path
        # components rather than string prefix (which would accept a sibling
        # like ".../output_evil").
        try:
            resolved_target = target.resolve()
            resolved_base = output_base.resolve()
            if not resolved_target.is_relative_to(resolved_base):
                return None, (
                    jsonify(
                        {
                            "success": False,
                            "error": "Access denied: Path outside allowed directory",
                        }
                    ),
                    403,
                )
        except (OSError, ValueError):
            return None, (
                jsonify({"success": False, "error": "Invalid path"}),
                400,
            )

        if not resolved_target.exists() or not resolved_target.is_file():
            return None, (
                jsonify({"success": False, "error": "File not found"}),
                404,
            )

        return resolved_target, None

    @app.route("/api/bluesky/output/download/<path:filepath>", methods=["GET"])
    def download_output_file(filepath):
        """Download an output file (GET /api/bluesky/output/download/<filepath>).

        Args:
            filepath (str): Path of the file relative to the output
                directory; validated against traversal.

        Returns:
            The file as an attachment, or a 400/403/404/500 error payload.
        """
        try:
            resolved_path, error = _validate_output_path(filepath)
            if error:
                return error

            return send_file(
                resolved_path,
                as_attachment=True,
                download_name=resolved_path.name,
            )

        except Exception as e:
            logger.error(f"Error downloading output file: {e}")
            return jsonify(
                {"success": False, "error": f"Failed to download file: {str(e)}"}
            ), 500

    @app.route("/api/bluesky/output/content/<path:filepath>", methods=["GET"])
    def get_output_file_content(filepath):
        """Read output-file content (GET /api/bluesky/output/content/<filepath>).

        Supports log streaming: with ``offset`` > 0 the file is read
        incrementally from that byte offset to the end; with offset 0 the
        last ``lines`` lines are tailed for the initial load. Query
        parameters:

        - ``offset``: byte offset to read from (0 = tail mode).
        - ``lines``: maximum lines for the initial tail load (default 200).

        Args:
            filepath (str): Path of the file relative to the output
                directory; validated against traversal.

        Returns:
            JSON with ``content``, the new ``offset``, ``total_size`` and
            ``filename``, or a 400/403/404/500 error payload.
        """
        try:
            resolved_path, error = _validate_output_path(filepath)
            if error:
                return error

            offset = request.args.get("offset", type=int, default=0)
            max_lines = request.args.get("lines", type=int, default=200)
            file_size = resolved_path.stat().st_size

            if offset > 0:
                # Incremental read from offset to end
                with open(resolved_path, errors="replace") as f:
                    f.seek(min(offset, file_size))
                    content = f.read()
                    new_offset = f.tell()
            else:
                # Initial load: tail the last N lines
                with open(resolved_path, errors="replace") as f:
                    all_lines = f.readlines()
                    tail_lines = all_lines[-max_lines:]
                    content = "".join(tail_lines)
                    new_offset = f.tell()

            return jsonify(
                {
                    "success": True,
                    "content": content,
                    "offset": new_offset,
                    "total_size": file_size,
                    "filename": resolved_path.name,
                }
            )

        except Exception as e:
            logger.error(f"Error reading output file content: {e}")
            return jsonify(
                {"success": False, "error": f"Failed to read file: {str(e)}"}
            ), 500

    @app.route("/api/bluesky/<file_type>/<filename>", methods=["DELETE"])
    def delete_bluesky_file(file_type, filename):
        """Delete a BlueSky file (DELETE /api/bluesky/<file_type>/<filename>).

        Args:
            file_type (str): One of ``scenario``, ``plugins``, ``settings``.
                For ``settings`` only ``settings.cfg`` may be deleted.
            filename (str): Name of the file to delete (sanitized).

        Returns:
            JSON confirming the deletion, or a 400/404/500 error payload.
        """
        try:
            # Check if base path is configured
            if not hasattr(current_app, "bluesky_base_path"):
                return jsonify(
                    {"success": False, "error": "BlueSky base path not configured"}
                ), 400

            base_path = Path(current_app.bluesky_base_path)

            # Validate file type
            file_type_config = {
                "scenario": {"directory": "scenario"},
                "plugins": {"directory": "plugins"},
                "settings": {"filepath": "settings.cfg"},
            }

            if file_type not in file_type_config:
                return jsonify(
                    {"success": False, "error": f"Invalid file type: {file_type}"}
                ), 400

            # Secure filename
            secure_name = secure_filename(filename)
            if not secure_name:
                return jsonify({"success": False, "error": "Invalid filename"}), 400

            config = file_type_config[file_type]

            # Determine target path
            if file_type == "settings":
                if filename != "settings.cfg":
                    return jsonify(
                        {"success": False, "error": "Can only delete settings.cfg"}
                    ), 400
                target_path = base_path / config["filepath"]
            else:
                target_dir = base_path / config["directory"]
                target_path = target_dir / secure_name

            # Check if file exists
            if not target_path.exists():
                return jsonify(
                    {"success": False, "error": f"File not found: {filename}"}
                ), 404

            # Delete file
            target_path.unlink()

            logger.info(f"File deleted successfully: {target_path}")

            return jsonify(
                {
                    "success": True,
                    "filename": filename,
                    "file_type": file_type,
                    "message": f"{file_type.title()} file deleted successfully",
                }
            )

        except Exception as e:
            logger.error(f"Error deleting {file_type} file: {e}")
            return jsonify(
                {"success": False, "error": f"Failed to delete file: {str(e)}"}
            ), 500

    @app.route("/api/bluesky/filestatus", methods=["GET"])
    def get_bluesky_file_status():
        """Get file-management configuration status (GET /api/bluesky/filestatus).

        Returns:
            JSON with ``configured``, the ``base_path`` and its
            ``derived_paths``, plus existence/writability flags, or a 500
            error payload.
        """
        try:
            if not hasattr(current_app, "bluesky_base_path"):
                return jsonify(
                    {"configured": False, "base_path": None, "derived_paths": {}}
                )

            base_path = Path(current_app.bluesky_base_path)

            return jsonify(
                {
                    "configured": True,
                    "base_path": str(base_path),
                    "derived_paths": {
                        "scenario": str(base_path / "scenario"),
                        "plugins": str(base_path / "plugins"),
                        "settings": str(base_path / "settings.cfg"),
                        "output": str(base_path / "output"),
                    },
                    "path_exists": base_path.exists(),
                    "path_writable": os.access(str(base_path), os.W_OK)
                    if base_path.exists()
                    else False,
                }
            )

        except Exception as e:
            logger.error(f"Error getting BlueSky file status: {e}")
            return jsonify(
                {"success": False, "error": f"Failed to get status: {str(e)}"}
            ), 500
