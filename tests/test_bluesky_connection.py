"""End-to-end connection tests for :class:`WebATM.bluesky_client.BlueSkyClient`.

The other ``BlueSkyClient`` tests (``test_bluesky_client.py``) deliberately stay
on the "no real sockets" side of the line and only cover the pure helpers and
construction. This module fills the obvious gap: it stands up a *real* ZMQ
peer that speaks BlueSky's wire protocol on loopback and drives the client
through the things it actually exists to do —

* open real ZMQ sockets against a server and report ``connected``/``running``,
* receive a published topic, decode the msgpack payload and dispatch it to the
  right subscriber (``SIMINFO``, ``ACDATA``, ``ECHO`` framing included),
* publish a command (``STACK``) that the server actually receives, and
* discover sim nodes and servers from the subscription stream so the
  ``node_added`` / ``server_added`` signals fire.

The "server" here is the minimum that satisfies the protocol: a ``PUB`` socket
the client's ``SUB`` receives data from (``recv_port``), and an ``XSUB`` socket
the client's ``XPUB`` sends commands to / discovers peers from (``send_port``).
Everything runs in-process on ``127.0.0.1`` with ephemeral ports, so the tests
need no external BlueSky install and clean up their own sockets.
"""

from __future__ import annotations

import time

import msgpack
import pytest
import zmq

from WebATM.bluesky_client import (
    GROUPID_SIM,
    IDLEN,
    BlueSkyClient,
    asbytestr,
    seqidx2id,
)

# A subscribe frame on an (X)SUB socket is ``b"\x01" + prefix``; unsubscribe is
# ``b"\x00" + prefix``. The client reads these off its XPUB to discover peers.
ZMQ_SUBSCRIBE = b"\x01"

# Stable 5-byte BlueSky ids for the fake peers. The last byte is the sequence
# index: index 0 == a server, index >= 1 == a sim node (see seqidx2id/seqid2idx).
SIM_NODE_ID = b"S\x01\x02\x03" + seqidx2id(1)
SIM_SERVER_ID = b"S\x01\x02\x03" + seqidx2id(0)

# Generous-but-bounded budget for ZMQ's "slow joiner" subscription propagation.
PUMP_TIMEOUT = 2.0


def make_header(topic: str, sender_id: bytes, to_group: bytes = b"") -> bytes:
    """Build a BlueSky data-frame header: ``dest(5) + topic + sender_id(5)``.

    This mirrors what :meth:`BlueSkyClient.send` writes and what
    :meth:`BlueSkyClient._process_data_message` parses back out.
    """
    return to_group.ljust(IDLEN, b"*") + asbytestr(topic) + sender_id


class FakeBlueSkyServer:
    """A real-ZMQ peer that speaks just enough of BlueSky's protocol.

    * ``data`` (``PUB``, bound on ``recv_port``) — what the client's ``SUB``
      connects to and receives published topics from.
    * ``cmd`` (``XSUB``, bound on ``send_port``) — what the client's ``XPUB``
      connects to. It receives the client's outgoing commands and is also the
      channel used to inject peer subscription frames for node discovery.
    """

    def __init__(self) -> None:
        # A private context (not the global instance) so each server is fully
        # isolated and can be torn down without affecting other tests.
        self.ctx = zmq.Context()
        self.data = self.ctx.socket(zmq.PUB)
        self.cmd = self.ctx.socket(zmq.XSUB)
        # Drop pending messages immediately on close so term() never blocks.
        for sock in (self.data, self.cmd):
            sock.setsockopt(zmq.LINGER, 0)

        self.recv_port = self.data.bind_to_random_port("tcp://127.0.0.1")
        self.send_port = self.cmd.bind_to_random_port("tcp://127.0.0.1")

        # Subscribe the XSUB to everything so it receives the client's commands.
        self.cmd.send(ZMQ_SUBSCRIBE)

    def publish(self, topic: str, data, sender_id: bytes = SIM_NODE_ID) -> None:
        """Publish a msgpack-framed topic the client is expected to receive."""
        header = make_header(topic, sender_id)
        self.data.send_multipart([header, msgpack.packb(data, use_bin_type=True)])

    def announce(self, peer_id: bytes) -> None:
        """Inject a subscribe frame so the client discovers ``peer_id``.

        BlueSky nodes/servers register by subscribing through the server; the
        client sees those subscriptions arrive on its XPUB. Sending the same
        frame from our XSUB reproduces that exactly.
        """
        self.cmd.send(ZMQ_SUBSCRIBE + peer_id)

    def recv_command(self, timeout: float = PUMP_TIMEOUT):
        """Return the next non-subscription multipart message, or ``None``."""
        poller = zmq.Poller()
        poller.register(self.cmd, zmq.POLLIN)
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if dict(poller.poll(50)).get(self.cmd) == zmq.POLLIN:
                msg = self.cmd.recv_multipart()
                # A bare ``b"\x01..."``/``b"\x00..."`` frame is a subscription
                # notification (XSUB sees the client's XPUB subscribe); skip it.
                if len(msg) == 1 and msg[0][:1] in (b"\x00", b"\x01"):
                    continue
                return msg
        return None

    def close(self) -> None:
        self.data.close()
        self.cmd.close()
        self.ctx.term()


