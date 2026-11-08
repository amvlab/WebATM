"""Handle BlueSky simulation-state events (SIMINFO, ACDATA).

These handlers receive the core simulation feed from the BlueSky server: the
per-node simulation clock and run-state (SIMINFO) and the aircraft traffic
frames (ACDATA). They cache the data on the proxy and forward it to connected
browsers over Socket.IO as the ``siminfo`` and ``acdata`` events.

BlueSky's STATECHANGE topic is deliberately NOT handled: sim nodes publish it
addressed to their own server (``to_group=bs.net.server_id``), which consumes
it for batch-scenario bookkeeping and never forwards it to clients — so a
client subscription can never receive it. Run-state reaches clients via the
``state`` field of the 1 Hz SIMINFO feed, as in BlueSky's own GUIs.
"""

import time

from ...logger import get_logger
from ...utils import id2str, make_json_serializable, tim2txt
from ..perf import data_path_perf
from ._base import active_proxy, is_active_node, shared_context

logger = get_logger()


def on_siminfo_received(
    speed, simdt, simt, simutc, ntraf, state, scenname, sender_id=None
):
    """Process a BlueSky SIMINFO event and emit ``siminfo`` to web clients.

    Updates the per-node status/clock tracking for every sending node (feeding
    the Simulation Nodes panel via a throttled ``node_info`` emission), but only
    caches and emits the header simulation info for the active node so the
    displayed clock does not jump between nodes. Emissions to browsers are
    throttled to ``proxy.siminfo_interval``.

    Args:
        speed (float): Simulation speed multiplier.
        simdt (float): Simulation timestep in seconds.
        simt (float): Elapsed simulation time in seconds.
        simutc (str): Simulation UTC time string.
        ntraf (int): Number of aircraft currently in the simulation.
        state (int): Simulation run-state code.
        scenname (str): Name of the currently loaded scenario.
        sender_id (bytes | str | None): Identifier of the sending node; bytes
            are converted to a hex string.
    """
    proxy = active_proxy()
    if not proxy:
        return

    sender_id_str = id2str(sender_id)
    current_time = time.time()

    # Update per-node tracking for EVERY node so the Simulation Nodes panel
    # shows each node's own clock, regardless of which node is currently active.
    if sender_id_str and sender_id_str in proxy.tracked_nodes:
        simt_str = tim2txt(simt)[:-3] if simt is not None else "00:00:00"
        proxy.tracked_nodes[sender_id_str].update(
            {"status": scenname or "init", "time": simt_str}
        )
        # Wall-clock throttle: a sim-time cadence misbehaves when the sim is
        # paused or fast-forwarded.
        if (current_time - proxy.last_node_info_emit) >= proxy.node_info_interval:
            proxy.last_node_info_emit = current_time
            proxy._emit_node_info()

    # Cache and emit the header sim info solely for the active node.
    if not is_active_node(proxy, sender_id_str):
        return

    proxy.sim_data = {
        "speed": float(speed) if speed is not None else 0.0,
        "simdt": float(simdt) if simdt is not None else 0.0,
        "simt": float(simt) if simt is not None else 0.0,
        "simutc": str(simutc) if simutc is not None else "",
        "ntraf": int(ntraf) if ntraf is not None else 0,
        "state": int(state) if state is not None else 0,
        "scenname": str(scenname) if scenname is not None else "",
        "sender_id": sender_id_str,
    }

    # Throttle sim info emissions
    if (
        proxy.socketio
        and proxy.connected_clients > 0
        and (current_time - proxy.last_siminfo_emit) >= proxy.siminfo_interval
    ):
        try:
            proxy.socketio.emit("siminfo", proxy.sim_data)
            proxy.last_siminfo_emit = current_time
        except Exception as e:
            logger.error(f"Error emitting SIMINFO: {e}")


def on_acdata_received(data):
    """Process a BlueSky ACDATA traffic frame and emit ``acdata`` to web clients.

    Hot path: the network timer delivers ACDATA at up to 50 Hz, but frames are
    only serialized and cached at ``acdata_interval`` (10 Hz), only for the
    active node, and only emitted to browsers while any are connected.
    ``make_json_serializable`` is the dominant per-frame cost, so it is deferred
    until after the active-node filter and the throttle accept the frame. The
    cache is refreshed even with no browser attached — ``initial_data``, the
    backup timer and the ROUTEDATA filter serve it, so it must track the live
    feed. Reset clearing is the RESET topic's job (events.on_reset_received),
    never an ACDATA action's. Set WEBATM_PERF=1 (WebATM.proxy.perf) to measure
    the hot path.

    Args:
        data (dict): Aircraft state arrays keyed by field (``id``, ``lat``,
            ``lon``, ``alt``, ``tas``, ``trk``, ``vs``, conflict counters, ...)
            as sent by the BlueSky server.
    """
    try:
        # ACDATA from any node proves the link is alive, so liveness (which
        # active_proxy refreshes) is updated before the active-node filter.
        proxy = active_proxy()
        if not proxy:
            return
        data_path_perf.record_received()

        # The sending node is set on the shared context just before this
        # synchronous dispatch; only the active node's traffic is displayed
        # (mirrors the SIMINFO filter).
        sender_id_str, _ = shared_context(proxy)
        if not is_active_node(proxy, sender_id_str):
            data_path_perf.record_filtered()
            return

        # Throttle BEFORE serializing: serialization is the dominant per-frame
        # cost, so pay it at most once per acdata_interval.
        current_time = time.time()
        if (current_time - proxy.last_acdata_emit) < proxy.acdata_interval:
            return

        t0 = time.perf_counter()
        serializable_data = make_json_serializable(data)
        data_path_perf.record_serialize(time.perf_counter() - t0)
        proxy.traffic_data = serializable_data
        proxy.last_acdata_emit = current_time

        if not (proxy.socketio and proxy.connected_clients > 0):
            return

        try:
            t1 = time.perf_counter()
            proxy.socketio.emit("acdata", serializable_data)
            data_path_perf.record_emit(time.perf_counter() - t1)
        except Exception:
            logger.exception("Error emitting ACDATA")

    except Exception:
        logger.exception(f"Error in on_acdata_received (data type: {type(data)})")
    finally:
        data_path_perf.maybe_log()
