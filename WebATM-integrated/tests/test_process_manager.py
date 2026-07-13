"""Mechanism tests for BlueSkyProcessManager.

These reproduce the exact behavior the live-log + kill features rely on, using a
synthetic process tree (a `python -c` "parent" that itself spawns a "child"
inheriting its stdout) -- so they need no real BlueSky:

* a child writing to the *inherited* stdout fd is captured in the manager's
  single merged pipe (this is precisely how BlueSky's `addnodes` spawns nodes:
  `subprocess.Popen([...])` with no stdout/stderr/start_new_session), and
* `kill()` reaps the whole process group, not just the parent.

The manager is imported flask-free (webatm_integrated/__init__ defers its Flask
imports into register()), so only `pytest` + the stdlib are required.
"""

import os
import sys
import threading
import time

from webatm_integrated.process_manager import BlueSkyProcessManager


def _collector():
    """Thread-safe line collector returning (on_line, snapshot)."""
    captured: list[str] = []
    lock = threading.Lock()

    def on_line(line: str) -> None:
        with lock:
            captured.append(line)

    def snapshot() -> list[str]:
        with lock:
            return list(captured)

    return on_line, snapshot


def _wait_for(predicate, timeout: float = 10.0, interval: float = 0.05):
    """Poll predicate until it returns truthy or the timeout elapses."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        result = predicate()
        if result:
            return result
        time.sleep(interval)
    return predicate()


def _pid_running(pid: int) -> bool:
    """True if pid exists and is not a reaped-pending zombie."""
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    # Exists; on Linux a zombie is dead-but-unreaped -> treat as not running.
    try:
        with open(f"/proc/{pid}/stat") as fh:
            state = fh.read().rsplit(") ", 1)[1].split()[0]
        return state != "Z"
    except FileNotFoundError:
        # No /proc (e.g. macOS): os.kill already said it exists.
        return True
    except OSError:
        return False


def test_merged_capture_includes_child_output():
    """A child writing to the inherited stdout fd lands in the merged pipe, in order."""
    on_line, snapshot = _collector()
    parent_src = (
        "import subprocess, sys\n"
        "print('P1', flush=True)\n"
        "subprocess.Popen([sys.executable, '-c', \"print('C1', flush=True)\"]).wait()\n"
        "print('P2', flush=True)\n"
    )
    manager = BlueSkyProcessManager(
        on_line=on_line, cmd=[sys.executable, "-c", parent_src]
    )
    try:
        assert manager.start()["success"] is True
        got = _wait_for(lambda: {"P1", "C1", "P2"} <= set(snapshot()))
        captured = snapshot()
        assert got, f"missing expected lines; captured={captured}"
        # Deterministic order: parent P1, then child C1 (waited), then parent P2.
        assert captured.index("P1") < captured.index("C1") < captured.index("P2")
    finally:
        manager.kill()


def test_kill_reaps_the_whole_process_group():
    """kill() takes down the inherited-group child, not just the parent."""
    on_line, snapshot = _collector()
    parent_src = (
        "import subprocess, sys, time\n"
        "child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])\n"
        "print('CHILD', child.pid, flush=True)\n"
        "time.sleep(60)\n"
    )
    manager = BlueSkyProcessManager(
        on_line=on_line, cmd=[sys.executable, "-c", parent_src]
    )
    manager.start()
    try:
        child_line = _wait_for(
            lambda: next((ln for ln in snapshot() if ln.startswith("CHILD ")), None)
        )
        assert child_line, f"never saw CHILD line; captured={snapshot()}"
        child_pid = int(child_line.split()[1])
        assert _pid_running(child_pid), "child should be alive before kill"

        manager.kill()

        dead = _wait_for(lambda: not _pid_running(child_pid))
        assert dead, f"child {child_pid} still running after kill()"
        assert manager.status()["running"] is False
    finally:
        manager.kill()


def test_reader_keeps_draining_when_on_line_raises():
    """A raising on_line callback must not stop pipe draining: an abandoned
    pipe fills up and then blocks the whole BlueSky tree on its next write."""
    captured: list[str] = []
    lock = threading.Lock()

    def on_line(line: str) -> None:
        if line == "BOOM":
            raise RuntimeError("handler failed")
        with lock:
            captured.append(line)

    exit_codes: list[int] = []
    src = "print('BOOM', flush=True)\nprint('AFTER', flush=True)\n"
    manager = BlueSkyProcessManager(
        on_line=on_line, on_exit=exit_codes.append, cmd=[sys.executable, "-c", src]
    )
    try:
        assert manager.start()["success"] is True
        got = _wait_for(lambda: "AFTER" in captured)
        assert got, f"reader died on the raising line; captured={captured}"
        assert _wait_for(lambda: exit_codes == [0])
    finally:
        manager.kill()


def test_status_and_restart():
    """status() tracks running/stopped; restart() yields a fresh pid."""
    cmd = [sys.executable, "-c", "import time; time.sleep(30)"]
    manager = BlueSkyProcessManager(cmd=cmd)
    try:
        assert manager.status()["running"] is False

        manager.start()
        assert manager.status()["running"] is True
        pid1 = manager.status()["pid"]
        assert pid1

        manager.restart()
        pid2 = manager.status()["pid"]
        assert pid2 and pid2 != pid1
    finally:
        manager.kill()
    assert _wait_for(lambda: manager.status()["running"] is False)
