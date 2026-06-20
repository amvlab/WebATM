# WebATM public demo stack

A **disposable-sandbox-per-visitor** public demo of the **integrated** WebATM
image behind Traefik v3 — **with no changes to the WebATM app itself**.
Everything here is deployment glue: Traefik, a capacity-full page, and a small
controller sidecar.

The full app is intentionally exposed — console, scenario *and* plugin uploads,
server controls. That's only safe because each visitor runs in a throwaway,
**gVisor-sandboxed, no-egress container that is wiped the moment they leave**.
In-container code execution is expected and contained; the container is the
blast radius. (See **Security** — this is the whole point of the design.)

```
                         ┌────────── Traefik v3.7 (TLS via Cloudflare DNS-01) ──────────┐
   webatm.amvlab.eu ───▶ │  router "app"  (priority 50, all traffic)                    │
                         │      └─ service "webatm" ─ sticky ─▶ 10 gVisor sandboxes     │
                         │  router "capacity" (priority 100, ONLY no-cookie requests)   │
                         │      └─ service "capacity-full" ─▶ nginx (the busy page)     │
                         │           ▲ this router exists only while every replica busy │
                         └───────────┼──────────────────────────────────────────────────┘
                                     │ writes/removes capacity.yml
                              ┌──────┴───────┐   polls /status; wipes a replica
                              │  controller  │──▶ once its visitor leaves (+ Docker socket)
                              └──────────────┘
```

## How each requirement is met

| You asked for | How it works here |
|---|---|
| **Latest Traefik** | `traefik:v3.7` (3.7.5 is current as of June 2026). |
| **Integrated image** | `ghcr.io/amvlab/webatm-integrated` (or your local build via `WEBATM_IMAGE`), BlueSky bundled per container. |
| **10 sessions at once** | `deploy.replicas: 10`; each replica is one isolated, sandboxed instance. |
| **One IP / one user per session** | Traefik **sticky cookie** (`webatm-session`) pins a browser to one replica; the controller only sends *new* visitors to *free* replicas (see caveats). |
| **Capacity-full page** | When every replica reports `active_sessions > 0`, the controller adds a higher-priority router that serves the nginx page **to new visitors only**. In-session users keep their cookie and are never diverted. |
| **Disposable per visitor** | The controller **wipes (restarts) a replica ~`RECYCLE_IDLE_GRACE`s after its visitor leaves**, so the next person gets a pristine sandbox. A `MAX_SESSION_TIME` cap also force-recycles a camper. Replaces `smart-restart.sh`. |
| **Safe to expose the full app** | Each replica runs under **gVisor**, has **no internet egress** and **no host mounts**, drops all caps, and is ephemeral. See Security. |
| **Usage tracking** | Baked into the controller — no cron. Live headcount every poll + a CSV history. Replaces `webatm-monitor.sh`. |

## Tracking who's using the demo

The controller already polls every replica's `/status`, so usage tracking is
built in — there is **no cron job to run**:

- **Live**: `docker compose logs -f controller` shows a line each poll, e.g.
  `people=3 replicas=10 busy=3 free=7 unreachable=0 full=False`
  (`people` = total active sessions across all replicas).
- **History**: a CSV with columns
  `timestamp,active_sessions,total_replicas,reachable,busy,free,unreachable`,
  on by default. It's written to the named **`webatm-logs`** Docker volume so it
  **persists across `docker compose down`** (a `down -v` or explicit
  `docker volume rm webatm-logs` wipes it). A new row is appended every
  `CSV_INTERVAL` seconds (default 60) and the file is capped at `CSV_MAX_ROWS`
  rows (default 100 000 ≈ 70 days; oldest trimmed). Set `CSV_FILE=` empty to
  disable.

  Read or export it any time:
  ```bash
  docker compose exec controller tail -n 20 /log/webatm-sessions.csv
  docker cp webatm-controller:/log/webatm-sessions.csv ./webatm-sessions.csv
  ```

## Why a controller instead of pure Traefik

