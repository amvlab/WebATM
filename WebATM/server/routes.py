"""Basic Flask routes for WebATM.

Contains routes for the main page, simulation commands, server
configuration, health/status endpoints, and BlueSky file management
(uploads, listings, directory browsing, downloads, and deletion).
"""

import json
import os
import re
import sqlite3
import time
from pathlib import Path

from flask import current_app, jsonify, render_template, request, send_file
from werkzeug.utils import secure_filename

from ..logger import get_logger
from .bluesky_server_status import probe_bluesky_ports

logger = get_logger()

# The file types managed by the /api/bluesky/ file routes. Directory types hold
# many files under base_path/<directory>; "settings" is the single settings.cfg
# file next to them. "output" is read-only: it is listable/browsable but not a
# valid upload or delete target.
FILE_TYPES = {
    "scenario": {"extension": ".scn", "directory": "scenario"},
    "plugins": {"extension": ".py", "directory": "plugins"},
    "settings": {"extension": ".cfg", "filepath": "settings.cfg"},
    "output": {"extension": "", "directory": "output"},
}
WRITABLE_FILE_TYPES = ("scenario", "plugins", "settings")

# Subdirectories pre-created under a configured base path so browsing works
# before BlueSky's first start (BlueSky itself maintains the same set in its
# working directory). Shared with the integrated build's auto-configuration.
MANAGED_SUBDIRS = ("scenario", "plugins", "output")

# Offline-built SQLite FTS index behind /api/navdata/search (see
# script/navdata/). Module-level so tests can point it at a fixture DB.
NAVDATA_DB = Path(__file__).parent.parent / "static" / "navdata" / "navdata.sqlite"


def _derived_paths(base_path):
    """Return the managed paths under a configured base directory.

    Args:
        base_path (Path): Configured BlueSky base directory.

    Returns:
        dict[str, str]: Scenario/plugins/settings/output paths as strings.
    """
    return {
        "scenario": str(base_path / "scenario"),
        "plugins": str(base_path / "plugins"),
        "settings": str(base_path / "settings.cfg"),
        "output": str(base_path / "output"),
    }


def _clean_parts(subpath):
    """Split a requested subpath into components, dropping ``.``/``..`` parts.

    Args:
        subpath (str): Requested path relative to a managed directory.

    Returns:
        list[str]: The safe path components (may be empty).
    """
    return [
        part
        for part in Path(subpath).as_posix().split("/")
        if part and part not in (".", "..")
    ]


def _resolve_under(directory, subpath):
    """Resolve ``subpath`` under ``directory``, rejecting escapes.

    Resolves symlinks and verifies the result stays inside ``directory`` by
    path components (not string prefixes, which would wrongly accept a sibling
    like ``.../scenario_evil``). The resolved path need not exist — callers do
    their own existence checks.

    Args:
        directory (Path): Managed base directory the path must stay inside.
        subpath (str): Requested path relative to that directory.

    Returns:
        tuple: ``(resolved_path, error_response)``; exactly one is None. The
            error is a Flask ``(json, status)`` pair ready to return.
    """
    target = directory.joinpath(*_clean_parts(subpath))
    try:
        resolved_target = target.resolve()
        if not resolved_target.is_relative_to(directory.resolve()):
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
        return None, (jsonify({"success": False, "error": "Invalid path"}), 400)
    return resolved_target, None


def _dir_entries(target_dir, extension):
    """List a managed directory for the browse endpoint, folders first.

    Folders and files are each sorted by name (case-insensitively) —
    ``iterdir`` yields raw filesystem order, which is effectively random.
    Files are matched on ``extension`` case-insensitively — BlueSky's bundled
    demo scenarios use uppercase ``.SCN`` — or unfiltered when ``extension``
    is empty (the ``output`` type).

    Args:
        target_dir (Path): Directory to list; missing directories yield [].
        extension (str): Required file suffix including the dot, or "".

    Returns:
        list[dict]: Entries with ``filename``, ``size``, ``modified``, ``type``.
    """
    folders = []
    files = []
    if not target_dir.is_dir():
        return []
    ext = extension.lower()
    for path in target_dir.iterdir():
        if path.is_dir():
            folders.append(
                {
                    "filename": path.name,
                    "size": 0,
                    "modified": path.stat().st_mtime,
                    "type": "folder",
                }
            )
        elif path.is_file() and (not ext or path.suffix.lower() == ext):
            stat_info = path.stat()
            files.append(
                {
                    "filename": path.name,
                    "size": stat_info.st_size,
                    "modified": stat_info.st_mtime,
                    "type": "file",
                }
            )

    def by_name(entry):
        return entry["filename"].lower()

    return sorted(folders, key=by_name) + sorted(files, key=by_name)


