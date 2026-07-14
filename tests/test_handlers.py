"""Tests for the proxy event handlers (WebATM.proxy.handlers.*).

These handlers fetch the process-global proxy via ``get_bluesky_proxy()``; the
``proxy`` fixture registers a real proxy (wired to a fake Socket.IO) as that
global, so the handlers operate against it directly.
"""

import time

import pytest

from WebATM.proxy import set_bluesky_proxy
from WebATM.proxy.handlers.commands import (
    on_stack_received,
    on_stackcmds_received,
)
from WebATM.proxy.handlers.echo import echo
from WebATM.proxy.handlers.events import on_request_received, on_reset_received
from WebATM.proxy.handlers.navigation import on_defwpt_received
from WebATM.proxy.handlers.routes import on_routedata_received
from WebATM.proxy.handlers.shapes import (
    _separate_poly_and_polyline_data,
    on_poly_received,
)
from WebATM.proxy.handlers.simulation import (
    on_acdata_received,
    on_siminfo_received,
    on_statechange_received,
)
from WebATM.proxy.handlers.visualization import (
    on_plot_received,
    on_showdialog_received,
    on_simsettings_received,
    on_trails_received,
)


class TestSiminfoHandler:
    def test_stores_sim_data(self, proxy, fake_socketio):
        on_siminfo_received(
            1.0, 0.05, 12.0, "2024-01-01", 3, 1, "demo", sender_id=b"\x01\x02"
        )
        assert proxy.sim_data["speed"] == 1.0
        assert proxy.sim_data["ntraf"] == 3
        assert proxy.sim_data["scenname"] == "demo"
        assert proxy.sim_data["sender_id"] == b"\x01\x02".hex()

    def test_emits_siminfo(self, proxy, fake_socketio):
        on_siminfo_received(1.0, 0.05, 12.0, "utc", 3, 1, "demo", sender_id=b"\x01")
        assert fake_socketio.count("siminfo") == 1

    def test_ignored_when_reconnection_disallowed(self, proxy, fake_socketio):
        proxy.allow_reconnection = False
        on_siminfo_received(1.0, 0.05, 12.0, "utc", 3, 1, "demo", sender_id=b"\x01")
        assert proxy.sim_data == {}
        assert fake_socketio.count("siminfo") == 0

    def test_handles_none_values(self, proxy):
        on_siminfo_received(None, None, None, None, None, None, None, sender_id=b"\x01")
        assert proxy.sim_data["speed"] == 0.0
        assert proxy.sim_data["ntraf"] == 0
        assert proxy.sim_data["scenname"] == ""

    def test_updates_tracked_node_status(self, proxy, fake_socketio):
        sender = b"\x01\x02"
        proxy.tracked_nodes[sender.hex()] = {"status": "init", "time": "00:00:00"}
        on_siminfo_received(1.0, 0.05, 0.0, "utc", 2, 1, "RUNNING", sender_id=sender)
        assert proxy.tracked_nodes[sender.hex()]["status"] == "RUNNING"

    def test_no_proxy_is_safe(self, fake_socketio):
        set_bluesky_proxy(None)
        # Should simply return without raising.
        on_siminfo_received(1.0, 0.0, 0.0, "utc", 0, 0, "x", sender_id=b"\x01")

    def test_missing_sender_id_is_handled(self, proxy, fake_socketio):
        # Regression: the old fallback imported the bluesky package (not a
        # dependency of standalone WebATM) when sender_id was missing.
        on_siminfo_received(1.0, 0.05, 12.0, "utc", 3, 1, "demo")
        assert proxy.sim_data["sender_id"] is None
        assert fake_socketio.count("siminfo") == 1


