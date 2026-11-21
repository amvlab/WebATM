"""Tests for the proxy's server-side aircraft trail history."""

import numpy as np

from WebATM.proxy.handlers.events import on_reset_received
from WebATM.proxy.handlers.simulation import on_acdata_received
from WebATM.proxy.managers.trail_manager import TrailManager


def frame(simt, **aircraft):
    """Build an ACDATA frame from ``id=(lat, lon)`` keyword pairs."""
    return {
        "simt": simt,
        "id": list(aircraft),
        "lat": np.array([pos[0] for pos in aircraft.values()], dtype=float),
        "lon": np.array([pos[1] for pos in aircraft.values()], dtype=float),
    }


class TestTrailRecording:
    def test_trail_starts_when_the_aircraft_appears(self, proxy):
        proxy.trail_mgr.record(frame(100.0, KL1=(52.0, 4.0)))
        assert proxy.trail_mgr.snapshot() == {
            "simt": 100.0,
            "trails": {"KL1": [[4.0, 52.0]]},
        }

    def test_samples_on_the_sim_time_interval(self, proxy):
        mgr = proxy.trail_mgr
        mgr.record(frame(0.0, KL1=(52.0, 4.0)))
        mgr.record(frame(4.9, KL1=(52.0, 4.1)))  # too soon
        mgr.record(frame(5.0, KL1=(52.0, 4.2)))
        assert mgr.snapshot()["trails"]["KL1"] == [[4.0, 52.0], [4.2, 52.0]]

    def test_stationary_aircraft_adds_no_duplicate_points(self, proxy):
        mgr = proxy.trail_mgr
        mgr.record(frame(0.0, KL1=(52.0, 4.0)))
        mgr.record(frame(10.0, KL1=(52.0, 4.0)))
        assert mgr.snapshot()["trails"]["KL1"] == [[4.0, 52.0]]

    def test_new_aircraft_is_seeded_between_samples(self, proxy):
        mgr = proxy.trail_mgr
        mgr.record(frame(0.0, KL1=(52.0, 4.0)))
        mgr.record(frame(1.0, KL1=(52.0, 4.1), KL2=(51.0, 3.0)))
        trails = mgr.snapshot()["trails"]
        assert trails["KL2"] == [[3.0, 51.0]]
        assert trails["KL1"] == [[4.0, 52.0]]  # not extended off-interval

    def test_trail_is_deleted_when_the_aircraft_leaves(self, proxy):
        mgr = proxy.trail_mgr
        mgr.record(frame(0.0, KL1=(52.0, 4.0), KL2=(51.0, 3.0)))
        mgr.record(frame(1.0, KL2=(51.0, 3.1)))
        assert list(mgr.snapshot()["trails"]) == ["KL2"]

    def test_empty_frame_clears_everything(self, proxy):
        mgr = proxy.trail_mgr
        mgr.record(frame(0.0, KL1=(52.0, 4.0)))
        mgr.record({"simt": 1.0, "id": [], "lat": [], "lon": []})
        assert mgr.snapshot() == {"simt": None, "trails": {}}

    def test_clock_running_backwards_restarts_the_history(self, proxy):
        mgr = proxy.trail_mgr
        mgr.record(frame(500.0, KL1=(52.0, 4.0)))
        mgr.record(frame(505.0, KL1=(52.0, 4.5)))
        mgr.record(frame(0.0, KL1=(10.0, 10.0)))
        assert mgr.snapshot()["trails"]["KL1"] == [[10.0, 10.0]]

    def test_invalid_positions_are_skipped_and_longitude_wrapped(self, proxy):
        mgr = proxy.trail_mgr
        mgr.record(frame(0.0, BAD=(float("nan"), 4.0), FAR=(10.0, 190.0)))
        assert mgr.snapshot()["trails"] == {"FAR": [[-170.0, 10.0]]}

    def test_decodes_msgpack_encoded_numpy_arrays(self, proxy):
        def encoded(values):
            arr = np.array(values, dtype=float)
            return {
                b"numpy": True,
                b"type": arr.dtype.str,
                b"shape": arr.shape,
                b"data": arr.tobytes(),
            }

        proxy.trail_mgr.record(
            {"simt": 1.0, "id": ["KL1"], "lat": encoded([52.0]), "lon": encoded([4.0])}
        )
        assert proxy.trail_mgr.snapshot()["trails"] == {"KL1": [[4.0, 52.0]]}

    def test_falls_back_to_the_siminfo_clock(self, proxy):
        proxy.sim_data = {"simt": 42.0}
        data = frame(0.0, KL1=(52.0, 4.0))
        del data["simt"]
        proxy.trail_mgr.record(data)
        assert proxy.trail_mgr.snapshot()["simt"] == 42.0


class TestTrailBounds:
    def test_interval_stretches_with_traffic_size(self, proxy):
        mgr = proxy.trail_mgr
        assert mgr.sample_interval(1) == 5.0
        assert mgr.sample_interval(1000) == 5.0
        assert mgr.sample_interval(1001) == 10.0
        assert mgr.sample_interval(5000) == 25.0

    def test_long_trail_is_thinned_keeping_both_ends(self, proxy, monkeypatch):
        monkeypatch.setattr(TrailManager, "MAX_POINTS", 10)
        mgr = proxy.trail_mgr
        for step in range(40):
            mgr.record(frame(step * 5.0, KL1=(50.0, step * 0.1)))
        trail = mgr.snapshot()["trails"]["KL1"]
        assert len(trail) <= 10
        assert trail[0] == [0.0, 50.0]
        assert trail[-1] == [3.9, 50.0]
        assert trail == sorted(trail)


class TestTrailLifecycle:
    def test_acdata_handler_records_even_when_emission_is_throttled(
        self, proxy, fake_socketio
    ):
        on_acdata_received(frame(0.0, KL1=(52.0, 4.0)))
        on_acdata_received(frame(5.0, KL1=(52.0, 4.5)))  # inside the 10 Hz throttle
        assert fake_socketio.count("acdata") == 1
        assert len(proxy.trail_mgr.snapshot()["trails"]["KL1"]) == 2

    def test_reset_clears_trails(self, proxy, fake_socketio):
        proxy.trail_mgr.record(frame(0.0, KL1=(52.0, 4.0)))
        on_reset_received(sender_id=b"\x01\x02")
        assert proxy.trail_mgr.snapshot()["trails"] == {}

    def test_disconnect_clears_trails(self, proxy):
        proxy.trail_mgr.record(frame(0.0, KL1=(52.0, 4.0)))
        proxy.data_mgr._reset_cached_state()
        assert proxy.trail_mgr.snapshot()["trails"] == {}

    def test_node_switch_clears_trails(self, proxy):
        proxy.running = True
        proxy.trail_mgr.record(frame(0.0, KL1=(52.0, 4.0)))
        proxy.node_mgr._on_actnode_changed(b"\x01")
        assert proxy.trail_mgr.snapshot()["trails"] == {}