def _split_incomplete_utf8(data):
    """Split off an incomplete trailing UTF-8 sequence from ``data``.

    A log poll can catch the writer mid-character; the held-back bytes are
    re-read whole on the next poll instead of being decoded as replacement
    characters twice.

    Args:
        data (bytes): Chunk read up to end-of-file.

    Returns:
        tuple[bytes, bytes]: ``(complete, held_back)``; ``held_back`` is empty
            unless ``data`` ends inside a multi-byte character.
    """
    for i in range(1, min(3, len(data)) + 1):
        byte = data[-i]
        if byte >= 0xC0:  # lead byte of a 2-4 byte sequence
            seq_len = 2 if byte < 0xE0 else 3 if byte < 0xF0 else 4
            if seq_len > i:
                return data[:-i], data[-i:]
            break
        if byte < 0x80:  # ASCII, nothing pending
            break
    return data, b""


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
    fallback = ['<script src="/static/dist/bundle.js"></script>']
    manifest_path = Path(__file__).parent.parent / "static" / "dist" / "manifest.json"
    try:
        with open(manifest_path) as f:
            manifest = json.load(f)
    except FileNotFoundError:
        return fallback
    except Exception as e:
        logger.info(f"Error reading webpack manifest: {e}")
        return fallback

    # Split production bundles must load in this order; a development
    # manifest simply only contains main.js.
    chunk_order = ("runtime.js", "vendor.js", "app.js", "main.js")
    script_tags = [
        f'<script src="/static/dist/{manifest[chunk]}"></script>'
        for chunk in chunk_order
        if chunk in manifest
    ]
    return script_tags or fallback


