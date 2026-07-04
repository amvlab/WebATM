"""Provide centralized logging configuration for WebATM.

Provides standardized logging similar to TypeScript logging with:

- Different log levels (DEBUG, INFO, WARNING, ERROR, CRITICAL)
- Automatic filename prefixes: [FileName] log information
- Consistent formatting across all Python modules
"""

import logging
import sys
from pathlib import Path


class FileNameFormatter(logging.Formatter):
    """Custom formatter that adds a filename prefix to log messages."""

    def format(self, record):
        """Format a log record, prefixing the message with its source filename.

        Werkzeug (Flask's HTTP server) records are prefixed with ``[Werkzeug]``;
        all other records use the CamelCased stem of the source file name.

        Args:
            record (logging.LogRecord): The log record to format.

        Returns:
            str: The formatted log message.
        """
        # Special handling for werkzeug (Flask's HTTP server) logs
        if record.name == "werkzeug":
            filename = "Werkzeug"
        else:
            # Get the filename without extension
            filename = Path(record.pathname).stem
            # Capitalize first letter for consistency
            filename = filename.replace("_", " ").title().replace(" ", "")

        # Add filename prefix to message
        record.msg = f"[{filename}] {record.msg}"

        return super().format(record)


# Global logger configuration
_loggers = {}
_log_level = logging.INFO
_log_format = "%(asctime)s - %(levelname)s - %(message)s"
_date_format = "%Y-%m-%d %H:%M:%S"


def configure_logging(
    level: int = logging.INFO,
    log_file: str | None = None,
    include_console: bool = True,
):
    """Configure global logging settings for WebATM.

    Resets the ``WebATM`` root logger and any cached module loggers, then
    attaches console and/or file handlers using the shared
    :class:`FileNameFormatter`.

    Args:
        level (int): Logging level (DEBUG, INFO, WARNING, ERROR, CRITICAL).
        log_file (str | None): Optional file path to write logs to.
        include_console (bool): Whether to include console output.
    """
    global _log_level, _loggers

    _log_level = level

    # Clear existing loggers to reconfigure them
    _loggers.clear()

    # Configure root logger
    root_logger = logging.getLogger("WebATM")
    root_logger.setLevel(level)
    root_logger.handlers.clear()

    # Create formatter
    formatter = FileNameFormatter(_log_format, datefmt=_date_format)

    # Add console handler if requested
    if include_console:
        console_handler = logging.StreamHandler(sys.stdout)
        console_handler.setLevel(level)
        console_handler.setFormatter(formatter)
        root_logger.addHandler(console_handler)

    # Add file handler if requested
    if log_file:
        file_handler = logging.FileHandler(log_file)
        file_handler.setLevel(level)
        file_handler.setFormatter(formatter)
        root_logger.addHandler(file_handler)


def get_logger(name: str | None = None) -> logging.Logger:
    """Get or create a logger for a module.

    This function automatically determines the calling module's name and
    creates a logger with filename prefixes. Loggers are cached, so repeated
    calls with the same name return the same instance.

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
    global _loggers

    if name is None:
        # Get the caller's filename automatically
        import inspect

        frame = inspect.currentframe()
        if frame and frame.f_back:
            caller_filename = frame.f_back.f_globals.get("__file__", "Unknown")
            name = Path(caller_filename).stem

    # Return cached logger if exists
    if name in _loggers:
        return _loggers[name]

    # Create new logger
    logger = logging.getLogger(f"WebATM.{name}")
    logger.setLevel(_log_level)

    # If no handlers are configured yet, configure default
    if not logger.handlers and not logging.getLogger("WebATM").handlers:
        configure_logging()

    _loggers[name] = logger
    return logger


# Configure default logging on import
configure_logging()
