"""
Session management for WebATM.

This module handles session tracking, heartbeat monitoring,
and session cleanup.
"""

import os
import time
from typing import Any, Dict

from ..logger import get_logger

logger = get_logger()


class SessionManager:
    """Manages active sessions and session lifecycle."""

    def __init__(self):
        """Initialize session manager with configuration from environment."""
        self.heartbeat_interval = int(
            os.getenv("HEARTBEAT_INTERVAL", 30)
        )  # 30 seconds default

        # Active sessions tracking: session_id -> {'start_time': time, 'last_heartbeat': time}
        self.active_sessions: Dict[str, Dict[str, float]] = {}

    def add_session(self, session_id: str) -> bool:
        """
        Add a new session.

        Args:
            session_id: Unique session identifier

        Returns:
            bool: True if session was added, False if session already exists
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
        """
        Remove a session from tracking.

        Args:
            session_id: Session identifier to remove

        Returns:
            bool: True if session was removed, False if not found
        """
        if session_id in self.active_sessions:
            self.active_sessions.pop(session_id, None)
            return True
        return False

    def update_heartbeat(self, session_id: str) -> bool:
        """
        Update the last heartbeat time for a session.

        Args:
            session_id: Session identifier to update

        Returns:
            bool: True if updated, False if session not found
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

    def get_session_info(self) -> Dict[str, Any]:
        """
        Get session information for status reporting.

        Returns:
            dict: Session information including active sessions count
        """
        current_sessions = self.get_session_count()

        return {
            "active_sessions": current_sessions,
        }

    def get_config_info(self) -> Dict[str, int]:
        """
        Get session manager configuration.

        Returns:
            dict: Configuration values
        """
        return {
            "heartbeat_interval": self.heartbeat_interval,
        }
