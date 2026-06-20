#!/usr/bin/env python3
"""WebATM demo capacity controller (zero changes to the WebATM app).

This sidecar is the whole trick that lets the published `webatm-integrated`
image power a gated public demo without modifying a single line of the app.
It does two jobs, both driven off each replica's *existing* ``/status``
endpoint (which already reports ``session_info.active_sessions``):

1. Capacity-full page.  When every replica is occupied, it writes a Traefik
   file-provider router (``capacity.yml``) that routes **only brand-new
   visitors** -- requests that do *not* carry the ``webatm-session`` sticky
   cookie -- to the capacity-full page.  Visitors already in a session keep
   their sticky cookie, so they always match the lower-priority ``app`` router
   and are never bounced off their container.  When a slot frees up the file is
   removed and new visitors flow in again.

2. Disposable-per-visitor recycle.  A replica that has *served a session* and
   then gone idle for ``RECYCLE_IDLE_GRACE`` seconds is restarted (wiped), so the
   next visitor always lands on a pristine sandbox -- no leftover state, uploads,
   or running plugins from the previous user. A replica that has never been used
   is left ready (not churned). ``MAX_SESSION_TIME`` additionally caps a single
   continuous session (force-recycle a camper). Together these replace the old
   ``smart-restart.sh`` cron, and the optional CSV log replaces
   ``webatm-monitor.sh``.

It talks to the Docker Engine API over the bind-mounted ``/var/run/docker.sock``
using only the Python standard library, so it runs on a stock ``python:slim``
image with no pip installs and no custom build.

Caveats (by design, because the app is untouched):
  * Assignment is poll-based, so in the brief window between a new user landing
    on a free replica and the next poll, a second simultaneous new arrival can
    be load-balanced onto the same replica (they would share one BlueSky sim).
    Rare at demo traffic; eliminated by the optional future "tiny app shim".
  * "Idle" here means "no active socket session" (abandoned tabs drop within
    ~60s via Socket.IO). Kicking a *still-connected but inactive* user at
    exactly 5 minutes also needs the future app shim.
"""

from __future__ import annotations

import http.client
import json
import os
import socket
import time
import urllib.parse
import urllib.request

# --------------------------------------------------------------------------- #
# Configuration (all overridable via environment)
# --------------------------------------------------------------------------- #
POLL_INTERVAL = float(os.environ.get("POLL_INTERVAL", "5"))
COMPOSE_SERVICE = os.environ.get("WEBATM_SERVICE", "webatm")
PROXY_NETWORK = os.environ.get("PROXY_NETWORK", "internal")
WEB_PORT = int(os.environ.get("WEB_PORT", "8082"))
DOMAIN = os.environ.get("WEBATM_DOMAIN", "webatm.amvlab.eu")
COOKIE_NAME = os.environ.get("STICKY_COOKIE_NAME", "webatm-session")
CAPACITY_SERVICE = os.environ.get("CAPACITY_SERVICE", "capacity-full@file")
CERT_RESOLVER = os.environ.get("CERT_RESOLVER", "production")
ENTRYPOINT = os.environ.get("WEBSECURE_ENTRYPOINT", "websecure")
DYNAMIC_DIR = os.environ.get("DYNAMIC_DIR", "/dynamic")
CAPACITY_FILE = os.path.join(DYNAMIC_DIR, "capacity.yml")
# Require this many consecutive "all full" polls before showing the capacity
# page, so a momentary blip does not flap the router.
FULL_DEBOUNCE = int(os.environ.get("FULL_DEBOUNCE", "2"))
RECYCLE_ENABLED = os.environ.get("RECYCLE_ENABLED", "1") != "0"
# Disposable-per-visitor recycling: once a replica that *served a session* has
# been idle this many seconds, wipe it (restart) so the next visitor gets a
# pristine sandbox. A replica that has never been used is left ready, not churned.
RECYCLE_IDLE_GRACE = float(os.environ.get("RECYCLE_IDLE_GRACE", "120"))
# Hard cap on a single continuous session: force-recycle a replica busy this
# long (kicks a camper). 0 disables. Matches the "ends after 20 minutes" copy.
MAX_SESSION_TIME = float(os.environ.get("MAX_SESSION_TIME", "1200"))
DOCKER_SOCK = os.environ.get("DOCKER_SOCK", "/var/run/docker.sock")
STATUS_TIMEOUT = float(os.environ.get("STATUS_TIMEOUT", "3"))
CSV_FILE = os.environ.get("CSV_FILE")  # optional; e.g. /log/webatm-sessions.csv
# Append at most one CSV row per CSV_INTERVAL seconds (decoupled from the much
# faster poll cadence) so the history stays compact and covers a long window.
CSV_INTERVAL = float(os.environ.get("CSV_INTERVAL", "60"))
# Retention cap: keep at most this many data rows (oldest trimmed). 0 = no cap.
# At the 60s default cadence, 100k rows is ~70 days.
CSV_MAX_ROWS = int(os.environ.get("CSV_MAX_ROWS", "100000"))


