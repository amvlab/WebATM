"""Utility functions for WebATM."""

from time import gmtime, strftime

import numpy as np

from .logger import get_logger

logger = get_logger()


def make_json_serializable(obj):
    """Convert an object to a JSON-serializable format.

    Recursively converts numpy arrays and scalars, dictionaries (including
    BlueSky's msgpack-serialized numpy arrays, identified by the ``numpy``,
    ``data``, ``type`` and ``shape`` byte keys), lists, tuples, and arbitrary
    objects (via ``vars()``) into plain Python types that ``json.dumps`` can
    handle. Byte dictionary keys are decoded to strings.

    Args:
        obj (Any): The object to convert. May be a numpy array/scalar, dict, list,
            tuple, or any object exposing ``__dict__``.

    Returns:
        Any: A JSON-serializable equivalent of ``obj`` (list, dict, int,
            float, str, or the object itself if already serializable).
    """
    if isinstance(obj, np.ndarray):
        return obj.tolist()
    elif isinstance(obj, np.integer):
        return int(obj)
    elif isinstance(obj, np.floating):
        return float(obj)
    elif isinstance(obj, dict):
        # Handle BlueSky's serialized numpy arrays
        if b"numpy" in obj and b"data" in obj and b"type" in obj and b"shape" in obj:
            try:
                # This is a BlueSky serialized numpy array - deserialize it
                import struct

                dtype = (
                    obj[b"type"].decode()
                    if isinstance(obj[b"type"], bytes)
                    else obj[b"type"]
                )
                shape = obj[b"shape"]
                data_bytes = obj[b"data"]

                # Convert numpy dtype string to struct format
                dtype_map = {
                    "<f8": "d",  # double
                    "<f4": "f",  # float
                    "<i8": "q",  # long long
                    "<i4": "i",  # int
                    "|b1": "?",  # bool
                }

                if dtype in dtype_map:
                    format_char = dtype_map[dtype]
                    num_elements = 1
                    for dim in shape:
                        num_elements *= dim

                    # Unpack the binary data
                    values = list(
                        struct.unpack(f"<{num_elements}{format_char}", data_bytes)
                    )

                    # Return as list for JSON serialization
                    return values
                else:
                    logger.warning(
                        f"Utils: Unknown numpy dtype {dtype}, returning raw data"
                    )
                    return obj[b"data"].hex()  # Return as hex string if we can't parse

            except Exception as e:
                logger.warning(f"Utils: Error deserializing numpy array: {e}")
                # Fall back to converting dict normally
                pass

        # Normal dict processing
        return {
            (key.decode() if isinstance(key, bytes) else key): make_json_serializable(
                value
            )
            for key, value in obj.items()
        }
    elif isinstance(obj, (list, tuple)):
        return [make_json_serializable(item) for item in obj]
    elif hasattr(obj, "__dict__"):
        try:
            return make_json_serializable(vars(obj))
        except Exception:
            return str(obj)
    else:
        return obj


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
