"""Tests for the shared proxy-handler helpers in ``WebATM/proxy/handlers/_base.py``.

The module is loaded in isolation (by file path) so the test does not pull in
the full proxy import chain, which depends on ``bluesky``/``msgpack`` — neither
is needed to exercise this pure-Python logic.
"""

import importlib.util
import time
import types
from pathlib import Path

_BASE_PATH = (
    Path(__file__).resolve().parents[1] / "WebATM" / "proxy" / "handlers" / "_base.py"
)
_spec = importlib.util.spec_from_file_location("webatm_handler_base", _BASE_PATH)
_base = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_base)


def _fake_proxy(*, allow_reconnection, last_update=0.0):
    return types.SimpleNamespace(
        allow_reconnection=allow_reconnection,
        last_successful_update=last_update,
    )


def test_active_proxy_returns_none_without_proxy(monkeypatch):
    """No registered proxy -> handlers should early-return."""
    monkeypatch.setattr(_base, "get_bluesky_proxy", lambda: None)
    assert _base.active_proxy() is None


def test_active_proxy_returns_none_when_disconnected(monkeypatch):
    """A disconnected proxy is treated as absent and its timestamp untouched."""
    proxy = _fake_proxy(allow_reconnection=False, last_update=42.0)
    monkeypatch.setattr(_base, "get_bluesky_proxy", lambda: proxy)

    assert _base.active_proxy() is None
    assert proxy.last_successful_update == 42.0  # not refreshed while disconnected


def test_active_proxy_refreshes_timestamp_when_connected(monkeypatch):
    """A connected proxy is returned with its last-update timestamp refreshed."""
    proxy = _fake_proxy(allow_reconnection=True, last_update=0.0)
    monkeypatch.setattr(_base, "get_bluesky_proxy", lambda: proxy)

    before = time.time()
    result = _base.active_proxy()

    assert result is proxy
    assert proxy.last_successful_update >= before


def _proxy_with_active_node(active_node):
    return types.SimpleNamespace(_get_safe_active_node=lambda: active_node)


def test_is_active_node_matches_sender():
    proxy = _proxy_with_active_node("aa81")
    assert _base.is_active_node(proxy, "aa81")
    assert not _base.is_active_node(proxy, "bb81")


def test_is_active_node_accepts_unresolvable_cases():
    """No resolvable active node or sender -> accept (single-node fallback)."""
    assert _base.is_active_node(_proxy_with_active_node(None), "aa81")
    assert _base.is_active_node(_proxy_with_active_node("aa81"), None)
