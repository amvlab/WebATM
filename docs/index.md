# WebATM

A modern **standalone web client** for the
[BlueSky Air Traffic Management (ATM) simulator](https://github.com/TUDelft-CNS-ATM/bluesky).
WebATM provides a browser-based interface with interactive aircraft
visualization to control air traffic management simulations from the web.

![Mixed fleet of A320, A350, A380 and B747 aircraft rendered in WebATM](screenshots/mixed-fleet.png)

**[Try the WebATM demo](https://webatm.amvlab.eu/)**

## Features

- **Interactive map visualization** — standard Web Mercator and globe view
  with live aircraft tracking using MapLibre GL, including a 3D aircraft
  overlay.
- **Customizable map sources** — bring your own tile sources, use the bundled
  OpenFreeMap styles, or run fully offline with a single
  [PMTiles](offline-pmtiles.md) archive.
- **BlueSky integration** — seamless connection to BlueSky ATM simulator
  servers over the native BlueSky ZMQ protocol.
- **TypeScript architecture** — modern, type-safe client-side application.
- **Docker-ready** — containerized deployment with Docker Compose, plus an
  optional [integrated build](integrated-build.md) that bundles the BlueSky
  simulator itself.

![A380 close-up over the Alpine lakes](screenshots/a380-hero-alps.png)

## How it works

WebATM sits between your browser and a BlueSky simulation server:

1. WebATM starts and (by default) auto-launches a headless BlueSky server.
2. The internal proxy connects to BlueSky over ZMQ (ports 11000/11001) and
   subscribes to simulation data streams.
3. Real-time data flows through Socket.IO to the TypeScript client, which
   renders it with MapLibre GL.
4. User commands travel back over the WebSocket to the BlueSky server.

See the [Architecture](architecture.md) page for the full picture, and the
[API Reference](api/index.md) for the documented Python modules.

## Where to go next

- [Getting Started](getting-started.md) — install and run WebATM locally or
  with Docker.
- [Configuration](configuration.md) — environment variables and network ports.
- [Screenshot Gallery](gallery.md) — the full gallery of live-traffic
  screenshots used throughout these docs.

## WebATM Pro

Looking for advanced features? **WebATM Pro** includes capabilities beyond
this open-source version: a server development environment, advanced 3D
visualization, enhanced server lifecycle management, multi-server support,
and flexible managed or on-premises deployment.

**[Visit amvlab.eu for the Pro version](https://amvlab.eu)**

## License & acknowledgments

Copyright © 2025 amvlab. Licensed under the GNU Affero General Public License
v3.0 (AGPL-3.0).

This software incorporates **BlueSky — The Open Air Traffic Simulator**
technology developed by TU Delft (Delft University of Technology).
