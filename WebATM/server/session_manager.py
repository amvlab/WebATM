"""Track active WebATM client sessions.

Connection liveness is handled by Socket.IO's built-in ping/pong (configured
in ``app.py``); this module only tracks which sessions are connected so the
``/status`` endpoint can report an accurate count.
"""


class SessionManager:
    """Track active client sessions by ID.

    Attributes:
        active_sessions (set[str]): IDs of the currently connected sessions.
    """

    def __init__(self):
        self.active_sessions: set[str] = set()

    def add_session(self, session_id: str) -> bool:
        """Start tracking a session.

        Args:
            session_id (str): Unique session identifier.

        Returns:
            bool: True if the session was added, False if it already exists.
        """
        if session_id in self.active_sessions:
            return False
        self.active_sessions.add(session_id)
        return True

    def remove_session(self, session_id: str) -> bool:
        """Stop tracking a session.

        Args:
            session_id (str): Session identifier to remove.

        Returns:
            bool: True if the session was removed, False if it was not found.
        """
        if session_id not in self.active_sessions:
            return False
        self.active_sessions.remove(session_id)
        return True

    def get_session_count(self) -> int:
        """Return the number of active sessions."""
        return len(self.active_sessions)

    def get_session_info(self) -> dict[str, int]:
        """Return session information for status reporting.

        Returns:
            dict: ``{"active_sessions": <count>}``, the shape read from
                ``/status`` by external capacity controllers (demo-deploy).
        """
        return {"active_sessions": self.get_session_count()}
