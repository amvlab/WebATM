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
