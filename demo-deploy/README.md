# WebATM public demo stack

A gated, multi-slot public demo of the **integrated** WebATM image
(`ghcr.io/amvlab/webatm-integrated`) behind Traefik v3 — **with no changes to
the WebATM app itself**. Everything here is deployment glue: Traefik, a
capacity-full page, and a small controller sidecar.

```
                         ┌────────── Traefik v3.7 (TLS via Cloudflare DNS-01) ──────────┐
   webatm.amvlab.eu ───▶ │  router "app"  (priority 50, all traffic)                    │
                         │      └─ service "webatm"  ── sticky cookie ──▶ 10 replicas   │
                         │  router "capacity" (priority 100, ONLY no-cookie requests)   │
                         │      └─ service "capacity-full" ─▶ nginx (the busy page)     │
                         │           ▲ this router exists only while every replica busy │
                         └───────────┼──────────────────────────────────────────────────┘
                                     │ writes/removes capacity.yml
                              ┌──────┴───────┐   polls /status, restarts idle replicas
                              │  controller  │──▶ Docker socket + each replica's /status
                              └──────────────┘
```

## How each requirement is met

| You asked for | How it works here |
|---|---|
| **Latest Traefik** | `traefik:v3.7` (3.7.5 is current as of June 2026). |
| **Integrated image** | `ghcr.io/amvlab/webatm-integrated:latest`, BlueSky bundled per container. |
| **10 sessions at once** | `deploy.replicas: 10`; each replica is one isolated demo instance. |
| **One IP / one user per session** | Traefik **sticky cookie** (`webatm-session`) pins a browser to one replica; the controller only sends *new* visitors to *free* replicas (see caveats). |
| **Capacity-full page** | When every replica reports `active_sessions > 0`, the controller adds a higher-priority router that serves the nginx page **to new visitors only**. In-session users keep their cookie and are never diverted. |
| **Auto-reboot hourly unless in use** | The controller restarts any replica that has been up ≥ 1 h **and** has zero active sessions; busy replicas are skipped and retried next cycle. Replaces `smart-restart.sh`. |
| **Usage tracking** | Baked into the controller — no cron. It logs the live headcount every poll and appends a CSV history (see below). Replaces `webatm-monitor.sh`. |

## Tracking who's using the demo

The controller already polls every replica's `/status`, so usage tracking is
built in — there is **no cron job to run**:

- **Live**: `docker compose logs -f controller` shows a line each poll, e.g.
  `people=3 replicas=10 busy=3 free=7 unreachable=0 full=False`
  (`people` = total active sessions across all replicas).
- **History**: a CSV is written to `./controller/log/webatm-sessions.csv` (on by
  default via `CSV_FILE`), with columns
  `timestamp,active_sessions,total_replicas,reachable,busy,free,unreachable`.
  Graph it however you like; set `CSV_FILE=` empty to turn it off.

## Why a controller instead of pure Traefik

Traefik can’t see “this container is occupied”, and health-check-based capacity
gating is a trap: in Traefik v3 a sticky backend that goes unhealthy gets
**re-routed and its cookie rewritten**, which would bounce — or even kick — an
*active* user. So the only signal for “busy” is the app’s own `/status`
endpoint, and the only place to act on it without touching the app is a sidecar.
The controller reads `/status` and toggles one Traefik router. Returning users
are matched by their sticky cookie on the always-present `app` router, so they
are never affected by the capacity page.

## Quick start

```bash
cd demo-deploy
cp .env.example .env          # fill in CF_DNS_API_TOKEN, ACME_EMAIL, domain
docker compose up -d
docker compose logs -f controller   # watch busy/free + capacity decisions
```

DNS: point `WEBATM_DOMAIN` (and the wildcard, for the cert) at the host. TLS is
issued via the Cloudflare DNS-01 challenge, so the host does **not** need to be
publicly reachable for cert issuance — only your Cloudflare token matters.

To change the slot count: edit `deploy.replicas` and `docker compose up -d`.

## Caveats (consequences of not touching the app)

These are the gaps versus a fully app-aware version, and all of them close with
the optional **tiny app shim** described below:

1. **New-visitor assignment is poll-based.** Between a user landing on a free
   replica and the next poll (`POLL_INTERVAL`, default 5 s), a second
   simultaneous arrival can be load-balanced onto the same replica and share its
   BlueSky sim. Unlikely at demo traffic; lower `POLL_INTERVAL` to shrink the
   window.
2. **“Idle” means “no socket session”.** Abandoned tabs free their slot within
   ~60 s on their own (Socket.IO ping timeout). Kicking a user who is *still
   connected but inactive* at exactly 5 minutes is **not** done here — the app
   never disconnects them and Traefik can’t kill an active WebSocket on a timer.
3. **“One IP” is really “one browser”.** Sticky cookies pin per browser, not per
   IP. A determined user with multiple browsers could hold more than one slot.

### Optional upgrade: the tiny app shim (future)

When you’re ready, an off-by-default, env-gated shim in the app makes all three
exact:
- returns **HTTP 503 when a replica is already occupied** (strict one-user-per-
  container + instant, race-free capacity signal — the controller’s job shrinks
  to just recycling);
- a background **reaper** disconnects sessions idle past `SESSION_TIMEOUT`
  (true 5-minute kick) and past `MAX_SESSION_TIME` (1-hour cap);
- adds `available_slots` to `/status`.

It stays disabled unless those env vars are set, so the standalone image is
unaffected, and it ships in the published integrated image on the next version
tag. This stack is forward-compatible: turn the shim on and the controller keeps
working (it just never needs to show the page on a shared replica).

## Files

| Path | Purpose |
|---|---|
| `docker-compose.yml` | The whole stack. |
| `traefik/traefik.yml` | Traefik static config (entrypoints, providers, ACME). |
| `traefik/dynamic/base.yml` | Capacity-full service + rate-limit middleware. |
| `traefik/dynamic/capacity.yml` | **Generated** by the controller; present only when full. |
| `capacity_full/capacity-full.html` | The “all slots busy” page. |
| `controller/controller.py` | Capacity toggling + hourly idle recycle (stdlib only). |
| `.env.example` | Copy to `.env` and fill in. |

## Hardening notes

- **Cloudflare client IPs**: the rate-limit middleware uses `ipStrategy.depth: 1`.
  If you proxy through Cloudflare, consider restricting ingress to Cloudflare IP
  ranges and/or trusting `CF-Connecting-IP` so rate limits key off the real
  client.
- **Docker socket**: the controller mounts `/var/run/docker.sock` read-write
  (it must restart replicas). Traefik mounts it read-only. Treat the controller
  as privileged.
- **Dashboard**: Traefik’s dashboard is disabled; enable it deliberately if
  needed and keep `:8080` closed to the internet.
