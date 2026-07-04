# Server Package

Flask routes, session management, BlueSky server status, and Socket.IO
event handlers.

!!! note
    The HTTP route and Socket.IO event handlers are defined inside the
    `register_*` functions, so the reference below documents those
    registration entry points; each handler's method, path/event and JSON
    payloads are described in the corresponding `register_*` function's
    source (viewable via the source toggles).

## `WebATM.server.routes`

::: WebATM.server.routes

## `WebATM.server.session_manager`

::: WebATM.server.session_manager

## `WebATM.server.bluesky_server_status`

::: WebATM.server.bluesky_server_status

## `WebATM.server.socket_handlers`

::: WebATM.server.socket_handlers
