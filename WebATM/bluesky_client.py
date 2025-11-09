"""
BlueSky-compatible network client adapted from BlueSky ATM simulator.

This module contains networking code adapted from the BlueSky Air Traffic
Management simulator's network infrastructure (bluesky.network package).
It replicates essential BlueSky Client/Node functionality without requiring
the full BlueSky framework dependency, following ZMQ best practices.

Original BlueSky project: https://github.com/TUDelft-CNS-ATM/bluesky
BlueSky is developed by TU Delft (Delft University of Technology)

Key adaptations from BlueSky's networking components:
- Node ID generation algorithms (from bluesky.network.common)
- ZMQ socket management patterns (from bluesky.network.client)
- Message serialization/deserialization (from bluesky.network)
- Subscription and signal handling patterns
"""

from collections import defaultdict, deque
from typing import Callable, Dict

import msgpack
import zmq

from .logger import get_logger

logger = get_logger()

# BlueSky network constants - adapted from bluesky.network.common
IDLEN = 5
GROUPID_CLIENT = ord("C")
GROUPID_SIM = ord("S")
GROUPID_NOGROUP = ord("N")
GROUPID_DEFAULT = 0
MSG_SUBSCRIBE = 1
MSG_UNSUBSCRIBE = 0


def genid(group_id=GROUPID_NOGROUP, seqidx=1):
    """Generate a node ID - adapted from bluesky.network.common.genid()."""
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
    """Convert to bytes - adapted from bluesky.network.common.asbytestr()."""
    if isinstance(data, int):
        return chr(data).encode("charmap")
    elif isinstance(data, str):
        return data.encode("charmap")
    else:
        return data


def seqid2idx(seqid_byte):
    """Convert sequence ID byte to index - adapted from bluesky.network.common."""
    val = seqid_byte if isinstance(seqid_byte, int) else ord(seqid_byte)
    ret = val - 128
    return max(-1, ret)


def seqidx2id(seqidx):
    """Convert index to sequence ID byte - adapted from bluesky.network.common."""
    return chr(128 + seqidx).encode("charmap")


def safe_decode(data):
    """Safely decode bytes to string."""
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
    """Simple signal/slot implementation - adapted from BlueSky's signal patterns."""

    def __init__(self, name):
        self.name = name
        self.callbacks = []

    def connect(self, callback):
        """Connect a callback to this signal."""
        if callback not in self.callbacks:
            self.callbacks.append(callback)

    def disconnect(self, callback):
        """Disconnect a callback from this signal."""
        if callback in self.callbacks:
            self.callbacks.remove(callback)

    def emit(self, *args, **kwargs):
        """Emit the signal to all connected callbacks."""
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
    """Simple subscriber system - adapted from BlueSky's subscriber patterns."""

    def __init__(self):
        self.subscribers: Dict[str, list] = defaultdict(list)

    def subscribe(self, topic: str, callback: Callable):
        """Subscribe to a topic."""
        self.subscribers[topic].append(callback)

    def emit(self, topic: str, *args, **kwargs):
        """Emit data to subscribers of a topic."""
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
    """Simple stack implementation - adapted from BlueSky's command stack patterns."""

    def __init__(self):
        self.cmdstack = deque()
        self.sender_id = None
        self.current = ""

    def stack(self, *cmdlines, sender_id=None):
        """Stack one or more commands."""
        for cmdline in cmdlines:
            cmdline = cmdline.strip()
            if cmdline:
                for line in cmdline.split(";"):
                    self.cmdstack.append((line.strip(), sender_id))

    def commands(self):
        """Generator for commands with sender tracking."""
        while self.cmdstack:
            self.current, self.sender_id = self.cmdstack.popleft()
            yield self.current
        self.current = ""
        self.sender_id = None


class BlueSkyContext:
    """Simple context object - adapted from BlueSky's simulation context patterns."""

    def __init__(self):
        self.action = None
        self.sender_id = None
        # BlueSky action constants
        self.Reset = "RESET"
        self.ActChange = "ACTCHANGE"


class BlueSkyClient:
    """
    BlueSky-compatible network client - adapted from bluesky.network.client.Client.

    This class replicates essential BlueSky Client/Node functionality including:
    - ZMQ socket management and lifecycle
    - Node discovery and server communication
    - Message subscription and publishing patterns
    - Command stacking and processing

    Adapted from BlueSky's networking infrastructure with proper ZMQ lifecycle management.
    """

    def __init__(self, group_id=GROUPID_CLIENT):
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
        """Connect to BlueSky server following ZMQ pattern."""
        logger.info(f"Connecting to {hostname}:{recv_port}/{send_port}...")

        try:
            # Create ZMQ context and sockets (following ZMQ pattern)
            self.zmq_context = zmq.Context()
            self.sock_recv = self.zmq_context.socket(zmq.SUB)
            self.sock_send = self.zmq_context.socket(zmq.XPUB)
            self.poller = zmq.Poller()

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

        try:
            # Unregister from poller first
            if self.poller:
                if self.sock_recv:
                    self.poller.unregister(self.sock_recv)
                if self.sock_send:
                    self.poller.unregister(self.sock_send)

            # Close sockets (following ZMQ pattern: close sockets first)
            if self.sock_recv:
                self.sock_recv.close()
                self.sock_recv = None

            if self.sock_send:
                self.sock_send.close()
                self.sock_send = None

            # Destroy context (following ZMQ pattern: destroy context after sockets)
            if self.zmq_context:
                self.zmq_context.destroy()
                self.zmq_context = None

            self.poller = None

            logger.info("All ZMQ resources cleaned up")

        except Exception as e:
            if "ENOTSOCK" in str(e):
                logger.debug("Socket already closed, ignoring")
            else:
                logger.warning(f"Error during close: {e}")

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
        """Receive and process incoming messages (following ZMQ recv pattern)."""
        if not self.running or not self.poller:
            return False

        try:
            # Poll for messages (like ZMQ C example with ZMQ_DONTWAIT)
            events = dict(self.poller.poll(timeout))

            for sock, event in events.items():
                if event != zmq.POLLIN:
                    continue

                # Receive message
                msg = sock.recv_multipart()
                if not msg:
                    continue

                # Process message based on socket
                if sock == self.sock_recv:
                    self._process_data_message(msg)
                elif sock == self.sock_send:
                    self._process_subscription_message(msg)

            return True

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

            self.sock_send.send_multipart([header, payload])

            return True

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
