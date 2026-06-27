"""Tests for the integrated auto-start (start BlueSky + connect proxy on boot).

These exercise the auto-start orchestration without a real BlueSky server or
Flask app: the port probe, subscriber registration and sleep are injected, so
the wait/connect ordering and the start->connect handoff are verified
deterministically.
"""

import pytest
from webatm_integrated import auto_start


class FakeProxy:
    """Records the connect sequence the auto-start drives."""

    def __init__(self, server_ip="localhost", raise_on_start=False):
        self.server_ip = server_ip
        self._raise_on_start = raise_on_start
        self.start_client_hosts: list[str] = []
        self.events: list[str] = []

    def start_client(self, hostname=None):
        self.start_client_hosts.append(hostname)
        self.events.append("start_client")
        if self._raise_on_start:
            raise RuntimeError("connect boom")


class FakeManager:
    """Minimal stand-in for BlueSkyProcessManager.start()."""

    def __init__(self, result):
        self._result = result
        self.start_calls = 0

    def start(self):
        self.start_calls += 1
        return self._result


def _always(value):
    def _listener(port, timeout, host):
        return value

    return _listener


# --------------------------------------------------------------------------
# auto_start_enabled
# --------------------------------------------------------------------------


def test_auto_start_enabled_default_on(monkeypatch):
    monkeypatch.delenv("WEBATM_AUTO_START", raising=False)
    assert auto_start_enabled_helper() is True


def test_auto_start_disabled_with_zero(monkeypatch):
    monkeypatch.setenv("WEBATM_AUTO_START", "0")
    assert auto_start_enabled_helper() is False


def test_auto_start_enabled_with_other_values(monkeypatch):
    monkeypatch.setenv("WEBATM_AUTO_START", "1")
    assert auto_start_enabled_helper() is True
    monkeypatch.setenv("WEBATM_AUTO_START", "yes")
    assert auto_start_enabled_helper() is True


def auto_start_enabled_helper():
    return auto_start.auto_start_enabled()


# --------------------------------------------------------------------------
# claim_first_boot (once-per-boot guard)
# --------------------------------------------------------------------------


def test_first_boot_claimed_exactly_once(tmp_path):
    marker = str(tmp_path / "autostart.done")

    # First caller wins; a replaced worker re-running register() stands down.
    assert auto_start.claim_first_boot(marker) is True
    assert auto_start.claim_first_boot(marker) is False
    assert auto_start.claim_first_boot(marker) is False


def test_claim_records_marker_on_disk(tmp_path):
    marker = tmp_path / "autostart.done"

    assert auto_start.claim_first_boot(str(marker)) is True
    assert marker.exists()
    # Content is informational (the claiming pid); presence is what matters.
    assert "pid=" in marker.read_text()


def test_claim_respects_env_override(monkeypatch, tmp_path):
    marker = tmp_path / "from-env.done"
    monkeypatch.setenv("WEBATM_AUTOSTART_MARKER", str(marker))

    assert auto_start.claim_first_boot() is True
    assert marker.exists()
    assert auto_start.claim_first_boot() is False


def test_claim_degrades_to_true_when_marker_uncreatable(tmp_path):
    # Parent directory does not exist -> os.open raises -> degrade to first-boot
    # so a fresh start still auto-starts rather than being silently suppressed.
    unwritable = str(tmp_path / "missing-dir" / "autostart.done")
    assert auto_start.claim_first_boot(unwritable) is True


# --------------------------------------------------------------------------
# connect_proxy_when_ready
# --------------------------------------------------------------------------


def test_connects_once_ports_come_up():
    """Ports come up after a couple of polls; then connect + subscribe, in order."""
    proxy = FakeProxy(server_ip="localhost")
    registered: list[str] = []
    ready = {"v": False}
    sleeps = {"n": 0}

    def fake_sleep(_):
        sleeps["n"] += 1
        if sleeps["n"] >= 2:  # ports come up after the 2nd poll
            ready["v"] = True

    def fake_lister(port, timeout, host):
        return ready["v"]

    def fake_register():
        proxy.events.append("register_subscribers")
        registered.append("ok")

    result = auto_start.connect_proxy_when_ready(
        proxy,
        ready_timeout=10.0,
        poll_interval=0.01,
        is_port_listening=fake_lister,
        register_subscribers=fake_register,
        sleep=fake_sleep,
    )

    assert result is True
    assert proxy.start_client_hosts == ["localhost"]
    assert registered == ["ok"]
    # Subscribers must be registered AFTER the client is created by start_client.
    assert proxy.events == ["start_client", "register_subscribers"]
    assert sleeps["n"] >= 2


def test_gives_up_when_ports_never_listen():
    """No port ever opens -> no connect attempt, returns False."""
    proxy = FakeProxy()
    registered: list[str] = []

    result = auto_start.connect_proxy_when_ready(
        proxy,
        ready_timeout=0.05,
        poll_interval=0.01,
        is_port_listening=_always(False),
        register_subscribers=lambda: registered.append("ok"),
        sleep=lambda _: None,
    )

    assert result is False
    assert proxy.start_client_hosts == []
    assert registered == []


