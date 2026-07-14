FROM debian:bookworm-slim

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    git \
    curl \
    ca-certificates \
    procps \
    fonts-dejavu-core \
    fonts-liberation \
    fontconfig \
    && rm -rf /var/lib/apt/lists/*

# Install uv for fast Python package management
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

# Create application user and set working directory
RUN useradd -m -s /bin/bash webatm
USER webatm
WORKDIR /home/webatm

# Project virtual environment. uv manages it from pyproject.toml + uv.lock and
# provisions the CPython interpreter required by `requires-python` automatically.
ENV VIRTUAL_ENV="/home/webatm/.local/webatm-venv"
ENV UV_PROJECT_ENVIRONMENT="$VIRTUAL_ENV"
ENV PATH="$VIRTUAL_ENV/bin:$PATH"

# Install locked production dependencies. Copying only the lock metadata first
# keeps this layer cached across source changes; --no-install-project skips
# building the app itself (it is run from PYTHONPATH below), --no-dev drops the
# dev tooling, and --extra prod pulls in gunicorn.
COPY --chown=webatm:webatm pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project --extra prod

# Install Node.js for TypeScript build
USER root
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Copy WebATM package and frontend sources, then build TypeScript
USER webatm
WORKDIR /home/webatm
COPY --chown=webatm:webatm WebATM/ ./WebATM/
COPY --chown=webatm:webatm frontend/ ./frontend/

# Build the frontend; output lands in WebATM/static/dist/. The frontend/
# directory is build-only — drop it after the build to keep the image lean.
WORKDIR /home/webatm/frontend
RUN npm ci && npm run build
WORKDIR /home/webatm
RUN rm -rf frontend
COPY --chown=webatm:webatm WebATM.py ./
COPY --chown=webatm:webatm script/wsgi.py ./

# Expose web server port
EXPOSE 8082

# Set environment variables with defaults
ENV WEB_HOST=0.0.0.0 \
    WEB_PORT=8082 \
    WEBATM_THREADS=4

# Add current directory to Python path so WebATM package can be found
ENV PYTHONPATH="/home/webatm"

# Start WebATM with gunicorn using a THREADED worker: SocketIO runs in
# async_mode="threading" (WebSocket via simple-websocket), and gunicorn 26+
# removed the eventlet worker. --threads is read from WEBATM_THREADS so the
# concurrency cap can be raised at `docker run` time (-e WEBATM_THREADS=16)
# without overriding this whole CMD. Shell form so WEB_HOST / WEB_PORT /
# WEBATM_THREADS env vars are honored; exec replaces the shell so gunicorn
# stays PID 1 and receives signals directly.
CMD ["sh", "-c", "exec gunicorn --worker-class gthread --threads ${WEBATM_THREADS:-4} -w 1 --bind ${WEB_HOST:-0.0.0.0}:${WEB_PORT:-8082} wsgi:app"]