class TestSiminfoActiveNodeFiltering:
    """The header clock/rate/state must follow the ACTIVE node only (multi-node
    fix #67): on_siminfo_received caches and emits sim data solely for the active
    node, while still updating per-node tracking for every node."""

    def _activate(self, proxy, fake_client, active_bytes):
        """Wire the proxy so _get_safe_active_node() resolves to active_bytes."""
        active_hex = active_bytes.hex()
        proxy.bluesky_client = fake_client
        proxy.running = True
        proxy.was_connected = True
        fake_client.act_id = active_bytes
        proxy.tracked_nodes[active_hex] = {"status": "init", "time": "00:00:00"}
        return active_hex

    def test_active_node_updates_header_sim_data(
        self, proxy, fake_client, fake_socketio
    ):
        active = b"\xaa\xaa\xaa\xaa\x81"
        active_hex = self._activate(proxy, fake_client, active)
        on_siminfo_received(1.0, 0.05, 12.0, "utc", 3, 1, "demo", sender_id=active)
        assert proxy.sim_data["scenname"] == "demo"
        assert proxy.sim_data["sender_id"] == active_hex
        assert fake_socketio.count("siminfo") == 1

    def test_non_active_node_does_not_touch_header(
        self, proxy, fake_client, fake_socketio
    ):
        active = b"\xaa\xaa\xaa\xaa\x81"
        self._activate(proxy, fake_client, active)
        proxy.sim_data = {"scenname": "ACTIVE"}  # sentinel set by the active node
        other = b"\xbb\xbb\xbb\xbb\x81"
        proxy.tracked_nodes[other.hex()] = {"status": "init", "time": "00:00:00"}

        on_siminfo_received(2.0, 0.05, 99.0, "utc", 7, 1, "other", sender_id=other)

        # Header sim data is left untouched and nothing is emitted...
        assert proxy.sim_data == {"scenname": "ACTIVE"}
        assert fake_socketio.count("siminfo") == 0
        # ...but the non-active node's own clock/status is still tracked.
        assert proxy.tracked_nodes[other.hex()]["status"] == "other"

    def test_falls_back_to_any_sender_without_active_node(self, proxy, fake_socketio):
        # No client/active node resolvable yet -> single-node display still works.
        on_siminfo_received(1.0, 0.05, 5.0, "utc", 1, 1, "solo", sender_id=b"\x01\x02")
        assert proxy.sim_data["scenname"] == "solo"
        assert fake_socketio.count("siminfo") == 1


class TestSiminfoNodeInfoThrottle:
    """The Simulation Nodes panel is refreshed on a wall-clock cadence
    (``node_info_interval``), not on a sim-time modulo. A sim-time throttle
    spams while paused on a multiple, never fires while paused off-multiple, and
    skips refreshes when fast-forwarding past the multiple."""

    def _track(self, proxy, sender=b"\x01\x02"):
        proxy.tracked_nodes[sender.hex()] = {"status": "init", "time": "00:00:00"}
        return sender

    def test_refreshes_when_interval_elapsed(self, proxy, fake_socketio):
        sender = self._track(proxy)
        proxy.last_node_info_emit = 0  # long ago -> interval has elapsed
        # simt=3.0 is NOT a multiple of 5; the old throttle would stay silent.
        on_siminfo_received(1.0, 0.05, 3.0, "utc", 1, 1, "run", sender_id=sender)
        assert fake_socketio.count("node_info") == 1

    def test_suppressed_within_interval(self, proxy, fake_socketio):
        sender = self._track(proxy)
        proxy.node_info_interval = 1.0
        proxy.last_node_info_emit = time.time()  # just emitted
        # simt=5.0 IS a multiple of 5; the old throttle would have spammed here.
        on_siminfo_received(1.0, 0.05, 5.0, "utc", 1, 1, "run", sender_id=sender)
        assert fake_socketio.count("node_info") == 0

    def test_emit_advances_timestamp(self, proxy, fake_socketio):
        sender = self._track(proxy)
        proxy.last_node_info_emit = 0
        before = time.time()
        on_siminfo_received(1.0, 0.05, 7.0, "utc", 1, 1, "run", sender_id=sender)
        assert fake_socketio.count("node_info") == 1
        assert proxy.last_node_info_emit >= before


class TestAcdataHandler:
    def test_stores_and_emits_traffic_data(self, proxy, fake_socketio):
        data = {"id": ["AC1", "AC2"], "lat": [1.0, 2.0]}
        on_acdata_received(data)
        assert proxy.traffic_data["id"] == ["AC1", "AC2"]
        assert fake_socketio.count("acdata") == 1

    def test_ignored_when_reconnection_disallowed(self, proxy, fake_socketio):
        proxy.allow_reconnection = False
        on_acdata_received({"id": ["AC1"]})
        assert proxy.traffic_data == {}

    def test_reset_clears_aircraft(self, proxy, fake_client, fake_socketio):
        proxy.bluesky_client = fake_client
        fake_client.context.action = fake_client.context.Reset
        on_acdata_received({"id": ["AC1"]})
        emitted = fake_socketio.last("acdata")
        assert emitted["id"] == []
        # Canonical empty payload shape (matches the disconnect clear path).
        from WebATM.utils import empty_traffic_data

        assert emitted == empty_traffic_data()


