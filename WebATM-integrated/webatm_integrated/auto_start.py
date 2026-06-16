"""Auto-start the bundled BlueSky server and connect the proxy on first boot.

Shipped ONLY in the ``webatm-integrated`` build. In this variant BlueSky runs
inside the same container as the WebATM backend, so there is no reason to make
the user open Settings and click Start/Connect before anything works: on
start-up we spawn the ``bluesky --headless`` process tree and, once its
command/data ports accept connections, connect the WebATM proxy to it. The user
then lands on a live, already-connected map.

This mirrors -- server-side and automatically -- the exact connect sequence the
manual ``/api/server/config`` route performs (``start_client`` then
``register_subscribers``; subscribers can only attach once the client exists).

Opt out with ``WEBATM_AUTO_START=0`` (e.g. for tests, or deployments that want
the manual Start button to drive the lifecycle). The core ``webatm`` package
never imports this module; it is reached only via ``webatm_integrated.register``
(env-guarded on ``WEBATM_INTEGRATED=1``).
"""

from __future__ import annotations

import os
from collections.abc import Callable

from WebATM.logger import get_logger

logger = get_logger()

# BlueSky's fixed command / data ports (not configurable, per the project docs).
# Either one listening means the server is up enough to connect to.
_BLUESKY_PORTS = (11000, 11001)

# Marker recording that auto-start has already fired this boot. It lives on a
# tmpfs (/dev/shm) by default so it survives a gunicorn worker being replaced
# (a crashed/timed-out worker re-imports the app and re-runs register()) within
# a running container -- making auto-start a true once-per-boot event that never
# resurrects a server the user has manually stopped -- yet is cleared when the
# container (re)starts, which is a genuinely fresh boot. Override the location
# with WEBATM_AUTOSTART_MARKER (e.g. point it at a persistent volume to fire
# auto-start only on the very first deployment, ever).
_DEFAULT_MARKER = "/dev/shm/webatm_autostart.done"


def auto_start_enabled() -> bool:
    """Whether to auto-start BlueSky + auto-connect on boot.

    On by default; set ``WEBATM_AUTO_START=0`` to disable.
    """
    return os.environ.get("WEBATM_AUTO_START", "1") != "0"


def claim_first_boot(marker_path: str | None = None) -> bool:
    """Atomically claim the one-shot auto-start for this boot.

    Returns True exactly once per boot -- for the first caller to create the
    marker file -- and False thereafter (e.g. when a replaced gunicorn worker
    re-runs ``register()``), so auto-start runs only on first boot and never
    fights the manual Start/Stop controls. If the marker cannot be created
    (e.g. no /dev/shm on a dev box), it degrades to True so a fresh start still
    auto-starts -- harmless there since such runs create the app only once.
    """
    path = marker_path or os.environ.get("WEBATM_AUTOSTART_MARKER", _DEFAULT_MARKER)
    try:
        # O_EXCL makes "create the marker" the atomic claim: only the first
        # caller succeeds; everyone else sees FileExistsError and stands down.
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
    except FileExistsError:
        logger.info("Auto-start: already performed this boot; skipping")
        return False
    except OSError as e:
        logger.warning(
            f"Auto-start: could not create boot marker '{path}' ({e}); "
            "proceeding without the once-per-boot guard"
        )
        return True
    try:
        os.write(fd, f"pid={os.getpid()}\n".encode())
    finally:
        os.close(fd)
    return True


def schedule_auto_start(socketio, manager, bluesky_proxy) -> None:
    """Run the auto-start sequence on a background task.

    Backgrounded so ``register()`` (which runs during app creation) returns
    immediately: waiting for BlueSky's ports can take several seconds on a cold
    start, and we must not block the worker from beginning to serve requests.
    """
    socketio.start_background_task(_run_auto_start, manager, bluesky_proxy)


def _run_auto_start(manager, bluesky_proxy) -> None:
    """Start the BlueSky process tree, then connect the proxy once it is ready."""
    result = manager.start()
    if not result.get("success"):
        logger.error(
            f"Auto-start: failed to start BlueSky server: {result.get('message')}"
        )
        return
    logger.info(f"Auto-start: BlueSky server starting (pid {result.get('pid')})")

    if bluesky_proxy is None:
        logger.warning("Auto-start: no proxy available; skipping auto-connect")
        return

    connect_proxy_when_ready(bluesky_proxy)


def connect_proxy_when_ready(
    bluesky_proxy,
    *,
    host: str | None = None,
    ready_timeout: float = 60.0,
    poll_interval: float = 0.5,
    is_port_listening: Callable[..., bool] | None = None,
    register_subscribers: Callable[[], None] | None = None,
    sleep: Callable[[float], None] | None = None,
) -> bool:
    """Wait for BlueSky to accept connections, then connect the WebATM proxy.

    Polls BlueSky's command/data ports until one is listening (or the timeout
    elapses), then performs the same connect sequence as the manual route:
    ``start_client`` followed by ``register_subscribers`` (subscribers attach to
    the client created by ``start_client``).

    The port probe, subscriber registration and sleep are injectable so this can
    be unit-tested without a real BlueSky server or wall-clock delays.

    Returns:
        True if the proxy connect was attempted, False if BlueSky never came up.
    """
    # Deferred imports: keep this module light for unit tests and avoid pulling
    # the Flask/ZMQ-laden core packages unless we actually connect.
    if is_port_listening is None:
        from WebATM.server.bluesky_server_status import is_port_listening
    if register_subscribers is None:
        from WebATM.proxy import register_subscribers
    if sleep is None:
        import time

        sleep = time.sleep

    host = (
        host
        or getattr(bluesky_proxy, "server_ip", None)
        or os.environ.get("BLUESKY_SERVER_HOST", "localhost")
    )

    if not _wait_for_ports(
        host, ready_timeout, poll_interval, is_port_listening, sleep
    ):
        logger.error(
            f"Auto-start: BlueSky ports {_BLUESKY_PORTS} not listening on '{host}' "
            f"after {ready_timeout:.0f}s; proxy not connected"
        )
        return False

    try:
        bluesky_proxy.server_ip = host
        bluesky_proxy.start_client(hostname=host)
        # Subscribers can only be registered once the client exists, which
        # start_client creates -- this is the same ordering the manual
        # /api/server/config route relies on.
        register_subscribers()
        logger.info(f"Auto-start: WebATM proxy connected to BlueSky at '{host}'")
        return True
    except Exception as e:
        logger.error(f"Auto-start: failed to connect proxy to BlueSky: {e}")
        return False


def _wait_for_ports(
    host: str,
    ready_timeout: float,
    poll_interval: float,
    is_port_listening: Callable[..., bool],
    sleep: Callable[[float], None],
) -> bool:
    """Poll until a BlueSky port is listening on ``host`` or attempts run out."""
    attempts = max(1, int(ready_timeout / poll_interval))
    for attempt in range(attempts):
        if any(is_port_listening(port, 0.5, host) for port in _BLUESKY_PORTS):
            return True
        if attempt < attempts - 1:
            sleep(poll_interval)
    return False
