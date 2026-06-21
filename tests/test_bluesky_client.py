"""Tests for WebATM.bluesky_client.

Covers the pure ID/encoding helpers, the signal/subscriber/stack primitives,
and the parts of :class:`BlueSkyClient` that can be exercised without opening
real ZMQ sockets.
"""

from WebATM.bluesky_client import (
    GROUPID_CLIENT,
    GROUPID_NOGROUP,
    IDLEN,
    BlueSkyClient,
    BlueSkyContext,
    BlueSkySignal,
    BlueSkyStack,
    BlueSkySubscriber,
    asbytestr,
    genid,
    safe_decode,
    seqid2idx,
    seqidx2id,
)


class TestSeqIdConversions:
    def test_seqidx2id_roundtrip(self):
        for idx in range(0, 10):
            assert seqid2idx(seqidx2id(idx)) == idx

    def test_seqidx2id_returns_single_byte(self):
        assert seqidx2id(0) == b"\x80"
        assert seqidx2id(1) == b"\x81"

    def test_seqid2idx_accepts_int(self):
        assert seqid2idx(128) == 0
        assert seqid2idx(130) == 2

    def test_seqid2idx_floor_is_minus_one(self):
        # Anything below 127 clamps to -1.
        assert seqid2idx(0) == -1
        assert seqid2idx(50) == -1


class TestAsbytestr:
    def test_int_input(self):
        assert asbytestr(ord("N")) == b"N"

    def test_str_input(self):
        assert asbytestr("AB") == b"AB"

    def test_bytes_passthrough(self):
        assert asbytestr(b"xy") == b"xy"


class TestGenid:
    def test_length_is_idlen(self):
        assert len(genid(GROUPID_NOGROUP, 1)) == IDLEN

    def test_group_prefix_present(self):
        node_id = genid(GROUPID_NOGROUP, 1)
        assert node_id[0:1] == b"N"

    def test_sequence_suffix(self):
        node_id = genid(GROUPID_NOGROUP, 3)
        assert seqid2idx(node_id[-1]) == 3

    def test_padding_avoids_wildcard(self):
        # Generate many ids; none of the random padding should contain '*'.
        for _ in range(100):
            node_id = genid(GROUPID_NOGROUP, 1)
            assert b"*" not in node_id

    def test_client_group_prefix(self):
        node_id = genid(GROUPID_CLIENT, 1)
        assert node_id[0:1] == b"C"


class TestSafeDecode:
    def test_printable_ascii_bytes(self):
        assert safe_decode(b"HELLO") == "HELLO"

    def test_non_printable_bytes_become_hex(self):
        # 0x01 decodes as utf-8 but is non-printable -> hex representation.
        assert safe_decode(b"\x01\x02") == "0102".upper()

    def test_invalid_utf8_becomes_hex(self):
        assert safe_decode(b"\x80\xff") == "80FF"

    def test_str_passthrough(self):
        assert safe_decode("already") == "already"

    def test_non_bytes_is_stringified(self):
        assert safe_decode(123) == "123"


class TestBlueSkySignal:
    def test_connect_and_emit(self):
        sig = BlueSkySignal("test")
        received = []
        sig.connect(lambda x: received.append(x))
        sig.emit(5)
        assert received == [5]

    def test_connect_is_idempotent(self):
        sig = BlueSkySignal("test")
        calls = []

        def cb(x):
            calls.append(x)

        sig.connect(cb)
        sig.connect(cb)  # duplicate ignored
        sig.emit(1)
        assert calls == [1]

    def test_disconnect(self):
        sig = BlueSkySignal("test")
        calls = []
        cb = lambda x: calls.append(x)  # noqa: E731
        sig.connect(cb)
        sig.disconnect(cb)
        sig.emit(1)
        assert calls == []

    def test_callback_exception_does_not_break_emit(self):
        sig = BlueSkySignal("test")
        survivors = []

        def boom(x):
            raise ValueError("boom")

        sig.connect(boom)
        sig.connect(lambda x: survivors.append(x))
        sig.emit(7)  # should not raise
        assert survivors == [7]

    def test_emit_passes_args_and_kwargs(self):
        sig = BlueSkySignal("test")
        captured = {}
        sig.connect(lambda *a, **k: captured.update({"args": a, "kwargs": k}))
        sig.emit(1, 2, foo="bar")
        assert captured == {"args": (1, 2), "kwargs": {"foo": "bar"}}


