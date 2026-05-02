"""Shape handlers for POLY and POLYLINE data."""

import time

from ...logger import get_logger
from ...utils import make_json_serializable

logger = get_logger()


def get_bluesky_proxy():
    """Get the current BlueSky proxy instance."""
    from .. import get_bluesky_proxy as _get_proxy

    return _get_proxy()


def on_poly_received(data, *args, **kwargs):
    """Handle polygon data updates from BlueSky server."""
    proxy = get_bluesky_proxy()
    if not proxy:
        return

    # Ignore data if reconnection is not allowed (we're disconnected)
    if not proxy.allow_reconnection:
        return

    # Mark successful data reception
    proxy.last_successful_update = time.time()

    try:
        # Get sender_id from BlueSky context
        sender_id = None
        if proxy.bluesky_client and hasattr(proxy.bluesky_client, "context"):
            ctx = proxy.bluesky_client.context
            if ctx.sender_id:
                sender_id = (
                    ctx.sender_id.hex()
                    if isinstance(ctx.sender_id, bytes)
                    else str(ctx.sender_id)
                )

        # Convert to JSON serializable format
        poly_data = make_json_serializable(data)

        # Separate polygons and polylines based on shape
        separated_data = _separate_poly_and_polyline_data(poly_data)

        # Store both POLY and POLYLINE data by node ID
        if sender_id:
            # Initialize storage if it doesn't exist
            if sender_id not in proxy.poly_data_by_node:
                proxy.poly_data_by_node[sender_id] = {"polys": {}}
            if sender_id not in proxy.polyline_data_by_node:
                proxy.polyline_data_by_node[sender_id] = {"polys": {}}

            # Check if we need to handle RESET/REPLACE action types differently
            action_type = None
            if isinstance(data, list) and len(data) >= 2:
                action_type = data[0] if isinstance(data[0], (str, bytes)) else None
                if isinstance(action_type, bytes):
                    action_type = (
                        action_type.decode("utf-8")
                        if len(action_type) == 1
                        else action_type.hex()
                    )

            # Handle different action types
            if action_type in [
                "R",
                "X",
                "C",
            ]:  # Reset/Replace/Change - clear existing data
                if separated_data["polygons"] and separated_data["polygons"].get(
                    "polys"
                ):
                    proxy.poly_data_by_node[sender_id] = separated_data["polygons"]
                else:
                    proxy.poly_data_by_node[sender_id] = {"polys": {}}

                if separated_data["polylines"] and separated_data["polylines"].get(
                    "polys"
                ):
                    proxy.polyline_data_by_node[sender_id] = separated_data["polylines"]
                else:
                    proxy.polyline_data_by_node[sender_id] = {"polys": {}}
            else:  # Update/Append - merge with existing data
                # Merge polygons if any exist in the new data
                if separated_data["polygons"] and separated_data["polygons"].get(
                    "polys"
                ):
                    proxy.poly_data_by_node[sender_id]["polys"].update(
                        separated_data["polygons"]["polys"]
                    )

                # Merge polylines if any exist in the new data
                if separated_data["polylines"] and separated_data["polylines"].get(
                    "polys"
                ):
                    proxy.polyline_data_by_node[sender_id]["polys"].update(
                        separated_data["polylines"]["polys"]
                    )

            # Apply 5-shape limit for polygons
            if len(proxy.poly_data_by_node[sender_id]["polys"]) > 5:
                # Get shape names sorted by creation order (keep most recent 5)
                poly_names = list(proxy.poly_data_by_node[sender_id]["polys"].keys())
                shapes_to_remove = poly_names[:-5]  # Remove all but last 5
                for shape_name in shapes_to_remove:
                    del proxy.poly_data_by_node[sender_id]["polys"][shape_name]
                logger.debug(
                    f"Demo limit: Removed {len(shapes_to_remove)} polygons, keeping 5 most recent"
                )

            # Apply 5-shape limit for polylines
            if len(proxy.polyline_data_by_node[sender_id]["polys"]) > 5:
                # Get shape names sorted by creation order (keep most recent 5)
                polyline_names = list(
                    proxy.polyline_data_by_node[sender_id]["polys"].keys()
                )
                shapes_to_remove = polyline_names[:-5]  # Remove all but last 5
                for shape_name in shapes_to_remove:
                    del proxy.polyline_data_by_node[sender_id]["polys"][shape_name]
                logger.debug(
                    f"Demo limit: Removed {len(shapes_to_remove)} polylines, keeping 5 most recent"
                )

        # Only emit data if it's from the currently active node
        active_node_id = proxy._get_safe_active_node()
        if sender_id and active_node_id and sender_id == active_node_id:
            if proxy.socketio:
                # Emit the complete stored data (not just the separated data from this message)
                complete_poly_data = proxy.poly_data_by_node.get(
                    sender_id, {"polys": {}}
                )
                complete_polyline_data = proxy.polyline_data_by_node.get(
                    sender_id, {"polys": {}}
                )

                proxy.socketio.emit("poly", complete_poly_data)
                proxy.socketio.emit("polyline", complete_polyline_data)

    except Exception as e:
        logger.error(f"Error processing POLY data: {e}")
        import traceback

        traceback.print_exc()


