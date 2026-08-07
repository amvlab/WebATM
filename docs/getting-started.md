# Getting Started

The fastest way to run WebATM is with Docker — no Python or Node toolchain
needed. If you plan to modify the code, run it from source instead and see
the [Development Workflow](development.md).

## Option 1: Docker (recommended)

Requires Docker 20.10+ with Docker Compose 2.0+. The repository's
`docker-compose.yml` defines both build variants: the standalone `webatm`
service (enabled by default) and a commented-out `webatm-integrated` service
that bundles the BlueSky simulator in the same container. Both pull prebuilt
images from GHCR, so no local build is needed.

### Standalone (`webatm`)

Connects to a BlueSky server you run yourself (by default on the Docker
host, via `BLUESKY_SERVER_HOST=host.docker.internal`).

1. **Start with Docker Compose** (pulls `ghcr.io/amvlab/webatm:latest`)

    ```bash
    docker compose up -d webatm
    ```

2. **Open the web interface** at <http://localhost:8082>

3. **View logs**

    ```bash
    docker compose logs -f webatm
    ```

### Integrated (`webatm-integrated`)

A single container that ships the simulator itself, with
Start/Stop/Restart controls and a live server log in the UI — see the
[Integrated Build](integrated-build.md) for details.

1. **Enable the service**: uncomment the `webatm-integrated` service in
   `docker-compose.yml`. Both services default to host port 8082, so also
   comment out the standalone `webatm` service (or map one of them to a
   different host port to run both side by side).

2. **Start with Docker Compose** (pulls
   `ghcr.io/amvlab/webatm-integrated:latest`)

    ```bash
    docker compose up -d webatm-integrated
    ```

3. **Open the web interface** at <http://localhost:8082> — the server
   lifecycle controls are in **Settings**, and the server log has its own
   console tab.

4. **View logs**

    ```bash
    docker compose logs -f webatm-integrated
    ```

!!! tip "Building images locally"
    To run from source instead of the published GHCR images, build the
    image first and point the service's `image:` at it:

    ```bash
    docker build -t webatm:latest .                                        # standalone
    docker build -f Dockerfile.integrated -t webatm-integrated:latest .    # integrated
    ```

## Option 2: Running from source

| Requirement | Version | Notes |
|---|---|---|
| Python | 3.13+ | managed with [uv](https://docs.astral.sh/uv/) |
| Node.js | 22+ | with npm, for building the TypeScript frontend |
| BlueSky | 1.1.0+ | automatically managed by WebATM |

!!! note "BlueSky compatibility"
    WebATM works best with the
    [amvlab fork of BlueSky](https://github.com/amvlab/bluesky), and is also
    compatible with the latest
    [BlueSky from TU Delft](https://github.com/TUDelft-CNS-ATM/bluesky).

1. **Clone the repository**

    ```bash
    git clone https://github.com/amvlab/WebATM
    cd WebATM
    ```

2. **Install Python dependencies** (with [uv](https://docs.astral.sh/uv/))

    ```bash
    uv sync
    ```

    This creates a virtual environment and installs the runtime and
    development dependencies pinned in `uv.lock`. Prefix commands with
    `uv run` (e.g. `uv run python WebATM.py`) to use that environment, or
    activate it with `source .venv/bin/activate`.

3. **Build frontend assets**

    ```bash
    script/build_frontend.sh
    ```

4. **Start the application**

    ```bash
    script/run_webatm.sh
    ```

5. **Open the web interface** at <http://localhost:8082>

Everything beyond running the app — linting, type checking, the test
suites, rebuilding the frontend on change, and building this documentation
site — is covered in the [Development Workflow](development.md).

## Option 3: Prebuilt release (source, no Node.js)

Use this to run WebATM directly from source without installing Node.js or
building the frontend yourself. You still clone the repo for the Python
source, then drop in two tarballs that contain the runtime assets that
aren't checked into git: a small per-version code tarball and a larger
static-asset tarball that changes rarely.

1. **Clone the repository**

    ```bash
    git clone https://github.com/amvlab/WebATM
    cd WebATM
    ```

2. **Download and extract the prebuilt code tarball**

    Grab the latest `webatm-prebuilt-<version>.tar.gz` from the
    [Releases page](https://github.com/amvlab/WebATM/releases) and extract
    it from the repo root:

    ```bash
    tar -xzf ~/Downloads/webatm-prebuilt-<version>.tar.gz
    ```

    This lands:

    - `WebATM/static/dist/` — prebuilt webpack bundles
    - `WebATM/static/vendor/` — third-party CSS/fonts (FontAwesome, MapLibre)

3. **Download and extract the static-asset tarball**

    Grab the assets tarball pinned by the repo's `.assets-version` file
    (e.g. `webatm-assets-v1.tar.gz`) from the
    [Releases page](https://github.com/amvlab/WebATM/releases) and extract
    it from the repo root:

    ```bash
    tar -xzf ~/Downloads/webatm-assets-<tag>.tar.gz
    ```

    This lands:

    - `WebATM/static/tiles/` — offline basemap (`world.pmtiles`) and
      navigation overlay (`navdata.pmtiles`)
    - `WebATM/static/glyphs/` — map fonts
    - `WebATM/static/navdata/` — navigation database

    This bundle changes rarely (only when tiles, fonts, or navdata roll),
    so a single download usually carries across many code releases.

4. **Install Python dependencies and start**

    ```bash
    uv sync
    uv run script/run_webatm.sh
    ```

5. **Open the web interface** at <http://localhost:8082>

6. **(Optional) Enable the offline basemap**

    The assets tarball already includes `WebATM/static/tiles/world.pmtiles`.
    To use it, open **Settings → Map Display Configuration → Offline (Local
    PMTiles)** in the web UI — see [Offline Use (PMTiles)](offline-pmtiles.md).
