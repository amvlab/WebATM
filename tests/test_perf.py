"""Tests for :mod:`WebATM.perf` (opt-in ACDATA data-path instrumentation).

Pin the two properties the summary numbers depend on:

* the measurement window opens with the first frame after an idle gap, so
  idle time (boot, disconnect/reconnect) never dilutes the CPU shares, and
* the serialize average divides by the number of serializations, not emits,
  so an emit failure cannot skew it (or be miscounted as throttled).
"""

import logging
import time

import pytest

from WebATM.proxy.perf import DataPathPerf


@pytest.fixture
def perf(monkeypatch):
    """An enabled DataPathPerf with the default 5 s summary interval."""
    monkeypatch.setenv("WEBATM_PERF", "1")
    monkeypatch.delenv("WEBATM_PERF_INTERVAL", raising=False)
    return DataPathPerf()


def summary_lines(caplog):
    return [r.getMessage() for r in caplog.records if r.name == "WebATM.perf"]


class TestConfiguration:
    def test_disabled_by_default_and_records_nothing(self, monkeypatch):
        monkeypatch.delenv("WEBATM_PERF", raising=False)
        perf = DataPathPerf()
        assert not perf.enabled

        perf.record_received()
        perf.record_filtered()
        perf.record_serialize(0.1)
        perf.record_emit(0.1)
        assert (perf.received, perf.filtered, perf.serializes, perf.emits) == (
            0,
            0,
            0,
            0,
        )

    def test_invalid_interval_falls_back_to_default(self, monkeypatch):
        monkeypatch.setenv("WEBATM_PERF", "1")
        monkeypatch.setenv("WEBATM_PERF_INTERVAL", "not-a-number")
        assert DataPathPerf().interval == 5.0

    def test_interval_has_a_one_second_floor(self, monkeypatch):
        monkeypatch.setenv("WEBATM_PERF", "1")
        monkeypatch.setenv("WEBATM_PERF_INTERVAL", "0.01")
        assert DataPathPerf().interval == 1.0


class TestWindowStart:
    """The window must open with the flow's first frame, not at import time."""

    def test_very_first_frame_opens_the_window(self, perf):
        # e.g. the proxy connects two minutes after the module was imported.
        perf._window_start = time.time() - 120
        perf.record_received()
        assert time.time() - perf._window_start < 1.0

    def test_frame_after_idle_gap_restarts_a_partial_window(self, perf):
        # 10 frames flowed, then the link dropped for a minute mid-window.
        for _ in range(10):
            perf.record_received()
        perf._last_frame_wall = time.time() - 60
        perf._window_start = time.time() - 65
        perf._last_emit_wall = time.time() - 60

        perf.record_received()

        assert time.time() - perf._window_start < 1.0
        assert perf.received == 1  # pre-gap partial counters discarded
        # The pre-idle emit timestamp must not read as a 1-minute "stall".
        assert perf._last_emit_wall is None

    def test_continuous_flow_keeps_the_window_anchor(self, perf):
        anchor = time.time() - 1.0  # last summary 1 s ago, data still flowing
        perf._window_start = anchor
        perf._last_frame_wall = time.time() - 0.2  # 5 Hz cadence
        perf.record_received()
        assert perf._window_start == anchor
        assert perf.received == 1


class TestSummary:
    def _force_window_closed(self, perf, elapsed=10.0):
        perf._window_start = time.time() - elapsed

    def test_no_summary_before_interval_elapsed(self, perf, caplog):
        with caplog.at_level(logging.INFO, logger="WebATM.perf"):
            perf.record_received()
            perf.maybe_log()
        assert summary_lines(caplog) == []

    def test_serialize_average_uses_serialize_count_not_emits(self, perf, caplog):
        # 4 frames: 1 filtered, 2 serialized (one emit then failed), 1 throttled.
        perf.record_received()
        perf.record_filtered()
        perf.record_received()
        perf.record_serialize(0.010)
        perf.record_emit(0.002)
        perf.record_received()
        perf.record_serialize(0.030)  # its socketio.emit raised
        perf.record_received()

        self._force_window_closed(perf)
        with caplog.at_level(logging.INFO, logger="WebATM.perf"):
            perf.maybe_log()

        (line,) = summary_lines(caplog)
        # avg = (10 ms + 30 ms) / 2 serializations, NOT / 1 emit (= 40 ms).
        assert "serialize avg=20.00ms max=30.00ms" in line
        # The failed emit is not miscounted as throttled: 4 - 1 - 2 = 1.
        assert "recv=4 filtered=1 emit=1 throttled=1" in line

    def test_counters_and_window_reset_after_summary(self, perf, caplog):
        perf.record_received()
        perf.record_serialize(0.001)
        perf.record_emit(0.001)
        self._force_window_closed(perf)
        with caplog.at_level(logging.INFO, logger="WebATM.perf"):
            perf.maybe_log()

        assert (perf.received, perf.serializes, perf.emits) == (0, 0, 0)
        assert perf.serialize_s == 0.0 and perf.emit_s == 0.0
        assert time.time() - perf._window_start < 1.0

    def test_empty_window_logs_nothing_but_still_resets(self, perf, caplog):
        self._force_window_closed(perf)
        with caplog.at_level(logging.INFO, logger="WebATM.perf"):
            perf.maybe_log()
        assert summary_lines(caplog) == []
        assert time.time() - perf._window_start < 1.0

    def test_max_emit_gap_tracked_within_flowing_data(self, perf):
        perf.record_emit(0.001)
        perf._last_emit_wall = time.time() - 0.5  # 500 ms since previous emit
        perf.record_emit(0.001)
        assert perf._max_emit_gap == pytest.approx(0.5, abs=0.05)
