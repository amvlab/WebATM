"""Tests for WebATM.proxy.subscribers.register_subscribers.

A real (but unconnected) BlueSkyClient is used: its ``_subscribe`` short-circuits
when there is no receive socket, so registration just populates the in-process
subscriber table without any network I/O.
"""

from WebATM.bluesky_client import BlueSkyClient
from WebATM.proxy import BlueSkyProxy, set_bluesky_proxy
from WebATM.proxy.subscribers import SUBSCRIPTIONS, register_subscribers


class TestRegisterSubscribers:
    def test_registers_expected_topics(self):
        proxy = BlueSkyProxy()
        proxy.bluesky_client = BlueSkyClient()
        set_bluesky_proxy(proxy)
        try:
            register_subscribers()
            subs = proxy.bluesky_client.subscriber.subscribers
            for topic in (
                "SIMINFO",
                "ACDATA",
                "ECHO",
                "STACK",
                "STACKCMDS",
                "POLY",
                "ROUTEDATA",
                "STATECHANGE",
                "RESET",
                "REQUEST",
                "PLOT",
                "SHOWDIALOG",
                "SIMSETTINGS",
                "TRAILS",
                "DEFWPT",
            ):
                assert topic in subs
                assert len(subs[topic]) >= 1
        finally:
            set_bluesky_proxy(None)

    def test_double_registration_does_not_duplicate_callbacks(self):
        # A reconnect that re-runs register_subscribers on the same client must
        # not stack duplicate callbacks (which would process every message twice).
        proxy = BlueSkyProxy()
        proxy.bluesky_client = BlueSkyClient()
        set_bluesky_proxy(proxy)
        try:
            register_subscribers()
            register_subscribers()
            subs = proxy.bluesky_client.subscriber.subscribers
            for topic, _, _ in SUBSCRIPTIONS:
                assert len(subs[topic]) == 1
        finally:
            set_bluesky_proxy(None)

    def test_no_proxy_is_safe(self):
        set_bluesky_proxy(None)
        # Should log an error and return without raising.
        register_subscribers()

    def test_no_client_is_safe(self):
        proxy = BlueSkyProxy()
        proxy.bluesky_client = None
        set_bluesky_proxy(proxy)
        try:
            # Warns about missing client and returns without raising.
            register_subscribers()
        finally:
            set_bluesky_proxy(None)


class TestSubscriptionTable:
    """Guard the data-driven SUBSCRIPTIONS table that registration iterates."""

    EXPECTED_TOPICS = {
        "SIMINFO",
        "STATECHANGE",
        "ACDATA",
        "ROUTEDATA",
        "ECHO",
        "STACKCMDS",
        "STACK",
        "POLY",
        "RESET",
        "REQUEST",
        "PLOT",
        "SHOWDIALOG",
        "SIMSETTINGS",
        "TRAILS",
        "DEFWPT",
    }

    def test_table_covers_expected_topics_without_duplicates(self):
        topics = [topic for topic, _, _ in SUBSCRIPTIONS]
        assert set(topics) == self.EXPECTED_TOPICS
        assert len(topics) == len(set(topics))

    def test_actonly_is_limited_to_active_node_topics(self):
        actonly_topics = {topic for topic, _, actonly in SUBSCRIPTIONS if actonly}
        assert actonly_topics == {"ACDATA", "ROUTEDATA"}

    def test_callbacks_are_callable(self):
        assert all(callable(callback) for _, callback, _ in SUBSCRIPTIONS)