def log(msg: str) -> None:
    print(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}", flush=True)


# --------------------------------------------------------------------------- #
# Minimal Docker Engine API client over the Unix socket (stdlib only)
# --------------------------------------------------------------------------- #
class _UDSConnection(http.client.HTTPConnection):
    """HTTPConnection that dials a Unix domain socket instead of TCP."""

    def __init__(self, sock_path: str):
        super().__init__("localhost", timeout=10)
        self._sock_path = sock_path

    def connect(self) -> None:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(self.timeout)
        s.connect(self._sock_path)
        self.sock = s


def docker_request(method: str, path: str):
    """Call the Docker Engine API; return parsed JSON (or None for empty bodies)."""
    conn = _UDSConnection(DOCKER_SOCK)
    try:
        conn.request(method, path)
        resp = conn.getresponse()
        body = resp.read()
        if resp.status >= 400:
            raise RuntimeError(f"docker {method} {path} -> {resp.status}: {body[:200]!r}")
        if body and resp.getheader("Content-Type", "").startswith("application/json"):
            return json.loads(body)
        return None
    finally:
        conn.close()


def list_replicas() -> list[dict]:
    """Return running webatm replicas as dicts: {id, name, ip}."""
    flt = json.dumps(
        {
            "label": [f"com.docker.compose.service={COMPOSE_SERVICE}"],
            "status": ["running"],
        }
    )
    containers = docker_request("GET", f"/containers/json?filters={urllib.parse.quote(flt)}")
    replicas = []
    for c in containers or []:
        networks = (c.get("NetworkSettings") or {}).get("Networks") or {}
        net = networks.get(PROXY_NETWORK) or next(iter(networks.values()), {})
        ip = net.get("IPAddress")
        if ip:
            name = (c.get("Names") or ["/?"])[0].lstrip("/")
            replicas.append({"id": c["Id"], "name": name, "ip": ip})
    return replicas


def get_active_sessions(ip: str) -> int:
    """Read active_sessions from a replica's /status endpoint."""
    url = f"http://{ip}:{WEB_PORT}/status"
    with urllib.request.urlopen(url, timeout=STATUS_TIMEOUT) as r:
        data = json.load(r)
    return int(((data.get("session_info") or {}).get("active_sessions")) or 0)


def restart_container(cid: str) -> None:
    docker_request("POST", f"/containers/{cid}/restart?t=10")


# --------------------------------------------------------------------------- #
# Traefik capacity router (file provider, hot-reloaded)
# --------------------------------------------------------------------------- #
def _capacity_yaml() -> str:
    # Higher priority than the `app` router, and matches only requests WITHOUT
    # the sticky session cookie -- so in-session users are never diverted here.
    return f"""# AUTO-GENERATED by the WebATM capacity controller -- do not edit.
# Present only while every replica is occupied; removed when a slot frees.
http:
  routers:
    capacity:
      rule: "Host(`{DOMAIN}`) && !HeaderRegexp(`Cookie`, `{COOKIE_NAME}=`)"
      priority: 100
      entryPoints:
        - {ENTRYPOINT}
      service: {CAPACITY_SERVICE}
      tls:
        certResolver: {CERT_RESOLVER}
"""


def set_capacity(full: bool) -> None:
    """Create or remove the capacity router file, only on state change."""
    exists = os.path.exists(CAPACITY_FILE)
    if full and not exists:
        tmp = CAPACITY_FILE + ".tmp"
        with open(tmp, "w") as f:
            f.write(_capacity_yaml())
        os.replace(tmp, CAPACITY_FILE)  # atomic: Traefik never sees a partial file
        log("ALL REPLICAS BUSY -> serving capacity-full page to new visitors")
    elif not full and exists:
        os.remove(CAPACITY_FILE)
        log("Slot available -> capacity-full page removed")


def append_csv(
    ts: float,
    active_sessions: int,
    total: int,
    reachable: int,
    busy: int,
    free: int,
    unreachable: int,
) -> None:
    # active_sessions = total people on the server right now (sum across
    # replicas); the rest are container-level counts. Mirrors the columns of
    # the old webatm-monitor.sh, plus the real headcount.
    new = not os.path.exists(CSV_FILE)
    with open(CSV_FILE, "a") as f:
        if new:
            f.write(
                "timestamp,active_sessions,total_replicas,reachable,busy,free,unreachable\n"
            )
        stamp = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(ts))
        f.write(
            f"{stamp},{active_sessions},{total},{reachable},{busy},{free},{unreachable}\n"
        )
    _trim_csv()


