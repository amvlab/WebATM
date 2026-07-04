"""Provide a BlueSky-compatible network client adapted from the BlueSky simulator.

This module contains networking code adapted from the BlueSky Air Traffic
Management simulator's network infrastructure (the ``bluesky.network`` package).
It replicates essential BlueSky Client/Node functionality without requiring the
full BlueSky framework dependency, following ZMQ best practices.

Original BlueSky project: https://github.com/TUDelft-CNS-ATM/bluesky
BlueSky is developed by TU Delft (Delft University of Technology).

Key adaptations from BlueSky's networking components:

- Node ID generation algorithms (from ``bluesky.network.common``)
- ZMQ socket management patterns (from ``bluesky.network.client``)
- Message serialization/deserialization (from ``bluesky.network``)
- Subscription and signal handling patterns
"""

import threading
from collections import defaultdict, deque
from collections.abc import Callable

import msgpack
import zmq

from .logger import get_logger

logger = get_logger()

# BlueSky network constants - adapted from bluesky.network.common
IDLEN = 5

# Socket-buffer high-water marks. BlueSky publishes ACDATA/SIMINFO in bursts —
# especially under fast-forward, where many sim steps' worth of traffic frames
# can arrive between two 20 ms network-timer ticks. A generous receive HWM lets
# those bursts queue in ZMQ instead of being silently dropped (the default SUB
# RCVHWM is only 1000). The send HWM bounds outbound commands (ADDWPT, DT, FF…)
# so a flood of GUI commands can't grow without limit.
RECV_HWM = 100000
SEND_HWM = 100000

# Maximum messages drained from a single socket per receive() call. The receive
# loop pulls *every* currently-available message each tick (not just one) so a
# burst doesn't take many ticks to clear; this cap stops a producer that floods
# faster than we can consume from monopolising the network-timer thread.
MAX_DRAIN_PER_SOCKET = 5000
GROUPID_CLIENT = ord("C")
GROUPID_SIM = ord("S")
GROUPID_NOGROUP = ord("N")
GROUPID_DEFAULT = 0
MSG_SUBSCRIBE = 1
MSG_UNSUBSCRIBE = 0


def genid(group_id=GROUPID_NOGROUP, seqidx=1):
    """Generate a unique node identifier.

    Adapted from ``bluesky.network.common.genid()``. Builds an ID of ``IDLEN``
    bytes: the group prefix, padded with random bytes if needed (avoiding the
    ``*`` wildcard byte), followed by a one-byte encoding of the sequence index.

    Args:
        group_id (int | str | bytes): Group identifier used as the ID prefix.
            Integers and strings are encoded via the charmap codec; bytes are
            used as-is.
        seqidx (int): Sequence index encoded as the final byte of the ID.

    Returns:
        bytes: A node ID of ``IDLEN`` bytes.
    """
    from os import urandom

    # Convert group_id to bytes
    if isinstance(group_id, int):
        group_bytes = chr(group_id).encode("charmap")
    elif isinstance(group_id, str):
        group_bytes = group_id.encode("charmap")
    else:
        group_bytes = group_id

    # Ensure proper length (IDLEN-1 for group + 1 for sequence)
    if len(group_bytes) >= IDLEN:
        return group_bytes[:IDLEN]
    elif len(group_bytes) < IDLEN - 1:
        # Pad with random bytes (avoiding '*' wildcard)
        padding_needed = IDLEN - 1 - len(group_bytes)
        padding = urandom(padding_needed).replace(b"*", b"_")
        group_bytes += padding

    return group_bytes + seqidx2id(seqidx)


def asbytestr(data):
    """Convert a value to a byte string.

    Adapted from ``bluesky.network.common.asbytestr()``. Integers are encoded as
    a single character via the charmap codec, strings are charmap-encoded, and
    any other value is returned unchanged.

    Args:
        data (int | str | bytes): Value to convert.

    Returns:
        bytes: The byte-string representation of ``data``.
    """
    if isinstance(data, int):
        return chr(data).encode("charmap")
    elif isinstance(data, str):
        return data.encode("charmap")
    else:
        return data


