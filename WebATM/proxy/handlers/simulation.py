"""Simulation data handlers for SIMINFO and ACDATA events."""

import time

from ...logger import get_logger
from ...utils import make_json_serializable, tim2txt
from ..perf import data_path_perf
from ._base import get_bluesky_proxy

logger = get_logger()


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

    # Update per-node tracking for EVERY node so the Simulation Nodes panel
    # shows each node's own clock, regardless of which node is currently active.
    if sender_id_str and sender_id_str in proxy.tracked_nodes:
        simt_str = tim2txt(simt)[:-3] if simt is not None else "00:00:00"
        proxy.tracked_nodes[sender_id_str].update(
            {"status": scenname or "init", "time": simt_str}
        )
        # Emit updated node info occasionally (not every frame to avoid spam)
        if int(simt or 0) % 5 == 0:  # Every 5 seconds
            proxy._emit_node_info()

    # The header clock/rate/state must follow the ACTIVE node only, not
    # whichever node sent the latest update. Otherwise, with two or more nodes
    # running, the displayed time jumps between them. Cache and emit the sim
    # info solely for the active node. When the active node can't be resolved
    # yet (e.g. early in connection setup, before act_id is known), fall back to
    # accepting any sender so a single-node display still works.
    active_node = proxy._get_safe_active_node()
    is_active_node = (
        active_node is None or sender_id_str is None or sender_id_str == active_node
    )
    if not is_active_node:
        return

    proxy.sim_data = sim_data

    # Throttle sim info emissions
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
    """Handle aircraft data updates.

    Hot path: the network timer delivers ACDATA at up to 50 Hz, but it is only
    emitted to browsers at ``acdata_interval`` (10 Hz) and only for the active
    node. ``make_json_serializable`` is the dominant per-frame cost, so it is
    deferred until after the active-node filter and the emit throttle decide the
    frame is actually sent. Set WEBATM_PERF=1 (WebATM.proxy.perf) to measure it.
    """
    try:
        proxy = get_bluesky_proxy()
        if not proxy:
            logger.debug("on_acdata_received called but no proxy available")
            return

        # Ignore data if reconnection is not allowed (we're disconnected)
        if not proxy.allow_reconnection:
            logger.debug("on_acdata_received ignored - reconnection not allowed")
            return

        # Check context action like BlueSky web client does, and resolve which
        # node sent this frame (set on the shared context just before this
        # synchronous dispatch) for the active-node filter below.
        sender_id_str = None
        if proxy.bluesky_client and hasattr(proxy.bluesky_client, "context"):
            ctx = proxy.bluesky_client.context
            if ctx.action == ctx.Reset or ctx.action == ctx.ActChange:
                # Simulation reset: Clear all entries like web client does
                logger.info("ACDATA reset/actchange detected - clearing aircraft data")
                empty_traffic_data = {
                    "id": [],
                    "lat": [],
                    "actype": [],  # this is only sent by bluesky/amvlab
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

            sender_id = getattr(ctx, "sender_id", None)
            if isinstance(sender_id, bytes):
                sender_id_str = sender_id.hex()
            elif sender_id is not None:
                sender_id_str = str(sender_id)

        # Any ACDATA from any node proves the link to BlueSky is alive: update
        # liveness before filtering so a background node's traffic still counts.
        proxy.last_successful_update = time.time()
        data_path_perf.record_received()

        # Only the active node's traffic is displayed. Skip serializing frames
        # from background nodes nobody is viewing (mirrors the SIMINFO filter).
        # When the active node can't be resolved yet (early connection or a
        # single-node sim), accept any sender so the map still populates.
        active_node = proxy._get_safe_active_node()
        if (
            active_node is not None
            and sender_id_str is not None
            and sender_id_str != active_node
        ):
            data_path_perf.record_filtered()
            return

        # Throttle BEFORE serializing. Emitting (and therefore serializing) only
        # at acdata_interval removes the wasted per-frame work under heavy node
        # load. traffic_data refreshes at the emit cadence, which is what the
        # initial-data snapshot and the 0.5 s backup emit consume.
        current_time = time.time()
        if not (
            proxy.socketio
            and proxy.connected_clients > 0
            and (current_time - proxy.last_acdata_emit) >= proxy.acdata_interval
        ):
            return

        t0 = time.perf_counter()
        serializable_data = make_json_serializable(data)
        data_path_perf.record_serialize(time.perf_counter() - t0)
        proxy.traffic_data = serializable_data

        try:
            t1 = time.perf_counter()
            proxy.socketio.emit("acdata", serializable_data)
            proxy.last_acdata_emit = current_time
            data_path_perf.record_emit(time.perf_counter() - t1)
        except Exception as e:
            logger.error(f"Error emitting ACDATA: {e}")
            import traceback

            traceback.print_exc()

    except Exception as e:
        logger.error(f"ACDATA Handler: Detailed error in on_acdata_received: {e}")
        logger.error(f"ACDATA Handler: Error type: {type(e).__name__}")
        logger.error(f"ACDATA Handler: Data type: {type(data)}")
        logger.error(f"ACDATA Handler: Data content: {data}")
        import traceback

        traceback.print_exc()
    finally:
        data_path_perf.maybe_log()


def on_statechange_received(data, sender_id=None):
    """Handle simulation state transitions from BlueSky (STATECHANGE topic)."""
    proxy = get_bluesky_proxy()
    if not proxy or not proxy.allow_reconnection:
        return

    simstate = data.get("simstate") if isinstance(data, dict) else None
    if simstate is None:
        return

    if isinstance(sender_id, bytes):
        sender_id_str = sender_id.hex()
    elif sender_id is not None:
        sender_id_str = str(sender_id)
    else:
        sender_id_str = None

    proxy.last_successful_update = time.time()

    if isinstance(proxy.sim_data, dict):
        proxy.sim_data["state"] = int(simstate)

    payload = {
        "simstate": int(simstate),
        "sender_id": sender_id_str,
    }

    if proxy.socketio and proxy.connected_clients > 0:
        try:
            proxy.socketio.emit("statechange", payload)
        except Exception as e:
            logger.error(f"Proxy->Web: Error sending STATECHANGE: {e}")

    logger.info(f"STATECHANGE from {sender_id_str}: simstate={simstate}")