@pytest.fixture
def server():
    srv = FakeBlueSkyServer()
    yield srv
    srv.close()


@pytest.fixture
def client(server):
    """A real :class:`BlueSkyClient` connected to the in-process fake server."""
    c = BlueSkyClient()
    assert c.connect(
        hostname="127.0.0.1",
        recv_port=server.recv_port,
        send_port=server.send_port,
    )
    yield c
    c.close()


def pump_recv(client: BlueSkyClient, predicate, timeout: float = PUMP_TIMEOUT) -> bool:
    """Pump ``client.receive()`` until ``predicate()`` is true or time runs out.

    Pumping in a loop absorbs ZMQ's slow-joiner window: a subscription set on a
    socket takes a moment to reach the peer, so the first publishes can be
    dropped. Returns whether the predicate became true.
    """
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        client.receive(timeout=20)
        if predicate():
            return True
        time.sleep(0.01)
    return False


class TestConnectionLifecycle:
    def test_connect_opens_sockets_and_sets_state(self, client):
        assert client.connected is True
        assert client.running is True
        assert client.sock_recv is not None
        assert client.sock_send is not None
        assert client.poller is not None

    def test_connect_failure_returns_false_and_stays_clean(self):
        c = BlueSkyClient()
        # A malformed protocol lets the sockets get created, then makes
        # zmq.connect() raise mid-setup. connect() must report failure and
        # close() must fully release everything it created.
        assert c.connect(hostname="127.0.0.1", protocol="bogus") is False
        assert c.connected is False
        assert c.running is False
        assert c.sock_recv is None
        assert c.sock_send is None
        assert c.zmq_context is None

    def test_close_after_failed_setup_releases_unregistered_socket(self):
        # Regression: a connect() that raises after creating sockets but before
        # registering them with the poller leaves a socket the poller never knew
        # about. close() used to raise on poller.unregister() and abort the rest
        # of cleanup, leaking the socket and context. Reproduce that exact state
        # and assert close() still fully cleans up.
        c = BlueSkyClient()
        c.zmq_context = zmq.Context()
        c.sock_recv = c.zmq_context.socket(zmq.SUB)
        c.sock_send = c.zmq_context.socket(zmq.XPUB)
        for sock in (c.sock_recv, c.sock_send):
            sock.setsockopt(zmq.LINGER, 0)
        c.poller = zmq.Poller()  # deliberately never register the sockets

        c.close()  # must not raise

        assert c.sock_recv is None
        assert c.sock_send is None
        assert c.zmq_context is None
        assert c.poller is None

    def test_close_releases_sockets_and_clears_state(self, server):
        c = BlueSkyClient()
        c.connect(
            hostname="127.0.0.1",
            recv_port=server.recv_port,
            send_port=server.send_port,
        )
        c.nodes.add(SIM_NODE_ID)
        c.close()
        assert c.connected is False
        assert c.running is False
        assert c.sock_recv is None
        assert c.sock_send is None
        assert c.zmq_context is None
        assert c.nodes == set()

    def test_update_noop_after_close(self, client):
        client.close()
        # Not running anymore -> update() short-circuits to False without touching
        # the (now-None) poller.
        assert client.update() is False