def seqid2idx(seqid_byte):
    """Convert a sequence ID byte to a sequence index.

    Adapted from ``bluesky.network.common``. The index is the byte value offset
    by -128, clamped to a minimum of -1.

    Args:
        seqid_byte (int | str): Sequence ID byte, as an integer value or a
            one-character string.

    Returns:
        int: The sequence index (at least -1).
    """
    val = seqid_byte if isinstance(seqid_byte, int) else ord(seqid_byte)
    ret = val - 128
    return max(-1, ret)


def seqidx2id(seqidx):
    """Convert a sequence index to a sequence ID byte.

    Adapted from ``bluesky.network.common``. Inverse of ``seqid2idx``: the byte
    value is the index offset by +128.

    Args:
        seqidx (int): Sequence index to encode.

    Returns:
        bytes: A single charmap-encoded byte representing the index.
    """
    return chr(128 + seqidx).encode("charmap")


def safe_decode(data):
    """Decode bytes to a readable string without raising.

    Attempts UTF-8 decoding first and returns the result only if it consists
    entirely of printable ASCII characters; otherwise falls back to ASCII
    decoding, and finally to an uppercase hexadecimal representation. Non-bytes
    input is converted with ``str()``.

    Args:
        data (bytes | object): Value to decode or stringify.

    Returns:
        str: A printable string representation of ``data``.
    """
    if isinstance(data, bytes):
        try:
            # First try utf-8 decoding
            decoded = data.decode("utf-8")
            # Check if the decoded string contains only printable ASCII characters
            if all(32 <= ord(c) <= 126 for c in decoded):
                return decoded
            else:
                # Contains non-printable characters, use hex representation
                return data.hex().upper()
        except UnicodeDecodeError:
            try:
                # Try ASCII decoding
                decoded = data.decode("ascii")
                return decoded
            except UnicodeDecodeError:
                # Unable to decode as text, use hex representation
                return data.hex().upper()
    return str(data)


class BlueSkySignal:
    """Provide a simple signal/slot implementation.

    Adapted from BlueSky's signal patterns.

    Attributes:
        name (str): Human-readable signal name, used in warning logs.
        callbacks (list): Callbacks currently connected to this signal.
    """

    def __init__(self, name):
        """Initialize the signal.

        Args:
            name (str): Human-readable signal name, used in warning logs.
        """
        self.name = name
        self.callbacks = []

    def connect(self, callback):
        """Connect a callback to this signal.

        Idempotent: a callback that is already connected is not added again.

        Args:
            callback (Callable): Callable invoked whenever the signal is
                emitted.
        """
        if callback not in self.callbacks:
            self.callbacks.append(callback)

    def disconnect(self, callback):
        """Disconnect a callback from this signal.

        A callback that is not connected is silently ignored.

        Args:
            callback (Callable): Callback to remove.
        """
        if callback in self.callbacks:
            self.callbacks.remove(callback)

    def emit(self, *args, **kwargs):
        """Emit the signal to all connected callbacks.

        Iterates over a snapshot of the callback list so callbacks may connect
        or disconnect during emission. Exceptions raised by a callback are
        logged and do not stop delivery to the remaining callbacks.

        Args:
            *args (Any): Positional arguments forwarded to each callback.
            **kwargs (Any): Keyword arguments forwarded to each callback.
        """
        callbacks_snapshot = self.callbacks[
            :
        ]  # Make a copy to avoid concurrency issues
        for callback in callbacks_snapshot:
            try:
                callback(*args, **kwargs)
            except Exception as e:
                logger.warning(f"Signal {self.name}: Error in callback {callback}: {e}")
                import traceback

                traceback.print_exc()


