"""Concurrency stress tests for :class:`WebATM.bluesky_client.BlueSkyClient`.

WebATM runs Socket.IO in ``async_mode="threading"``, so the BlueSky client is
driven from two real threads at once:

* the **network-timer thread**, which calls :meth:`BlueSkyClient.receive` ~50x/s
  to drain inbound traffic (ACDATA/SIMINFO) and node-discovery frames, and
* the **Socket.IO command threads**, which call :meth:`BlueSkyClient.send` to
  forward GUI stack commands (``ADDWPT``, ``DT``, ``FF`` …).

``receive()`` also reads the *send* socket (XPUB) for subscription frames, so
both threads touch the same ZMQ sockets — which ZMQ documents as not safe to
use from more than one thread. The client serialises every socket operation on
a single reentrant lock so this is well-defined regardless of timing.

These tests drive the exact workload the user hits — create 100 aircraft, then
fire ``ADDWPT`` commands and crank fast-forward while traffic streams back — on
a real loopback ZMQ peer, and assert the link stays up and commands still get
through under sustained concurrent send/receive pressure.
"""

from __future__ import annotations

import threading
import time

import msgpack
import pytest
import zmq

from WebATM.bluesky_client import IDLEN, BlueSkyClient, asbytestr, seqidx2id

ZMQ_SUBSCRIBE = b"\x01"
SIM_NODE_ID = b"S\x01\x02\x03" + seqidx2id(1)


def make_header(topic: str, sender_id: bytes, to_group: bytes = b"") -> bytes:
    return to_group.ljust(IDLEN, b"*") + asbytestr(topic) + sender_id


class FakeBlueSkyServer:
    """Minimal real-ZMQ BlueSky peer (PUB data port + XSUB command port)."""

    def __init__(self) -> None:
        self.ctx = zmq.Context()
        self.data = self.ctx.socket(zmq.PUB)
        self.cmd = self.ctx.socket(zmq.XSUB)
        for sock in (self.data, self.cmd):
            sock.setsockopt(zmq.LINGER, 0)
            sock.setsockopt(zmq.RCVHWM, 0)  # never drop on the server side
            sock.setsockopt(zmq.SNDHWM, 0)
        self.recv_port = self.data.bind_to_random_port("tcp://127.0.0.1")
        self.send_port = self.cmd.bind_to_random_port("tcp://127.0.0.1")
        self.cmd.send(ZMQ_SUBSCRIBE)  # subscribe XSUB to all client commands

    def publish(self, topic: str, data, sender_id: bytes = SIM_NODE_ID) -> None:
        header = make_header(topic, sender_id)
        self.data.send_multipart([header, msgpack.packb(data, use_bin_type=True)])

    def drain_commands(self) -> int:
        """Count the STACK commands queued on the command socket right now."""
        count = 0
        while True:
            try:
                msg = self.cmd.recv_multipart(zmq.DONTWAIT)
            except zmq.Again:
                break
            if len(msg) == 1 and msg[0][:1] in (b"\x00", b"\x01"):
                continue  # subscription notification, not a command
            count += 1
        return count

    def close(self) -> None:
        self.data.close()
        self.cmd.close()
        self.ctx.term()


def _acdata_frame(n_aircraft: int) -> list:
    """A realistic ACDATA payload: BlueSky's ``[action, data_dict]`` shape."""
    ids = [f"AC{i:04d}" for i in range(n_aircraft)]
    return [
        "UPDATE",
        {
            "id": ids,
            "lat": [52.0 + i * 0.001 for i in range(n_aircraft)],
            "lon": [4.0 + i * 0.001 for i in range(n_aircraft)],
            "alt": [10000.0] * n_aircraft,
            "tas": [250.0] * n_aircraft,
            "trk": [90.0] * n_aircraft,
            "vs": [0.0] * n_aircraft,
        },
    ]


@pytest.fixture
def server():
    srv = FakeBlueSkyServer()
    yield srv
    srv.close()


def _establish_route(client: BlueSkyClient, server: FakeBlueSkyServer) -> None:
    """Send probe commands until one arrives, riding out ZMQ's slow-joiner.

    A freshly-connected XPUB drops messages until it has received the peer
    XSUB's subscription; retrying the send absorbs that window so the test
    measures steady-state behaviour, not the connection handshake.
    """
    deadline = time.monotonic() + 3.0
    while time.monotonic() < deadline:
        client.send("STACK", "_PROBE_", SIM_NODE_ID)
        time.sleep(0.02)
        if server.drain_commands() > 0:
            return
    raise AssertionError("route to server never established")


@pytest.fixture
def client(server):
    c = BlueSkyClient()
    assert c.connect(
        hostname="127.0.0.1", recv_port=server.recv_port, send_port=server.send_port
    )
    # Subscribe so inbound ACDATA is actually delivered to the SUB socket.
    received: list = []
    c.subscribe("ACDATA", lambda data: received.append(data))
    c._received = received  # stash for assertions
    yield c
    c.close()


