# API Reference

Generated with [mkdocstrings](https://mkdocstrings.github.io/) from the
Google-style docstrings in the Python source.

## Core package (`WebATM`)

| Page | Modules | Role |
|---|---|---|
| [Application](app.md) | `WebATM.app`, `WebATM.main` | Flask app factory and server startup |
| [BlueSky Network Client](bluesky-client.md) | `WebATM.bluesky_client` | ZMQ client speaking BlueSky's native protocol |
| [Proxy Core](proxy.md) | `WebATM.proxy`, `WebATM.proxy.core`, `WebATM.proxy.subscribers` | The proxy gateway between web clients and BlueSky |
| [Proxy Managers](proxy-managers.md) | `WebATM.proxy.managers.*` | Connection, node, command and data management |
| [Proxy Handlers](proxy-handlers.md) | `WebATM.proxy.handlers.*` | BlueSky data-event handlers |
| [Server Package](server.md) | `WebATM.server.*` | Flask routes, sessions, Socket.IO handlers |
| [Utilities & Logging](utils.md) | `WebATM.utils`, `WebATM.logger`, `WebATM.proxy.perf` | Serialization helpers, logging, perf instrumentation |

## Integrated variant (`webatm_integrated`)

| Page | Modules | Role |
|---|---|---|
| [Integrated Variant](integrated.md) | `webatm_integrated.*` | Bundled-BlueSky build: auto-start, process manager, log streaming |
