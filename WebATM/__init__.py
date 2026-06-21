"""
BlueSky Web app developed by amvlab.

This package provides a web-based interface for BlueSky - The Open Air Traffic
Simulator developed by TU Delft (Delft University of Technology).
"""

from importlib.metadata import PackageNotFoundError
from importlib.metadata import version as _pkg_version
from pathlib import Path


def _read_version() -> str:
    """Resolve the WebATM version.

    Prefer the installed package metadata (the single source of truth is the
    ``version`` field in ``pyproject.toml``). Fall back to parsing
    ``pyproject.toml`` directly when running from a source checkout that isn't
    installed (e.g. plain ``python WebATM.py``).
    """
    try:
        return _pkg_version("webatm")
    except PackageNotFoundError:
        pass

    pyproject = Path(__file__).resolve().parent.parent / "pyproject.toml"
    try:
        import tomllib

        with open(pyproject, "rb") as f:
            return tomllib.load(f)["project"]["version"]
    except Exception:
        return "unknown"


__version__ = _read_version()