def _separate_poly_and_polyline_data(poly_data):
    """Separate polygons and polylines from combined POLY data based on shape field."""
    polygons_data = {}
    polylines_data = {}

    try:
        # Handle the BlueSky POLY data format
        if isinstance(poly_data, dict) and "polys" in poly_data:
            polys = poly_data["polys"]

            # Separate by shape field
            polygons_polys = {}
            polylines_polys = {}

            for name, poly_info in polys.items():
                if isinstance(poly_info, dict):
                    shape = poly_info.get(
                        "shape", "POLY"
                    )  # Default to POLY if no shape specified
                    if shape == "LINE":
                        # BlueSky sends polylines with a flat 'coordinates' array: [lat1, lon1, lat2, lon2, ...]
                        # Convert to separate lat/lon arrays for web client compatibility
                        poly_info_converted = poly_info.copy()

                        if "coordinates" in poly_info and not (
                            "lat" in poly_info and "lon" in poly_info
                        ):
                            coords = poly_info["coordinates"]
                            if (
                                isinstance(coords, list) and len(coords) >= 4
                            ):  # At least 2 points (lat1,lon1,lat2,lon2)
                                # Split flat array into separate lat/lon arrays
                                lats = [coords[i] for i in range(0, len(coords), 2)]
                                lons = [coords[i] for i in range(1, len(coords), 2)]

                                poly_info_converted["lat"] = lats
                                poly_info_converted["lon"] = lons
                                poly_info_converted["name"] = name

                        polylines_polys[name] = poly_info_converted
                    elif shape == "POLYALT":
                        # Convert POLYALT to POLY for web display
                        poly_info_copy = poly_info.copy()
                        poly_info_copy["shape"] = "POLY"

                        # Handle coordinates conversion for POLYALT too
                        if "coordinates" in poly_info_copy and not (
                            "lat" in poly_info_copy and "lon" in poly_info_copy
                        ):
                            coords = poly_info_copy["coordinates"]
                            if (
                                isinstance(coords, list) and len(coords) >= 6
                            ):  # At least 3 points for polygon
                                lats = [coords[i] for i in range(0, len(coords), 2)]
                                lons = [coords[i] for i in range(1, len(coords), 2)]
                                poly_info_copy["lat"] = lats
                                poly_info_copy["lon"] = lons
                                poly_info_copy["name"] = name

                        polygons_polys[name] = poly_info_copy
                    else:  # 'POLY' or any other shape
                        poly_info_copy = poly_info.copy()

                        # Handle coordinates conversion for POLY too
                        if "coordinates" in poly_info_copy and not (
                            "lat" in poly_info_copy and "lon" in poly_info_copy
                        ):
                            coords = poly_info_copy["coordinates"]
                            if (
                                isinstance(coords, list) and len(coords) >= 6
                            ):  # At least 3 points for polygon
                                lats = [coords[i] for i in range(0, len(coords), 2)]
                                lons = [coords[i] for i in range(1, len(coords), 2)]
                                poly_info_copy["lat"] = lats
                                poly_info_copy["lon"] = lons
                                poly_info_copy["name"] = name

                        polygons_polys[name] = poly_info_copy
                else:
                    # Fallback: assume it's a polygon if no shape info
                    polygons_polys[name] = poly_info

            # Create separated data structures
            if polygons_polys:
                polygons_data = {"polys": polygons_polys}
            if polylines_polys:
                polylines_data = {"polys": polylines_polys}

        else:
            # If not in expected format, treat as polygons
            polygons_data = poly_data

    except Exception as e:
        logger.error(f"Error separating POLY data: {e}")
        # Fallback: treat all as polygons
        polygons_data = poly_data
        polylines_data = {}

    return {"polygons": polygons_data, "polylines": polylines_data}
