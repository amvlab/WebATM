"""Manage WebATM client sessions.

This module handles session tracking, heartbeat monitoring, and session
cleanup for connected web clients.
"""

import os
import time
from typing import Any

from ..logger import get_logger

logger = get_logger()


class SessionManager:
    """Manage active client sessions and their lifecycle.

    Attributes:
        heartbeat_interval (int): Expected client heartbeat interval in
            seconds, read from the ``HEARTBEAT_INTERVAL`` environment variable
            (default 30).
        active_sessions (dict[str, dict[str, float]]): Mapping of session ID to
            a dict with ``start_time`` and ``last_heartbeat`` timestamps.
    """

    def __init__(self):
        """Initialize the session manager with configuration from the environment."""
        self.heartbeat_interval = int(os.getenv("HEARTBEAT_INTERVAL", 30))
        self.active_sessions: dict[str, dict[str, float]] = {}

    def add_session(self, session_id: str) -> bool:
        """Add a new session to tracking.

        Args:
            session_id (str): Unique session identifier.

        Returns:
            bool: True if the session was added, False if it already exists.
        """
        if session_id in self.active_sessions:
            return False

        current_time = time.time()
        self.active_sessions[session_id] = {
            "start_time": current_time,
            "last_heartbeat": current_time,
        }
        return True

    def remove_session(self, session_id: str) -> bool:
        """Remove a session from tracking.

        Args:
            session_id (str): Session identifier to remove.

        Returns:
            bool: True if the session was removed, False if it was not found.
        """
        return self.active_sessions.pop(session_id, None) is not None

    def update_heartbeat(self, session_id: str) -> bool:
        """Update the last heartbeat time for a session.

        Args:
            session_id (str): Session identifier to update.

        Returns:
            bool: True if updated, False if the session was not found.
        """
        if session_id in self.active_sessions:
            self.active_sessions[session_id]["last_heartbeat"] = time.time()
            return True
        return False

    def get_session_count(self) -> int:
        """
        Get the current number of active sessions.

        Returns:
            int: Number of active sessions
        """
        return len(self.active_sessions)

    def get_session_info(self) -> dict[str, Any]:
        """
        Get session information for status reporting.

        Returns:
            dict: Session information including active sessions count
        """
        current_sessions = self.get_session_count()

        return {
            "active_sessions": current_sessions,
        }

    def get_config_info(self) -> dict[str, int]:
        """
        Get session manager configuration.

        Returns:
            dict: Configuration values
        """
        return {
            "heartbeat_interval": self.heartbeat_interval,
        }
