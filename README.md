# WebATM ![License](https://img.shields.io/badge/license-AGPL--3.0-blue) ![Python](https://img.shields.io/badge/python-3.13%2B-blue) ![TypeScript](https://img.shields.io/badge/typescript-5.9%2B-blue)

A modern web client for the [BlueSky Air Traffic Management (ATM) simulator](https://github.com/TUDelft-CNS-ATM/bluesky). WebATM provides a standalone web interface with interactive aircraft visualization to control air traffic management simulations from the Web.

<img width="1916" height="1079" alt="webatm" src="https://github.com/user-attachments/assets/3c57d8ff-35c9-40fc-9f9c-20c1beae2384" />

**[Try WebATM Demo](https://webatm.amvlab.eu/)** 

## Features

- **Intuitive Aircraft Interaction**: Single-click to fly to any aircraft, double-click to activate follow mode
- **Customizable Aircraft Display**: Toggle visibility of labels, icons, trails, routes, and shapes
- **Aircraft Type in Labels & Info Panel**: View aircraft type directly on map labels and in the aircraft information panel
- **Flexible Aircraft Styling**: Choose from chevron, drone, triangle, or aircraft icon styles and customise colors
- **3D Aircraft Visualization**: Render aircraft as 3D models (A320, A350, A380, drones, and more).
- **Smart Command Input**: Tab completion for BlueSky commands with autosuggestion
- **Command Palette**: Quickly browse and search available BlueSky stack commands from the console
- **Console Map Picker**: Select coordinates directly from the map when entering commands
- **Scenario File Management**: Upload, organize, and run BlueSky scenario (`.scn`) files and folders straight from the web interface
- **Flexible Map Projection**: Switch between Web Mercator and 3D globe view powered by [MapLibre GL](https://maplibre.org/maplibre-gl-js/docs/)
- **Custom Map Sources**: Configure custom tile sources to personalize your base map layer
- **Configurable Scenario Path**: Set your BlueSky scenario directory from the settings modal
- **BlueSky Integration**: Seamless connection to BlueSky ATM simulator servers
- **Modern TypeScript Architecture**: Fully type-safe, maintainable client-side codebase

## 🚀 WebATM Pro Version Available

**Looking for more advanced features?** WebATM Pro includes everything in the open source version, plus additional capabilities:

- **Custom Simulation Engine**: Built on amvlab's custom simulator, controllable end-to-end from the WebATM interface
- **Multi-Node Simulation**: Spawn and manage multiple parallel simulation nodes from one interface
- **Server Development Environment**: Modify and develop simulation server code directly from the web interface
- **Enhanced Server Management**: Full control over server lifecycle (start/stop/restart)
- **Pro-Only Roadmap**: In-browser scenario editor, simulation rewind, and client-side command validation
- **Flexible Deployment**: amvlab can provide managed hosting or deploy on your local network for full data sovereignty

**[Visit amvlab.eu for Pro Version](https://amvlab.eu)**

## Prerequisites

### For Local Development
- Python 3.13 or higher
- Node.js 22+ and npm (for TypeScript development)
- [BlueSky ATM simulator](https://github.com/amvlab/bluesky) (amvlab fork recommended) or [TUDelft-CNS-ATM/bluesky](https://github.com/TUDelft-CNS-ATM/bluesky) version 1.1.1

## Compatibility

WebATM works best with the [amvlab fork of BlueSky](https://github.com/amvlab/bluesky), but is also compatible with the latest [BlueSky from TU Delft](https://github.com/TUDelft-CNS-ATM/bluesky).

## Quick Start

### Option 1: Prebuilt Release (no Node.js required)

Use this if you just want to run WebATM without installing Node.js or building the frontend yourself. You still clone the repo for the Python source, then drop in a single tarball that contains all the runtime assets that aren't checked into git.

1. **Clone the repository**
   ```bash
   git clone https://github.com/amvlab/WebATM
   cd WebATM
   ```

2. **Download and extract the prebuilt assets**

   Grab the latest `webatm-prebuilt-<version>.tar.gz` from the [Releases page](https://github.com/amvlab/WebATM/releases) and extract it from the repo root:
   ```bash
   tar -xzf ~/Downloads/webatm-prebuilt-<version>.tar.gz
   ```
   The tarball uses repo-relative paths, so extracting from the WebATM root lands the files in the right places:
   - `WebATM/static/dist/` — prebuilt webpack bundles
   - `WebATM/static/vendor/` — third-party CSS/fonts (FontAwesome, MapLibre)
   - `WebATM/static/tiles/world.pmtiles` — offline basemap (optional but bundled)

3. **Install Python dependencies**
   ```bash
   pip install -r requirements.txt
   ```

4. **Start the application**
   ```bash
   script/run_webatm.sh
   ```

5. **Access the web interface**

   Open your browser to: http://localhost:8082

6. **(Optional) Enable the offline basemap**

   The tarball already includes `WebATM/static/tiles/world.pmtiles`. To use it, open **Settings → Map Display Configuration → Offline (Local PMTiles)** in the web UI.

### Option 2: Local Deployment (build from source)

1. **Clone the repository**
   ```bash
   git clone https://github.com/amvlab/WebATM
   cd WebATM
   ```

2. **Install Python dependencies**
   ```bash
   pip install -r requirements.txt
   ```

3. **Build frontend assets**
   ```bash
   script/build_frontend.sh
   ```

4. **Start the application**
   ```bash
   script/run_webatm.sh
   ```

5. **Access the web interface**

   Open your browser to: http://localhost:8082

### Option 3: Docker Deployment

1. **Build the Docker image**
   ```bash
   docker build -t webatm:latest .
   ```

2. **Start with Docker Compose**
   ```bash
   docker compose up -d
   ```

3. **Access the web interface**

   Open your browser to: http://localhost:8082

4. **View logs**
   ```bash
   docker compose logs -f webatm
   ```

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `WEB_HOST` | Web server bind address | localhost |
| `WEB_PORT` | Web server port | 8082 |
| `BLUESKY_SERVER_HOST` | BlueSky server hostname/IP | localhost |

### BlueSky Server Ports

WebATM connects to BlueSky servers using the standard BlueSky network ports (11000 and 11001).

**Important**: These ports are currently not configurable. Ensure your BlueSky server runs with default port configuration.

### Offline Basemap

WebATM can render the map from a local PMTiles archive instead of an online tile provider — useful for air-gapped deployments or unreliable networks. The prebuilt release tarball (Option 1) already includes `world.pmtiles`; if you built from source, advanced users can generate their own archive with the `pmtiles` CLI — see the instructions in [.gitignore](.gitignore).

Once `WebATM/static/tiles/world.pmtiles` exists, enable it via **Settings → Map Display Configuration → Offline (Local PMTiles)**.


### Code Quality

**Python:**
```bash
# Linting with Ruff
ruff check .

# Format code
ruff format .
```

**TypeScript:**
```bash
cd frontend/
npm run type-check
```

## License

Copyright (c) 2025 amvlab

This project is licensed under the GNU Affero General Public License v3.0 (AGPL-3.0). See [LICENSE](LICENSE) file for details.

## Acknowledgments

This software incorporates **BlueSky - The Open Air Traffic Simulator** technology developed by TU Delft (Delft University of Technology). We acknowledge and thank TU Delft for their contribution to the open aviation simulation community.

## Support

For inquiries and support, please contact amvlab.