class TestAcdataActiveNodeFiltering:
    """Traffic is displayed for the ACTIVE node only: on_acdata_received caches
    and emits the active node's aircraft and skips frames from background nodes
    *before* serializing them, mirroring the SIMINFO active-node filter."""

    def _activate(self, proxy, fake_client, active_bytes):
        """Wire the proxy so _get_safe_active_node() resolves to active_bytes."""
        active_hex = active_bytes.hex()
        proxy.bluesky_client = fake_client
        proxy.running = True
        proxy.was_connected = True
        fake_client.act_id = active_bytes
        proxy.tracked_nodes[active_hex] = {"status": "init", "time": "00:00:00"}
        return active_hex

    def test_active_node_traffic_is_stored_and_emitted(
        self, proxy, fake_client, fake_socketio
    ):
        active = b"\xaa\xaa\xaa\xaa\x81"
        self._activate(proxy, fake_client, active)
        fake_client.context.sender_id = active

        on_acdata_received({"id": ["AC1", "AC2"]})

        assert proxy.traffic_data["id"] == ["AC1", "AC2"]
        assert fake_socketio.count("acdata") == 1

    def test_non_active_node_traffic_is_dropped(
        self, proxy, fake_client, fake_socketio
    ):
        active = b"\xaa\xaa\xaa\xaa\x81"
        self._activate(proxy, fake_client, active)
        other = b"\xbb\xbb\xbb\xbb\x81"
        proxy.tracked_nodes[other.hex()] = {"status": "init", "time": "00:00:00"}
        fake_client.context.sender_id = other

        on_acdata_received({"id": ["GHOST"]})

        # A background node's traffic is neither cached nor emitted.
        assert proxy.traffic_data == {}
        assert fake_socketio.count("acdata") == 0

    def test_non_active_node_still_counts_as_liveness(self, proxy, fake_client):
        active = b"\xaa\xaa\xaa\xaa\x81"
        self._activate(proxy, fake_client, active)
        other = b"\xbb\xbb\xbb\xbb\x81"
        proxy.tracked_nodes[other.hex()] = {"status": "init", "time": "00:00:00"}
        fake_client.context.sender_id = other
        proxy.last_successful_update = 0.0

        on_acdata_received({"id": ["GHOST"]})

        # Filtered for display, but receiving it still proves the link is alive.
        assert proxy.last_successful_update > 0.0

    def test_falls_back_to_any_sender_without_active_node(self, proxy, fake_socketio):
        # No client / active node resolvable yet -> single-node display works.
        on_acdata_received({"id": ["SOLO"]})
        assert proxy.traffic_data["id"] == ["SOLO"]
        assert fake_socketio.count("acdata") == 1


class TestAcdataThrottle:
    """Serializing + emitting only happen when an emit is actually due
    (acdata_interval); rapid frames within the window are skipped wholesale."""

    def test_second_frame_within_interval_is_not_re_emitted(self, proxy, fake_socketio):
        on_acdata_received({"id": ["AC1"]})
        assert fake_socketio.count("acdata") == 1
        cached = proxy.traffic_data

        # A second frame immediately after (well within acdata_interval) is not
        # re-emitted, and the cached frame is left untouched (not re-serialized).
        on_acdata_received({"id": ["AC2"]})
        assert fake_socketio.count("acdata") == 1
        assert proxy.traffic_data is cached
        assert proxy.traffic_data["id"] == ["AC1"]


class TestStatechangeHandler:
    def test_emits_statechange(self, proxy, fake_socketio):
        proxy.sim_data = {"state": 0}
        on_statechange_received({"simstate": 2}, sender_id=b"\x01")
        payload = fake_socketio.last("statechange")
        assert payload["simstate"] == 2
        assert proxy.sim_data["state"] == 2

    def test_missing_simstate_is_ignored(self, proxy, fake_socketio):
        on_statechange_received({"other": 1}, sender_id=b"\x01")
        assert fake_socketio.count("statechange") == 0

    def test_ignored_when_reconnection_disallowed(self, proxy, fake_socketio):
        proxy.allow_reconnection = False
        on_statechange_received({"simstate": 1})
        assert fake_socketio.count("statechange") == 0

    def test_empty_sim_data_is_not_seeded(self, proxy, fake_socketio):
        # Without a cached SIMINFO payload there is nothing to patch; seeding
        # {'state': ...} would let the backup timer emit a partial siminfo.
        on_statechange_received({"simstate": 2}, sender_id=b"\x01")
        assert proxy.sim_data == {}
        assert fake_socketio.count("statechange") == 1


