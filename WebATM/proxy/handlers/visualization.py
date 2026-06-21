"""Visualization handlers for PLOT, TRAILS, SHOWDIALOG, and SIMSETTINGS events."""

from ...logger import get_logger
from ._base import active_proxy

logger = get_logger()


def on_plot_received(data, *args, **kwargs):
    """Handle PLOT messages from BlueSky server."""
    if not active_proxy():
        return

    try:
        logger.debug(f"PLOT data received: {data}")
        # TODO: Implement plot data handling and visualization
    except Exception as e:
        logger.error(f"Error processing PLOT data: {e}")


def on_showdialog_received(data, *args, **kwargs):
    """Handle SHOWDIALOG messages from BlueSky server."""
    if not active_proxy():
        return

    try:
        logger.debug(f"SHOWDIALOG data received: {data}")
        # TODO: Implement dialog display logic for web interface
    except Exception as e:
        logger.error(f"Error processing SHOWDIALOG data: {e}")


def on_simsettings_received(data, *args, **kwargs):
    """Handle SIMSETTINGS messages from BlueSky server."""
    if not active_proxy():
        return

    try:
        logger.debug(f"SIMSETTINGS data received: {data}")
        # TODO: Implement simulation settings handling
    except Exception as e:
        logger.error(f"Error processing SIMSETTINGS data: {e}")


def on_trails_received(data, *args, **kwargs):
    """Handle TRAILS messages from BlueSky server."""
    if not active_proxy():
        return

    try:
        logger.debug(f"TRAILS data received: {data}")
        # TODO: Implement aircraft trail/track visualization
    except Exception as e:
        logger.error(f"Error processing TRAILS data: {e}")
