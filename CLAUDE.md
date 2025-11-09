# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

WebATM is a modern **standalone** web client for the BlueSky Air Traffic Management (ATM) simulator. It provides a web interface using MapLibre GL for aircraft visualization and radar display, connecting to BlueSky simulation servers via network protocols. The project features Docker containerization, TypeScript-based frontend, and connection to a BlueSky server.

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

### TypeScript Development
```bash
# Navigate to TypeScript directory
cd WebATM/static/ts/

# Install dependencies
npm install

# Build TypeScript
npm run build

# Watch for changes during development
npm run watch

# Type checking only
npm run type-check
```

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
# Build the Docker image
docker build -t webatm:latest .

# Run the container
docker run -p 8082:8082 webatm:latest
```

#### Docker Environment Variables
- `FLASK_ENV` - Set to 'production' for production deployment
- `BLUESKY_SERVER_HOST` - BlueSky server hostname/IP address (default: localhost)
- `WEB_PORT` - Web server port (default: 8082)
- `WEB_HOST` - Web server bind address (default: localhost for security, use 0.0.0.0 for Docker)
- `HEARTBEAT_INTERVAL` - Heartbeat interval in seconds (default: 30)

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
│   ├── static/                 # Static web assets
│   │   ├── css/               # Stylesheets
│   │   │   └── style.css      # Main stylesheet
│   │   ├── favicon.png        # Application favicon
│   │   └── ts/                # TypeScript source and build
│   │       ├── src/           # TypeScript source code
│   │       │   ├── main.ts    # Application entry point
│   │       │   ├── core/      # Core application logic
│   │       │   │   ├── App.ts
│   │       │   │   ├── ConnectionStatusService.ts
│   │       │   │   ├── SocketManager.ts
│   │       │   │   └── StateManager.ts
│   │       │   ├── data/      # Data processing and types
│   │       │   │   ├── CommandHandler.ts
│   │       │   │   ├── DataProcessor.ts
│   │       │   │   └── types.ts
│   │       │   ├── ui/        # User interface components
│   │       │   │   ├── ConnectionManager.ts
│   │       │   │   ├── Console.ts
│   │       │   │   ├── ConsoleManager.ts
│   │       │   │   ├── Controls.ts
│   │       │   │   ├── EchoManager.ts
│   │       │   │   ├── Header.ts
│   │       │   │   ├── ModalManager.ts
│   │       │   │   ├── Modals.ts
│   │       │   │   ├── ServerManager.ts
│   │       │   │   ├── SettingsModal.ts
│   │       │   │   ├── map/   # Map-related components
│   │       │   │   │   ├── EntityRenderer.ts
│   │       │   │   │   ├── MapDisplay.ts
│   │       │   │   │   ├── MapOverlay.ts
│   │       │   │   │   ├── aircraft/
│   │       │   │   │   │   ├── AircraftCreationManager.ts
│   │       │   │   │   │   ├── AircraftInteractionManager.ts
│   │       │   │   │   │   ├── AircraftRenderer.ts
│   │       │   │   │   │   ├── AircraftRouteRenderer.ts
│   │       │   │   │   │   ├── AircraftRoutes.ts
│   │       │   │   │   │   └── AircraftShapes.ts
│   │       │   │   │   └── shapes/
│   │       │   │   │       ├── ShapeDrawingManager.ts
│   │       │   │   │       └── ShapeRenderer.ts
│   │       │   │   └── panels/ # UI panels
│   │       │   │       ├── BasePanel.ts
│   │       │   │       ├── PanelResizer.ts
│   │       │   │       ├── left/
│   │       │   │       │   ├── DisplayOptionsPanel.ts
│   │       │   │       │   ├── MapControlsPanel.ts
│   │       │   │       │   └── SimulationNodesPanel.ts
│   │       │   │       └── right/
│   │       │   │           ├── AircraftInfoPanel.ts
│   │       │   │           ├── ConflictsPanel.ts
│   │       │   │           └── TrafficListPanel.ts
│   │       │   └── utils/     # Utility functions
│   │       │       ├── Logger.ts
│   │       │       └── StorageManager.ts
│   │       ├── package.json   # TypeScript dependencies
│   │       ├── tsconfig.json  # TypeScript configuration
│   │       └── webpack.config.js # Webpack build configuration
│   └── templates/              # HTML templates
│       └── index.html         # Main web interface
├── script/                     # Build and utility scripts
│   ├── build_docker.sh        # Docker build script
│   ├── build_ts.sh            # TypeScript build script
│   ├── run_webatm.sh          # Application startup script
│   └── wsgi.py                # WSGI configuration
├── requirements.txt            # Python dependencies (core)
├── requirements-dev.txt        # Development dependencies
├── requirements-prod.txt       # Production dependencies
├── pyproject.toml             # Python project configuration (Python 3.13+)
├── docker-compose.yml         # Docker Compose configuration
├── Dockerfile                 # Docker image definition
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

**Frontend Architecture:**
- **TypeScript Core** (`WebATM/static/ts/src/core/`) - Application controller, socket management, state management
- **User Interface** (`WebATM/static/ts/src/ui/`) - Modular components for map, panels, controls, and modals
- **Data Layer** (`WebATM/static/ts/src/data/`) - Command handling, data processing, and type definitions
- **MapLibre GL Integration** - Interactive map with aircraft tracking and visualization

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
3. Real-time data → Socket.IO → TypeScript client → MapLibre GL visualization
4. User commands → WebSocket → BlueSky server

## Development Guide

### Dependencies and Setup

**Python (3.13+):**
- Flask/Flask-SocketIO (web server)
- msgpack/pyzmq (BlueSky protocol)
- NumPy (data processing)
- gunicorn (production serving)

**TypeScript:**
- MapLibre GL (map visualization)
- Socket.IO client (real-time communication)
- Turf.js (geospatial operations)
- Webpack (bundling)

**Installation:** See `requirements.txt` (core), `requirements-dev.txt` (development), `requirements-prod.txt` (production), and `pyproject.toml` (full configuration)

### Development Workflow

**Code Quality Tools:**
```bash
# Python (configured in pyproject.toml)
ruff check .                    # Check code quality
ruff format .                   # Auto-format code
mypy WebATM/                    # Type checking (if installed)

# TypeScript
cd WebATM/static/ts/
npm run type-check              # Type checking only
```

**Backend Development:**
1. Edit Python files in `WebATM/`
2. Run `python WebATM.py` for testing
3. Use `ruff check .` and `ruff format .` before committing

**Frontend Development:**
1. Edit TypeScript files in `WebATM/static/ts/src/`
2. Build: `npm run build` or watch: `npm run watch`
3. Run `npm run type-check` for validation

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
- **Standalone web client** (not integrated BlueSky plugin)
- **Python 3.13+** and **BlueSky 1.1.0+** required
- **TypeScript-first** frontend architecture
- **Auto-start** BlueSky server in headless mode
- **Docker-ready** for production deployment

**Development Reminders:**
- Use `pyproject.toml` for Python configuration
- Follow modular composition pattern in proxy package
- Run linting tools before committing
- Production deployments require `WEB_HOST=0.0.0.0`
- BlueSky ports (11000/11001) are not configurable