class TestStatechangeActiveNodeFiltering:
    """Like SIMINFO, STATECHANGE must only touch the cached header state for
    the active node: a paused background node must not flip the displayed
    run-state (which the 0.5 s backup emit would then broadcast as siminfo)."""

    def _activate(self, proxy, fake_client, active_bytes):
        proxy.bluesky_client = fake_client
        proxy.running = True
        proxy.was_connected = True
        fake_client.act_id = active_bytes
        proxy.tracked_nodes[active_bytes.hex()] = {
            "status": "init",
            "time": "00:00:00",
        }

    def test_active_node_updates_state(self, proxy, fake_client, fake_socketio):
        active = b"\xaa\xaa\xaa\xaa\x81"
        self._activate(proxy, fake_client, active)
        proxy.sim_data = {"state": 2}
        on_statechange_received({"simstate": 1}, sender_id=active)
        assert proxy.sim_data["state"] == 1
        assert fake_socketio.last("statechange")["sender_id"] == active.hex()

    def test_background_node_is_ignored(self, proxy, fake_client, fake_socketio):
        active = b"\xaa\xaa\xaa\xaa\x81"
        self._activate(proxy, fake_client, active)
        proxy.sim_data = {"state": 2}  # active node is running (OP)

        other = b"\xbb\xbb\xbb\xbb\x81"
        on_statechange_received({"simstate": 1}, sender_id=other)  # HOLD elsewhere

        assert proxy.sim_data["state"] == 2
        assert fake_socketio.count("statechange") == 0

    def test_falls_back_to_any_sender_without_active_node(self, proxy, fake_socketio):
        proxy.sim_data = {"state": 0}
        on_statechange_received({"simstate": 2}, sender_id=b"\x01")
        assert proxy.sim_data["state"] == 2
        assert fake_socketio.count("statechange") == 1


class TestEchoHandler:
    def test_stores_and_emits_echo(self, proxy, fake_socketio):
        echo("hello world", flags=1, sender_id=b"NODE1")
        assert proxy.echo_data["text"] == "hello world"
        assert proxy.echo_data["flags"] == 1
        assert proxy.echo_data["sender"] == "NODE1"
        assert fake_socketio.count("echo") == 1

    def test_none_text_becomes_empty_string(self, proxy):
        echo(None)
        assert proxy.echo_data["text"] == ""

    def test_ignored_when_reconnection_disallowed(self, proxy, fake_socketio):
        proxy.allow_reconnection = False
        echo("test")
        assert fake_socketio.count("echo") == 0


class TestStackcmdsHandler:
    def test_updates_cmddict_and_emits(self, proxy, fake_socketio):
        on_stackcmds_received("UPDATE", {"cmddict": {"CRE": "acid,type"}})
        assert proxy.cmddict["CRE"] == "acid,type"
        assert fake_socketio.count("cmddict") == 1

    def test_non_dict_data_does_not_raise(self, proxy):
        on_stackcmds_received("UPDATE", "some string")
        on_stackcmds_received("UPDATE", b"bytes")


class TestStackReceivedHandler:
    def test_local_help_command_executed(self, proxy, fake_socketio):
        on_stack_received("HELP")
        # HELP is in the seed cmddict -> executed locally -> echo emitted.
        assert fake_socketio.count("echo") == 1
        assert "executed" in proxy.echo_data["text"].lower()

    def test_unknown_command_reports_not_implemented(self, proxy):
        on_stack_received("NOSUCHCMD")
        assert "not implemented" in proxy.echo_data["text"].lower()

    def test_list_of_commands(self, proxy, fake_socketio):
        on_stack_received(["HELP", "?"])
        assert fake_socketio.count("echo") == 2

    def test_empty_command_skipped(self, proxy, fake_socketio):
        on_stack_received(["", "   "])
        assert fake_socketio.count("echo") == 0


