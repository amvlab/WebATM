"""Shared pytest fixtures and lightweight test doubles for WebATM.

The WebATM proxy talks to the outside world through two collaborators:

* a Socket.IO server (``proxy.socketio``) used to push events to browsers, and
* a ``BlueSkyClient`` (``proxy.bluesky_client``) that owns the ZMQ sockets.

Neither is appropriate to spin up for real in a unit test, so this module
provides in-memory fakes that record what the code under test tried to do.
"""

from __future__ import annotations

import pytest

from WebATM.bluesky_client import BlueSkyContext, BlueSkyStack
from WebATM.proxy import BlueSkyProxy, set_bluesky_proxy


class FakeSocketIO:
    """Records ``emit`` calls instead of sending them over a socket."""

    def __init__(self, raise_on_emit: bool = False):
        self.emitted: list[tuple[str, object]] = []
        self.raise_on_emit = raise_on_emit

    def emit(self, event, data=None, **kwargs):
        if self.raise_on_emit:
            raise RuntimeError("simulated socket failure")
        self.emitted.append((event, data))

    # --- test helpers -------------------------------------------------
    def events(self, name):
        """Return the payloads emitted under ``name`` (in order)."""
        return [data for event, data in self.emitted if event == name]

    def last(self, name):
        """Return the most recent payload emitted under ``name``."""
        payloads = self.events(name)
        return payloads[-1] if payloads else None

    def count(self, name):
        return len(self.events(name))


class FakeBlueSkyClient:
    """Minimal stand-in for :class:`WebATM.bluesky_client.BlueSkyClient`.

    Implements just enough surface (``stack``, ``send``, ``context``, ``act_id``)
    for the command/data managers and handlers to be exercised without ZMQ.
    """

    def __init__(self, running: bool = True):
        self.running = running
        self.stack = BlueSkyStack()
        self.context = BlueSkyContext()
        self.act_id = None
        self.server_id = b"SRV\x80\x80"
        self.servers = set()
        self.nodes = set()
        self.sent: list[tuple[str, object, object]] = []
        self.closed = False

    def send(self, topic, data="", to_group=""):
        self.sent.append((topic, data, to_group))
        return True

    def actnode(self, node_id):
        self.act_id = node_id
        return node_id

    def addnodes(self, count, server_id=None):
        self.sent.append(("ADDNODES", {"count": count}, server_id))
        return True

    def close(self):
        self.closed = True


@pytest.fixture
def fake_socketio():
    """A recording Socket.IO double."""
    return FakeSocketIO()


@pytest.fixture
def fake_client():
    """A recording BlueSky network client double."""
    return FakeBlueSkyClient()


@pytest.fixture
def proxy(fake_socketio):
    """A real :class:`BlueSkyProxy` wired to a fake Socket.IO server.

    The proxy is registered as the process-global instance so module-level
    event handlers (which call ``get_bluesky_proxy()``) operate on it. The
    global is reset afterwards and any background timers are cancelled.
    """
    instance = BlueSkyProxy()
    instance.socketio = fake_socketio
    instance.connected_clients = 1
    instance.allow_reconnection = True
    set_bluesky_proxy(instance)

    yield instance

    # Defensive cleanup: make sure no background timers survive the test.
    for timer_attr in ("network_timer", "backup_timer"):
        timer = getattr(instance, timer_attr, None)
        if timer is not None:
            try:
                timer.cancel()
            except Exception:
                pass
    set_bluesky_proxy(None)
