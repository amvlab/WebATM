"""Subscriber registration for BlueSky network events.

Maps BlueSky data topics (SIMINFO, ACDATA, ECHO, ...) to the handler
functions in :mod:`WebATM.proxy.handlers` and registers them with the
active BlueSky network client.
"""

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
    on_statechange_received,
    on_trails_received,
)

logger = get_logger()

# (topic, callback, actonly). actonly topics only deliver data for the
# active node and are re-subscribed when the active node changes.
SUBSCRIPTIONS = [
    ("SIMINFO", on_siminfo_received, False),
    ("STATECHANGE", on_statechange_received, False),
    ("ACDATA", on_acdata_received, True),
    ("ROUTEDATA", on_routedata_received, True),
    ("ECHO", echo, False),
    ("STACKCMDS", on_stackcmds_received, False),
    ("STACK", on_stack_received, False),
    ("POLY", on_poly_received, False),  # handles both polygons and polylines
    ("RESET", on_reset_received, False),
    ("REQUEST", on_request_received, False),
    ("PLOT", on_plot_received, False),
    ("SHOWDIALOG", on_showdialog_received, False),
    ("SIMSETTINGS", on_simsettings_received, False),
    ("TRAILS", on_trails_received, False),
    ("DEFWPT", on_defwpt_received, False),
]


def register_subscribers():
    """Register all handler callbacks with the proxy's BlueSky client.

    Iterates over ``SUBSCRIPTIONS`` and subscribes each (topic, callback,
    actonly) triple on the global proxy's network client. Topics flagged
    ``actonly`` only deliver data for the active node and are re-subscribed
    when the active node changes.

    Logs an error and returns early if no global proxy is set, or a warning
    if the proxy has no connected BlueSky client yet.
    """
    # Imported lazily: WebATM.proxy imports this module while it is still being
    # initialised, so get_bluesky_proxy does not exist at module-load time yet.
    from . import get_bluesky_proxy

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
        for topic, callback, actonly in SUBSCRIPTIONS:
            proxy.bluesky_client.subscribe(topic, callback, actonly=actonly)
            logger.debug(f"Registered {topic} subscriber (actonly={actonly})")

        logger.info("All subscribers registered successfully with standalone client")
    except Exception as e:
        logger.error(f"Error registering subscribers: {e}")
        import traceback

        traceback.print_exc()