class TestResetHandler:
    def test_clears_shapes_and_emits(self, proxy, fake_socketio):
        sender_hex = b"NODE1".hex()
        proxy.poly_data_by_node[sender_hex] = {"polys": {"a": {}}}
        on_reset_received(sender_id=b"NODE1")
        assert sender_hex not in proxy.poly_data_by_node
        assert fake_socketio.count("reset") == 1

    def test_ignored_when_reconnection_disallowed(self, proxy, fake_socketio):
        proxy.allow_reconnection = False
        on_reset_received()
        assert fake_socketio.count("reset") == 0


class TestResetActiveNodeScoping:
    """A RESET only affects the node that sent it: browsers display the active
    node, so a background node's reset must neither delete the active node's
    stored shapes nor emit the map-wiping ``poly``/``polyline``/``reset``
    events (which clear aircraft, selection and shapes frontend-side)."""

    def _activate(self, proxy, fake_client, active_bytes):
        """Wire the proxy so _get_safe_active_node() resolves to active_bytes."""
        active_hex = active_bytes.hex()
        proxy.bluesky_client = fake_client
        proxy.running = True
        proxy.was_connected = True
        fake_client.act_id = active_bytes
        proxy.tracked_nodes[active_hex] = {"status": "init", "time": "00:00:00"}
        return active_hex

    def test_background_node_reset_leaves_active_display_alone(
        self, proxy, fake_client, fake_socketio
    ):
        active = b"\xaa\xaa\xaa\xaa\x81"
        active_hex = self._activate(proxy, fake_client, active)
        other = b"\xbb\xbb\xbb\xbb\x81"
        other_hex = other.hex()
        proxy.tracked_nodes[other_hex] = {"status": "init", "time": "00:00:00"}
        proxy.poly_data_by_node = {
            active_hex: {"polys": {"keep": {}}},
            other_hex: {"polys": {"stale": {}}},
        }
        proxy.polyline_data_by_node = {active_hex: {"polys": {"keep": {}}}}

        on_reset_received(sender_id=other)

        # The resetting node's shapes are dropped, the active node's are kept.
        assert other_hex not in proxy.poly_data_by_node
        assert proxy.poly_data_by_node[active_hex] == {"polys": {"keep": {}}}
        assert proxy.polyline_data_by_node[active_hex] == {"polys": {"keep": {}}}
        # Nothing display-clearing reaches the browser.
        assert fake_socketio.count("reset") == 0
        assert fake_socketio.count("poly") == 0
        assert fake_socketio.count("polyline") == 0

    def test_active_node_reset_clears_and_emits(
        self, proxy, fake_client, fake_socketio
    ):
        active = b"\xaa\xaa\xaa\xaa\x81"
        active_hex = self._activate(proxy, fake_client, active)
        proxy.poly_data_by_node = {active_hex: {"polys": {"stale": {}}}}

        on_reset_received(sender_id=active)

        assert active_hex not in proxy.poly_data_by_node
        assert fake_socketio.count("reset") == 1
        assert fake_socketio.last("poly") == {"polys": {}}
        assert fake_socketio.last("polyline") == {"polys": {}}

    def test_unresolvable_sender_falls_back_to_active_node(
        self, proxy, fake_client, fake_socketio
    ):
        active = b"\xaa\xaa\xaa\xaa\x81"
        active_hex = self._activate(proxy, fake_client, active)
        proxy.poly_data_by_node = {active_hex: {"polys": {"stale": {}}}}

        on_reset_received()  # no sender resolvable -> active-node fallback

        assert active_hex not in proxy.poly_data_by_node
        assert fake_socketio.count("reset") == 1

    def test_no_sender_and_no_active_node_is_a_noop(self, proxy, fake_socketio):
        proxy.poly_data_by_node = {"somenode": {"polys": {"kept": {}}}}

        on_reset_received()

        assert proxy.poly_data_by_node == {"somenode": {"polys": {"kept": {}}}}
        assert fake_socketio.count("reset") == 0


class TestSmokeHandlers:
    """Handlers that currently just update bookkeeping; verify they are safe."""

    def test_request_handler(self, proxy):
        proxy.last_successful_update = 0
        on_request_received(["POLY"])
        assert proxy.last_successful_update > 0

    def test_defwpt_handler(self, proxy):
        proxy.last_successful_update = 0
        on_defwpt_received({"wpt": "ABC"})
        assert proxy.last_successful_update > 0

    def test_plot_handler(self, proxy):
        on_plot_received({"data": 1})  # should not raise

    def test_showdialog_handler(self, proxy):
        on_showdialog_received({"dialog": "x"})

    def test_simsettings_handler(self, proxy):
        on_simsettings_received({"setting": 1})

    def test_trails_handler(self, proxy):
        on_trails_received({"trail": []})

    def test_disallowed_reconnection_short_circuits(self, proxy):
        proxy.allow_reconnection = False
        proxy.last_successful_update = 0
        on_request_received(["POLY"])
        # Early-returns without updating the timestamp.
        assert proxy.last_successful_update == 0