def test_wait_for_ports_honors_wall_clock_deadline():
    """The wait is bounded by ready_timeout even when each probe is slow.

    A fixed attempt count (the old behavior) would probe ``ready_timeout /
    poll_interval`` = 10 times here regardless of how long each probe blocks; a
    deadline gives up once the wall clock passes ``ready_timeout``.
    """
    # Fake clock: each probe round advances the wall clock by 1s, modeling probes
    # that each consume ~1s on the socket connect (0.5s per port) -- the cost the
    # old fixed attempt count ignored.
    now = {"t": 0.0}

    def clock():
        now["t"] += 1.0
        return now["t"]

    rounds = {"n": 0}

    def fake_sleep(_):
        rounds["n"] += 1  # one sleep follows each not-yet-expired probe round

    result = auto_start._wait_for_ports(
        "localhost",
        ready_timeout=5.0,
        poll_interval=0.5,
        is_port_listening=_always(False),
        sleep=fake_sleep,
        clock=clock,
    )

    assert result is False
    # ~5 rounds (deadline / per-round cost), not the 10 (= 5.0 / 0.5) a fixed
    # attempt count would do regardless of how long each probe blocks.
    assert 1 <= rounds["n"] < 9


def test_explicit_host_overrides_proxy_and_env(monkeypatch):
    monkeypatch.setenv("BLUESKY_SERVER_HOST", "from-env")
    proxy = FakeProxy(server_ip="from-proxy")
    seen_hosts: list[str] = []

    def fake_lister(port, timeout, host):
        seen_hosts.append(host)
        return True

    auto_start.connect_proxy_when_ready(
        proxy,
        host="explicit",
        is_port_listening=fake_lister,
        register_subscribers=lambda: None,
        sleep=lambda _: None,
    )

    assert proxy.start_client_hosts == ["explicit"]
    assert proxy.server_ip == "explicit"
    assert set(seen_hosts) == {"explicit"}


def test_host_falls_back_to_env_when_proxy_has_none(monkeypatch):
    monkeypatch.setenv("BLUESKY_SERVER_HOST", "envhost")
    proxy = FakeProxy(server_ip=None)

    auto_start.connect_proxy_when_ready(
        proxy,
        is_port_listening=_always(True),
        register_subscribers=lambda: None,
        sleep=lambda _: None,
    )

    assert proxy.start_client_hosts == ["envhost"]


def test_connect_failure_is_caught():
    """A start_client that raises is reported as a failed (False) connect."""
    proxy = FakeProxy(raise_on_start=True)
    registered: list[str] = []

    result = auto_start.connect_proxy_when_ready(
        proxy,
        is_port_listening=_always(True),
        register_subscribers=lambda: registered.append("ok"),
        sleep=lambda _: None,
    )

    assert result is False
    # start_client was attempted, but subscribers must not be registered after it failed.
    assert proxy.start_client_hosts == ["localhost"]
    assert registered == []


# --------------------------------------------------------------------------
# _run_auto_start
# --------------------------------------------------------------------------


def test_run_auto_start_connects_after_successful_start(monkeypatch):
    manager = FakeManager({"success": True, "pid": 4242})
    proxy = FakeProxy()
    connected: list[object] = []
    monkeypatch.setattr(
        auto_start, "connect_proxy_when_ready", lambda p: connected.append(p)
    )

    auto_start._run_auto_start(manager, proxy)

    assert manager.start_calls == 1
    assert connected == [proxy]


def test_run_auto_start_skips_connect_when_start_fails(monkeypatch):
    manager = FakeManager({"success": False, "message": "bluesky not found"})
    proxy = FakeProxy()
    connected: list[object] = []
    monkeypatch.setattr(
        auto_start, "connect_proxy_when_ready", lambda p: connected.append(p)
    )

    auto_start._run_auto_start(manager, proxy)

    assert manager.start_calls == 1
    assert connected == []


def test_run_auto_start_skips_connect_without_proxy(monkeypatch):
    manager = FakeManager({"success": True, "pid": 1})
    connected: list[object] = []
    monkeypatch.setattr(
        auto_start, "connect_proxy_when_ready", lambda p: connected.append(p)
    )

    auto_start._run_auto_start(manager, None)

    assert manager.start_calls == 1
    assert connected == []


# --------------------------------------------------------------------------
# schedule_auto_start
# --------------------------------------------------------------------------


def test_schedule_runs_on_a_background_task():
    scheduled: list[tuple] = []

    class FakeSocketIO:
        def start_background_task(self, func, *args):
            scheduled.append((func, args))

    manager = FakeManager({"success": True, "pid": 1})
    proxy = FakeProxy()

    auto_start.schedule_auto_start(FakeSocketIO(), manager, proxy)

    assert len(scheduled) == 1
    func, args = scheduled[0]
    assert func is auto_start._run_auto_start
    assert args == (manager, proxy)


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v"]))