class TestDataReceive:
    def test_receives_and_dispatches_siminfo(self, client, server):
        received: list[tuple] = []
        client.subscribe("SIMINFO", lambda *a, **k: received.append((a, k)))

        # SIMINFO signature: speed, simdt, simt, simutc, ntraf, state, scenname.
        payload = [1.0, 0.05, 12.3, "2026-06-21", 4, 2, "MY_SCENARIO"]

        def got_it():
            if not received:
                server.publish("SIMINFO", payload)
            return bool(received)

        assert pump_recv(client, got_it), "SIMINFO never dispatched to subscriber"

        args, kwargs = received[0]
        assert args[:7] == tuple(payload)
        assert kwargs["sender_id"] == SIM_NODE_ID

    def test_receives_acdata_unwraps_shared_state(self, client, server):
        received: list = []
        client.subscribe("ACDATA", received.append)

        ac = {"id": ["KL204"], "lat": [52.0], "lon": [4.0]}

        def got_it():
            if not received:
                # ACDATA arrives as BlueSky shared-state: [action, data_dict].
                server.publish("ACDATA", ["UPDATE", ac])
            return bool(received)

        assert pump_recv(client, got_it), "ACDATA never dispatched"
        # The client unwraps the [action, data] envelope and emits the dict only.
        assert received[0] == ac
        assert client.context.action == "UPDATE"

    def test_receives_echo_adds_sender_from_header(self, client, server):
        received: list[tuple] = []
        client.subscribe("ECHO", lambda *a: received.append(a))

        def got_it():
            if not received:
                # Two-element ECHO -> client appends sender_id from the header.
                server.publish("ECHO", ["hello world", 0])
            return bool(received)

        assert pump_recv(client, got_it), "ECHO never dispatched"
        text, flags, sender_id = received[0]
        assert text == "hello world"
        assert flags == 0
        assert sender_id == SIM_NODE_ID

    def test_unsubscribed_topic_is_not_delivered(self, client, server):
        received: list = []
        client.subscribe("SIMINFO", received.append)

        # Publish a topic nobody subscribed to; pump for a bit. It must never
        # reach a SIMINFO subscriber (and there is no SHOWDIALOG subscriber).
        delivered = pump_recv(
            client,
            lambda: server.publish("SHOWDIALOG", {"x": 1}) or bool(received),
            timeout=0.6,
        )
        assert delivered is False
        assert received == []


class TestCommandSend:
    def test_send_delivers_command_to_server(self, client, server):
        # Retry the send to ride out the XPUB/XSUB subscription propagation
        # window, then assert the server actually received the framed command.
        msg = None
        deadline = time.monotonic() + PUMP_TIMEOUT
        while msg is None and time.monotonic() < deadline:
            assert client.send("STACK", "CRE KL204 B738") is True
            msg = server.recv_command(timeout=0.2)

        assert msg is not None, "server never received the STACK command"
        header, payload = msg
        # Header ends with the *client's* node id (the sender).
        assert header.endswith(client.node_id)
        assert "STACK" in header.decode("charmap")
        assert msgpack.unpackb(payload, raw=False) == "CRE KL204 B738"

    def test_send_when_not_running_returns_false(self, client):
        client.close()
        assert client.send("STACK", "OP") is False


class TestNodeDiscovery:
    def test_discovers_sim_node(self, client, server):
        added: list[bytes] = []
        client.node_added.connect(added.append)

        assert pump_recv(
            client,
            lambda: server.announce(SIM_NODE_ID) or SIM_NODE_ID in client.nodes,
        ), "sim node was never discovered"
        assert SIM_NODE_ID in added
        # First discovered node is auto-selected as the active node.
        assert client.act_id == SIM_NODE_ID

    def test_discovers_server(self, client, server):
        servers: list[bytes] = []
        client.server_added.connect(servers.append)

        assert pump_recv(
            client,
            lambda: server.announce(SIM_SERVER_ID) or SIM_SERVER_ID in client.servers,
        ), "server was never discovered"
        assert SIM_SERVER_ID in servers

    def test_node_removed_on_unsubscribe(self, client, server):
        removed: list[bytes] = []
        client.node_removed.connect(removed.append)

        # An XPUB only reports an unsubscribe for a prefix it saw subscribed, so
        # the node must be discovered first, then dropped.
        assert pump_recv(
            client,
            lambda: server.announce(SIM_NODE_ID) or SIM_NODE_ID in client.nodes,
        ), "node was never discovered"

        # Unsubscribe frame (leading b"\x00") removes the known node.
        assert pump_recv(
            client,
            lambda: (
                server.cmd.send(b"\x00" + SIM_NODE_ID)
                or SIM_NODE_ID not in client.nodes
            ),
        ), "node was never removed"
        assert SIM_NODE_ID in removed


def test_group_constant_marks_sim_sender():
    # Guards the assumption baked into the fake server's ids: a sender whose
    # first byte is GROUPID_SIM is treated as a sim peer, not a client.
    assert SIM_NODE_ID[0] == GROUPID_SIM
    assert SIM_SERVER_ID[0] == GROUPID_SIM
