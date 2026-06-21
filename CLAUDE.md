# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

WebATM is a modern web client for the BlueSky Air Traffic Management (ATM) simulator. It provides a web interface using MapLibre GL for aircraft visualization and radar display, connecting to BlueSky simulation servers via network protocols. The project features Docker containerization, TypeScript-based frontend, and connection to a BlueSky server.

### Build Variants

WebATM ships in two variants, both built from this repo:

- **Standalone (`webatm`)** — the default. Web client only; connects to a BlueSky server you run yourself.
- **Integrated (`webatm-integrated`)** — bundles BlueSky in the same container and adds in-app server lifecycle controls (Start/Stop/Restart/Kill) plus a live server-log tab. File management auto-wires to BlueSky's working directory.

The integrated variant is **fully opt-in and gated end-to-end**:
- **Backend**: `WebATM/app.py` calls `webatm_integrated.register()` only when `WEBATM_INTEGRATED=1`. Any failure is logged and non-fatal.
- **Frontend**: `frontend/src/main.ts` dynamic-imports `./integrated/index` only when the `INTEGRATED_BUILD` compile-time constant (webpack `DefinePlugin`) is `true`. The `integrated` chunk is dead-code-eliminated from the default bundle.
- **Dependency direction**: the core `WebATM` package never imports `webatm_integrated`. The arrow only points integrated → core.

When working on integrated features, **do not** add imports from core into integrated code paths or vice versa beyond the one registration hook.

## Requirements

- **Python**: 3.13 or higher
- **Node.js**: 22+ with npm (for TypeScript development)
- **Docker**: 20.10+ with Docker Compose 2.0+ (for containerized deployment)
- **BlueSky**: Version 1.1.0 or higher (automatically managed by WebATM)

## Running and Testing Commands

### Starting the Application
```bash
# Run the main web server
python WebATM.py
```

The web interface will be available at http://localhost:8082

