"""Provide centralized logging configuration for WebATM.

Provides standardized logging similar to TypeScript logging with:

- Different log levels (DEBUG, INFO, WARNING, ERROR, CRITICAL)
- Automatic filename prefixes: [FileName] log information
- Consistent formatting across all Python modules
"""

import inspect
import logging
import sys
from pathlib import Path


class FileNameFormatter(logging.Formatter):
    """Custom formatter that adds a filename prefix to log messages."""

    def format(self, record):
        """Format a log record, prefixing the message with its source filename.

        Werkzeug (Flask's HTTP server) records are prefixed with ``[Werkzeug]``;
        all other records use the CamelCased stem of the source file name. The
        record is restored afterwards, so a record that passes through several
        handlers (e.g. console and file) is prefixed exactly once per output.

        Args:
            record (logging.LogRecord): The log record to format.

        Returns:
            str: The formatted log message.
        """
        if record.name == "werkzeug":
            filename = "Werkzeug"
        else:
            stem = Path(record.pathname).stem
            filename = stem.replace("_", " ").title().replace(" ", "")

        original_msg = record.msg
        record.msg = f"[{filename}] {record.msg}"
        try:
            return super().format(record)
        finally:
            record.msg = original_msg


_log_format = "%(asctime)s - %(levelname)s - %(message)s"
_date_format = "%Y-%m-%d %H:%M:%S"


def configure_logging(
    level: int = logging.INFO,
    log_file: str | None = None,
    include_console: bool = True,
):
    """Configure global logging settings for WebATM.

    Resets the ``WebATM`` root logger and attaches console and/or file
    handlers using the shared :class:`FileNameFormatter`. Module loggers from
    :func:`get_logger` delegate their level to this root logger, so calling
    this again (e.g. to switch to DEBUG at runtime) takes effect everywhere,
    including loggers created before the call.

    Args:
        level (int): Logging level (DEBUG, INFO, WARNING, ERROR, CRITICAL).
        log_file (str | None): Optional file path to write logs to.
        include_console (bool): Whether to include console output.
    """
    root_logger = logging.getLogger("WebATM")
    root_logger.setLevel(level)
    root_logger.handlers.clear()

    formatter = FileNameFormatter(_log_format, datefmt=_date_format)

    if include_console:
        console_handler = logging.StreamHandler(sys.stdout)
        console_handler.setFormatter(formatter)
        root_logger.addHandler(console_handler)

    if log_file:
        file_handler = logging.FileHandler(log_file)
        file_handler.setFormatter(formatter)
        root_logger.addHandler(file_handler)


def get_logger(name: str | None = None) -> logging.Logger:
    """Get or create a logger for a module.

    The returned logger is a child of the ``WebATM`` root logger and carries
    no level of its own, so it always follows the level set by
    :func:`configure_logging` — including changes made after it was created.
    ``logging.getLogger`` caches by name, so repeated calls with the same name
    return the same instance.

    Args:
        name (str | None): Optional custom name for the logger. If not
            provided, uses the calling module's filename.

    Returns:
        logging.Logger: A configured logger instance.

    Example:
        >>> logger = get_logger()
        >>> logger.info("Starting process")
        2025-11-06 10:30:45 - INFO - [Main] Starting process
    """
    if name is None:
        frame = inspect.currentframe()
        if frame and frame.f_back:
            caller_filename = frame.f_back.f_globals.get("__file__", "Unknown")
            name = Path(caller_filename).stem

    return logging.getLogger(f"WebATM.{name}")


# Configure default logging on import
configure_logging()
