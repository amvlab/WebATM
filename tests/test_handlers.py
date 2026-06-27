"""Tests for the proxy event handlers (WebATM.proxy.handlers.*).

These handlers fetch the process-global proxy via ``get_bluesky_proxy()``; the
``proxy`` fixture registers a real proxy (wired to a fake Socket.IO) as that
global, so the handlers operate against it directly.
"""

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
    def test_clears_shapes_and_emits(self, proxy, fake_client, fake_socketio):
        proxy.bluesky_client = fake_client
        fake_client.context.sender_id = b"NODE1"
        proxy.poly_data_by_node["4e4f444531"] = {"polys": {"a": {}}}
        # sender hex of b"NODE1"
        sender_hex = b"NODE1".hex()
        proxy.poly_data_by_node[sender_hex] = {"polys": {"a": {}}}
        on_reset_received()
        assert sender_hex not in proxy.poly_data_by_node
        assert fake_socketio.count("reset") == 1

    def test_ignored_when_reconnection_disallowed(self, proxy, fake_socketio):
        proxy.allow_reconnection = False
        on_reset_received()
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
