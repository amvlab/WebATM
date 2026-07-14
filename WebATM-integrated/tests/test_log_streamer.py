"""Tests for LogStreamer: ordered batching, bounded history, and recovery
when scheduling a flush fails.

Uses a synchronous flask_socketio stand-in that queues background tasks so the
test controls exactly when flushes run (feed_line schedules while holding the
streamer's lock, so tasks must not run inline).
"""

import pytest
from webatm_integrated.log_streamer import EVENT, LogStreamer


class FakeSocketIO:
    """flask_socketio stand-in: queues background tasks for explicit draining."""

    def __init__(self):
        self.emitted: list[tuple[str, dict]] = []
        self.tasks: list = []
        self.fail_next_schedule = False

    def start_background_task(self, target, *args):
        if self.fail_next_schedule:
            self.fail_next_schedule = False
            raise RuntimeError("can't start new thread")
        self.tasks.append((target, args))

    def run_all(self):
        while self.tasks:
            target, args = self.tasks.pop(0)
            target(*args)

    def sleep(self, seconds):
        pass

    def emit(self, event, payload):
        self.emitted.append((event, payload))


def _lines(sio):
    return [item["line"] for _, payload in sio.emitted for item in payload["lines"]]


def test_lines_are_emitted_in_order_with_monotonic_seq():
    sio = FakeSocketIO()
    streamer = LogStreamer(sio)

    for line in ("one", "two", "three"):
        streamer.feed_line(line)
    sio.run_all()

    assert _lines(sio) == ["one", "two", "three"]
    seqs = [item["seq"] for _, payload in sio.emitted for item in payload["lines"]]
    assert seqs == [1, 2, 3]
    assert [item["line"] for item in streamer.history()] == ["one", "two", "three"]


def test_burst_coalesces_into_one_task_and_chunks_by_batch_max():
    sio = FakeSocketIO()
    streamer = LogStreamer(sio, batch_max=2)

    for i in range(5):
        streamer.feed_line(f"l{i}")

    # One coalesced flush task for the whole burst...
    assert len(sio.tasks) == 1
    sio.run_all()
    # ...emitted in chunks capped at batch_max.
    assert [len(payload["lines"]) for _, payload in sio.emitted] == [2, 2, 1]
    assert all(event == EVENT for event, _ in sio.emitted)


def test_history_is_bounded_to_max_history():
    sio = FakeSocketIO()
    streamer = LogStreamer(sio, max_history=3)

    for i in range(5):
        streamer.feed_line(f"l{i}")

    assert [item["line"] for item in streamer.history()] == ["l2", "l3", "l4"]


def test_feed_line_recovers_after_a_failed_schedule():
    """A failed start_background_task must not leave _flush_scheduled stuck
    True, which would silence the stream forever."""
    sio = FakeSocketIO()
    streamer = LogStreamer(sio)

    sio.fail_next_schedule = True
    with pytest.raises(RuntimeError):
        streamer.feed_line("first")

    # The next line re-schedules and the flush delivers BOTH lines.
    streamer.feed_line("second")
    sio.run_all()

    assert _lines(sio) == ["first", "second"]