class BlueSkySubscriber:
    """Provide a simple topic-based subscriber system.

    Adapted from BlueSky's subscriber patterns.

    Attributes:
        subscribers (dict[str, list]): Mapping of topic name to the callbacks
            subscribed to that topic.
    """

    def __init__(self):
        """Initialize the subscriber registry with no subscriptions."""
        self.subscribers: dict[str, list] = defaultdict(list)

    def subscribe(self, topic: str, callback: Callable):
        """Subscribe a callback to a topic.

        Idempotent, like ``BlueSkySignal.connect``: a callback already
        subscribed to the topic is not added again.

        Args:
            topic (str): Topic name to subscribe to.
            callback (Callable): Callable invoked when data is emitted on the
                topic.
        """
        if callback not in self.subscribers[topic]:
            self.subscribers[topic].append(callback)

    def emit(self, topic: str, *args, **kwargs):
        """Emit data to all subscribers of a topic.

        Exceptions raised by a callback are logged and do not stop delivery to
        the remaining callbacks. Topics without subscribers are ignored.

        Args:
            topic (str): Topic name to emit on.
            *args (Any): Positional arguments forwarded to each callback.
            **kwargs (Any): Keyword arguments forwarded to each callback.
        """
        for callback in self.subscribers.get(topic, []):
            try:
                callback(*args, **kwargs)
            except Exception as e:
                logger.warning(f"Subscriber {topic}: Error in callback {callback}: {e}")
                logger.debug(f"Subscriber {topic}: Error type: {type(e).__name__}")
                logger.debug(f"Subscriber {topic}: Args: {args}")
                logger.debug(f"Subscriber {topic}: Kwargs: {kwargs}")
                import traceback

                traceback.print_exc()


class BlueSkyStack:
    """Provide a simple command stack.

    Adapted from BlueSky's command stack patterns.

    Attributes:
        cmdstack (collections.deque): Queued ``(command, sender_id)`` pairs.
        sender_id: Sender ID of the command currently being processed, or None.
        current (str): Command currently being processed, or an empty string.
    """

    def __init__(self):
        """Initialize an empty command stack."""
        self.cmdstack = deque()
        self.sender_id = None
        self.current = ""

    def stack(self, *cmdlines, sender_id=None):
        """Queue one or more command lines.

        Each command line is stripped of surrounding whitespace; empty lines are
        ignored. Semicolon-separated compound lines are split into individual
        commands, each queued with the given sender ID.

        Args:
            *cmdlines (str): One or more command lines to queue.
            sender_id (bytes | str | None): Identifier of the command originator, stored
                alongside each queued command.
        """
        for cmdline in cmdlines:
            cmdline = cmdline.strip()
            if cmdline:
                for line in cmdline.split(";"):
                    self.cmdstack.append((line.strip(), sender_id))

    def commands(self):
        """Iterate over queued commands with sender tracking.

        Pops commands from the front of the stack, exposing each one through the
        ``current`` and ``sender_id`` attributes while it is being processed.
        Both attributes are reset when the stack is exhausted.

        Yields:
            str: The next queued command.
        """
        while self.cmdstack:
            self.current, self.sender_id = self.cmdstack.popleft()
            yield self.current
        self.current = ""
        self.sender_id = None


class BlueSkyContext:
    """Provide a simple simulation context object.

    Adapted from BlueSky's simulation context patterns. Tracks the shared-state
    action and sender of the message currently being processed.

    Attributes:
        action: Action type of the message being processed (e.g. "RESET"), or
            None.
        sender_id: Node ID of the message sender, or None.
        Reset (str): BlueSky action constant for a simulation reset ("RESET").
        ActChange (str): BlueSky action constant for an active-node change
            ("ACTCHANGE").
    """

    def __init__(self):
        """Initialize the context with no active action or sender."""
        self.action = None
        self.sender_id = None
        # BlueSky action constants
        self.Reset = "RESET"
        self.ActChange = "ACTCHANGE"


