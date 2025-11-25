"""
Basic Flask routes for WebATM.

This module contains routes for the main page, simulation commands,
server configuration, health/status endpoints, and BlueSky file uploads.
"""

import json
import os
import socket
import time
from pathlib import Path
from werkzeug.utils import secure_filename

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

    # BlueSky File Upload System Routes

    @app.route("/api/bluesky/configure-base-path", methods=["POST"])
    def configure_bluesky_base_path():
        """Configure BlueSky base directory path."""
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
        """Upload files to BlueSky directories."""
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
        """List files in BlueSky directories."""
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

                    # Add files with the specified extension
                    for file_path in target_dir.glob(f"*{config['extension']}"):
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
        """Browse files and folders in BlueSky directories with subdirectory navigation."""
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

            # Security check: ensure the target directory is within the allowed base
            try:
                # Resolve to absolute paths and check containment
                resolved_target = target_dir.resolve()
                resolved_base = target_base.resolve()

                # Check if target is within the allowed directory
                if not str(resolved_target).startswith(str(resolved_base)):
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

                # Add files with the specified extension
                for file_path in target_dir.glob(f"*{config['extension']}"):
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

    @app.route("/api/bluesky/<file_type>/<filename>", methods=["DELETE"])
    def delete_bluesky_file(file_type, filename):
        """Delete files from BlueSky directories."""
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
        """Get BlueSky file system configuration status."""
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
