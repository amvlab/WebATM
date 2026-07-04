# Architecture

WebATM is a standalone web client: a Python backend that speaks BlueSky's
native ZMQ protocol, and a TypeScript frontend that renders the simulation
with MapLibre GL. The two halves talk over Socket.IO.

## Data flow

```
BlueSky server (ZMQ 11000/11001)
        │
        ▼
BlueSkyClient  ──  WebATM/bluesky_client.py
        │
        ▼
BlueSkyProxy   ──  WebATM/proxy/  (managers + handlers)
        │
        ▼
Flask + Socket.IO  ──  WebATM/app.py, WebATM/server/
        │
        ▼
TypeScript client  ──  frontend/src/  (MapLibre GL visualization)
```

1. WebATM starts and (by default) auto-launches a headless BlueSky server.
2. The proxy connects the network client and subscribes to simulation data.
3. Real-time data flows through Socket.IO to the TypeScript client and is
   rendered with MapLibre GL.
4. User commands travel back over the WebSocket to the BlueSky server.

## Backend components

- **Entry point** — `WebATM.py` initializes the web server via
  `WebATM/main.py`.
- **Flask application** (`WebATM/app.py`) — factory pattern, session
  management, and Socket.IO integration.
- **BlueSky client** (`WebATM/bluesky_client.py`) — direct ZMQ network
  communication with BlueSky servers, adapted from BlueSky's own
  `bluesky.network` package (node ID generation, socket management, msgpack
  serialization, subscription handling).
- **Proxy package** (`WebATM/proxy/`) — modular proxy system using a
  composition pattern:
    - `core.py` — the main `BlueSkyProxy` delegation layer.
    - `managers/` — one manager per concern: connection lifecycle, node
      tracking, command processing, data emission.
    - `handlers/` — event handlers organized by functionality (simulation,
      shapes, commands, echo, routes, events, visualization, navigation).
    - `subscribers.py` — maps BlueSky topics to handlers and registers them.
- **Server package** (`WebATM/server/`) — Flask routes, session management,
  BlueSky server status, and Socket.IO handlers.

## Frontend components

- **Core** (`frontend/src/core/`) — application controller (`App.ts`),
  socket management, connection status service, and state management.
- **UI** (`frontend/src/ui/`) — modular components for the map (2D/3D
  aircraft renderers, shapes, routes), panels (traffic list, conflicts,
  aircraft info, display options), controls, console, and modals.
- **Data layer** (`frontend/src/data/`) — command handling, data
  processing, and shared type definitions.

## Network ports

| Port | Purpose |
|---|---|
| 11000 | Command port — sending simulation commands |
| 11001 | Data port — receiving real-time simulation data |
| 8082 | Web server port — user interface |

## Design principles

- Follow the modular composition pattern used by the proxy package.
- Keep modules under 500 lines with a clear separation of concerns.
- Register new data handlers in `WebATM/proxy/subscribers.py`.
- Extension points: routes go in `WebATM/server/routes.py`, proxy handlers
  in `WebATM/proxy/handlers/`, new proxy capabilities in
  `WebATM/proxy/managers/`, network features in `bluesky_client.py`; UI
  components follow the patterns in `frontend/src/ui/`.

The [API Reference](api/index.md) documents each backend module from its
Google-style docstrings.
