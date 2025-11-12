"""Simulation data handlers for SIMINFO and ACDATA events."""

import time

from ...logger import get_logger
from ...utils import make_json_serializable, tim2txt

logger = get_logger()


def get_bluesky_proxy():
    """Get the current BlueSky proxy instance."""
    from .. import get_bluesky_proxy as _get_proxy

    return _get_proxy()


def on_siminfo_received(
    speed, simdt, simt, simutc, ntraf, state, scenname, sender_id=None
):
    """Handle simulation info updates."""
    proxy = get_bluesky_proxy()
    if not proxy:
        logger.debug("on_siminfo_received called but no proxy available")
        return

    # Ignore data if reconnection is not allowed (we're disconnected)
    if not proxy.allow_reconnection:
        logger.debug("on_siminfo_received ignored - reconnection not allowed")
        return

    # Convert binary sender_id to string for web client compatibility
    if isinstance(sender_id, bytes):
        # Convert bytes to hex string for consistent identification
        sender_id_str = sender_id.hex()
    else:
        sender_id_str = str(sender_id) if sender_id else None

    # Fallback to BlueSky context if no sender_id parameter provided (for compatibility)
    if sender_id_str is None:
        from bluesky.network import context as ctx

        if ctx.sender_id:
            sender_id_str = (
                ctx.sender_id.hex()
                if isinstance(ctx.sender_id, bytes)
                else str(ctx.sender_id)
            )

    # Mark successful data reception
    current_time = time.time()
    time_since_last = current_time - proxy.last_successful_update

    # Log first data reception after connection
    if not proxy.was_connected and time_since_last > 1.0:
        pass  # Connection fully active

    proxy.last_successful_update = current_time

    sim_data = {
        "speed": float(speed) if speed is not None else 0.0,
        "simdt": float(simdt) if simdt is not None else 0.0,
        "simt": float(simt) if simt is not None else 0.0,
        "simutc": str(simutc) if simutc is not None else "",  # UTC is a string
        "ntraf": int(ntraf) if ntraf is not None else 0,
        "state": int(state) if state is not None else 0,
        "scenname": str(scenname) if scenname is not None else "",
        "sender_id": sender_id_str,  # Include sender ID for node identification
    }
    proxy.sim_data = sim_data

    # Update node information like web client does
    if sender_id_str and sender_id_str in proxy.tracked_nodes:
        simt_str = tim2txt(simt)[:-3] if simt is not None else "00:00:00"
        proxy.tracked_nodes[sender_id_str].update(
            {"status": scenname or "init", "time": simt_str}
        )
        # Emit updated node info occasionally (not every frame to avoid spam)
        if int(simt or 0) % 5 == 0:  # Every 5 seconds
            proxy._emit_node_info()

    # Throttle sim info emissions
    current_time = time.time()
    if (
        proxy.socketio
        and proxy.connected_clients > 0
        and (current_time - proxy.last_siminfo_emit) >= proxy.siminfo_interval
    ):
        try:
            proxy.socketio.emit("siminfo", sim_data)
            proxy.last_siminfo_emit = current_time
        except Exception as e:
            logger.error(f"Proxy→Web: Error sending SIMINFO: {e}")
            pass


def on_acdata_received(data):
    """Handle aircraft data updates."""
    try:
        proxy = get_bluesky_proxy()
        if not proxy:
            logger.debug("on_acdata_received called but no proxy available")
            return

        # Ignore data if reconnection is not allowed (we're disconnected)
        if not proxy.allow_reconnection:
            logger.debug("on_acdata_received ignored - reconnection not allowed")
            return

        # Check context action like BlueSky web client does
        if proxy.bluesky_client and hasattr(proxy.bluesky_client, "context"):
            ctx = proxy.bluesky_client.context
            if ctx.action == ctx.Reset or ctx.action == ctx.ActChange:
                # Simulation reset: Clear all entries like web client does
                logger.info("ACDATA reset/actchange detected - clearing aircraft data")
                empty_traffic_data = {
                    "id": [],
                    "lat": [],
                    "actype": [], # this is only sent by bluesky/amvlab
                    "lon": [],
                    "alt": [],
                    "tas": [],
                    "trk": [],
                    "vs": [],
                    "inconf": [],
                    "tcpamax": [],
                    "nconf_cur": 0,
                    "nconf_tot": 0,
                    "nlos_cur": 0,
                    "nlos_tot": 0,
                }
                proxy.traffic_data = empty_traffic_data

                # Emit cleared data immediately
                if proxy.socketio and proxy.connected_clients > 0:
                    try:
                        proxy.socketio.emit("acdata", empty_traffic_data)
                        logger.debug(
                            f"Emitted cleared ACDATA to {proxy.connected_clients} web clients"
                        )
                    except Exception as e:
                        logger.error(f"Error emitting cleared ACDATA: {e}")
                return

        # Remove all ACDATA debug logging per user request

        # Mark successful data reception
        proxy.last_successful_update = time.time()

        # Convert to JSON-serializable format
        serializable_data = make_json_serializable(data)
        proxy.traffic_data = serializable_data

        # Throttle aircraft data emissions
        current_time = time.time()
        if (
            proxy.socketio
            and proxy.connected_clients > 0
            and (current_time - proxy.last_acdata_emit) >= proxy.acdata_interval
        ):
            try:
                proxy.socketio.emit("acdata", serializable_data)
                proxy.last_acdata_emit = current_time
                # Remove ACDATA emission logging per user request
            except Exception as e:
                logger.error(f"Error emitting ACDATA: {e}")
                import traceback

                traceback.print_exc()
        # Remove noisy debug messages for empty data

    except Exception as e:
        logger.error(f"ACDATA Handler: Detailed error in on_acdata_received: {e}")
        logger.error(f"ACDATA Handler: Error type: {type(e).__name__}")
        logger.error(f"ACDATA Handler: Data type: {type(data)}")
        logger.error(f"ACDATA Handler: Data content: {data}")
        import traceback

        traceback.print_exc()
