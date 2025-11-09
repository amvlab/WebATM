# WebATM ![License](https://img.shields.io/badge/license-AGPL--3.0-blue) ![Python](https://img.shields.io/badge/python-3.13%2B-blue) ![TypeScript](https://img.shields.io/badge/typescript-5.9%2B-blue)

A modern web client for the [BlueSky Air Traffic Management (ATM) simulator](https://github.com/TUDelft-CNS-ATM/bluesky). WebATM provides a standalone web interface with interactive aircraft visualization to control air traffic management simulations from the Web.

<img width="1916" height="1079" alt="webatm" src="https://github.com/user-attachments/assets/046fe846-c1f1-4c59-a0fc-ba5ba9abc1ba" />

**[Try WebATM Demo](https://webatm.amvlab.eu/)** 

## Features

- **Interactive Map Visualisation**: Standard Web Mercator and globe view with aircraft tracking using MapLibre GL
- **Customizable Map Sources**: Support for custom tile sources to customize the base map layer
- **BlueSky Integration**: Seamless connection to BlueSky ATM simulator servers
- **TypeScript Architecture**: Modern, type-safe client-side application

## 🚀 WebATM Pro Version Available

**Looking for advanced features?** WebATM Pro includes additional capabilities not available in this open source version:

- **Server Development Environment**: Modify and develop BlueSky server code directly from the web interface
- **3D Visualisation**: Advanced 3D aircraft and terrain visualization
- **Enhanced Server Management**: Full control over BlueSky server lifecycle (stat/stop/restart)
- **Multi-Server Support**: Connect and manage multiple BlueSky simulation servers
- **Flexible Deployment**: amvlab can provide managed hosting or deploy on your local network for full data sovereignty

**[Visit amvlab.eu for Pro Version](https://amvlab.eu)**

## Prerequisites

### For Local Development
- Python 3.13 or higher
- Node.js 22+ and npm (for TypeScript development)
- [BlueSky ATM simulator](https://github.com/TUDelft-CNS-ATM/bluesky) version 1.1.0 or higher (automatically managed by WebATM)


## Quick Start

### Option 1: Local Development

1. **Clone the repository**
   ```bash
   git clone https://github.com/amvlab/WebATM
   cd WebATM
   ```

2. **Install Python dependencies**
   ```bash
   pip install -r requirements.txt
   ```

3. **Build TypeScript assets**
   ```bash
   script/build_ts.sh
   ```

4. **Start the application**
   ```bash
   script/run_webatm.sh
   ```

5. **Access the web interface**

   Open your browser to: http://localhost:8082

### Option 2: Docker Deployment

1. **Build the Docker image**
   ```bash
   docker build -t webatm:latest .
   ```

2. **Start with Docker Compose**
   ```bash
   docker-compose up -d
   ```

3. **Access the web interface**

   Open your browser to: http://localhost:8082

4. **View logs**
   ```bash
   docker-compose logs -f webatm
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
cd WebATM/static/ts/
npm run type-check
```

## License

Copyright (c) 2025 amvlab

This project is licensed under the GNU Affero General Public License v3.0 (AGPL-3.0). See [LICENSE](LICENSE) file for details.

## Acknowledgments

This software incorporates **BlueSky - The Open Air Traffic Simulator** technology developed by TU Delft (Delft University of Technology). We acknowledge and thank TU Delft for their contribution to the open aviation simulation community.

## Support

For inquiries and support, please contact amvlab.