class TestRoutedataHandler:
    def test_no_active_node_short_circuits(self, proxy, fake_socketio):
        # No active node configured -> nothing emitted.
        on_routedata_received({"acid": "AC1"})
        assert fake_socketio.count("routedata") == 0

    def test_ignored_when_reconnection_disallowed(self, proxy, fake_socketio):
        proxy.allow_reconnection = False
        on_routedata_received({"acid": "AC1"})
        assert fake_socketio.count("routedata") == 0


class TestSeparatePolyAndPolyline:
    def test_separates_by_shape_field(self):
        poly_data = {
            "polys": {
                "area1": {
                    "shape": "POLY",
                    "coordinates": [1.0, 2.0, 3.0, 4.0, 5.0, 6.0],
                },
                "line1": {"shape": "LINE", "coordinates": [1.0, 2.0, 3.0, 4.0]},
            }
        }
        result = _separate_poly_and_polyline_data(poly_data)
        assert "area1" in result["polygons"]["polys"]
        assert "line1" in result["polylines"]["polys"]

    def test_line_coordinates_split_into_lat_lon(self):
        poly_data = {
            "polys": {
                "line1": {"shape": "LINE", "coordinates": [10.0, 20.0, 30.0, 40.0]},
            }
        }
        result = _separate_poly_and_polyline_data(poly_data)
        line = result["polylines"]["polys"]["line1"]
        assert line["lat"] == [10.0, 30.0]
        assert line["lon"] == [20.0, 40.0]

    def test_polyalt_converted_to_poly(self):
        poly_data = {
            "polys": {
                "alt1": {
                    "shape": "POLYALT",
                    "coordinates": [1.0, 2.0, 3.0, 4.0, 5.0, 6.0],
                },
            }
        }
        result = _separate_poly_and_polyline_data(poly_data)
        assert result["polygons"]["polys"]["alt1"]["shape"] == "POLY"

    def test_poly_without_shape_defaults_to_polygon(self):
        poly_data = {"polys": {"area": {"coordinates": [1.0, 2.0, 3.0, 4.0, 5.0, 6.0]}}}
        result = _separate_poly_and_polyline_data(poly_data)
        assert "area" in result["polygons"]["polys"]

    def test_box_expanded_to_four_corner_polygon(self):
        # BlueSky sends a BOX as two opposite corners [lat0, lon0, lat1, lon1].
        poly_data = {
            "polys": {
                "box1": {"shape": "BOX", "coordinates": [48.0, 2.0, 49.0, 3.0]},
            }
        }
        result = _separate_poly_and_polyline_data(poly_data)
        box = result["polygons"]["polys"]["box1"]
        assert box["shape"] == "POLY"
        # Four corners of the axis-aligned rectangle.
        assert box["lat"] == [48.0, 48.0, 49.0, 49.0]
        assert box["lon"] == [2.0, 3.0, 3.0, 2.0]

    def test_circle_tessellated_into_polygon_ring(self):
        # BlueSky sends a CIRCLE as [clat, clon, radius_nm].
        poly_data = {
            "polys": {
                "circ1": {"shape": "CIRCLE", "coordinates": [45.0, 5.0, 10.0]},
            }
        }
        result = _separate_poly_and_polyline_data(poly_data)
        circ = result["polygons"]["polys"]["circ1"]
        assert circ["shape"] == "POLY"
        # A full ring of points, all offset from the centre by ~radius/60 deg.
        assert len(circ["lat"]) == len(circ["lon"]) > 8
        # First point sits due north of the centre (theta = 0): dlat = 10/60.
        assert circ["lat"][0] == pytest.approx(45.0 + 10.0 / 60.0)
        assert circ["lon"][0] == pytest.approx(5.0)
        # Every ring point stays within the bounding radius of the centre.
        max_dlat = max(abs(v - 45.0) for v in circ["lat"])
        assert max_dlat == pytest.approx(10.0 / 60.0)

    def test_finite_altitudes_passed_through_for_3d(self):
        # amvlab BlueSky publishes top/bottom (metres) for a 3D volume.
        poly_data = {
            "polys": {
                "vol1": {
                    "shape": "POLYALT",
                    "coordinates": [1.0, 2.0, 3.0, 4.0, 5.0, 6.0],
                    "top": 3000.0,
                    "bottom": 500.0,
                },
            }
        }
        result = _separate_poly_and_polyline_data(poly_data)
        vol = result["polygons"]["polys"]["vol1"]
        assert vol["top"] == 3000.0
        assert vol["bottom"] == 500.0

    def test_box_altitudes_passed_through(self):
        # A BOX with a vertical extent should also carry top/bottom to the 3D path.
        poly_data = {
            "polys": {
                "box3d": {
                    "shape": "BOX",
                    "coordinates": [48.0, 2.0, 49.0, 3.0],
                    "top": 3048.0,
                    "bottom": 610.0,
                },
            }
        }
        result = _separate_poly_and_polyline_data(poly_data)
        box = result["polygons"]["polys"]["box3d"]
        assert box["shape"] == "POLY"
        assert box["lat"] == [48.0, 48.0, 49.0, 49.0]
        assert box["top"] == 3048.0
        assert box["bottom"] == 610.0

    def test_unbounded_sentinel_altitudes_dropped(self):
        # BlueSky's +/-1e9 "unbounded" sentinels must not reach the 3D renderer.
        poly_data = {
            "polys": {
                "flat": {
                    "shape": "POLY",
                    "coordinates": [1.0, 2.0, 3.0, 4.0, 5.0, 6.0],
                    "top": 1e9,
                    "bottom": -1e9,
                },
            }
        }
        result = _separate_poly_and_polyline_data(poly_data)
        flat = result["polygons"]["polys"]["flat"]
        assert "top" not in flat
        assert "bottom" not in flat

    def test_vanilla_bluesky_without_altitudes_stays_flat(self):
        # Vanilla BlueSky sends no top/bottom - shape must render flat (no keys).
        poly_data = {
            "polys": {
                "z": {"shape": "POLY", "coordinates": [1.0, 2.0, 3.0, 4.0, 5.0, 6.0]},
            }
        }
        result = _separate_poly_and_polyline_data(poly_data)
        z = result["polygons"]["polys"]["z"]
        assert "top" not in z
        assert "bottom" not in z

    def test_partial_bound_keeps_finite_side_only(self):
        # Only a finite ceiling: keep top, drop the sentinel floor.
        poly_data = {
            "polys": {
                "ceil": {
                    "shape": "POLY",
                    "coordinates": [1.0, 2.0, 3.0, 4.0, 5.0, 6.0],
                    "top": 2000.0,
                    "bottom": -1e9,
                },
            }
        }
        result = _separate_poly_and_polyline_data(poly_data)
        ceil = result["polygons"]["polys"]["ceil"]
        assert ceil["top"] == 2000.0
        assert "bottom" not in ceil

    def test_box_with_malformed_coordinates_kept_as_polygon(self):
        # Too few values to be a box - stored without lat/lon (frontend skips it)
        # rather than raising.
        poly_data = {"polys": {"bad": {"shape": "BOX", "coordinates": [1.0, 2.0]}}}
        result = _separate_poly_and_polyline_data(poly_data)
        assert "bad" in result["polygons"]["polys"]
        assert "lat" not in result["polygons"]["polys"]["bad"]

    def test_unexpected_format_treated_as_polygons(self):
        result = _separate_poly_and_polyline_data({"unexpected": True})
        assert result["polygons"] == {"unexpected": True}


class TestPolyReceivedHandler:
    def test_stores_poly_data_by_node(self, proxy, fake_client):
        proxy.bluesky_client = fake_client
        fake_client.context.sender_id = b"NODE1"
        data = {
            "polys": {
                "area1": {
                    "shape": "POLY",
                    "coordinates": [1.0, 2.0, 3.0, 4.0, 5.0, 6.0],
                }
            }
        }
        on_poly_received(data)
        sender_hex = b"NODE1".hex()
        assert sender_hex in proxy.poly_data_by_node
        assert "area1" in proxy.poly_data_by_node[sender_hex]["polys"]

    def test_ignored_when_reconnection_disallowed(self, proxy):
        proxy.allow_reconnection = False
        on_poly_received({"polys": {}})
        assert proxy.poly_data_by_node == {}
