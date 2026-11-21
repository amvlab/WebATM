"""Server-side aircraft trail history for the BlueSky proxy."""

import math
import threading
from typing import Any

from ...logger import get_logger
from ...utils import make_json_serializable

logger = get_logger()


class TrailManager:
    """Record the flown track of every aircraft of the active node.

    Trails used to live only in the browser, so a page opened (or reloaded)
    mid-simulation had no history for the aircraft already flying. The proxy
    sees every ACDATA frame from the moment it connects, so it keeps the
    history instead: a trail starts when an aircraft first appears in the
    traffic feed and is dropped when the aircraft leaves it. Browsers receive
    the stored history on connect (the ``trails`` Socket.IO event) and keep
    extending it locally from the live ``acdata`` stream.

    Memory is bounded two ways so large scenarios stay cheap:

    * positions are sampled on simulation time, every ``BASE_INTERVAL``
      seconds, stretched proportionally once traffic exceeds
      ``AIRCRAFT_PER_INTERVAL_STEP`` aircraft;
    * a trail that grows past ``MAX_POINTS`` drops every other point, so the
      whole flight from the spawn point is kept at half the resolution rather
      than losing its oldest part.

    Attributes:
        BASE_INTERVAL (float): Sampling period in simulation seconds.
        AIRCRAFT_PER_INTERVAL_STEP (int): Aircraft count per extra multiple
            of ``BASE_INTERVAL`` in the sampling period.
        MAX_POINTS (int): Per-aircraft point cap that triggers thinning.
    """

    BASE_INTERVAL = 5.0
    AIRCRAFT_PER_INTERVAL_STEP = 1000
    MAX_POINTS = 500

    def __init__(self, proxy):
        """Initialize an empty trail store.

        Args:
            proxy (BlueSkyProxy): Parent proxy instance.
        """
        self.proxy = proxy
        # record() runs on the network thread, snapshot() on Socket.IO threads.
        self._lock = threading.Lock()
        self._trails: dict[str, list[list[float]]] = {}
        self._last_sample_simt: float | None = None
        self._last_count = 0

    def sample_interval(self, aircraft_count: int) -> float:
        """Return the sampling period for the given traffic size.

        Args:
            aircraft_count (int): Number of aircraft in the current frame.

        Returns:
            float: Simulation seconds between stored trail points.
        """
        steps = max(1, math.ceil(aircraft_count / self.AIRCRAFT_PER_INTERVAL_STEP))
        return self.BASE_INTERVAL * steps

    def record(self, data: dict[str, Any]) -> None:
        """Update the trail store from one ACDATA frame.

        Cheap for the common frame: unless a sampling period has elapsed or
        the aircraft count changed (a spawn or deletion), it returns after a
        couple of comparisons. A count change triggers a membership-only pass
        that seeds trails for new aircraft at their current position and
        drops the trails of aircraft that left.

        Args:
            data (dict): Raw ACDATA payload (``id``, ``lat``, ``lon`` and
                optionally ``simt``); array fields may be numpy arrays or
                BlueSky's msgpack-encoded numpy dictionaries.
        """
        try:
            ids = data.get("id")
            count = len(ids) if ids is not None else 0
            if count == 0:
                self.clear()
                return

            simt = data.get("simt")
            if simt is None:
                simt = self.proxy.sim_data.get("simt")
            if simt is None:
                return
            simt = float(simt)

            last = self._last_sample_simt
            if last is not None and simt < last:
                # The clock ran backwards: a reset or a different simulation.
                self.clear()
                last = None

            due = last is None or (simt - last) >= self.sample_interval(count)
            if not due and count == self._last_count:
                return

            self._sample(ids, data.get("lat"), data.get("lon"), simt, due)
        except Exception:
            logger.exception("Error recording aircraft trails")

    def _sample(self, ids, lats, lons, simt: float, extend: bool) -> None:
        """Seed new trails, drop departed ones and optionally extend the rest.

        Args:
            ids (Sequence[str]): Aircraft ids of the frame.
            lats (Sequence[float]): Latitudes, parallel to ``ids``.
            lons (Sequence[float]): Longitudes, parallel to ``ids``.
            simt (float): Simulation time of the frame.
            extend (bool): Append the current position to existing trails
                (False for a membership-only pass).
        """
        # Raw frames carry numpy arrays or BlueSky's msgpack-encoded form of
        # them; decode only the two fields needed, and only on sampled frames.
        lats = make_json_serializable(lats)
        lons = make_json_serializable(lons)
        if not isinstance(lats, list) or not isinstance(lons, list):
            return
        count = min(len(ids), len(lats), len(lons))

        with self._lock:
            seen = set()
            for i in range(count):
                acid = str(ids[i])
                seen.add(acid)
                point = self._point(lats[i], lons[i])
                if point is None:
                    continue

                trail = self._trails.get(acid)
                if trail is None:
                    self._trails[acid] = [point]
                elif extend and trail[-1] != point:
                    trail.append(point)
                    if len(trail) > self.MAX_POINTS:
                        self._thin(trail)

            for acid in [acid for acid in self._trails if acid not in seen]:
                del self._trails[acid]

            self._last_count = len(ids)
            if extend:
                self._last_sample_simt = simt

    @staticmethod
    def _point(lat, lon) -> list[float] | None:
        """Build a rounded ``[lon, lat]`` point, or None for invalid input.

        Args:
            lat (float): Latitude in degrees.
            lon (float): Longitude in degrees; values beyond ±180 are wrapped
                (BlueSky stops wrapping longitude after creation).

        Returns:
            list[float] | None: ``[lon, lat]`` rounded to ~1 m, or None.
        """
        try:
            lat = float(lat)
            lon = float(lon)
        except (TypeError, ValueError):
            return None
        if not (math.isfinite(lat) and math.isfinite(lon)) or abs(lat) > 90:
            return None
        if lon > 180 or lon < -180:
            lon = (lon + 180) % 360 - 180
        return [round(lon, 5), round(lat, 5)]

    @staticmethod
    def _thin(trail: list[list[float]]) -> None:
        """Halve a trail's resolution in place, keeping both end points.

        Args:
            trail (list): Trail points; every other one is removed.
        """
        last = trail[-1]
        del trail[1::2]
        if trail[-1] is not last:
            trail.append(last)

    def clear(self) -> None:
        """Forget every stored trail (reset, node switch, disconnect)."""
        with self._lock:
            self._trails.clear()
            self._last_sample_simt = None
            self._last_count = 0

    def snapshot(self) -> dict[str, Any]:
        """Return the stored trail history for a connecting browser.

        Returns:
            dict[str, Any]: ``simt`` (simulation time of the newest sample,
                or None when empty) and ``trails`` mapping each aircraft id
                to its ``[lon, lat]`` points, oldest first.
        """
        with self._lock:
            return {
                "simt": self._last_sample_simt,
                "trails": {acid: list(trail) for acid, trail in self._trails.items()},
            }