def register_basic_routes(app, session_manager):
    """Register the basic Flask routes with the application.

    Args:
        app (Flask): Flask application instance.
        session_manager (SessionManager): Session manager used by the status
            endpoint for session counts.
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
            command = (request.get_json(silent=True) or {}).get("command", "")
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
        BlueSky proxy, creates a fresh proxy instance preserving the
        Socket.IO wiring, connects it to the requested server, re-registers
        the data subscribers, then waits up to 10 seconds for BlueSky nodes
        to be detected before confirming.

        Returns:
            JSON with ``success: True`` and the ``server_ip`` once nodes are
            detected, or a 500 error payload if the connection fails or no
            nodes appear before the timeout.
        """
        try:
            data = request.get_json(silent=True) or {}
            server_ip = data.get("server_ip", "localhost").strip() or "localhost"
            logger.info(f"User requested connection to BlueSky server at {server_ip}")

            from ..proxy import (
                BlueSkyProxy,
                connect_lock,
                register_subscribers,
                set_bluesky_proxy,
            )

            # Every (re)connect gets a fresh proxy — recreating the ZMQ client
            # is the reliable way to shed half-dead connection state; only the
            # Socket.IO wiring carries over. The old proxy is replaced in place
            # so concurrent requests always find a usable proxy, and the swap
            # runs under connect_lock so the integrated auto-start (or another
            # connect request) can't revive the proxy being torn down.
            with connect_lock:
                old_proxy = getattr(current_app, "bluesky_proxy", None)
                if old_proxy is not None:
                    if old_proxy.running:
                        old_proxy.stop_client()
                        time.sleep(0.3)  # let ZMQ teardown settle before reconnecting
                    old_proxy.close()

                proxy = BlueSkyProxy()
                proxy.socketio = old_proxy.socketio if old_proxy else None
                proxy.connected_clients = (
                    old_proxy.connected_clients if old_proxy else 0
                )
                current_app.bluesky_proxy = proxy
                set_bluesky_proxy(proxy)  # update the global the subscribers use

                proxy.server_ip = server_ip
                proxy.start_client(hostname=server_ip)
                # Subscribers attach to the client start_client just created.
                register_subscribers(proxy)

            # Confirm the server is real: wait for node detection.
            timeout = 10.0
            start_time = time.time()
            while time.time() - start_time < timeout:
                if len(proxy.tracked_nodes) > 0:
                    logger.info("BlueSky nodes detected - connection confirmed")
                    return jsonify(
                        {
                            "success": True,
                            "server_ip": server_ip,
                            "message": "Connected to BlueSky remote server hosted by amvlab",
                        }
                    )
                time.sleep(0.1)

            logger.info(
                f"No BlueSky nodes detected after {timeout}s - server may be offline"
            )
            proxy.stop_client()
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

            # Friendly display names, keyed by the lowercased base stem
            # (the filename stem with any "_nologo" suffix stripped). Keep
            # this in sync with CATEGORY_TO_MODEL in aircraftCategories.ts.
            display_name_map = {
                "a320": "Airbus A320",
                "a350": "Airbus A350",
                "a380": "Airbus A380",
                "b737": "Boeing 737",
                "b787": "Boeing 787",
                "evtol": "eVTOL",
                "drone": "Drone",
            }

            # The model used when an aircraft's type is unknown and no model
            # is forced (mirrors DEFAULT_FALLBACK_MODEL in aircraftCategories.ts).
            default_model = "A320.glb"

            models = []

            for model_file in models_dir.iterdir():
                if not (
                    model_file.is_file()
                    and model_file.suffix.lower() in supported_extensions
                ):
                    continue

                # Split the stem into a base name and an optional "no logo"
                # variant so both spell out to a consistent display name.
                stem = model_file.stem
                is_nologo = stem.lower().endswith("_nologo")
                base = stem[: -len("_nologo")] if is_nologo else stem

                display_name = display_name_map.get(base.lower(), base)
                if is_nologo:
                    display_name = f"{display_name} (no logo)"

                models.append(
                    {
                        "filename": model_file.name,
                        "displayName": display_name,
                        "description": f"{display_name} 3D model",
                        "fileSize": model_file.stat().st_size,
                        "isDefault": model_file.name == default_model,
                    }
                )

            # Default model first, then grouped by friendly name with the
            # logo variant ahead of its "(no logo)" counterpart.
            models.sort(
                key=lambda m: (
                    not m["isDefault"],
                    m["displayName"].casefold(),
                )
            )

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
        offline from OurAirports open data (see ``script/navdata/``). Query
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

            db_path = NAVDATA_DB
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
            # each into a quoted prefix term so "heath" matches "Heathrow"
            # and "kse" matches "KSEA". The quotes keep uppercase tokens like
            # OR/AND/NOT literal — unquoted they are FTS5 operators, so e.g.
            # typing "ORD" would error at the "OR" keystroke. Multiple tokens
            # are implicitly AND-ed.
            tokens = re.findall(r"[A-Za-z0-9]+", query)
            if not tokens:
                return jsonify({"success": True, "results": []})
            match_expr = " ".join(f'"{t}"*' for t in tokens)

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
        nodes, and includes session information from the session manager
        (used externally, e.g. by demo-deploy, for capacity decisions).

        Returns:
            A 200 JSON payload with ``bluesky_server`` and ``session_info``
            sections, or 503 with the error on failure.
        """
        try:
            proxy = getattr(current_app, "bluesky_proxy", None)
            listening, _ = probe_bluesky_ports(getattr(proxy, "server_ip", None))

            response_data = {
                "status": "healthy",
                "bluesky_server": {
                    "ports_accessible": bool(listening),
                    "port_11000": 11000 in listening,
                    "port_11001": 11001 in listening,
                    "proxy_running": getattr(proxy, "running", False),
                    "proxy_connected": getattr(proxy, "is_connected", False),
                    "has_active_nodes": len(getattr(proxy, "tracked_nodes", [])) > 0,
                },
                "session_info": session_manager.get_session_info(),
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
        creates the ``scenario/``, ``plugins/`` and ``output/``
        subdirectories if needed (the same set the integrated build
        pre-creates), so browsing works before BlueSky's first start.

        In the integrated build the base path is fixed to BlueSky's own
        working directory (``bluesky_base_path_locked``); reconfiguring it
        is refused with 403 so uploads can never be diverted away from
        where the bundled server actually reads them.

        Returns:
            JSON with the accepted ``base_path`` and ``derived_paths``
            (scenario, plugins, settings, output), or a 400/403/500 error
            payload.
        """
        try:
            if getattr(current_app, "bluesky_base_path_locked", False):
                return jsonify(
                    {
                        "success": False,
                        "error": (
                            "Base path is fixed to BlueSky's working directory "
                            "in this build and cannot be reconfigured"
                        ),
                    }
                ), 403

            data = request.get_json(silent=True) or {}
            base_path = data.get("base_path", "").strip()

            if not base_path:
                return jsonify(
                    {"success": False, "error": "Base path is required"}
                ), 400

            path_obj = Path(base_path).expanduser().resolve()

            if not path_obj.exists():
                return jsonify(
                    {"success": False, "error": f"Path does not exist: {path_obj}"}
                ), 400

            if not path_obj.is_dir():
                return jsonify(
                    {"success": False, "error": f"Path is not a directory: {path_obj}"}
                ), 400

            if not os.access(str(path_obj), os.W_OK):
                return jsonify(
                    {"success": False, "error": f"Path is not writable: {path_obj}"}
                ), 400

            current_app.bluesky_base_path = str(path_obj)

            try:
                for subdir in MANAGED_SUBDIRS:
                    (path_obj / subdir).mkdir(exist_ok=True)
                logger.info(
                    f"BlueSky base path configured: {current_app.bluesky_base_path}"
                )

                return jsonify(
                    {
                        "success": True,
                        "base_path": current_app.bluesky_base_path,
                        "derived_paths": _derived_paths(path_obj),
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
            if not hasattr(current_app, "bluesky_base_path"):
                return jsonify(
                    {"success": False, "error": "BlueSky base path not configured"}
                ), 400

            base_path = Path(current_app.bluesky_base_path)

            if file_type not in WRITABLE_FILE_TYPES:
                return jsonify(
                    {"success": False, "error": f"Invalid file type: {file_type}"}
                ), 400

            if "file" not in request.files:
                return jsonify({"success": False, "error": "No file provided"}), 400

            file = request.files["file"]
            if file.filename == "":
                return jsonify({"success": False, "error": "No file selected"}), 400

            config = FILE_TYPES[file_type]

            if not file.filename.lower().endswith(config["extension"]):
                return jsonify(
                    {
                        "success": False,
                        "error": f"Invalid file extension. Expected {config['extension']}",
                    }
                ), 400

            max_size = 50 * 1024 * 1024 if file_type == "scenario" else 10 * 1024 * 1024
            file.seek(0, 2)
            file_size = file.tell()
            file.seek(0)

            if file_size > max_size:
                max_size_mb = max_size // (1024 * 1024)
                return jsonify(
                    {
                        "success": False,
                        "error": f"File too large. Maximum size: {max_size_mb}MB",
                    }
                ), 400

            filename = secure_filename(file.filename)
            if not filename:
                return jsonify({"success": False, "error": "Invalid filename"}), 400

            if file_type == "settings":
                # Single fixed file; a re-upload replaces it.
                target_path = base_path / config["filepath"]
            else:
                extension = config["extension"]
                if not filename.lower().endswith(extension):
                    # secure_filename can reduce a name like ".scn" to the
                    # bare extension, which browse would never list.
                    return jsonify({"success": False, "error": "Invalid filename"}), 400
                # Store the extension lowercase: BlueSky's IC forces ".scn"
                # onto the name via Path.with_suffix, so an uploaded
                # "DEMO.SCN" could never be run on a case-sensitive fs.
                filename = filename[: -len(extension)] + extension
                target_dir = base_path / config["directory"]
                target_dir.mkdir(exist_ok=True)

                # Auto-rename on conflicts rather than overwriting.
                counter = 1
                target_path = target_dir / filename
                while target_path.exists():
                    new_filename = (
                        f"{Path(filename).stem}_{counter}{Path(filename).suffix}"
                    )
                    target_path = target_dir / new_filename
                    counter += 1

            # Report the name the file was actually stored under — the
            # auto-renamed one, or settings.cfg whatever the upload was named.
            filename = target_path.name

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

    @app.route("/api/bluesky/browse/<file_type>", methods=["GET"])
    @app.route("/api/bluesky/browse/<file_type>/<path:subpath>", methods=["GET"])
    def browse_bluesky_directory(file_type, subpath=""):
        """Browse a BlueSky directory tree (GET /api/bluesky/browse/<file_type>[/<subpath>]).

        Lists folders and files (extension matched case-insensitively) with
        subdirectory navigation and breadcrumbs. The subpath is sanitized
        (no ``..`` components) and resolved paths are verified to stay
        inside the allowed base directory to prevent traversal.

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
            if not hasattr(current_app, "bluesky_base_path"):
                return jsonify(
                    {"success": False, "error": "BlueSky base path not configured"}
                ), 400

            base_path = Path(current_app.bluesky_base_path)

            if file_type not in FILE_TYPES:
                return jsonify(
                    {"success": False, "error": f"Invalid file type: {file_type}"}
                ), 400

            config = FILE_TYPES[file_type]

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

            # Sanitize the subpath and verify it stays inside the type's
            # directory (traversal/symlink escapes rejected).
            target_base = base_path / config["directory"]
            current_path_parts = _clean_parts(subpath)
            target_dir, error = _resolve_under(target_base, subpath)
            if error:
                return error

            files = _dir_entries(target_dir, config["extension"])

            breadcrumbs = [{"name": config["directory"], "path": ""}]
            for i, part in enumerate(current_path_parts):
                breadcrumbs.append(
                    {"name": part, "path": "/".join(current_path_parts[: i + 1])}
                )

            return jsonify(
                {
                    "success": True,
                    "file_type": file_type,
                    "files": files,
                    "current_path": "/".join(current_path_parts),
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

        output_base = Path(current_app.bluesky_base_path) / "output"

        if not _clean_parts(filepath):
            return None, (
                jsonify({"success": False, "error": "No file specified"}),
                400,
            )

        resolved_target, error = _resolve_under(output_base, filepath)
        if error:
            return None, error

        if not resolved_target.is_file():
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

        Supports log streaming with plain byte offsets: with ``offset`` > 0
        the file is read from that byte offset to the end; with offset 0 the
        last ``lines`` lines are tailed for the initial load. If the file
        shrank below the offset (truncated/rewritten between polls), the
        stream restarts with a tail load instead of silently skipping the
        new content. Query parameters:

        - ``offset``: byte offset to read from (0 = tail mode).
        - ``lines``: maximum lines for the initial tail load (default 200);
          0 or negative skips history and streams from the current end.
        - ``include_header``: with a truthy value, a tail load that dropped
          lines prepends the file's leading ``#`` comment block. BlueSky's
          datalog writes a log's header (including the column-names line)
          only once at the top, so a plain tail of a long log would lose it.

        Args:
            filepath (str): Path of the file relative to the output
                directory; validated against traversal.

        Returns:
            JSON with ``content``, the new byte ``offset``, ``total_size``
            and ``filename``, or a 400/403/404/500 error payload.
        """
        try:
            resolved_path, error = _validate_output_path(filepath)
            if error:
                return error

            offset = request.args.get("offset", type=int, default=0)
            max_lines = request.args.get("lines", type=int, default=200)
            include_header = request.args.get("include_header", type=int, default=0)
            file_size = resolved_path.stat().st_size

            # A file smaller than the offset was truncated or rewritten
            # between polls; restart with a tail load instead of pinning at EOF.
            if offset > file_size:
                offset = 0

            # Binary mode so offsets are real byte positions (text-mode tell()
            # returns opaque cookies and garbles CRLF logs caught mid-line).
            with open(resolved_path, "rb") as f:
                if offset > 0:
                    f.seek(offset)
                    data = f.read()
                elif max_lines > 0:
                    # Initial (or post-truncation) load: tail the last N lines.
                    all_lines = f.readlines()
                    data = b"".join(all_lines[-max_lines:])
                    cut = len(all_lines) - max_lines
                    if include_header and cut > 0:
                        header = []
                        for line in all_lines[:cut]:
                            if not line.startswith(b"#"):
                                break
                            header.append(line)
                        data = b"".join(header) + data
                else:
                    f.seek(0, os.SEEK_END)
                    data = b""
                new_offset = f.tell()

            data, held_back = _split_incomplete_utf8(data)
            new_offset -= len(held_back)
            content = data.decode("utf-8", errors="replace").replace("\r\n", "\n")

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

    @app.route("/api/bluesky/<file_type>/<path:filename>", methods=["DELETE"])
    def delete_bluesky_file(file_type, filename):
        """Delete a BlueSky file (DELETE /api/bluesky/<file_type>/<path:filename>).

        The filename is used as listed/browsed — it may include subdirectories
        below the type's directory (the browse UI navigates into them) and is
        validated against traversal with the same containment rule as browsing.

        Args:
            file_type (str): One of ``scenario``, ``plugins``, ``settings``.
                For ``settings`` only ``settings.cfg`` may be deleted.
            filename (str): Path of the file to delete, relative to the file
                type's directory.

        Returns:
            JSON confirming the deletion, or a 400/403/404/500 error payload.
        """
        try:
            if not hasattr(current_app, "bluesky_base_path"):
                return jsonify(
                    {"success": False, "error": "BlueSky base path not configured"}
                ), 400

            base_path = Path(current_app.bluesky_base_path)

            if file_type not in WRITABLE_FILE_TYPES:
                return jsonify(
                    {"success": False, "error": f"Invalid file type: {file_type}"}
                ), 400

            if file_type == "settings":
                if filename != "settings.cfg":
                    return jsonify(
                        {"success": False, "error": "Can only delete settings.cfg"}
                    ), 400
                target_path = base_path / FILE_TYPES["settings"]["filepath"]
            else:
                target_dir = base_path / FILE_TYPES[file_type]["directory"]
                target_path, error = _resolve_under(target_dir, filename)
                if error:
                    return error

            # Only real files are deletable — never directories.
            if not target_path.is_file():
                return jsonify(
                    {"success": False, "error": f"File not found: {filename}"}
                ), 404

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
                    "derived_paths": _derived_paths(base_path),
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
