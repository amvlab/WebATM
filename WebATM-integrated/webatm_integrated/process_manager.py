"""BlueSky headless server process manager.

Owns the lifecycle of the ``bluesky --headless`` process *tree*: the headless
server plus every node child process it spawns. On POSIX, BlueSky spawns node
children as ordinary subprocesses that inherit the parent's stdout/stderr and
live in the parent's process group, so:

* a single merged pipe on the parent captures the server *and* all node-child
  output, already interleaved in order; and
* launching the parent in its own session (``start_new_session=True``) lets us
  reap the entire tree with one ``os.killpg``.
"""

from __future__ import annotations

import logging
import os
import signal
import subprocess
import threading
from collections.abc import Callable

# Stdlib logger (not WebATM.logger) so this module stays importable without
# Flask; it still propagates into WebATM's root logger configuration.
logger = logging.getLogger(f"WebATM.{__name__}")


def _default_spawn(target: Callable, *args) -> threading.Thread:
    """Fallback spawn primitive (a daemon thread) if none is provided."""
    thread = threading.Thread(target=target, args=args, daemon=True)
    thread.start()
    return thread


class BlueSkyProcessManager:
    """Thread-safe lifecycle manager for the ``bluesky --headless`` process tree.

    Tracks only the parent process; signals (stop/kill) address the whole
    process group so node children are reaped together with the server.
    """

    def __init__(
        self,
        on_line: Callable[[str], None] | None = None,
        on_exit: Callable[[int], None] | None = None,
        spawn: Callable | None = None,
        cmd: list[str] | None = None,
    ):
        """Initialize the process manager.

        Args:
            on_line: Callback invoked with each output line of the process
                tree (newline stripped).
            on_exit: Callback invoked with the return code when the server
                process exits.
            spawn: Spawn primitive for the reader task (e.g.
                ``socketio.start_background_task``); defaults to a plain
                daemon thread.
            cmd (list[str] | None): Command to launch; defaults to
                ``["bluesky", "--headless"]``.
        """
        self._lock = threading.RLock()
        self._proc: subprocess.Popen | None = None
        self._on_line = on_line
        self._on_exit = on_exit
        self._spawn = spawn or _default_spawn
        self._cmd = cmd or ["bluesky", "--headless"]
        self._state = "stopped"  # stopped | starting | running | stopping

    # ---- lifecycle ------------------------------------------------------

    def start(self) -> dict:
        """Spawn the headless server (in its own process group) and a reader.

        The process is started in a new session with merged, line-buffered
        stdout/stderr so the reader receives one ordered stream for the
        server and all node children. A no-op if the server is already
        running.

        Returns:
            dict: Result with ``success``, ``status``, ``pid`` and
                ``message`` (plus ``error`` on failure).
        """
        with self._lock:
            if self._proc is not None and self._proc.poll() is None:
                return {
                    "success": True,
                    "status": "running",
                    "pid": self._proc.pid,
                    "message": "BlueSky server already running",
                }
            self._state = "starting"
            # PYTHONUNBUFFERED keeps the server's (and inherited children's)
            # stdout line-buffered so log lines arrive promptly and in order.
            env = dict(os.environ, PYTHONUNBUFFERED="1")
            try:
                self._proc = subprocess.Popen(
                    self._cmd,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,  # merge -> single ordered stream
                    stdin=subprocess.DEVNULL,
                    bufsize=1,
                    text=True,
                    env=env,
                    start_new_session=True,  # own process group / session
                    close_fds=True,
                )
            except Exception as e:
                self._state = "stopped"
                return {
                    "success": False,
                    "status": "error",
                    "message": f"Failed to start BlueSky: {e}",
                    "error": str(e),
                }
            self._state = "running"
            proc = self._proc

        # Launch the reader outside the lock.
        self._spawn(self._read_loop, proc)
        return {
            "success": True,
            "status": "running",
            "pid": proc.pid,
            "message": "BlueSky server started",
        }

    def _read_loop(self, proc: subprocess.Popen) -> None:
        """Stream merged stdout/stderr line by line until the process exits."""
        stream = proc.stdout
        try:
            if stream is not None:
                for line in iter(stream.readline, ""):
                    if self._on_line:
                        try:
                            self._on_line(line.rstrip("\n"))
                        except Exception:
                            # Keep draining: an abandoned pipe fills up and
                            # then blocks the whole BlueSky tree on its next
                            # write, freezing the simulation.
                            logger.exception("Log line callback failed")
        finally:
            return_code = proc.wait()
            with self._lock:
                # Only flip to stopped if this is still the current process
                # (a restart may have already replaced it).
                if self._proc is proc:
                    self._state = "stopped"
            if self._on_exit:
                self._on_exit(return_code)

    def stop(self, sig: int = signal.SIGTERM, escalate_after: float = 5.0) -> dict:
        """Signal the whole process group, escalating to SIGKILL if needed.

        Args:
            sig (int): Signal sent to the process group first.
            escalate_after (float): Seconds to wait for exit before
                force-killing the group with SIGKILL.

        Returns:
            dict: Result with ``success``, ``status`` and ``message``.
                ``success`` is False if the process survives even SIGKILL.
        """
        with self._lock:
            proc = self._proc
            if proc is None or proc.poll() is not None:
                self._state = "stopped"
                return {
                    "success": True,
                    "status": "stopped",
                    "message": "BlueSky server is not running",
                }
            self._state = "stopping"
            try:
                pgid = os.getpgid(proc.pid)
            except ProcessLookupError:
                self._state = "stopped"
                return {
                    "success": True,
                    "status": "stopped",
                    "message": "BlueSky server already exited",
                }

        # Signal the whole group (server + all node children) outside the lock.
        try:
            os.killpg(pgid, sig)
        except ProcessLookupError:
            pass

        try:
            proc.wait(timeout=escalate_after)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(pgid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                logger.error("BlueSky process group %s survived SIGKILL", pgid)
                with self._lock:
                    if self._proc is proc:
                        self._state = "running"
                return {
                    "success": False,
                    "status": "error",
                    "message": "BlueSky server did not exit after SIGKILL",
                }

        with self._lock:
            if self._proc is proc:
                self._state = "stopped"
        return {
            "success": True,
            "status": "stopped",
            "message": "BlueSky server stopped",
        }

    def kill(self) -> dict:
        """Force-kill the whole process group immediately (no graceful wait).

        Returns:
            dict: Result with ``success``, ``status`` and ``message``.
        """
        result = self.stop(sig=signal.SIGKILL, escalate_after=2.0)
        if result.get("success") and result.get("status") == "stopped":
            result["message"] = "BlueSky server killed"
        return result

    def restart(self) -> dict:
        """Stop the current tree (if any) and start a fresh one.

        Returns:
            dict: The ``start()`` result, with the message adjusted to
                "restarted" on success.
        """
        self.stop()
        result = self.start()
        if result.get("success"):
            result["message"] = "BlueSky server restarted"
        return result

    def status(self) -> dict:
        """Report whether the server is running, with its pid and state.

        Returns:
            dict: Result with ``success``, ``running``, ``status`` and
                ``pid`` (None when stopped).
        """
        with self._lock:
            proc = self._proc
            if proc is None or proc.poll() is not None:
                return {
                    "success": True,
                    "running": False,
                    "status": "stopped",
                    "pid": None,
                }
            return {
                "success": True,
                "running": True,
                "status": self._state,
                "pid": proc.pid,
            }