Traefik can't see "this container is occupied", and health-check-based capacity
gating is a trap: in Traefik v3 a sticky backend that goes unhealthy gets
**re-routed and its cookie rewritten**, which would bounce — or even kick — an
*active* user. So the only signal for "busy" is the app's own `/status`
endpoint, and the only place to act on it without touching the app is a sidecar.
The controller reads `/status`, toggles one Traefik router, and recycles
replicas. Returning users are matched by their sticky cookie on the
always-present `app` router, so they are never affected by the capacity page.

## Quick start

**Prerequisite: install gVisor on the host** (the sandbox runtime). See
<https://gvisor.dev/docs/user_guide/install/>, then register it with Docker
(`/etc/docker/daemon.json` gets a `runtimes.runsc` entry, `systemctl restart
docker`). Verify with `docker info | grep -i runtimes` → should list `runsc`.

```bash
cd demo-deploy
cp .env.example .env          # CF_DNS_API_TOKEN, ACME_EMAIL, domain
docker compose pull           # pulls the pinned public image (WEBATM_IMAGE)
docker compose up -d
docker compose logs -f controller   # watch busy/free + capacity + recycles
```

`.env` defaults `WEBATM_IMAGE` to the **published** image
(`ghcr.io/amvlab/webatm-integrated:0.4.2`), which is the recommended path: CI
bakes the offline tiles/glyphs/navdata into it. The package must be public to
pull anonymously — otherwise `docker login ghcr.io` first.

Building the image yourself is possible but **not** the easy path: a plain
`docker build -f Dockerfile.integrated` does **not** hydrate those static assets
(they're gitignored and pulled from a separate assets release by CI), so the
navdata search and offline tiles would be missing. Prefer the published image.

No gVisor yet? Set `WEBATM_RUNTIME=runc` in `.env` to boot **un-sandboxed for
local testing only** — do **not** expose that to the internet.

DNS: point `WEBATM_DOMAIN` (and the wildcard, for the cert) at the host. TLS is
issued via the Cloudflare DNS-01 challenge, so the host does **not** need to be
publicly reachable for cert issuance — only your Cloudflare token matters.

To change the slot count: edit `deploy.replicas` and `docker compose up -d`.

## Security

This is the crux of the design, so read it. WebATM's value *is* the dangerous
surface: the console forwards arbitrary commands to BlueSky, and scenarios are
stack programs that can `PLUGIN LOAD`/`CALL`. You cannot feature-gate your way to
safety for anonymous users without deleting the app. So instead of locking
features, this stack **assumes in-container code execution will happen and makes
it boring** — every visitor gets a disposable, contained sandbox.

| Layer | What it does |
|---|---|
| **gVisor (`runsc`) runtime** | Each `webatm` replica runs on gVisor's user-space kernel, so container syscalls never hit the host kernel directly — a real isolation boundary for untrusted code (not just namespaces). |
| **No internet egress** | Replicas sit on an `internal: true` network (`webatm-internal`) with no gateway. Even with full RCE there is no path to exfiltrate, reach a C2, join a botnet, or attack third parties. Map tiles load in the *browser*; BlueSky is on localhost; nothing here needs outbound. |
| **No host mounts** | The `webatm` service bind-mounts nothing from the host. Uploads land in the container's own `~/bluesky` and vanish on recycle. |
| **Bounded storage** | `~/bluesky` (uploads + sim output) is a **size-limited tmpfs** (`BLUESKY_TMPFS_SIZE`, default 256 MB). Uploading can't exhaust host disk — it's RAM-backed and capped, writes fail past the cap, and it's wiped per visitor. The app also rejects any single upload over 10 MB (plugins/settings) / 50 MB (scenarios). |
| **Wiped per visitor** | The controller restarts a replica shortly after its session ends, so no state, uploaded plugin, or running process survives into the next visitor's session. |
| **Least privilege** | Non-root user, `no-new-privileges`, `cap_drop: ALL`, `pids: 512`, `cpus: 0.75`, `memory: 1280 MB` (≈1 GB app + the upload tmpfs) per replica. |
| **Protected control plane** | The Docker socket is only in Traefik (read-only) and the controller; replicas can't reach it (local socket, not networked). Traefik's dashboard is off. Rate limiting on the edge. |

### Residual risks — know these

- **gVisor isn't perfect.** It's a very strong boundary but not a VM; treat it as
  such. For hardware-virtualized isolation use **Kata Containers / Firecracker
  microVMs** (heavier). Also test the app under `runsc` (below) — gVisor
  implements most syscalls, but if BlueSky hits an unimplemented one you'll see
  it in `runsc` logs.
- **Sibling reachability.** All replicas share the `internal` network, so a
  compromised container can reach *other* visitors' replicas (annoyance / info
  disclosure between anonymous strangers) — but **not** the host or the internet.
  Eliminating this needs a per-replica network (drop `deploy.replicas` for N
  explicit one-network-each services), which is verbose; left as an option since
  the impact is low given no egress + gVisor.