def _trim_csv() -> None:
    """Cap the CSV at CSV_MAX_ROWS data rows, trimming oldest. Hysteresis keeps
    the rewrite infrequent: we let it grow a little past the cap, then trim back."""
    if CSV_MAX_ROWS <= 0:
        return
    margin = max(64, CSV_MAX_ROWS // 50)
    with open(CSV_FILE) as f:
        lines = f.readlines()
    if len(lines) - 1 <= CSV_MAX_ROWS + margin:  # -1 for the header
        return
    header, data = lines[0], lines[1:]
    kept = data[-CSV_MAX_ROWS:]
    tmp = CSV_FILE + ".tmp"
    with open(tmp, "w") as f:
        f.write(header)
        f.writelines(kept)
    os.replace(tmp, CSV_FILE)  # atomic
    log(f"Trimmed {CSV_FILE} to last {CSV_MAX_ROWS} rows")


# --------------------------------------------------------------------------- #
# Main loop
# --------------------------------------------------------------------------- #
def main() -> None:
    os.makedirs(DYNAMIC_DIR, exist_ok=True)
    # Disposable-per-visitor state:
    #   dirty       - replica has served a session since its last (re)start
    #   idle_since  - when a *dirty* replica went idle (eligible to be wiped)
    #   busy_since  - when the current continuous session began (max-session cap)
    dirty: set[str] = set()
    idle_since: dict[str, float] = {}
    busy_since: dict[str, float] = {}
    full_streak = 0
    last_csv_write = 0.0

    def recycle(cid: str, name: str, reason: str) -> None:
        log(f"Recycling {name}: {reason}")
        try:
            restart_container(cid)
        except Exception as e:
            log(f"  restart of {name} failed: {e}")
        dirty.discard(cid)
        idle_since.pop(cid, None)
        busy_since.pop(cid, None)

    log(
        f"WebATM capacity controller started "
        f"(service={COMPOSE_SERVICE} network={PROXY_NETWORK} domain={DOMAIN} "
        f"poll={POLL_INTERVAL}s idle_grace={RECYCLE_IDLE_GRACE}s "
        f"max_session={MAX_SESSION_TIME}s recycle_enabled={RECYCLE_ENABLED})"
    )

    while True:
        try:
            now = time.time()
            replicas = list_replicas()
            total = len(replicas)
            busy = free = unreachable = 0
            active_sessions = 0  # total people on the server right now

            for r in replicas:
                cid, name = r["id"], r["name"]
                try:
                    active = get_active_sessions(r["ip"])
                except Exception:
                    # Starting up or wedged: treat as not-free so we never send
                    # a new visitor to it, and never recycle it blindly.
                    unreachable += 1
                    continue

                active_sessions += active
                if active > 0:
                    busy += 1
                    dirty.add(cid)            # it has now served a visitor
                    idle_since.pop(cid, None)
                    busy_since.setdefault(cid, now)
                    # Hard session cap: wipe a camper mid-session.
                    if (
                        RECYCLE_ENABLED
                        and MAX_SESSION_TIME > 0
                        and now - busy_since[cid] >= MAX_SESSION_TIME
                    ):
                        recycle(cid, name, f"session exceeded the {MAX_SESSION_TIME:.0f}s cap")
                else:
                    free += 1
                    busy_since.pop(cid, None)
                    if cid in dirty:
                        # Used and now idle: wipe it after the grace period so the
                        # next visitor lands on a pristine sandbox.
                        idle_since.setdefault(cid, now)
                        if RECYCLE_ENABLED and now - idle_since[cid] >= RECYCLE_IDLE_GRACE:
                            recycle(cid, name, "visitor left -> wiping for next user")
                    # A clean, never-used replica is left ready (not churned).

            # Forget replicas that no longer exist.
            live_ids = {r["id"] for r in replicas}
            for state in (dirty, idle_since, busy_since):
                for cid in [c for c in state if c not in live_ids]:
                    state.discard(cid) if isinstance(state, set) else state.pop(cid, None)

            # Capacity = no reachable, idle replica left (unreachable counts as
            # unavailable). Debounced so a transient blip does not flap.
            is_full = total > 0 and free == 0
            full_streak = full_streak + 1 if is_full else 0
            set_capacity(full_streak >= FULL_DEBOUNCE)

            reachable = total - unreachable
            if CSV_FILE and now - last_csv_write >= CSV_INTERVAL:
                append_csv(now, active_sessions, total, reachable, busy, free, unreachable)
                last_csv_write = now
            log(
                f"people={active_sessions} replicas={total} busy={busy} "
                f"free={free} unreachable={unreachable} full={is_full}"
            )

        except Exception as e:
            log(f"loop error: {e}")

        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    main()
