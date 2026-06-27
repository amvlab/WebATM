"""Opt-in performance instrumentation for the proxy ACDATA hot path.

The proxy receives ACDATA at up to the 50 Hz network-timer rate, and
serializing every frame (``make_json_serializable`` walks every aircraft field
in pure Python) is the dominant per-frame CPU cost under heavy node load. This
module measures that cost so you can tell whether the single ``-w 1`` worker is
actually saturating, and it quantifies the saving from only serializing frames
that are emitted (throttle-gated + filtered to the active node).

Disabled by default. Set ``WEBATM_PERF=1`` to turn it on; when off, every
``record_*`` call is a single boolean check that returns immediately, so the hot
path pays effectively nothing. A one-line summary is logged every
``WEBATM_PERF_INTERVAL`` seconds (default 5), for example::

    [Perf] acdata 5.0s | recv=250 filtered=200 emit=48 throttled=2 |
    serialize avg=3.10ms max=8.40ms | emit avg=0.90ms | datapath cpu=0.4% |
    projected pre-opt cpu~=15.8% | max emit gap=140ms

(The ``[Perf]`` prefix is added by the shared logger from this module's name.)

``datapath cpu`` is the share of wall-clock this worker spent serializing and
emitting ACDATA; ``projected pre-opt cpu`` estimates what the old
serialize-every-frame path would have cost (same emits, but one serialize per
received frame) so a single run shows the before/after.
"""

from __future__ import annotations

import os
import time

from ..logger import get_logger

logger = get_logger()


class DataPathPerf:
    """Accumulates ACDATA serialize/emit timings and logs periodic summaries."""

    def __init__(self) -> None:
        self.enabled = os.environ.get("WEBATM_PERF") == "1"
        try:
            self.interval = max(1.0, float(os.environ.get("WEBATM_PERF_INTERVAL", "5")))
        except ValueError:
            self.interval = 5.0
        self._window_start = time.time()
        self._last_emit_wall: float | None = None
        self._max_emit_gap = 0.0
        self._reset_counters()

    def _reset_counters(self) -> None:
        self.received = 0  # ACDATA frames into the handler (any node)
        self.filtered = 0  # dropped by the active-node filter
        self.emits = 0  # frames serialized and emitted
        self.serialize_s = 0.0
        self.serialize_max_s = 0.0
        self.emit_s = 0.0

    # --- recording (cheap no-ops when disabled) --------------------------

    def record_received(self) -> None:
        if self.enabled:
            self.received += 1

    def record_filtered(self) -> None:
        if self.enabled:
            self.filtered += 1

    def record_serialize(self, seconds: float) -> None:
        if not self.enabled:
            return
        self.serialize_s += seconds
        if seconds > self.serialize_max_s:
            self.serialize_max_s = seconds

    def record_emit(self, seconds: float) -> None:
        if not self.enabled:
            return
        self.emits += 1
        self.emit_s += seconds
        now = time.time()
        if self._last_emit_wall is not None:
            gap = now - self._last_emit_wall
            if gap > self._max_emit_gap:
                self._max_emit_gap = gap
        self._last_emit_wall = now

    # --- periodic summary ------------------------------------------------

    def maybe_log(self) -> None:
        if not self.enabled:
            return
        now = time.time()
        elapsed = now - self._window_start
        if elapsed < self.interval:
            return
        if self.received:
            throttled = max(0, self.received - self.filtered - self.emits)
            avg_ser_s = self.serialize_s / self.emits if self.emits else 0.0
            avg_emit_ms = 1000.0 * self.emit_s / self.emits if self.emits else 0.0
            datapath_cpu = 100.0 * (self.serialize_s + self.emit_s) / elapsed
            # Estimate the pre-optimization cost: one serialize per received
            # frame (no throttle, no active-node filter), with the same emits.
            projected_cpu = 100.0 * (avg_ser_s * self.received + self.emit_s) / elapsed
            logger.info(
                "acdata %.1fs | recv=%d filtered=%d emit=%d throttled=%d | "
                "serialize avg=%.2fms max=%.2fms | emit avg=%.2fms | "
                "datapath cpu=%.1f%% | projected pre-opt cpu~=%.1f%% | "
                "max emit gap=%.0fms",
                elapsed,
                self.received,
                self.filtered,
                self.emits,
                throttled,
                1000.0 * avg_ser_s,
                1000.0 * self.serialize_max_s,
                avg_emit_ms,
                datapath_cpu,
                projected_cpu,
                1000.0 * self._max_emit_gap,
            )
        self._window_start = now
        self._max_emit_gap = 0.0
        self._reset_counters()


# Process-global singleton: one proxy / data loop per worker, matching the
# proxy's own per-process model.
data_path_perf = DataPathPerf()
