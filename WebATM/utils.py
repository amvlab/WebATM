"""Utility functions for WebATM."""

import math
from time import gmtime, strftime

import numpy as np

from .logger import get_logger

logger = get_logger()


def _finite_list(arr):
    """Return ``arr.tolist()`` with non-finite floats replaced by ``None``.

    NaN/Infinity must never reach ``json.dumps``: it writes them as bare
    ``NaN``/``Infinity`` tokens, which are invalid JSON, so every browser's
    Socket.IO parser rejects the whole packet and drops the connection (one
    aircraft created with a NaN altitude wedged all web clients in a
    connect/disconnect loop). The all-finite fast path stays a plain
    ``tolist()`` — this runs per ACDATA frame.
    """
    if arr.dtype.kind == "f" and not np.isfinite(arr).all():
        if arr.ndim != 1:
            return make_json_serializable(arr.tolist())
        return [x if math.isfinite(x) else None for x in arr.tolist()]
    return arr.tolist()


def safe_decode(data):
    """Decode bytes to a readable string without raising.

    Attempts UTF-8 decoding and returns the result only if it consists
    entirely of printable ASCII characters; otherwise falls back to an
    uppercase hexadecimal representation. Non-bytes input is converted with
    ``str()``.

    Args:
        data (bytes | object): Value to decode or stringify.

    Returns:
        str: A printable string representation of ``data``.
    """
    if isinstance(data, bytes):
        try:
            decoded = data.decode("utf-8")
        except UnicodeDecodeError:
            return data.hex().upper()
        if all(32 <= ord(c) <= 126 for c in decoded):
            return decoded
        return data.hex().upper()
    return str(data)


def make_json_serializable(obj):
    """Convert an object to a JSON-serializable format.

    Recursively converts numpy arrays and scalars, bytes, dictionaries
    (including BlueSky's msgpack-serialized numpy arrays, identified by the
    ``numpy``, ``data``, ``type`` and ``shape`` byte keys), lists, tuples, and
    arbitrary objects (via ``vars()``) into plain Python types that
    ``json.dumps`` can handle. Byte dictionary keys and values are decoded to
    strings (values via ``safe_decode``, so undecodable bytes become hex).
    Non-finite floats (NaN/Infinity) become ``None``, since ``json.dumps``
    would otherwise emit them as invalid-JSON tokens that break every browser
    client (see ``_finite_list``).

    Args:
        obj (Any): The object to convert. May be a numpy array/scalar, bytes,
            dict, list, tuple, or any object exposing ``__dict__``.

    Returns:
        Any: A JSON-serializable equivalent of ``obj`` (list, dict, int,
            float, str, or the object itself if already serializable).
    """
    if isinstance(obj, np.ndarray):
        return _finite_list(obj)
    if isinstance(obj, np.generic):
        # Any numpy scalar (np.float64, np.int32, np.bool_, np.str_, ...):
        # unwrap to the equivalent Python scalar and convert that instead.
        # json.dumps rejects the numpy types the branches below don't cover
        # (np.bool_ for one), which would drop the whole Socket.IO packet.
        obj = obj.item()
    if isinstance(obj, float):
        return obj if math.isfinite(obj) else None
    if isinstance(obj, (bytes, bytearray)):
        # msgpack bin values (e.g. raw node/sender IDs embedded in a payload)
        # are not JSON serializable and would also drop the whole packet.
        return safe_decode(bytes(obj))
    if isinstance(obj, dict):
        if b"numpy" in obj and b"data" in obj and b"type" in obj and b"shape" in obj:
            # BlueSky msgpack-encoded numpy array; decode it the same way as
            # bluesky.network.npcodec.decode_ndarray, flattened for JSON.
            try:
                dtype = obj[b"type"]
                if isinstance(dtype, bytes):
                    dtype = dtype.decode()
                return _finite_list(np.frombuffer(obj[b"data"], dtype=np.dtype(dtype)))
            except Exception as e:
                logger.warning(f"Utils: Error deserializing numpy array: {e}")
                data_bytes = obj[b"data"]
                return (
                    data_bytes.hex()
                    if isinstance(data_bytes, bytes)
                    else str(data_bytes)
                )

        return {
            (safe_decode(key) if isinstance(key, bytes) else key): (
                make_json_serializable(value)
            )
            for key, value in obj.items()
        }
    if isinstance(obj, (list, tuple)):
        return [make_json_serializable(item) for item in obj]
    if hasattr(obj, "__dict__"):
        try:
            return make_json_serializable(vars(obj))
        except Exception:
            return str(obj)
    return obj


def empty_traffic_data():
    """Return a fresh empty ACDATA payload for clearing all aircraft.

    Emitted whenever the map must drop stale traffic (simulation reset,
    active-node change, or server disconnect). A new dict is returned on each
    call so callers can cache or mutate it without sharing state.

    Returns:
        dict: An ``acdata`` payload with empty per-field arrays and zeroed
            conflict/LOS counters.
    """
    return {
        "id": [],
        "lat": [],
        "lon": [],
        "alt": [],
        "actype": [],  # only sent by bluesky/amvlab
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


def empty_sim_data(scenname=""):
    """Return a fresh empty ``siminfo`` payload for clearing the sim header.

    Same shape as the SIMINFO handler emits, so clients always receive a
    complete payload. Emitted whenever the displayed sim info becomes stale
    (active-node change, server disconnect).

    Args:
        scenname (str): Scenario name to show, e.g. ``"disconnected"`` on the
            disconnect clear path.

    Returns:
        dict: A ``siminfo`` payload with zeroed clock/speed/state fields.
    """
    return {
        "speed": 0.0,
        "simdt": 0.0,
        "simt": 0.0,
        "simutc": "",
        "ntraf": 0,
        "state": 0,
        "scenname": scenname,
        "sender_id": None,
    }


def id2str(node_id):
    """Convert a BlueSky node/sender ID to its hex-string form.

    Node IDs arrive from the network as raw bytes; WebATM keys its tracking
    maps and Socket.IO payloads by the hex-string form.

    Args:
        node_id (bytes | str | None): Raw node/sender identifier.

    Returns:
        str | None: Hex string for bytes input, ``str(node_id)`` for other
            non-None values, or None.
    """
    if isinstance(node_id, bytes):
        return node_id.hex()
    return str(node_id) if node_id is not None else None


def i2txt(i, n):
    """Convert an integer to a zero-padded string of fixed width.

    Args:
        i (int): The integer to format.
        n (int): The total width of the resulting string.

    Returns:
        str: ``i`` rendered with leading zeros to exactly ``n`` characters.
    """
    return f"{i:0{n}d}"


def tim2txt(t):
    """Convert a time value in seconds to an ``HH:MM:SS.hh`` string.

    Args:
        t (float): Time in seconds (e.g. simulation time).

    Returns:
        str: The formatted time string with hundredths of a second.
    """
    return strftime("%H:%M:%S.", gmtime(t)) + i2txt(int((t - int(t)) * 100.0), 2)
