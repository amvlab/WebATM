# WebATM ![License](https://img.shields.io/badge/license-AGPL--3.0-blue) ![Python](https://img.shields.io/badge/python-3.13%2B-blue) ![TypeScript](https://img.shields.io/badge/typescript-5.9%2B-blue)

A modern web client for the [BlueSky Air Traffic Management (ATM) simulator](https://github.com/TUDelft-CNS-ATM/bluesky). WebATM provides a standalone web interface with interactive aircraft visualization to control air traffic management simulations from the Web.

<img width="1909" height="1048" alt="image" src="https://github.com/user-attachments/assets/15401992-a349-4a40-8088-229966c94717" />

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
- **Multi-Node Simulation**: Spawn and manage multiple parallel simulation nodes from one interface
- **BlueSky Integration**: Seamless connection to BlueSky ATM simulator servers
- **Modern TypeScript Architecture**: Fully type-safe, maintainable client-side codebase

<img width="1200" height="658" alt="webatm_demo" src="https://github.com/user-attachments/assets/fa43352c-c463-4f8f-bc9d-03e01f82b4ac" />

## Editions

WebATM ships in two flavors, both open source and published to GHCR:

- **`webatm`** (standalone) — the web client only. Connects to a BlueSky server you run yourself, on the docker host or elsewhere on the network. This is the default everywhere in this README.
- **`webatm-integrated`** — bundles BlueSky inside the same container and adds in-app **Start / Stop / Restart / Kill** server controls plus a live server-log tab. File management auto-wires to BlueSky's working directory, so there's no base-path step. Useful if you want a single-container deployment with no separate BlueSky process to manage. See [WebATM Integrated](#webatm-integrated) below for usage.

## 🚀 WebATM Pro Version Available

**Looking for more advanced features?** WebATM Pro includes everything in the open source version, plus additional capabilities:

- **Custom Simulation Engine**: Built on amvlab's custom simulator, controllable end-to-end from the WebATM interface
- **Server Development Environment**: Modify and develop simulation server code directly from the web interface
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

### Option 1: Docker Compose (prebuilt image, fastest)

The quickest way to run WebATM is to use the provided `docker-compose.yml` to pull the prebuilt image from GHCR.

1. **Download the compose file**
   ```bash
   wget https://raw.githubusercontent.com/amvlab/WebATM/main/docker-compose.yml
   ```

2. **Start the stack**
   ```bash
   docker compose up -d
   ```

3. **Access the web interface**

   Open your browser to: http://localhost:8082

4. **View logs**
   ```bash
   docker compose logs -f webatm
   ```

By default the container connects to a BlueSky server on the Docker host via `host.docker.internal`. To enable the in-app file manager for scenarios, plugins, and settings, uncomment the `volumes:` block in `docker-compose.yml` and point it at your local BlueSky working directory.

### Option 2: Prebuilt Release (no Node.js required)

Use this if you want to run WebATM directly from source without installing Node.js or building the frontend yourself. You still clone the repo for the Python source, then drop in two tarballs that contain the runtime assets that aren't checked into git: a small per-version code tarball and a larger static-asset tarball that changes rarely.

1. **Clone the repository**
   ```bash
   git clone https://github.com/amvlab/WebATM
   cd WebATM
   ```

2. **Download and extract the prebuilt code tarball**

   Grab the latest `webatm-prebuilt-<version>.tar.gz` from the [Releases page](https://github.com/amvlab/WebATM/releases) and extract it from the repo root:
   ```bash
   tar -xzf ~/Downloads/webatm-prebuilt-<version>.tar.gz
   ```
   This lands:
   - `WebATM/static/dist/` — prebuilt webpack bundles
   - `WebATM/static/vendor/` — third-party CSS/fonts (FontAwesome, MapLibre)

3. **Download and extract the static-asset tarball**

   Grab the assets tarball pinned by [`.assets-version`](./.assets-version) in this repo (e.g. `webatm-assets-v1.tar.gz`) from the [Releases page](https://github.com/amvlab/WebATM/releases) and extract it from the repo root:
   ```bash
   tar -xzf ~/Downloads/webatm-assets-<tag>.tar.gz
   ```
   This lands:
   - `WebATM/static/tiles/` — offline basemap (`world.pmtiles`) and navigation overlay (`navdata.pmtiles`)
   - `WebATM/static/glyphs/` — map fonts
   - `WebATM/static/navdata/` — navigation database

   This bundle changes rarely (only when tiles, fonts, or navdata roll), so a single download usually carries across many code releases.

4. **Install Python dependencies**
   ```bash
   pip install -r requirements.txt
   ```

5. **Start the application**
   ```bash
   script/run_webatm.sh
   ```

6. **Access the web interface**

   Open your browser to: http://localhost:8082

7. **(Optional) Enable the offline basemap**

   The assets tarball already includes `WebATM/static/tiles/world.pmtiles`. To use it, open **Settings → Map Display Configuration → Offline (Local PMTiles)** in the web UI.

### Option 3: Local Deployment (build from source)

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

## WebATM Integrated

The integrated image bundles BlueSky inside the same container and exposes its lifecycle (Start / Stop / Restart / Kill) plus a live server-log tab from the web UI. File management is pre-wired to BlueSky's working directory — no base-path configuration needed.

### Run the prebuilt image

The image is published alongside the standalone one on every release tag at `ghcr.io/amvlab/webatm-integrated`. To run it, uncomment the `webatm-integrated` service in [`docker-compose.yml`](docker-compose.yml) and bring it up:

```bash
docker compose up -d webatm-integrated
```

Open http://localhost:8082 and use the **Start** button in the Server Log tab (or in Settings → BlueSky Server Controls) to launch BlueSky inside the container.

### Build locally with your own BlueSky fork

The integrated image pulls BlueSky from [`amvlab/bluesky`](https://github.com/amvlab/bluesky) on its `main` branch by default. To build against your own fork, branch, or tag, edit the `bluesky-simulator` dependency line in [`webatm-integrated/pyproject.toml`](webatm-integrated/pyproject.toml):

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

Your fork must keep BlueSky's pip distribution name (`bluesky-simulator`) and the `bluesky = bluesky.__main__:main` console script entry point — the container spawns the server as `bluesky --headless`.

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

WebATM can render the map from a local [PMTiles](https://docs.protomaps.com/pmtiles/) archive instead of an online tile provider — useful for air-gapped deployments or unreliable networks. The offline MapLibre styles live in `WebATM/static/map/` (`offline-style.json` and `offline-style-light.json`) and expect a tile archive at `WebATM/static/tiles/world.pmtiles`.

The prebuilt release tarball (Option 1) already ships `world.pmtiles`. If you built from source, generate your own archive as follows.

#### 1. Install the `pmtiles` CLI

```bash
# macOS / Linux with Go installed:
go install github.com/protomaps/go-pmtiles@latest
export PATH="$HOME/go/bin:$PATH"
ln -sf "$HOME/go/bin/go-pmtiles" "$HOME/go/bin/pmtiles"   # optional alias
```

Or download a prebuilt binary from the [go-pmtiles releases page](https://github.com/protomaps/go-pmtiles/releases).

#### 2. Extract a worldwide tile archive

Pick a daily planet build date from [maps.protomaps.com/builds](https://maps.protomaps.com/builds/) (e.g. `20260415`) and extract only the zoom levels you need. Zoom 0–8 worldwide is roughly 400 MB – 1.2 GB and covers coastlines, major roads, and country/state boundaries — enough context for ATM visualization:

```bash
mkdir -p WebATM/static/tiles
pmtiles extract \
  https://build.protomaps.com/<YYYYMMDD>.pmtiles \
  WebATM/static/tiles/world.pmtiles \
  --maxzoom=8
```

To add street-level detail for a specific region, run a second extract with a bounding box and a higher max zoom, then add it as an extra source in `WebATM/static/map/offline-style.json`:

```bash
pmtiles extract \
  https://build.protomaps.com/<YYYYMMDD>.pmtiles \
  WebATM/static/tiles/region.pmtiles \
  --bbox=<minLon,minLat,maxLon,maxLat> \
  --maxzoom=12
```

#### 3. Verify and enable

```bash
pmtiles show WebATM/static/tiles/world.pmtiles
```

Then enable it in the UI via **Settings → Map Display Configuration → Offline (Local PMTiles)**.

> The `*.pmtiles` archives can grow to hundreds of MB or more, so distribute them via GitHub releases rather than committing them to the repository.

#### Navdata overlay (airports, runways, waypoints)

WebATM can also render an offline navdata overlay (airports, heliports, runways, taxiways, and waypoints) with a search box backed by a local SQLite index. This is built from X-Plane `apt.dat`/`earth_fix.dat` plus OurAirports and produces `WebATM/static/tiles/navdata.pmtiles` and `WebATM/static/navdata/navdata.sqlite`. See [script/README.md](script/README.md) for the build pipeline and tuning options.


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

This software incorporates **[BlueSky - The Open Air Traffic Simulator](https://github.com/TUDelft-CNS-ATM/bluesky)** technology developed by TU Delft (Delft University of Technology). We acknowledge and thank TU Delft for their contribution to the open aviation simulation community.

The offline basemap is built from [Protomaps](https://protomaps.com/) planet builds distributed as [PMTiles](https://docs.protomaps.com/pmtiles/), derived from OpenStreetMap data (© OpenStreetMap contributors, [ODbL](https://www.openstreetmap.org/copyright)). The airport, runway, taxiway, and waypoint overlay is built from X-Plane navigation data (`apt.dat` and `earth_fix.dat`) released by [Laminar Research](https://www.x-plane.com/) under the GNU GPL, with airport importance ranking and IATA codes sourced from [OurAirports](https://ourairports.com/data/) (public domain).

## Support

For inquiries and support, please contact amvlab.