### Python Environment and Tests
Dependencies are managed with [uv](https://docs.astral.sh/uv/) from `pyproject.toml` and the pinned `uv.lock` (the legacy `requirements*.txt` files have been removed).

```bash
# Sync the dev environment (core deps + PEP 735 `dev` group)
uv sync

# Sync with production extras (gunicorn, eventlet)
uv sync --extra prod

# Run the test suite (collects both core and integrated suites)
uv run pytest                # everything (core + integrated)
uv run pytest -m core        # core `webatm` package only (tests/)
uv run pytest -m integrated  # optional `webatm_integrated` package only
```

### Frontend (TypeScript) Development
The TypeScript source lives in the top-level `frontend/` directory. Build output is emitted to `WebATM/static/dist/` (consumed by the Flask templates) and vendored third-party assets (FontAwesome, MapLibre GL CSS) are copied into `WebATM/static/vendor/` by the `vendor-assets` prebuild step.

```bash
# Navigate to frontend directory
cd frontend/

# Install dependencies
npm install

# Production build (also runs vendor-assets prebuild)
npm run build              # alias for build:production
npm run build:production   # NODE_ENV=production webpack
npm run build:integrated   # INTEGRATED_BUILD=true webpack (emits integrated chunk)
npm run build:dev          # development build

# Watch for changes during development
npm run watch
npm run watch:integrated   # watch with integrated chunk emitted

# Type checking only
npm run type-check

# Copy vendored assets only
npm run vendor-assets
```

A convenience script `script/build_frontend.sh` runs the full production build from the repo root. Pass `--integrated` to build the integrated bundle instead.

### Docker Deployment

#### Using Docker Compose (Recommended)
```bash
# Start the application stack
docker-compose up -d

# View logs
docker-compose logs -f webatm

# Stop the stack
docker-compose down
```

#### Building Docker Image Manually
```bash
# Standalone image
docker build -t webatm:latest .
docker run -p 8082:8082 webatm:latest

# Integrated image (bundles BlueSky from amvlab/bluesky)
docker build -f Dockerfile.integrated -t webatm-integrated:latest .
docker run -p 8082:8082 webatm-integrated:latest
```

The integrated image bakes in `WEBATM_INTEGRATED=1`, `BLUESKY_SERVER_HOST=localhost`, `WEB_HOST=0.0.0.0`, and `WEB_PORT=8082`, and runs under gunicorn with the `gthread` worker (not eventlet — incompatible with the blocking subprocess pipe the integrated build reads in a background thread). The standalone image is unaffected by anything in `WebATM-integrated/`.

#### Docker Environment Variables
- `FLASK_ENV` - Set to 'production' for production deployment
- `BLUESKY_SERVER_HOST` - BlueSky server hostname/IP address (default: localhost)
- `WEB_PORT` - Web server port (default: 8082)
- `WEB_HOST` - Web server bind address (default: localhost for security, use 0.0.0.0 for Docker)
- `HEARTBEAT_INTERVAL` - Heartbeat interval in seconds (default: 30)
- `WEBATM_INTEGRATED` - Set to `1` to enable the integrated extensions (server lifecycle + log streaming). Off by default; ignored if `webatm_integrated` isn't installed.

#### BlueSky Server Configuration
This web client connects to BlueSky servers using the default BlueSky network ports:
- **Port 11000** - For sending commands and events to the BlueSky server
- **Port 11001** - For receiving simulation data and information from the server

## Architecture Overview

### Project Structure

```
WebATM/
├── WebATM.py                    # Main entry point
├── README.md                    # User-facing project documentation
├── CLAUDE.md                    # AI assistant guidance (this file)
├── WebATM/                      # Core web application package
│   ├── __init__.py             # Module initialization
│   ├── main.py                 # Server startup and BlueSky auto-start
│   ├── app.py                  # Flask web application and routes
│   ├── bluesky_client.py       # BlueSky standalone network client
│   ├── logger.py               # Logging configuration
│   ├── utils.py                # Utility functions
│   ├── proxy/                  # Modular proxy package for client-server communication
│   │   ├── __init__.py        # Package exports and global management
│   │   ├── core.py            # BlueSkyProxy main class (delegation layer)
│   │   ├── subscribers.py     # Subscriber registration
│   │   ├── handlers/          # Data event handlers by functionality
│   │   │   ├── __init__.py
│   │   │   ├── simulation.py  # SIMINFO, ACDATA handlers
│   │   │   ├── shapes.py      # POLY, POLYLINE handlers
│   │   │   ├── commands.py    # STACK, STACKCMDS handlers
│   │   │   ├── echo.py        # ECHO handler
│   │   │   ├── routes.py      # ROUTEDATA handler
│   │   │   ├── events.py      # RESET, REQUEST handlers
│   │   │   ├── visualization.py # PLOT, TRAILS, SHOWDIALOG handlers
│   │   │   └── navigation.py  # DEFWPT handler
│   │   └── managers/          # Focused manager modules
│   │       ├── __init__.py
│   │       ├── connection_manager.py  # Connection lifecycle management
│   │       ├── node_manager.py        # Node/server tracking
│   │       ├── command_processor.py   # Command processing
│   │       └── data_manager.py        # Data emission & state management
│   ├── server/                 # Server management modules
│   │   ├── __init__.py
│   │   ├── routes.py          # Flask route handlers
│   │   ├── bluesky_server_status.py  # BlueSky server status management
│   │   ├── session_manager.py  # Session management
│   │   └── socket_handlers.py  # Socket.IO event handlers
│   ├── static/                 # Static web assets (served by Flask)
│   │   ├── css/               # Stylesheets (style.css)
│   │   ├── dist/              # Webpack build output (bundles + manifest.json)
│   │   ├── map/               # Offline MapLibre style JSON (light/dark)
│   │   ├── models/            # 3D aircraft .glb models (A320/A350/A380/EVTOL)
│   │   ├── tiles/             # Map tile assets
│   │   ├── vendor/            # Vendored third-party assets (fontawesome, maplibre-gl)
│   │   └── favicon.png        # Application favicon
│   └── templates/              # HTML templates
│       └── index.html         # Main web interface
├── frontend/                   # TypeScript frontend (separate from Python package)
│   ├── src/                   # TypeScript source code
│   │   ├── main.ts            # Application entry point
│   │   ├── core/              # Core application logic
│   │   │   ├── App.ts
│   │   │   ├── ConnectionStatusService.ts
│   │   │   ├── SocketManager.ts
│   │   │   └── StateManager.ts
│   │   ├── data/              # Data processing, types, and command metadata
│   │   │   ├── CommandHandler.ts
│   │   │   ├── CommandSignature.ts
│   │   │   ├── DataProcessor.ts
│   │   │   ├── aircraftCategories.ts
│   │   │   ├── aircraftDimensions.ts
│   │   │   ├── aircraftTypes.ts
│   │   │   └── types.ts
│   │   ├── integrated/        # Integrated build only — gated by INTEGRATED_BUILD
│   │   │   ├── index.ts                       # registerIntegrated() entry point
│   │   │   ├── ProcessControlManager.ts       # Start/Stop/Restart/Kill button wiring
│   │   │   ├── ServerLogStreamManager.ts      # Live server-log tab (seq-ordered, replayable)
│   │   │   └── settingsServerControls.ts      # Injects lifecycle controls into Settings
│   │   ├── ui/                # User interface components
│   │   │   ├── BlueSkyFileManager.ts
│   │   │   ├── CommandListView.ts
│   │   │   ├── CommandPaletteModal.ts
│   │   │   ├── ConnectionManager.ts
│   │   │   ├── Console.ts
│   │   │   ├── ConsoleManager.ts
│   │   │   ├── ConsoleMapPicker.ts
│   │   │   ├── Controls.ts
│   │   │   ├── EchoManager.ts
│   │   │   ├── Header.ts
│   │   │   ├── ModalManager.ts
│   │   │   ├── Modals.ts
│   │   │   ├── ServerManager.ts
│   │   │   ├── SettingsModal.ts
│   │   │   ├── map/           # Map-related components
│   │   │   │   ├── EntityRenderer.ts
│   │   │   │   ├── MapDisplay.ts
│   │   │   │   ├── MapOverlay.ts
│   │   │   │   ├── aircraft/  # 2D and 3D aircraft renderers
│   │   │   │   │   ├── Aircraft2DRenderer.ts
│   │   │   │   │   ├── Aircraft3DRenderer.ts
│   │   │   │   │   ├── AircraftCreationManager.ts
│   │   │   │   │   ├── AircraftInteractionManager.ts
│   │   │   │   │   ├── AircraftRenderer.ts
│   │   │   │   │   ├── AircraftRendererFactory.ts
│   │   │   │   │   ├── AircraftRoute3DRenderer.ts
│   │   │   │   │   ├── AircraftRouteRenderer.ts
│   │   │   │   │   ├── AircraftRoutes.ts
│   │   │   │   │   └── AircraftShapes.ts
│   │   │   │   ├── rendering/ # Shared 3D rendering primitives
│   │   │   │   │   ├── CustomLayer3D.ts
│   │   │   │   │   └── IEntityRenderer.ts
│   │   │   │   ├── routes/    # Route drawing UI
│   │   │   │   │   ├── RouteConstraintsModal.ts
│   │   │   │   │   ├── RouteDrawingManager.ts
│   │   │   │   │   └── RouteDrawingPreview.ts
│   │   │   │   └── shapes/    # 2D and 3D shape rendering
│   │   │   │       ├── Shape3DRenderer.ts
│   │   │   │       ├── ShapeDrawingManager.ts
│   │   │   │       └── ShapeRenderer.ts
│   │   │   └── panels/        # UI panels
│   │   │       ├── BasePanel.ts
│   │   │       ├── PanelResizer.ts
│   │   │       ├── left/
│   │   │       │   ├── DisplayOptionsPanel.ts
│   │   │       │   ├── MapControlsPanel.ts
│   │   │       │   └── SimulationNodesPanel.ts
│   │   │       └── right/
│   │   │           ├── AircraftInfoPanel.ts
│   │   │           ├── ConflictsPanel.ts
│   │   │           └── TrafficListPanel.ts
│   │   └── utils/             # Utility functions
│   │       ├── Logger.ts
│   │       └── StorageManager.ts
│   ├── scripts/
│   │   └── vendor-assets.js   # Copies vendor assets into WebATM/static/vendor/
│   ├── dist/                  # Local webpack output (mirrored to WebATM/static/dist/)
│   ├── package.json           # TypeScript dependencies
│   ├── tsconfig.json          # TypeScript configuration
│   └── webpack.config.js      # Webpack build configuration
├── WebATM-integrated/          # Optional Python package — integrated build only
│   ├── pyproject.toml         # Pulls bluesky-simulator from amvlab/bluesky
│   ├── conftest.py            # Test bootstrap (adds package + repo root to sys.path)
│   ├── webatm_integrated/
│   │   ├── __init__.py        # register(app, socketio, ...) entry point
│   │   ├── process_manager.py # BlueSkyProcessManager: start/stop/restart/kill
│   │   ├── log_streamer.py    # Gap-free, replayable server_log emission
│   │   ├── bluesky_paths.py   # Pre-configures file management for ~/bluesky
│   │   ├── routes.py          # /api/bluesky/* HTTP surface
│   │   └── socket_handlers.py # bs:* Socket.IO surface
│   └── tests/                  # pytest-driven unit tests
├── script/                     # Build and utility scripts
│   ├── build_docker.sh        # Docker build script
│   ├── build_frontend.sh      # Frontend (TypeScript) build script (--integrated for integrated bundle)
│   ├── check_frontend.sh      # Type-check + lint + tests (--integrated for compile-check)
│   ├── run_webatm.sh          # Application startup script
│   ├── wsgi.py                # WSGI configuration (eventlet, standalone)
│   └── wsgi_integrated.py     # WSGI configuration (gthread, integrated build)
├── pyproject.toml             # Python project config + deps (Python 3.13+, uv-managed)
├── uv.lock                    # Pinned dependency lockfile (uv)
├── conftest.py                # Root pytest config (auto-marks core vs integrated suites)
├── tests/                     # pytest unit tests for the core webatm package
├── docker-compose.yml         # Docker Compose configuration (incl. commented integrated service)
├── Dockerfile                 # Docker image definition (standalone)
├── Dockerfile.integrated      # Docker image definition (integrated — bundles BlueSky)
└── LICENSE                    # AGPL-3.0 license
```

## Architecture Overview

### Core Components

**Entry Point:**
- `WebATM.py` - Main application entry point that initializes the web server

**Backend Architecture:**
- **Flask Application** (`WebATM/app.py`) - Web server with factory pattern, session management, and Socket.IO integration
- **BlueSky Client** (`WebATM/bluesky_client.py`) - Direct network communication with BlueSky servers
- **Proxy Package** (`WebATM/proxy/`) - Modular proxy system using composition pattern:
  - `core.py` - Main BlueSkyProxy delegation layer
  - `managers/` - Specialized modules (connection, node, command, data management)
  - `handlers/` - Event handlers organized by functionality (simulation, shapes, commands, etc.)
  - `subscribers.py` - Handler registration system
- **Server Package** (`WebATM/server/`) - Flask routes, session management, and Socket.IO handlers

**Frontend Architecture (top-level `frontend/` package):**
- **TypeScript Core** (`frontend/src/core/`) - Application controller, socket management, state management
- **User Interface** (`frontend/src/ui/`) - Modular components for map, panels, controls, modals, command palette, and BlueSky file management
- **Data Layer** (`frontend/src/data/`) - Command handling/signatures, data processing, type definitions, and aircraft category/type/dimension catalogs
- **MapLibre GL + Three.js Integration** - Interactive 2D map plus 3D aircraft, route, and shape rendering via custom MapLibre layers
- **Build Output** - Webpack emits hashed bundles to `WebATM/static/dist/` (with `manifest.json`); `frontend/scripts/vendor-assets.js` mirrors third-party assets into `WebATM/static/vendor/`

### Network Integration

**BlueSky Communication:**
- Auto-starts BlueSky headless server with logging to `/tmp/bluesky_combined.log`
- Real-time data subscription via Socket.IO
- Multi-node simulation environment support

**Port Configuration:**
- **11000** - Command port (sending simulation commands)
- **11001** - Data port (receiving real-time simulation data)
- **8082** - Web server port (user interface)

**Data Flow:**
1. WebATM starts → Auto-launches BlueSky headless server
2. BlueSkyProxy connects → Manages network client connection
3. Real-time data → Socket.IO → TypeScript client → MapLibre GL (2D) / Three.js custom layers (3D)
4. User commands → WebSocket → BlueSky server

## Development Guide

### Dependencies and Setup

**Python (3.13+):**
- Flask/Flask-SocketIO (web server)
- msgpack/pyzmq (BlueSky protocol)
- NumPy (data processing)
- gunicorn (production serving)

**TypeScript:**
- MapLibre GL (2D map visualization)
- Three.js (3D aircraft, routes, shapes)
- Socket.IO client (real-time communication)
- @turf/circle (geospatial operations)
- pmtiles (offline tile bundles)
- FontAwesome (icons, vendored at build time)
- Webpack (bundling)

**Installation:** Dependencies are managed with [uv](https://docs.astral.sh/uv/) from `pyproject.toml` and the pinned `uv.lock`. Run `uv sync` for the full dev environment (core deps + the PEP 735 `dev` group), or `uv sync --extra prod` to add the production extras (`gunicorn`, `eventlet`). The legacy `requirements*.txt` files have been removed.

### Development Workflow

**Code Quality Tools:**
```bash
# Python (configured in pyproject.toml)
ruff check .                    # Check code quality
ruff format .                   # Auto-format code
mypy WebATM/                    # Type checking (if installed)

# TypeScript
cd frontend/
npm run type-check              # Type checking only
```

**Backend Development:**
1. Edit Python files in `WebATM/`
2. Run `python WebATM.py` for testing
3. Use `ruff check .` and `ruff format .` before committing

**Frontend Development:**
1. Edit TypeScript files in `frontend/src/`
2. Build: `cd frontend && npm run build` or watch: `npm run watch`
3. Run `npm run type-check` for validation
4. Built bundles are emitted to `WebATM/static/dist/` and referenced from `WebATM/templates/index.html` via the webpack manifest

### Extension Guidelines

**Backend Extensions:**
- **Routes:** Add to `WebATM/server/routes.py`
- **Proxy Handlers:** Add to `WebATM/proxy/handlers/` by functionality
- **Proxy Managers:** Extend `WebATM/proxy/managers/` for new capabilities
- **Network Features:** Extend `bluesky_client.py`

**Frontend Extensions:**
- **UI Components:** Follow pattern in `ui/` directory
- **Map Features:** Add to `ui/map/` components
- **Data Processing:** Extend `data/types.ts` and `DataProcessor.ts`

**Integrated-only Extensions** (server lifecycle, log streaming, anything that assumes BlueSky lives in this container):
- **Python:** Add to `WebATM-integrated/webatm_integrated/`, wire from `register()`.
- **TypeScript:** Add to `frontend/src/integrated/`, wire from `registerIntegrated()` in `index.ts`.
- **Toggling core UI:** Add an `enableIntegratedMode()` method to the core component (e.g. `SettingsModal`, `BlueSkyFileManager`) that's a no-op unless called. Call it from `frontend/src/integrated/index.ts`. Never branch on `INTEGRATED_BUILD` inside core UI files.
- **Never import `webatm_integrated` or `frontend/src/integrated/` from core code** — the dependency arrow only points one way. The default build must still work with these directories absent (or with their imports tree-shaken).

**Best Practices:**
- Follow modular composition pattern (proxy package)
- Keep modules under 500 lines
- Use clear separation of concerns
- Register new handlers in `proxy/subscribers.py`

## Production Deployment

### Docker Deployment

**Quick Start:**
```bash
docker-compose up -d            # Start application stack
docker-compose logs -f webatm   # View logs
docker-compose down             # Stop stack
```

**Manual Docker:**
```bash
docker build -t webatm:latest .
docker run -p 8082:8082 webatm:latest
```

### Configuration

**Environment Variables:**
- `FLASK_ENV=production` - Production mode
- `WEB_HOST=0.0.0.0` - Container networking (use `localhost` for local dev)
- `WEB_PORT=8082` - Web server port
- `BLUESKY_SERVER_HOST=localhost` - BlueSky server location
- `HEARTBEAT_INTERVAL=30` - Connection heartbeat interval

**Deployment Checklist:**
1. Configure environment variables in `docker-compose.yml`
2. Set production environment variables
3. Deploy with `docker-compose up -d`
4. Monitor with `docker-compose ps` and logs

### Security Features
- Capability dropping and no-new-privileges in Docker
- Session management with configurable timeouts
- Heartbeat-based connection monitoring
- Environment-based configuration

## Important Notes

**Project Characteristics:**
- **Two variants**: standalone (`webatm`) and integrated (`webatm-integrated`); see [Build Variants](#build-variants)
- **Python 3.13+** and **BlueSky 1.1.0+** required
- **TypeScript-first** frontend architecture
- **Auto-start** BlueSky server in headless mode (standalone variant; integrated variant exposes lifecycle controls in the UI)
- **Docker-ready** for production deployment

**Development Reminders:**
- Use `pyproject.toml` for Python configuration
- Follow modular composition pattern in proxy package
- Run linting tools before committing
- Production deployments require `WEB_HOST=0.0.0.0`
- BlueSky ports (11000/11001) are not configurable
- Integrated features go in `WebATM-integrated/` (Python) and `frontend/src/integrated/` (TS); the default build must still work with these absent
- CI publishes both images on every `v*` tag (matrix in `.github/workflows/docker-publish.yml`); no separate workflow to maintain