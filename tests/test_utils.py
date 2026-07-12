"""Tests for WebATM.utils (JSON serialization and time helpers)."""

import struct

import numpy as np

from WebATM.utils import (
    empty_traffic_data,
    i2txt,
    id2str,
    make_json_serializable,
    tim2txt,
)


class TestI2txt:
    def test_pads_with_leading_zeros(self):
        assert i2txt(5, 3) == "005"

    def test_no_padding_when_already_wide(self):
        assert i2txt(123, 3) == "123"

    def test_value_wider_than_width_is_not_truncated(self):
        assert i2txt(12345, 3) == "12345"

    def test_zero(self):
        assert i2txt(0, 2) == "00"


class TestTim2txt:
    def test_zero_time(self):
        assert tim2txt(0) == "00:00:00.00"

    def test_hours_minutes_seconds_and_hundredths(self):
        # 1h 1m 1.5s -> hundredths = 50
        assert tim2txt(3661.5) == "01:01:01.50"

    def test_hundredths_truncated_not_rounded(self):
        # 0.999s -> int(0.999 * 100) == 99
        assert tim2txt(0.999) == "00:00:00.99"

    def test_returns_string(self):
        assert isinstance(tim2txt(42.0), str)


class TestMakeJsonSerializable:
    def test_numpy_array_becomes_list(self):
        arr = np.array([1, 2, 3])
        assert make_json_serializable(arr) == [1, 2, 3]

    def test_numpy_integer_becomes_int(self):
        result = make_json_serializable(np.int64(7))
        assert result == 7
        assert isinstance(result, int)

    def test_numpy_float_becomes_float(self):
        result = make_json_serializable(np.float64(3.5))
        assert result == 3.5
        assert isinstance(result, float)

    def test_bytes_keys_in_dict_are_decoded(self):
        obj = {b"alpha": 1, b"beta": 2}
        assert make_json_serializable(obj) == {"alpha": 1, "beta": 2}

    def test_nested_structures(self):
        obj = {b"items": [np.int64(1), {b"x": np.float64(2.0)}]}
        assert make_json_serializable(obj) == {"items": [1, {"x": 2.0}]}

    def test_tuple_becomes_list(self):
        assert make_json_serializable((1, 2, 3)) == [1, 2, 3]

    def test_object_with_dict_is_recursively_serialized(self):
        class Thing:
            def __init__(self):
                self.value = np.int64(9)

        assert make_json_serializable(Thing()) == {"value": 9}

    def test_passthrough_primitives(self):
        assert make_json_serializable("hello") == "hello"
        assert make_json_serializable(42) == 42
        assert make_json_serializable(None) is None

    def test_bluesky_serialized_numpy_double_array(self):
        data_bytes = struct.pack("<3d", 1.0, 2.0, 3.0)
        obj = {
            b"numpy": True,
            b"data": data_bytes,
            b"type": "<f8",
            b"shape": [3],
        }
        assert make_json_serializable(obj) == [1.0, 2.0, 3.0]

    def test_bluesky_serialized_numpy_int_array(self):
        data_bytes = struct.pack("<2i", 10, 20)
        obj = {
            b"numpy": True,
            b"data": data_bytes,
            b"type": "<i4",
            b"shape": [2],
        }
        assert make_json_serializable(obj) == [10, 20]

    def test_bluesky_serialized_numpy_type_as_bytes(self):
        data_bytes = struct.pack("<1d", 4.5)
        obj = {
            b"numpy": True,
            b"data": data_bytes,
            b"type": b"<f8",
            b"shape": [1],
        }
        assert make_json_serializable(obj) == [4.5]

    def test_bluesky_serialized_numpy_multidim_shape(self):
        data_bytes = struct.pack("<4d", 1.0, 2.0, 3.0, 4.0)
        obj = {
            b"numpy": True,
            b"data": data_bytes,
            b"type": "<f8",
            b"shape": [2, 2],
        }
        # The deserializer flattens to a single list of values.
        assert make_json_serializable(obj) == [1.0, 2.0, 3.0, 4.0]

    def test_bluesky_serialized_unknown_dtype_falls_back_to_hex(self):
        data_bytes = b"\x01\x02\x03\x04"
        obj = {
            b"numpy": True,
            b"data": data_bytes,
            b"type": "<f2",  # not in the dtype map
            b"shape": [2],
        }
        assert make_json_serializable(obj) == data_bytes.hex()

    def test_plain_dict_without_all_numpy_keys_is_treated_normally(self):
        # Has b"numpy" but is missing b"data"/b"type"/b"shape": normal dict path.
        obj = {b"numpy": True, b"other": 1}
        assert make_json_serializable(obj) == {"numpy": True, "other": 1}


class TestId2str:
    def test_bytes_become_hex(self):
        assert id2str(b"\x01\x02") == "0102"

    def test_none_stays_none(self):
        assert id2str(None) is None

    def test_string_passes_through(self):
        assert id2str("abcd") == "abcd"


class TestEmptyTrafficData:
    def test_all_arrays_empty_and_counters_zero(self):
        payload = empty_traffic_data()
        for field in (
            "id",
            "lat",
            "lon",
            "alt",
            "actype",
            "tas",
            "trk",
            "vs",
            "inconf",
            "tcpamax",
        ):
            assert payload[field] == []
        for counter in ("nconf_cur", "nconf_tot", "nlos_cur", "nlos_tot"):
            assert payload[counter] == 0

    def test_includes_actype_field(self):
        # actype must be present so the reset and disconnect clear paths emit
        # an identical acdata shape.
        assert "actype" in empty_traffic_data()

    def test_returns_fresh_dict_each_call(self):
        first = empty_traffic_data()
        first["id"].append("AC1")
        assert empty_traffic_data()["id"] == []
