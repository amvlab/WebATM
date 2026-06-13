"""Live, in-order log streaming of the BlueSky process tree to web clients.

A single server-wide stream (one subprocess) is broadcast to all connected
browsers over the ``server_log`` Socket.IO event. Ordering is guaranteed by a
monotonic sequence number assigned under a lock at ingest, before any async
hop. Bursts (for example, creating many nodes at once) are coalesced into
batches so a flood of lines cannot overwhelm Socket.IO.
"""

from __future__ import annotations

import collections
import threading
import time

EVENT = "server_log"


class LogStreamer:
    """Buffers process output and broadcasts it as ordered, batched events."""

    def __init__(
        self,
        socketio,
        max_history: int = 2000,
        batch_ms: int = 100,
        batch_max: int = 200,
    ):
        self._sio = socketio
        self._lock = threading.Lock()
        self._history = collections.deque(maxlen=max_history)
        self._pending: list[dict] = []
        self._seq = 0
        self._flush_scheduled = False
        self._batch_ms = batch_ms
        self._batch_max = batch_max

    def feed_line(self, line: str) -> None:
        """Ingest one output line; assigns its order and schedules a flush."""
        with self._lock:
            self._seq += 1
            item = {"seq": self._seq, "t": time.time(), "line": line}
            self._history.append(item)
            self._pending.append(item)
            if not self._flush_scheduled:
                self._flush_scheduled = True
                self._sio.start_background_task(self._flush_after_delay)

    def _flush_after_delay(self) -> None:
        # Cooperative sleep: works under both threading and eventlet modes.
        self._sio.sleep(self._batch_ms / 1000.0)
        with self._lock:
            batch = self._pending
            self._pending = []
            self._flush_scheduled = False
        for start in range(0, len(batch), self._batch_max):
            chunk = batch[start : start + self._batch_max]
            self._sio.emit(EVENT, {"lines": chunk})

    def history(self) -> list[dict]:
        """Return a snapshot of buffered lines (for late-joining clients)."""
        with self._lock:
            return list(self._history)

    def on_process_exit(self, return_code: int) -> None:
        """Emit an end-of-stream marker when the server process exits."""
        self.feed_line(f"--- bluesky server exited (return code {return_code}) ---")

    def clear(self) -> None:
        with self._lock:
            self._history.clear()
