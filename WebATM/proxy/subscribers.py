"""Subscriber registration for BlueSky network events."""

from ..logger import get_logger
from .handlers import (
    echo,
    on_acdata_received,
    on_defwpt_received,
    on_plot_received,
    on_poly_received,
    on_request_received,
    on_reset_received,
    on_routedata_received,
    on_showdialog_received,
    on_siminfo_received,
    on_simsettings_received,
    on_stack_received,
    on_stackcmds_received,
    on_trails_received,
)

logger = get_logger()


def get_bluesky_proxy():
    """Get the current BlueSky proxy instance."""
    from . import get_bluesky_proxy as _get_proxy

    return _get_proxy()


def register_subscribers():
    """Register subscriber callbacks using standalone proxy."""
    proxy = get_bluesky_proxy()
    if not proxy:
        logger.error("No proxy available for subscriber registration")
        return

    if not proxy.bluesky_client:
        logger.warning(
            "No BlueSky client available in BlueSky Proxy - Connect to BlueSky server via WebATM"
        )
        return

    logger.debug("Registering subscriber callbacks with standalone client...")
    try:
        # Register callbacks directly with standalone proxy
        logger.debug("Registering SIMINFO subscriber...")
        proxy.bluesky_client.subscribe("SIMINFO", on_siminfo_received)
        logger.debug(
            f"SIMINFO subscribers: {len(proxy.bluesky_client.subscriber.subscribers['SIMINFO'])}"
        )

        logger.debug("Registering ACDATA subscriber with actonly=True...")
        proxy.bluesky_client.subscribe("ACDATA", on_acdata_received, actonly=True)
        logger.debug(
            f"ACDATA subscribers: {len(proxy.bluesky_client.subscriber.subscribers['ACDATA'])}"
        )

        logger.debug("Registering ROUTEDATA subscriber...")
        proxy.bluesky_client.subscribe("ROUTEDATA", on_routedata_received, actonly=True)
        logger.debug(
            f"ROUTEDATA subscribers: {len(proxy.bluesky_client.subscriber.subscribers['ROUTEDATA'])}"
        )

        logger.debug("Registering echo subscriber...")
        proxy.bluesky_client.subscribe("ECHO", echo)
        logger.debug(
            f"ECHO subscribers: {len(proxy.bluesky_client.subscriber.subscribers['ECHO'])}"
        )

        logger.debug("Registering STACKCMDS subscriber...")
        proxy.bluesky_client.subscribe("STACKCMDS", on_stackcmds_received)
        logger.debug(
            f"STACKCMDS subscribers: {len(proxy.bluesky_client.subscriber.subscribers['STACKCMDS'])}"
        )

        logger.debug(
            "Registering STACK subscriber (to detect incoming stack commands)..."
        )
        proxy.bluesky_client.subscribe("STACK", on_stack_received)
        logger.debug(
            f"STACK subscribers: {len(proxy.bluesky_client.subscriber.subscribers['STACK'])}"
        )

        logger.debug(
            "Registering POLY subscriber (handles both polygons and polylines)..."
        )
        proxy.bluesky_client.subscribe("POLY", on_poly_received)
        logger.debug(
            f"POLY subscribers: {len(proxy.bluesky_client.subscriber.subscribers['POLY'])}"
        )

        # Register new topic subscribers
        logger.debug("Registering RESET subscriber...")
        proxy.bluesky_client.subscribe("RESET", on_reset_received)

        logger.debug("Registering REQUEST subscriber...")
        proxy.bluesky_client.subscribe("REQUEST", on_request_received)

        logger.debug("Registering PLOT subscriber...")
        proxy.bluesky_client.subscribe("PLOT", on_plot_received)

        logger.debug("Registering SHOWDIALOG subscriber...")
        proxy.bluesky_client.subscribe("SHOWDIALOG", on_showdialog_received)

        logger.debug("Registering SIMSETTINGS subscriber...")
        proxy.bluesky_client.subscribe("SIMSETTINGS", on_simsettings_received)

        logger.debug("Registering TRAILS subscriber...")
        proxy.bluesky_client.subscribe("TRAILS", on_trails_received)

        logger.debug("Registering DEFWPT subscriber...")
        proxy.bluesky_client.subscribe("DEFWPT", on_defwpt_received)

        logger.info("All subscribers registered successfully with standalone client")
    except Exception as e:
        logger.error(f"Error registering subscribers: {e}")
        import traceback

        traceback.print_exc()
