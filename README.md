# WebATM ![License](https://img.shields.io/badge/license-AGPL--3.0-blue) ![Python](https://img.shields.io/badge/python-3.13%2B-blue) ![TypeScript](https://img.shields.io/badge/typescript-5.9%2B-blue)

A modern web client for the [BlueSky Air Traffic Management (ATM) simulator](https://github.com/TUDelft-CNS-ATM/bluesky). WebATM provides a standalone web interface with interactive aircraft visualization to control air traffic management simulations from the Web.

<img width="1909" height="1048" alt="image" src="https://github.com/user-attachments/assets/15401992-a349-4a40-8088-229966c94717" />

**[Try WebATM Demo](https://webatm.amvlab.eu/)** · **[Documentation](https://docs.amvlab.eu/)**

## Features

- **Interactive map** — Web Mercator or 3D globe view powered by [MapLibre GL](https://maplibre.org/maplibre-gl-js/docs/), with custom tile sources and fully offline (air-gapped) operation from a local [PMTiles](https://docs.protomaps.com/pmtiles/) basemap and navdata overlay
- **Rich aircraft display** — click-to-fly and follow modes, configurable labels/trails/routes/shapes, multiple 2D icon styles, and bundled 3D aircraft models (A320, A350, A380, B737, B787, EVTOL, and drone) from amvlab's open-source [aircraft-models](https://github.com/amvlab/aircraft-models) collection
- **Powerful command console** — tab completion and autosuggestion for BlueSky commands, a searchable command palette, and picking coordinates straight from the map
- **Scenario management** — upload, organize, and run BlueSky scenario (`.scn`) files and folders from the browser
- **Simulation control** — multi-node simulations and seamless connection to BlueSky servers, all from a fully type-safe TypeScript client

See the [full feature overview](https://docs.amvlab.eu/) in the documentation.

<img width="1200" height="658" alt="webatm_demo" src="https://github.com/user-attachments/assets/fa43352c-c463-4f8f-bc9d-03e01f82b4ac" />

## Editions

WebATM ships in two flavors, both open source and published to GHCR:

- **`webatm`** (standalone) — the web client only. Connects to a BlueSky server you run yourself, on the docker host or elsewhere on the network.
- **`webatm-integrated`** — bundles BlueSky inside the same container and adds in-app **Start / Stop / Restart / Kill** server controls plus a live server-log tab. See the [Integrated Build docs](https://docs.amvlab.eu/integrated-build/).

WebATM works best with the [amvlab fork of BlueSky](https://github.com/amvlab/bluesky), and is also compatible with the latest [BlueSky from TU Delft](https://github.com/TUDelft-CNS-ATM/bluesky).

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

Copyright (c) 2025–2026 [amvlab](https://amvlab.eu)

This project is licensed under the GNU Affero General Public License v3.0 (AGPL-3.0). See [LICENSE](LICENSE) file for details.

## Acknowledgments

This software incorporates **[BlueSky - The Open Air Traffic Simulator](https://github.com/TUDelft-CNS-ATM/bluesky)** technology developed by TU Delft (Delft University of Technology). We acknowledge and thank TU Delft for their contribution to the open aviation simulation community.

The offline basemap is built from [Protomaps](https://protomaps.com/) planet builds distributed as [PMTiles](https://docs.protomaps.com/pmtiles/), derived from OpenStreetMap data (© OpenStreetMap contributors, [ODbL](https://www.openstreetmap.org/copyright)). The airport, runway, taxiway, and waypoint overlay is built from X-Plane navigation data (`apt.dat` and `earth_fix.dat`) released by [Laminar Research](https://www.x-plane.com/) under the GNU GPL, with airport importance ranking and IATA codes sourced from [OurAirports](https://ourairports.com/data/) (public domain).

## Support

For inquiries and support, please contact [amvlab](https://amvlab.eu).