- **DoS within limits.** Resource caps bound abuse but a visitor can still peg
  their own replica; the per-visitor wipe recovers it.

### Verify before going live

1. **Run under gVisor.** Bring the stack up with `WEBATM_RUNTIME=runsc` and click
   around — load a scenario, open the console, watch traffic. If something
   misbehaves, check `runsc` logs for an unsupported syscall and report it.
2. **BlueSky nav data.** The no-egress network assumes the bundled BlueSky ships
   its navigation data and doesn't fetch it at runtime. If the map/traffic don't
   populate, pre-bake nav data into the image (best), or briefly attach `webatm`
   to an egress network once to populate a cached volume.
3. **Example scenarios.** The `~/bluesky` tmpfs starts empty each boot. BlueSky
   repopulates its working dir on start, so the bundled example scenarios should
   reappear (consuming part of the cap) — confirm they list in the file manager.
   If they don't and you want them, raise `BLUESKY_TMPFS_SIZE` or bake them in.
   Hosts on xfs/overlay2 with project quotas can instead cap the whole writable
   layer with `storage_opt: { size: ... }` (preserves baked-in content); it's
   not portable, which is why the tmpfs is the default.

### Optional: read-only root filesystem

For extra hardening set `read_only: true` on `webatm` plus tmpfs/volume mounts
for the paths BlueSky writes (`~/bluesky`, `/tmp`, any `~/.cache`). Left **off**
by default because it needs a quick test against the bundled image — BlueSky /
matplotlib may write to a few home-dir caches.

## Caveats (consequences of not touching the app)

1. **New-visitor assignment is poll-based.** Between a user landing on a free
   replica and the next poll (`POLL_INTERVAL`, default 5 s), a second
   simultaneous arrival can be load-balanced onto the same replica and share its
   BlueSky sim. Unlikely at demo traffic; lower `POLL_INTERVAL` to shrink the
   window. (A small app-side shim returning 503-when-occupied would make this
   race-free, but that's an app change.)
2. **"One IP" is really "one browser".** Sticky cookies pin per browser, not per
   IP — a determined user with multiple browsers could hold more than one slot.
3. **Idle-but-connected isn't force-kicked at 5 min.** Abandoned tabs free their
   slot within ~60 s (Socket.IO timeout) and the replica is then wiped;
   `MAX_SESSION_TIME` caps the maximum. A precise "kick after N minutes of no
   interaction" would need the app to report activity.

## Files

| Path | Purpose |
|---|---|
| `docker-compose.yml` | The whole stack (incl. the `runsc` runtime + internal network). |
| `traefik/traefik.yml` | Traefik static config (entrypoints, providers, ACME). |
| `traefik/dynamic/base.yml` | Capacity-full service + rate-limit middleware. |
| `traefik/dynamic/capacity.yml` | **Generated** by the controller; present only when full. |
| `capacity_full/capacity-full.html` | The "all slots busy" page. |
| `controller/controller.py` | Capacity toggling + disposable-per-visitor recycle + usage log (stdlib only). |
| `.env.example` | Copy to `.env` and fill in. |

## Hardening notes

- **Cloudflare client IPs**: the rate-limit middleware uses `ipStrategy.depth: 1`.
  If you proxy through Cloudflare, consider restricting ingress to Cloudflare IP
  ranges and/or trusting `CF-Connecting-IP` so rate limits key off the real
  client.
- **Docker socket**: the controller mounts `/var/run/docker.sock` read-write
  (it must restart replicas) and is **not** sandboxed — treat it as privileged
  and trusted. Only the `webatm` replicas run under gVisor.
- **Dashboard**: Traefik's dashboard is disabled; enable it deliberately if
  needed and keep `:8080` closed to the internet.