class BlueSkyClient:
    """Provide a BlueSky-compatible network client.

    Adapted from ``bluesky.network.client.Client``. Replicates essential BlueSky
    Client/Node functionality with proper ZMQ lifecycle management, including:

    - ZMQ socket management and lifecycle
    - Node discovery and server communication
    - Message subscription and publishing patterns
    - Command stacking and processing

    Attributes:
        node_id (bytes): Unique identifier of this client node.
        group_id (bytes): Group prefix derived from the node ID.
        server_id (bytes): Derived ID of the server this client belongs to.
        act_id (bytes | None): ID of the active simulation node, or None.
        connected (bool): Whether the client is connected to a server.
        running (bool): Whether the client is running (accepting I/O).
        nodes (set): Known simulation node IDs.
        servers (set): Known server IDs.
        node_added (BlueSkySignal): Emitted when a new simulation node appears.
        node_removed (BlueSkySignal): Emitted when a simulation node disappears.
        server_added (BlueSkySignal): Emitted when a new server appears.
        server_removed (BlueSkySignal): Emitted when a server disappears.
        actnode_changed (BlueSkySignal): Emitted when the active node changes.
        subscriber (BlueSkySubscriber): Topic subscription registry.
        stack (BlueSkyStack): Command stack.
        context (BlueSkyContext): Shared-state processing context.
    """

    def __init__(self, group_id=GROUPID_CLIENT):
        """Initialize the client and its identifiers, signals, and state.

        Generates the node/group/server IDs, sets up the socket lock and network
        state tracking, and auto-connects the ``node_added`` signal to active-node
        selection and initial data requests. No network resources are created
        until ``connect()`` is called.

        Args:
            group_id (int): Group identifier for node ID generation. Defaults to
                ``GROUPID_CLIENT``.
        """
        logger.debug("Initializing...")

        # Node identification
        self.node_id = genid(group_id)
        self.group_id = asbytestr(group_id)[: len(self.node_id) - 1]
        self.server_id = self.node_id[:-1] + seqidx2id(0)
        self.act_id = None

        # Connection state
        self.connected = False
        self.running = False

        # ZMQ resources (created when connecting)
        self.zmq_context = None
        self.sock_recv = None
        self.sock_send = None
        self.poller = None

        # ZMQ sockets are NOT thread-safe, and WebATM drives them from two
        # threads at once: the network-timer thread (receive()/subscription
        # discovery) and the Socket.IO command threads (send(), running under
        # the "threading" async mode). Concurrent access to the same socket
        # corrupts its internal state and can tear the connection down — exactly
        # what happens when GUI commands (rapid ADDWPT, FF…) are sent while data
        # streams in. This reentrant lock serialises every socket operation.
        # It is reentrant because subscription callbacks fired during receive()
        # (e.g. on_node_added_request_data → send()) re-enter the guarded path.
        self._sock_lock = threading.RLock()

        # Network state tracking
        self.nodes = set()
        self.servers = set()
        self.acttopics = defaultdict(set)

        # Signals (simplified)
        self.node_added = BlueSkySignal("node-added")
        self.node_removed = BlueSkySignal("node-removed")
        self.server_added = BlueSkySignal("server-added")
        self.server_removed = BlueSkySignal("server-removed")
        self.actnode_changed = BlueSkySignal("actnode-changed")

        # Message handling
        self.subscriber = BlueSkySubscriber()
        self.stack = BlueSkyStack()
        self.context = BlueSkyContext()

        # Auto-connect node_added to actnode (like BlueSky Client does)
        self.node_added.connect(self.actnode)

        # Connect to node_added signal to request latest data from new nodes
        self.node_added.connect(self.on_node_added_request_data)

        logger.info(f"Initialized with node_id={safe_decode(self.node_id)}")

    def connect(
        self, hostname="localhost", recv_port=11000, send_port=11001, protocol="tcp"
    ):
        """Connect to a BlueSky server following the ZMQ pattern.

        Creates the ZMQ context, SUB (data) and XPUB (command) sockets, tunes
        buffer and shutdown options, connects both sockets, registers them with a
        poller, and subscribes to messages targeted at this node so the server
        can discover it. On failure all partially-created resources are released
        via ``close()``.

        Args:
            hostname (str): BlueSky server hostname or IP address.
            recv_port (int): Port for receiving simulation data.
            send_port (int): Port for sending commands and events.
            protocol (str): ZMQ transport protocol (e.g. "tcp").

        Returns:
            bool: True if the connection was established, False otherwise.
        """
        logger.info(f"Connecting to {hostname}:{recv_port}/{send_port}...")

        try:
            # Create ZMQ context and sockets (following ZMQ pattern)
            self.zmq_context = zmq.Context()
            self.sock_recv = self.zmq_context.socket(zmq.SUB)
            self.sock_send = self.zmq_context.socket(zmq.XPUB)
            self.poller = zmq.Poller()

            # Tune buffers and shutdown behaviour BEFORE connecting (HWM/LINGER
            # must be set before connect to take effect):
            #  - RCVHWM/SNDHWM absorb bursty traffic instead of dropping it.
            #  - LINGER=0 makes close()/reconnect return immediately rather than
            #    blocking on undeliverable queued messages, so a disconnect can
            #    never hang the timer/command threads.
            self.sock_recv.setsockopt(zmq.RCVHWM, RECV_HWM)
            self.sock_recv.setsockopt(zmq.LINGER, 0)
            self.sock_send.setsockopt(zmq.SNDHWM, SEND_HWM)
            self.sock_send.setsockopt(zmq.LINGER, 0)

            # Connect sockets
            recv_addr = f"{protocol}://{hostname}:{recv_port}"
            send_addr = f"{protocol}://{hostname}:{send_port}"

            self.sock_recv.connect(recv_addr)
            self.sock_send.connect(send_addr)

            # Register with poller
            self.poller.register(self.sock_recv, zmq.POLLIN)
            self.poller.register(self.sock_send, zmq.POLLIN)

            # CRITICAL: Register this node by subscribing to targeted messages
            # This is what makes the node discoverable to the server!
            self._subscribe("", "", self.node_id)

            self.connected = True
            self.running = True

            logger.info(
                f"Connected to BlueSky server host at {hostname} with node_id={safe_decode(self.node_id)}"
            )
            return True

        except Exception as e:
            logger.error(f"Connection failed: {e}")
            self.close()
            return False

    def close(self):
        """Close all connections following ZMQ pattern."""
        logger.debug("Closing connections...")

        self.running = False
        self.connected = False

        # Take the socket lock so teardown cannot race a receive()/send() in
        # another thread (the timer thread may still be mid-poll when a command
        # thread or shutdown triggers close()). RLock keeps this safe even if a
        # close path is re-entered.
        with self._sock_lock:
            self._close_locked()

    def _close_locked(self):
        """Socket/context teardown; caller must hold ``_sock_lock``."""
        # Each step is guarded independently so a failure in one cannot abort
        # the rest and leak resources. In particular, a connect() that raised
        # mid-setup can leave a socket created but never registered with the
        # poller; unregister() then raises and must not prevent the socket from
        # being closed and the context destroyed.
        if self.poller:
            for sock in (self.sock_recv, self.sock_send):
                if sock is not None:
                    try:
                        self.poller.unregister(sock)
                    except Exception:
                        # Never registered (e.g. failed connect) - nothing to do.
                        pass
            self.poller = None

        # Close sockets (following ZMQ pattern: close sockets first)
        for attr in ("sock_recv", "sock_send"):
            sock = getattr(self, attr)
            if sock is not None:
                try:
                    sock.close()
                except Exception as e:
                    if "ENOTSOCK" in str(e):
                        logger.debug("Socket already closed, ignoring")
                    else:
                        logger.warning(f"Error closing {attr}: {e}")
                setattr(self, attr, None)

        # Destroy context (following ZMQ pattern: destroy context after sockets)
        if self.zmq_context:
            try:
                self.zmq_context.destroy()
            except Exception as e:
                logger.warning(f"Error destroying ZMQ context: {e}")
            self.zmq_context = None

        logger.info("All ZMQ resources cleaned up")

        # Clear state
        self.nodes.clear()
        self.servers.clear()
        self.acttopics.clear()
        self.act_id = None

    def update(self):
        """Update function - call periodically to receive and process data."""
        if not self.running or not self.connected:
            return False

        try:
            return self.receive(timeout=0)
        except Exception as e:
            logger.error(f"Error in update: {e}")
            return False

    def receive(self, timeout=0):
        """Receive and process incoming messages (following ZMQ recv pattern).

        Socket I/O (poll + recv) is done under ``_sock_lock`` so it cannot race
        a concurrent send() from a command thread. Every currently-available
        message is drained in one pass — a single recv per tick would let a
        fast-forward burst back up for many ticks (stale map, growing latency).
        Handler dispatch runs *outside* the lock: handlers can re-enter the
        client (e.g. node discovery triggers a REQUEST send), and keeping the
        lock hold short means command sends are never blocked by serialisation.
        """
        if not self.running or not self.poller:
            return False

        # (is_data_socket, msg) pairs collected under the lock, dispatched after.
        collected: list[tuple[bool, list]] = []

        try:
            with self._sock_lock:
                if not self.poller:
                    return False

                events = dict(self.poller.poll(timeout))

                for sock, event in events.items():
                    if event != zmq.POLLIN:
                        continue

                    is_data_socket = sock is self.sock_recv

                    # Drain everything queued on this socket right now, bounded
                    # so a flood can't pin the timer thread indefinitely.
                    for _ in range(MAX_DRAIN_PER_SOCKET):
                        try:
                            msg = sock.recv_multipart(zmq.DONTWAIT)
                        except zmq.Again:
                            break
                        if msg:
                            collected.append((is_data_socket, msg))

        except zmq.Again:
            # No messages available (expected with timeout=0)
            return True
        except Exception as e:
            if "ENOTSOCK" in str(e):
                logger.debug("Socket closed during receive")
                return False
            else:
                logger.error(f"Error receiving: {e}")
                return False

        # Dispatch outside the socket lock.
        for is_data_socket, msg in collected:
            if is_data_socket:
                self._process_data_message(msg)
            else:
                self._process_subscription_message(msg)

        return True

    def _process_data_message(self, msg):
        """Process incoming data messages."""
        try:
            # Parse message format: [to_group + topic + from_group, data]
            header = msg[0]
            if len(header) < IDLEN * 2:
                return

            # Extract topic and sender
            topic = header[IDLEN:-IDLEN].decode()
            sender_id = header[-IDLEN:]

            # Decode message data
            try:
                data = msgpack.unpackb(msg[1], raw=False)
            except Exception as e:
                logger.warning(f"Error unpacking message: {e}")
                return

            # Emit to subscribers (follow BlueSky's calling conventions)
            if topic:
                # Special handling for known BlueSky topics with specific signatures
                if (
                    topic == "SIMINFO"
                    and isinstance(data, (list, tuple))
                    and len(data) >= 7
                ):
                    # SIMINFO expects: speed, simdt, simt, simutc, ntraf, state, scenname
                    # Pass sender_id as additional parameter to our custom handler
                    self.subscriber.emit(topic, *data, sender_id=sender_id)
                elif topic in ("ACDATA", "ROUTEDATA"):
                    # ACDATA and ROUTEDATA - handle BlueSky shared state format
                    if isinstance(data, (list, tuple)) and len(data) == 2:
                        # BlueSky shared state format: [action_type, data_dict]
                        action_type, actual_data = data

                        # Set context action for BlueSky compatibility
                        self.context.action = action_type
                        self.context.sender_id = sender_id

                        # Handle different action types like BlueSky does
                        if action_type in ("RESET", "ACTCHANGE"):
                            self.context.action = (
                                self.context.Reset
                                if action_type == "RESET"
                                else self.context.ActChange
                            )

                        self.subscriber.emit(
                            topic, actual_data
                        )  # Pass the actual data dict, not the action wrapper
                    else:
                        self.subscriber.emit(topic, data)  # Pass as single argument
                elif topic == "ECHO":
                    # ECHO expects: text, flags, sender_id (can be called with varying args)
                    # Always include sender_id from message header to identify which node sent the echo
                    if isinstance(data, (list, tuple)):
                        # Ensure we always pass sender_id from message header
                        if len(data) >= 3:
                            # Data already contains [text, flags, sender_id]
                            self.subscriber.emit(topic, *data)
                        elif len(data) == 2:
                            # Data is [text, flags] - add sender_id from header
                            self.subscriber.emit(topic, data[0], data[1], sender_id)
                        elif len(data) == 1:
                            # Data is [text] - add default flags and sender_id from header
                            self.subscriber.emit(topic, data[0], 0, sender_id)
                        else:
                            # Empty list - send empty text with sender_id from header
                            self.subscriber.emit(topic, "", 0, sender_id)
                    elif isinstance(data, dict):
                        text = data.get("text", "")
                        flags = data.get("flags", 0)
                        # Use sender_id from data if available, otherwise from message header
                        data_sender_id = data.get("sender_id", sender_id)
                        self.subscriber.emit(topic, text, flags, data_sender_id)
                    else:
                        # Simple string or other data - add defaults and sender_id from header
                        self.subscriber.emit(topic, str(data), 0, sender_id)
                elif topic == "STATECHANGE":
                    # STATECHANGE follows BlueSky's shared-state format:
                    # [action_type, {"simstate": <int>, ...}]
                    if isinstance(data, (list, tuple)) and len(data) == 2:
                        action_type, actual_data = data
                        self.context.action = action_type
                        self.context.sender_id = sender_id
                        self.subscriber.emit(topic, actual_data, sender_id=sender_id)
                    else:
                        self.subscriber.emit(topic, data, sender_id=sender_id)
                elif topic == "POLY":
                    # POLY expects BlueSky shared state format: [action_type, data_dict]
                    if isinstance(data, (list, tuple)) and len(data) == 2:
                        action_type, actual_data = data

                        # Set context action for BlueSky compatibility
                        self.context.action = action_type
                        self.context.sender_id = sender_id

                        # Handle different action types
                        if action_type in ("RESET", "ACTCHANGE"):
                            self.context.action = (
                                self.context.Reset
                                if action_type == "RESET"
                                else self.context.ActChange
                            )

                        self.subscriber.emit(
                            topic, actual_data
                        )  # Pass the actual data dict
                    else:
                        self.subscriber.emit(topic, data)
                else:
                    # Generic handling for other topics
                    if isinstance(data, dict):
                        self.subscriber.emit(topic, **data)
                    elif isinstance(data, (list, tuple)):
                        self.subscriber.emit(topic, *data)
                    elif data == "":
                        self.subscriber.emit(topic)
                    else:
                        self.subscriber.emit(topic, data)

        except Exception as e:
            logger.error(f"Error processing data message: {e}")

    def _process_subscription_message(self, msg):
        """Process subscription/unsubscription messages (node discovery)."""
        try:
            if len(msg[0]) == IDLEN + 1:
                sender_id = msg[0][1:]
                sequence_idx = seqid2idx(sender_id[-1])

                if sender_id[0] in (GROUPID_SIM, GROUPID_NOGROUP):
                    if msg[0][0] == MSG_SUBSCRIBE:
                        if sequence_idx > 0:
                            # New simulation node
                            if sender_id not in self.nodes:
                                self.nodes.add(sender_id)
                                if sender_id != self.node_id:
                                    logger.info(f"Node added: {safe_decode(sender_id)}")
                                    self.node_added.emit(sender_id)
                        elif sequence_idx == 0:
                            # New server
                            if sender_id not in self.servers:
                                self.servers.add(sender_id)
                                logger.info(f"Server added: {safe_decode(sender_id)}")
                                self.server_added.emit(sender_id)

                    elif msg[0][0] == MSG_UNSUBSCRIBE:
                        if sequence_idx > 0:
                            # Node removed
                            if sender_id in self.nodes:
                                self.nodes.discard(sender_id)
                                logger.info(f"Node removed: {safe_decode(sender_id)}")
                                self.node_removed.emit(sender_id)
                        elif sequence_idx == 0:
                            # Server removed
                            if sender_id in self.servers:
                                self.servers.discard(sender_id)
                                logger.info(f"Server removed: {safe_decode(sender_id)}")
                                self.server_removed.emit(sender_id)

        except Exception as e:
            logger.error(f"Error processing subscription message: {e}")

    def send(self, topic: str, data="", to_group=""):
        """Send data to a topic."""
        if not self.running or not self.sock_send:
            return False

        try:
            btopic = asbytestr(topic)
            bto_group = asbytestr(to_group or "")

            header = bto_group.ljust(IDLEN, b"*") + btopic + self.node_id
            payload = msgpack.packb(data, use_bin_type=True)

            # Serialise socket access against the receive loop / other senders;
            # ZMQ sockets are not thread-safe (see _sock_lock). DONTWAIT means a
            # momentarily-full send buffer raises zmq.Again instead of blocking
            # the caller (a Socket.IO command thread) on the socket.
            with self._sock_lock:
                if not self.sock_send:
                    return False
                self.sock_send.send_multipart([header, payload], zmq.DONTWAIT)

            return True

        except zmq.Again:
            logger.warning(f"Send buffer full, dropping '{topic}' command")
            return False
        except Exception as e:
            logger.error(f"Error sending: {e}")
            return False

    def subscribe(self, topic: str, callback: Callable, actonly=False):
        """Subscribe to a topic with callback."""
        self.subscriber.subscribe(topic, callback)
        # Subscribe on network level with actonly support
        self._subscribe(topic, GROUPID_DEFAULT, "", actonly=actonly)

    def _subscribe(
        self, topic: str, from_group=GROUPID_DEFAULT, to_group="", actonly=False
    ):
        """Low-level network subscription (following BlueSky Client logic)."""
        if not self.sock_recv:
            return

        try:
            # Follow BlueSky Client subscription logic exactly
            if from_group == GROUPID_DEFAULT:
                from_group = GROUPID_SIM
                if actonly:
                    # Store this as an actonly topic for later re-subscription when active node changes
                    self.acttopics[topic].add(to_group)
                    if self.act_id is not None:
                        # We have an active node - subscribe to that specific node
                        from_group = self.act_id
                        logger.debug(
                            f"Subscribing to {topic} from active node {safe_decode(self.act_id)}"
                        )
                    else:
                        # No active node yet - store subscription for later
                        logger.debug(
                            f"Deferring {topic} actonly subscription until active node is set"
                        )
                        return

            btopic = asbytestr(topic)
            bfrom_group = asbytestr(from_group)
            bto_group = asbytestr(to_group)

            subscribe_key = bto_group.ljust(IDLEN, b"*") + btopic + bfrom_group
            with self._sock_lock:
                if self.sock_recv:
                    self.sock_recv.setsockopt(zmq.SUBSCRIBE, subscribe_key)

        except Exception as e:
            logger.error(f"Error subscribing to {topic}: {e}")

    def _unsubscribe(self, topic: str, from_group=GROUPID_DEFAULT, to_group=""):
        """Low-level network unsubscription (following BlueSky Client logic)."""
        if not self.sock_recv:
            return

        try:
            # Follow BlueSky Client unsubscription logic
            if from_group == GROUPID_DEFAULT:
                from_group = GROUPID_SIM
                if topic in self.acttopics:
                    self.acttopics[topic].discard(to_group)
                    if self.act_id is not None:
                        from_group = self.act_id
                    else:
                        return

            btopic = asbytestr(topic)
            bfrom_group = asbytestr(from_group)
            bto_group = asbytestr(to_group)

            subscribe_key = bto_group.ljust(IDLEN, b"*") + btopic + bfrom_group
            with self._sock_lock:
                if self.sock_recv:
                    self.sock_recv.setsockopt(zmq.UNSUBSCRIBE, subscribe_key)

        except Exception as e:
            logger.error(f"Error unsubscribing from {topic}: {e}")

    def actnode(self, newact=None):
        """Set or get the active simulation node."""
        if newact:
            if newact not in self.nodes:
                logger.error(
                    f"Error selecting active node (unknown node): {safe_decode(newact)}"
                )
                return None

            if self.act_id is None:
                # First time selecting active node - disconnect auto-selection
                self.node_added.disconnect(self.actnode)

            # Update subscriptions for new active node
            if newact != self.act_id:
                for topic, groupset in self.acttopics.items():
                    for to_group in groupset:
                        if self.act_id:
                            self._unsubscribe(topic, self.act_id, to_group)
                        self._subscribe(topic, newact, to_group)

                self.act_id = newact
                self.actnode_changed.emit(newact)

        return self.act_id

    def addnodes(self, count=1, server_id=None):
        """Tell server to add nodes."""
        target_server = server_id or (
            self.act_id[:-1] + seqidx2id(0) if self.act_id else self.server_id
        )
        return self.send("ADDNODES", {"count": count}, target_server)

    def on_node_added_request_data(self, node_id):
        """When a new node is announced, request the initial/current state of all
        subscribed shared states."""
        logger.info("A new node has been added! request topics")

        # TODO: fix request
        # Request all BlueSky topics we want to receive add #STACK
        # topics = ['RESET', 'REQUEST', 'PLOT', 'SHOWDIALOG', 'SIMINFO',
        #          'SIMSETTINGS', 'TRAILS', 'ROUTEDATA', 'ACDATA', 'DEFWPT',
        #          'POLY', 'STACKCMDS']

        topics = ["POLY", "STACKCMDS"]

        logger.debug(
            f"Requesting topics {topics} from all nodes (triggered by new node {safe_decode(node_id)})"
        )
        self.send("REQUEST", topics)
        self.send("REQUEST", topics)
