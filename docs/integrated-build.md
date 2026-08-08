# Integrated Build (`webatm-integrated`)

An optional, separately-packaged variant that bundles the BlueSky simulator
so the container can run `bluesky --headless` itself. It is **excluded from
the default build** — the backend lives in the separate `WebATM-integrated/`
package and the frontend behind a compile-time flag — and adds:

- **Auto-start on first boot** — because BlueSky lives in the same
  container, the first start-up auto-starts the headless server and
  auto-connects the WebATM proxy to it, so the user lands on a live,
  connected map without opening Settings. It fires **once per boot**: a
  marker file (default `/dev/shm/webatm_autostart.done`, on tmpfs) ensures a
  replaced gunicorn worker never resurrects a server the user manually
  stopped. Opt out with `WEBATM_AUTO_START=0`; move the marker with
  `WEBATM_AUTOSTART_MARKER`.
- **Server lifecycle controls** — Start / Stop / Restart / Kill the BlueSky
  server from the web UI. Kill terminates the whole process group, so the
  server *and* all node child processes are reaped.
- **Live "Server Log" tab** — streams the in-order stdout/stderr of the
  `bluesky --headless` process tree over the `server_log` Socket.IO event,
  next to the Echo / Output Log tabs.
- **Auto-wired file management** — BlueSky's working directory is fixed at
  `~/bluesky`, so the file manager points straight at BlueSky's
  `scenario/`, `plugins/` and `output/` directories. The manual "BlueSky
  Base Directory" configuration is removed (the standalone build keeps it).
- **Consistent status indicators** — the top-header BlueSky status (live
  data-flow truth) and the server-control status are kept in agreement: a
  process that stays up while data stops reads as `running — not connected`,
  never a stale `connected`.

## `QUIT` semantics

BlueSky's real `QUIT` is a **server-wide shutdown**: it stops the headless
server loop and terminates every node child process. WebATM deliberately
does **not** forward `QUIT` to BlueSky:

- Standalone connects to a shared remote server, so forwarding `QUIT` would
  tear it down for every other user.
- Integrated bundles its own server, whose lifecycle is owned by the
  explicit Start / Stop / Restart / Kill controls.

Instead `QUIT` ends *this* client's session: it disconnects WebATM's proxy
from BlueSky and flips the connection status, without dropping the
browser↔WebATM socket. The BlueSky server is left running.

## Killing a single node

Terminating one simulation node without touching the rest of the tree is a
separate `DELNODE` message, sent to the owning server when the per-node kill
button in the Simulation Nodes panel is used (the `DELNODE [nodeid]` console
command works too — bare `DELNODE` kills the active node). It requires a
BlueSky server with `DELNODE` support — older servers silently ignore the
request. When the *active* node is killed, WebATM automatically switches to
a surviving node so the map and status indicators stay live. BlueSky refuses
to delete its last remaining node (stopping the server is `QUIT` territory),
and WebATM mirrors that refusal in the panel. This works in both build
variants (it goes over the normal command channel, not the integrated
process manager).

## Build and run

The variant uses the threaded gunicorn worker, like the standalone build (it
additionally requires threads because it reads a blocking subprocess pipe):

```bash
docker build -f Dockerfile.integrated -t webatm-integrated .
docker run -p 8082:8082 webatm-integrated
```

Or use the helper scripts with `--integrated`:

```bash
script/build_docker.sh --integrated     # build + run the image
# — or, for a local (non-Docker) run —
script/build_frontend.sh --integrated
script/run_webatm.sh --integrated
```

For local frontend work on the variant: `npm run build:integrated` /
`npm run watch:integrated`.

### Build with your own BlueSky fork

The integrated image pulls BlueSky from
[`amvlab/bluesky`](https://github.com/amvlab/bluesky) on its `main` branch
by default. To build against your own fork, branch, or tag, edit the
`bluesky-simulator` dependency line in `WebATM-integrated/pyproject.toml`:

```toml
dependencies = [
    "bluesky-simulator[headless] @ git+https://github.com/<your-org>/bluesky.git@<branch-or-tag>",
]
```

Then build and run the image locally:

```bash
docker build -f Dockerfile.integrated -t webatm-integrated:dev .
docker run --rm -p 8082:8082 webatm-integrated:dev
```

Your fork must keep BlueSky's pip distribution name (`bluesky-simulator`)
and the `bluesky = bluesky.__main__:main` console script entry point — the
container spawns the server as `bluesky --headless`.

## How the exclusion works

- **Backend**: `webatm_integrated` is never imported by the core `webatm`
  package. It is wired in by a single env-guarded hook in `WebATM/app.py`
  that runs only when `WEBATM_INTEGRATED=1`.
- **Frontend**: integrated code lives in `frontend/src/integrated/`, reached
  only through an `if (INTEGRATED_BUILD)` guarded dynamic import; webpack's
  `DefinePlugin` compiles that to `false` by default, so the integrated code
  is dead-code eliminated and never enters the default bundle.

See the [Integrated Variant API reference](api/integrated.md) for the
documented modules.
