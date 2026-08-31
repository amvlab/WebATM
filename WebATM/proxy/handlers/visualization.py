"""Visualization handlers for PLOT, TRAILS, SHOWDIALOG, and SIMSETTINGS events.

All four are placeholders that only log their payload until visualization
support is implemented in the web client. Their signatures accept any payload
shape the client dispatches: shared-state topics (TRAILS, SIMSETTINGS) arrive
as one positional dict, while event topics with dict payloads (PLOT,
SHOWDIALOG) arrive as keyword arguments.
"""

from ...logger import get_logger
from ._base import active_proxy

logger = get_logger()


def on_plot_received(*args, **kwargs):
    """Log PLOT events; plot display is not yet implemented."""
    if not active_proxy():
        return

    logger.debug(f"PLOT data received: args={args} kwargs={kwargs}")


def on_showdialog_received(*args, **kwargs):
    """Log SHOWDIALOG events; web dialog display is not yet implemented."""
    if not active_proxy():
        return

    logger.debug(f"SHOWDIALOG data received: args={args} kwargs={kwargs}")


def on_simsettings_received(*args, **kwargs):
    """Log SIMSETTINGS events; settings handling is not yet implemented."""
    if not active_proxy():
        return

    logger.debug(f"SIMSETTINGS data received: args={args} kwargs={kwargs}")


def on_trails_received(*args, **kwargs):
    """Log TRAILS events; trail visualization is not yet implemented."""
    if not active_proxy():
        return

    logger.debug(f"TRAILS data received: args={args} kwargs={kwargs}")
