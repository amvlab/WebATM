# WebATM ![License](https://img.shields.io/badge/license-AGPL--3.0-blue) ![Python](https://img.shields.io/badge/python-3.13%2B-blue) ![TypeScript](https://img.shields.io/badge/typescript-5.9%2B-blue)

A modern web client for the [BlueSky Air Traffic Management (ATM) simulator](https://github.com/TUDelft-CNS-ATM/bluesky). WebATM provides a standalone web interface with interactive aircraft visualization to control air traffic management simulations from the Web.

<img width="1909" height="1048" alt="image" src="https://github.com/user-attachments/assets/15401992-a349-4a40-8088-229966c94717" />

**[Try WebATM Demo](https://webatm.amvlab.eu/)** · **[Documentation](https://docs.amvlab.eu/)**

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
- **Offline Operation**: Fully air-gapped deployments with a local [PMTiles](https://docs.protomaps.com/pmtiles/) basemap and navdata overlay
- **Multi-Node Simulation**: Spawn and manage multiple parallel simulation nodes from one interface
- **BlueSky Integration**: Seamless connection to BlueSky ATM simulator servers
- **Modern TypeScript Architecture**: Fully type-safe, maintainable client-side codebase

<img width="1200" height="658" alt="webatm_demo" src="https://github.com/user-attachments/assets/fa43352c-c463-4f8f-bc9d-03e01f82b4ac" />

## Editions

WebATM ships in two flavors, both open source and published to GHCR:

- **`webatm`** (standalone) — the web client only. Connects to a BlueSky server you run yourself, on the docker host or elsewhere on the network.
- **`webatm-integrated`** — bundles BlueSky inside the same container and adds in-app **Start / Stop / Restart / Kill** server controls plus a live server-log tab. See the [Integrated Build docs](https://docs.amvlab.eu/integrated-build/).

WebATM works best with the [amvlab fork of BlueSky](https://github.com/amvlab/bluesky), and is also compatible with the latest [BlueSky from TU Delft](https://github.com/TUDelft-CNS-ATM/bluesky).

## 🚀 WebATM Pro Version Available

**Looking for more advanced features?** WebATM Pro includes everything in the open source version, plus additional capabilities:

- **Custom Simulation Engine**: Built on amvlab's custom simulator, controllable end-to-end from the WebATM interface
- **Server Development Environment**: Modify and develop simulation server code directly from the web interface
- **Pro-Only Roadmap**: In-browser scenario editor, simulation rewind, and client-side command validation
- **Flexible Deployment**: amvlab can provide managed hosting or deploy on your local network for full data sovereignty

**[Visit amvlab.eu for Pro Version](https://amvlab.eu)**

## Quick Start

Run the prebuilt image from GHCR with Docker Compose:

```bash
wget https://raw.githubusercontent.com/amvlab/WebATM/main/docker-compose.yml
docker compose up -d
```

Then open http://localhost:8082. By default the container connects to a BlueSky server on the Docker host (`host.docker.internal`); to run the integrated variant instead, uncomment the `webatm-integrated` service in `docker-compose.yml` and `docker compose up -d webatm-integrated`.

All other installation paths — running from source, the prebuilt release tarballs (no Node.js needed), and building the images yourself — are covered in [Getting Started](https://docs.amvlab.eu/getting-started/).

## Documentation

Full documentation lives at **[docs.amvlab.eu](https://docs.amvlab.eu/)**:

- [Getting Started](https://docs.amvlab.eu/getting-started/) — Docker, from-source, and prebuilt-release installs
- [Configuration](https://docs.amvlab.eu/configuration/) — environment variables, network ports, production checklist
- [Offline Use (PMTiles)](https://docs.amvlab.eu/offline-pmtiles/) — air-gapped basemap and navdata overlay
- [Integrated Build](https://docs.amvlab.eu/integrated-build/) — the `webatm-integrated` variant, including building against your own BlueSky fork
- [Architecture](https://docs.amvlab.eu/architecture/) and [Development Workflow](https://docs.amvlab.eu/development/) — for contributors, plus generated [Python](https://docs.amvlab.eu/api/) and [TypeScript](https://docs.amvlab.eu/frontend/) API references

## License

Copyright (c) 2025 amvlab

This project is licensed under the GNU Affero General Public License v3.0 (AGPL-3.0). See [LICENSE](LICENSE) file for details.

## Acknowledgments

This software incorporates **[BlueSky - The Open Air Traffic Simulator](https://github.com/TUDelft-CNS-ATM/bluesky)** technology developed by TU Delft (Delft University of Technology). We acknowledge and thank TU Delft for their contribution to the open aviation simulation community.

The offline basemap is built from [Protomaps](https://protomaps.com/) planet builds distributed as [PMTiles](https://docs.protomaps.com/pmtiles/), derived from OpenStreetMap data (© OpenStreetMap contributors, [ODbL](https://www.openstreetmap.org/copyright)). The airport, runway, taxiway, and waypoint overlay is built from X-Plane navigation data (`apt.dat` and `earth_fix.dat`) released by [Laminar Research](https://www.x-plane.com/) under the GNU GPL, with airport importance ranking and IATA codes sourced from [OurAirports](https://ourairports.com/data/) (public domain).

## Support

For inquiries and support, please contact amvlab.
