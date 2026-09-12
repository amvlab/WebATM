"""Auto-start the bundled BlueSky server and connect the proxy on first boot.

Integrated build only: BlueSky runs in the same container, so on start-up we
spawn the ``bluesky --headless`` process tree and, once its ports accept
connections, run the same connect sequence as the manual ``/api/server/config``
route. The user lands on a live, already-connected map. If a manual connect
wins the race, auto-start stands down (see ``connect_proxy_when_ready``).

Opt out with ``WEBATM_AUTO_START=0``. The core ``webatm`` package never imports
this module; it is reached only via ``webatm_integrated.register`` (env-guarded
on ``WEBATM_INTEGRATED=1``).
"""

from __future__ import annotations

import os
import time
from collections.abc import Callable
from contextlib import AbstractContextManager

from WebATM.logger import get_logger

logger = get_logger()

# BlueSky's fixed command / data ports (not configurable, per the project docs).
# Either one listening means the server is up enough to connect to.
_BLUESKY_PORTS = (11000, 11001)

# Once-per-boot marker; see claim_first_boot() for the full rationale.
_DEFAULT_MARKER = "/dev/shm/webatm_autostart.done"


def auto_start_enabled() -> bool:
    """Report whether to auto-start BlueSky and auto-connect on boot.

    On by default; set ``WEBATM_AUTO_START=0`` to disable.

    Returns:
        bool: True unless the ``WEBATM_AUTO_START`` environment variable is
            set to ``"0"``.
    """
    return os.environ.get("WEBATM_AUTO_START", "1") != "0"


def claim_first_boot(marker_path: str | None = None) -> bool:
    """Atomically claim the one-shot auto-start for this boot.

    Creates the marker file with ``O_CREAT | O_EXCL`` so only the first caller
    per boot wins — a replaced gunicorn worker re-running ``register()`` stands
    down instead of resurrecting a manually-stopped server. The default marker
    lives on tmpfs so it clears on a fresh container start.

    Args:
        marker_path (str | None): Marker file location. Defaults to
            ``WEBATM_AUTOSTART_MARKER``, then ``/dev/shm/webatm_autostart.done``.

    Returns:
        bool: True for the first caller to create the marker file, False
            thereafter. If the marker cannot be created at all (e.g. no
            ``/dev/shm``), degrades to True and skips the once-per-boot guard.
    """
    path = marker_path or os.environ.get("WEBATM_AUTOSTART_MARKER", _DEFAULT_MARKER)
    try:
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

    Args:
        socketio (flask_socketio.SocketIO): Socket.IO instance whose
            ``start_background_task`` runs the sequence.
        manager (BlueSkyProcessManager): Process manager used to start the
            BlueSky server.
        bluesky_proxy (BlueSkyProxy | None): Core proxy to connect once
            BlueSky is ready, or None to skip the auto-connect.
    """
    socketio.start_background_task(_run_auto_start, manager, bluesky_proxy)


def _run_auto_start(manager, bluesky_proxy) -> None:
    """Start the BlueSky process tree, then connect the proxy once it is ready.

    Args:
        manager (BlueSkyProcessManager): Process manager used to start the
            BlueSky server.
        bluesky_proxy: Core BlueSkyProxy to connect, or None to skip the
            auto-connect.
    """
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
    register_subscribers: Callable[..., None] | None = None,
    get_proxy: Callable[[], object] | None = None,
    lock: AbstractContextManager | None = None,
    sleep: Callable[[float], None] | None = None,
) -> bool:
    """Wait for BlueSky to accept connections, then connect the WebATM proxy.

    Polls BlueSky's command/data ports until one is listening (or the timeout
    elapses), then performs the same ``start_client`` → ``register_subscribers``
    sequence as the manual ``/api/server/config`` route. The connect step runs
    under the shared ``WebATM.proxy.connect_lock`` and stands down if a manual
    connect replaced the global proxy during the port wait — connecting the
    stale boot-time proxy would leave a second, subscriber-less ZMQ client
    alive to broadcast a bogus disconnect later.

    The collaborators are injectable so this can be unit-tested without a real
    BlueSky server or wall-clock delays.

    Args:
        bluesky_proxy (BlueSkyProxy): Core proxy to connect.
        host (str | None): BlueSky server host. Defaults to the proxy's
            ``server_ip``, then ``BLUESKY_SERVER_HOST``, then ``"localhost"``.
        ready_timeout (float): Maximum seconds to wait for a port to listen.
        poll_interval (float): Seconds to sleep between port probes.
        is_port_listening (Callable | None): Port probe ``(port, timeout,
            host)``; defaults to the core implementation.
        register_subscribers (Callable | None): Subscriber-registration hook;
            defaults to ``WebATM.proxy.register_subscribers``.
        get_proxy (Callable | None): Returns the current global proxy;
            defaults to ``WebATM.proxy.get_bluesky_proxy``.
        lock (AbstractContextManager | None): Lock held around the connect
            step; defaults to ``WebATM.proxy.connect_lock``.
        sleep (Callable | None): Sleep function; defaults to ``time.sleep``.

    Returns:
        bool: True if the proxy connect succeeded, False if BlueSky never came
            up in time, the connect raised, or a manual connect won the race.
    """
    # Deferred imports: keep this module light for unit tests and avoid pulling
    # the Flask/ZMQ-laden core packages unless we actually connect.
    if is_port_listening is None:
        from WebATM.server.bluesky_server_status import is_port_listening
    if register_subscribers is None:
        from WebATM.proxy import register_subscribers
    if get_proxy is None:
        from WebATM.proxy import get_bluesky_proxy as get_proxy
    if lock is None:
        from WebATM.proxy import connect_lock as lock
    if sleep is None:
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

    with lock:
        if get_proxy() is not bluesky_proxy:
            logger.info(
                "Auto-start: a manual connect replaced the proxy while waiting "
                "for BlueSky; standing down"
            )
            return False
        try:
            bluesky_proxy.server_ip = host
            bluesky_proxy.start_client(hostname=host)
            # Subscribers can only be registered once the client exists, which
            # start_client creates -- this is the same ordering the manual
            # /api/server/config route relies on. They attach to bluesky_proxy
            # explicitly, so they always land on the client just started.
            register_subscribers(bluesky_proxy)
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
    *,
    clock: Callable[[], float] = time.monotonic,
) -> bool:
    """Poll until a BlueSky port is listening on ``host`` or ``ready_timeout`` elapses.

    Bounds the *wall-clock* wait by ``ready_timeout``. Each probe can itself block
    on the socket connect (~0.5s per port), so counting attempts would overshoot
    the timeout several-fold; a monotonic deadline (injectable for tests) avoids
    that while still doing at least one probe.
    """
    deadline = clock() + ready_timeout
    while True:
        if any(is_port_listening(port, 0.5, host) for port in _BLUESKY_PORTS):
            return True
        if clock() >= deadline:
            return False
        sleep(poll_interval)
