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
    """Buffer process output and broadcast it as ordered, batched events."""

    def __init__(
        self,
        socketio,
        max_history: int = 2000,
        batch_ms: int = 100,
        batch_max: int = 200,
    ):
        """Initialize the streamer.

        Args:
            socketio (flask_socketio.SocketIO): Instance used to emit batches.
            max_history (int): Maximum lines retained for history replay.
            batch_ms (int): Delay in milliseconds used to coalesce a batch.
            batch_max (int): Maximum lines per emitted batch chunk.
        """
        self._sio = socketio
        self._lock = threading.Lock()
        self._history: collections.deque[dict] = collections.deque(maxlen=max_history)
        self._pending: list[dict] = []
        self._seq = 0
        self._flush_scheduled = False
        self._batch_ms = batch_ms
        self._batch_max = batch_max

    def feed_line(self, line: str) -> None:
        """Ingest one output line, assign its order, and schedule a flush.

        Args:
            line (str): The process output line to broadcast.
        """
        with self._lock:
            self._seq += 1
            item = {"seq": self._seq, "t": time.time(), "line": line}
            self._history.append(item)
            self._pending.append(item)
            if not self._flush_scheduled:
                self._flush_scheduled = True
                try:
                    self._sio.start_background_task(self._flush_after_delay)
                except Exception:
                    # Un-wedge the scheduler: the line stays pending and the
                    # next feed_line retries; a stuck True flag would silence
                    # the stream forever.
                    self._flush_scheduled = False
                    raise

    def _flush_after_delay(self) -> None:
        # Cooperative sleep via SocketIO so it matches the active async mode.
        self._sio.sleep(self._batch_ms / 1000.0)
        with self._lock:
            batch = self._pending
            self._pending = []
            self._flush_scheduled = False
        for start in range(0, len(batch), self._batch_max):
            chunk = batch[start : start + self._batch_max]
            self._sio.emit(EVENT, {"lines": chunk})

    def history(self) -> list[dict]:
        """Return a snapshot of buffered lines for late-joining clients.

        Returns:
            list[dict]: Buffered items with ``seq``, ``t`` and ``line`` keys.
        """
        with self._lock:
            return list(self._history)

    def on_process_exit(self, return_code: int) -> None:
        """Emit an end-of-stream marker when the server process exits.

        Args:
            return_code (int): Exit code of the BlueSky server process.
        """
        self.feed_line(f"--- bluesky server exited (return code {return_code}) ---")
