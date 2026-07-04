# Getting Started

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Python | 3.13+ | managed with [uv](https://docs.astral.sh/uv/) |
| Node.js | 22+ | with npm, for the TypeScript frontend |
| Docker | 20.10+ | with Docker Compose 2.0+, for containerized deployment |
| BlueSky | 1.1.0+ | automatically managed by WebATM |

## Option 1: Local development

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

## Option 2: Docker deployment

1. **Build the Docker image**

    ```bash
    docker build -t webatm:latest .
    ```

2. **Start with Docker Compose**

    ```bash
    docker-compose up -d
    ```

3. **Open the web interface** at <http://localhost:8082>

4. **View logs**

    ```bash
    docker-compose logs -f webatm
    ```

!!! tip "Bundled BlueSky"
    The default build connects to an external BlueSky server (and can
    auto-start one on the same host). If you want a single container that
    ships the simulator itself — with Start/Stop/Restart controls and a live
    server log in the UI — see the [Integrated Build](integrated-build.md).

## Frontend development

The TypeScript sources live in `frontend/` and are bundled by webpack into
`WebATM/static/dist/`:

```bash
cd frontend/
npm install       # install dependencies
npm run build     # production build
npm run watch     # rebuild on change during development
```

## Running the tests

Python tests run with pytest through uv from a single entry point that covers
both the core `webatm` package (`tests/`) and the optional `webatm_integrated`
package (`WebATM-integrated/tests/`):

```bash
uv run pytest                # everything (core + integrated)
uv run pytest -m core        # core package only
uv run pytest -m integrated  # integrated package only
uv run pytest -m core --cov=WebATM --cov-report=term-missing  # with coverage
```

Frontend unit tests use Vitest and live next to the code they cover:

```bash
cd frontend/
npm test
```