class TestConcurrentSendReceive:
    """The link must survive simultaneous command floods and inbound traffic."""

    def test_command_flood_during_traffic_stream_keeps_link_alive(self, server, client):
        """Reproduce: 100 aircraft streaming in + ADDWPT/FF commands hammered out.

        A receiver thread drains the client (as the network timer does) while a
        command thread floods ``send()`` and the server floods ACDATA — the same
        socket touched from two threads at once. The test asserts no thread
        raised, the client stayed connected, and commands got through.
        """
        n_commands = 3000
        n_frames = 600
        errors: list[BaseException] = []
        stop = threading.Event()

        def receiver():
            # Mirror the network-timer thread: poll + drain as fast as possible.
            try:
                while not stop.is_set():
                    client.receive(timeout=0)
                    time.sleep(0.001)
                # Final drain to pick up the tail of the stream.
                for _ in range(50):
                    client.receive(timeout=0)
                    time.sleep(0.001)
            except BaseException as exc:  # noqa: BLE001 - surface to main thread
                errors.append(exc)

        def commander():
            # Mirror Socket.IO command threads: ADDWPT per aircraft + FF/DT.
            try:
                for i in range(n_commands):
                    acid = f"AC{i % 100:04d}"
                    client.send("STACK", f"ADDWPT {acid} 52.1 4.1 10000", SIM_NODE_ID)
                    if i % 25 == 0:
                        client.send("STACK", "FF", SIM_NODE_ID)
                        client.send("STACK", "DT 5", SIM_NODE_ID)
            except BaseException as exc:  # noqa: BLE001
                errors.append(exc)

        def publisher():
            # Mirror BlueSky under fast-forward: bursts of 100-aircraft frames.
            try:
                for _ in range(n_frames):
                    server.publish("ACDATA", _acdata_frame(100))
            except BaseException as exc:  # noqa: BLE001
                errors.append(exc)

        rx = threading.Thread(target=receiver)
        rx.start()
        # Establish the command route first (XPUB slow-joiner), then clear the
        # probe so the post-flood count reflects only the measured commands.
        _establish_route(client, server)
        server.drain_commands()

        tx = threading.Thread(target=commander)
        pub = threading.Thread(target=publisher)
        tx.start()
        pub.start()
        tx.join(timeout=30)
        pub.join(timeout=30)
        stop.set()
        rx.join(timeout=30)

        # No thread blew up, and none is still stuck.
        assert not errors, f"thread(s) raised under load: {errors}"
        assert not tx.is_alive() and not pub.is_alive() and not rx.is_alive()

        # The link is still healthy after the storm.
        assert client.running is True
        assert client.connected is True
        assert client.sock_send is not None
        assert client.sock_recv is not None

        # Commands actually reached the server (the send path survived the race).
        time.sleep(0.2)
        got = server.drain_commands()
        assert got > n_commands * 0.5, f"server only received {got} commands"

        # And inbound traffic kept flowing to the subscriber.
        assert len(client._received) > 0

    def test_send_after_concurrent_storm_still_works(self, server, client):
        """A single clean send must succeed once the storm settles."""
        _establish_route(client, server)
        server.drain_commands()
        stop = threading.Event()

        def churn():
            while not stop.is_set():
                client.receive(timeout=0)
                client.send("STACK", "FF", SIM_NODE_ID)

        t = threading.Thread(target=churn)
        t.start()
        time.sleep(0.5)
        stop.set()
        t.join(timeout=10)
        assert not t.is_alive()

        # Drain whatever the storm queued, then prove a fresh command lands.
        server.drain_commands()
        assert client.send("STACK", "POS AC0001", SIM_NODE_ID) is True
        time.sleep(0.2)
        assert server.drain_commands() >= 1


class TestBurstDrain:
    """receive() must consume a whole burst per tick, not one frame at a time."""

    def test_single_receive_drains_buffered_burst(self, server, client):
        """A fast-forward burst that queues in the SUB buffer is drained in one
        receive() call.

        The old loop pulled a single message per tick, so a 200-frame backlog
        took 200 ticks (~4 s at the 20 ms network-timer rate) to clear and grew
        without bound while fast-forward kept producing. Draining everything
        available each tick keeps the displayed traffic current.
        """
        n = 200
        time.sleep(0.4)  # SUB slow-joiner: ensure the subscription is in effect

        for _ in range(n):
            server.publish("ACDATA", _acdata_frame(100))
        time.sleep(0.5)  # let the whole burst land in the client's SUB buffer

        # One receive() should consume the entire backlog (capped only by
        # MAX_DRAIN_PER_SOCKET, far above n), not a single frame.
        client.receive(timeout=0)
        assert len(client._received) >= n, (
            f"one receive() drained {len(client._received)} of {n} frames "
            "(expected the whole burst)"
        )