class TestBlueSkySubscriber:
    def test_subscribe_and_emit(self):
        sub = BlueSkySubscriber()
        received = []
        sub.subscribe("TOPIC", lambda d: received.append(d))
        sub.emit("TOPIC", "data")
        assert received == ["data"]

    def test_multiple_subscribers_same_topic(self):
        sub = BlueSkySubscriber()
        a, b = [], []
        sub.subscribe("T", a.append)
        sub.subscribe("T", b.append)
        sub.emit("T", 99)
        assert a == [99] and b == [99]

    def test_emit_unknown_topic_is_noop(self):
        sub = BlueSkySubscriber()
        # No subscribers; should simply not raise.
        sub.emit("MISSING", 1)

    def test_subscriber_exception_is_isolated(self):
        sub = BlueSkySubscriber()
        ok = []
        sub.subscribe("T", lambda d: (_ for _ in ()).throw(RuntimeError("x")))
        sub.subscribe("T", ok.append)
        sub.emit("T", "payload")
        assert ok == ["payload"]


class TestBlueSkyStack:
    def test_stack_single_command(self):
        stack = BlueSkyStack()
        stack.stack("CRE KL204")
        assert list(stack.commands()) == ["CRE KL204"]

    def test_stack_splits_on_semicolons(self):
        stack = BlueSkyStack()
        stack.stack("A;B;C")
        assert list(stack.commands()) == ["A", "B", "C"]

    def test_stack_strips_whitespace(self):
        stack = BlueSkyStack()
        stack.stack("  HOLD  ;  OP  ")
        assert list(stack.commands()) == ["HOLD", "OP"]

    def test_empty_command_is_ignored(self):
        stack = BlueSkyStack()
        stack.stack("")
        stack.stack("   ")
        assert list(stack.commands()) == []

    def test_commands_drains_the_stack(self):
        stack = BlueSkyStack()
        stack.stack("ONE")
        list(stack.commands())
        assert list(stack.commands()) == []

    def test_sender_id_tracked(self):
        stack = BlueSkyStack()
        stack.stack("CMD", sender_id=b"abc")
        list(stack.commands())
        assert stack.sender_id is None  # reset after draining

    def test_multiple_stack_calls_accumulate(self):
        stack = BlueSkyStack()
        stack.stack("A")
        stack.stack("B")
        assert list(stack.commands()) == ["A", "B"]


class TestBlueSkyContext:
    def test_action_constants(self):
        ctx = BlueSkyContext()
        assert ctx.Reset == "RESET"
        assert ctx.ActChange == "ACTCHANGE"

    def test_defaults(self):
        ctx = BlueSkyContext()
        assert ctx.action is None
        assert ctx.sender_id is None


class TestBlueSkyClientConstruction:
    def test_node_id_length_and_group(self):
        client = BlueSkyClient()
        assert len(client.node_id) == IDLEN
        assert client.node_id[0:1] == b"C"  # GROUPID_CLIENT

    def test_server_id_derived_from_node_id(self):
        client = BlueSkyClient()
        assert client.server_id == client.node_id[:-1] + seqidx2id(0)

    def test_starts_disconnected(self):
        client = BlueSkyClient()
        assert client.connected is False
        assert client.running is False
        assert client.act_id is None

    def test_signals_exist(self):
        client = BlueSkyClient()
        for name in (
            "node_added",
            "node_removed",
            "server_added",
            "server_removed",
            "actnode_changed",
        ):
            assert isinstance(getattr(client, name), BlueSkySignal)

    def test_send_when_not_running_returns_false(self):
        client = BlueSkyClient()
        # No socket / not running -> graceful False.
        assert client.send("STACK", "CRE KL204") is False

    def test_update_when_not_connected_returns_false(self):
        client = BlueSkyClient()
        assert client.update() is False

    def test_actnode_with_unknown_node_returns_none(self):
        client = BlueSkyClient()
        assert client.actnode(b"unknown") is None

    def test_actnode_selects_known_node(self):
        client = BlueSkyClient()
        node = b"S\x01\x02\x03\x81"
        client.nodes.add(node)
        captured = []
        client.actnode_changed.connect(captured.append)
        assert client.actnode(node) == node
        assert client.act_id == node
        assert captured == [node]

    def test_close_is_safe_without_connection(self):
        client = BlueSkyClient()
        # Closing a never-connected client should clear state without error.
        client.close()
        assert client.act_id is None
        assert client.nodes == set()
