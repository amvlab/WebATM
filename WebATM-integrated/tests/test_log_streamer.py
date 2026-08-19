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


class ReentrantSocketIO(FakeSocketIO):
    """Runs a newly scheduled flush task *during* an emit.

    FakeSocketIO drains tasks strictly one after another, which hides the real
    threading-mode behaviour where a second flush task can emit while the first
    is still working through its chunks. This stand-in models that by firing
    ``on_first_emit`` mid-flush and giving any task it schedules a turn there
    and then.
    """

    def __init__(self):
        super().__init__()
        self.on_first_emit = None
        self._reentered = False

    def emit(self, event, payload):
        super().emit(event, payload)
        if self.on_first_emit and not self._reentered:
            self._reentered = True
            hook, self.on_first_emit = self.on_first_emit, None
            hook()  # a log line arrives mid-flush...
            self.run_all()  # ...and its flush task gets a turn


def test_a_line_arriving_mid_flush_does_not_overtake_the_batch_being_emitted():
    """Only one flush task may be live: a second one emitting concurrently
    would interleave its newer lines among the older chunks, delivering the
    stream out of order despite seq being assigned in order."""
    sio = ReentrantSocketIO()
    streamer = LogStreamer(sio, batch_max=2)

    for i in range(5):
        streamer.feed_line(f"l{i}")
    sio.on_first_emit = lambda: streamer.feed_line("late")
    sio.run_all()

    seqs = [item["seq"] for _, payload in sio.emitted for item in payload["lines"]]
    assert seqs == sorted(seqs), f"lines delivered out of order: {seqs}"
    assert _lines(sio) == ["l0", "l1", "l2", "l3", "l4", "late"]


def test_a_line_arriving_as_the_flusher_winds_down_is_still_delivered():
    """The scheduled flag is cleared under the same lock feed_line appends
    under, so a line can never be left pending with no flush task coming."""
    sio = FakeSocketIO()
    streamer = LogStreamer(sio)

    streamer.feed_line("first")
    sio.run_all()
    streamer.feed_line("second")
    sio.run_all()

    assert _lines(sio) == ["first", "second"]


def test_stream_recovers_after_an_emit_raises():
    """A raising emit must not leave the flush flag stuck True -- feed_line only
    schedules while it is False, so the stream would go silent for good."""
    sio = FakeSocketIO()
    streamer = LogStreamer(sio)

    def boom(event, payload):
        raise RuntimeError("socket write failed")

    sio.emit = boom
    streamer.feed_line("during-outage")
    with pytest.raises(RuntimeError):
        sio.run_all()

    # The next line must schedule a fresh flush and get through.
    sio.emit = lambda event, payload: sio.emitted.append((event, payload))
    streamer.feed_line("after-outage")
    sio.run_all()

    assert _lines(sio) == ["after-outage"]


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
