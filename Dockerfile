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

# Set up virtual environment
ENV VIRTUAL_ENV="/home/webatm/.local/webatm-venv"
RUN uv venv $VIRTUAL_ENV
ENV PATH="$VIRTUAL_ENV/bin:$PATH"

# Install Python dependencies (production)
COPY --chown=webatm:webatm requirements.txt requirements-prod.txt ./
RUN uv pip install -r requirements-prod.txt

# Install Node.js for TypeScript build
USER root
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Copy entire WebATM directory and build TypeScript
USER webatm
WORKDIR /home/webatm
COPY --chown=webatm:webatm WebATM/ ./WebATM/

# Build TypeScript in place and clean up
WORKDIR /home/webatm/WebATM/static/ts
RUN npm ci && npm run build:production \
    && rm -rf node_modules src webpack.config.js tsconfig.json package*.json

# Return to home directory and copy application entry points
WORKDIR /home/webatm
COPY --chown=webatm:webatm WebATM.py ./
COPY --chown=webatm:webatm script/wsgi.py ./

# Expose web server port
EXPOSE 8082

# Switch to non-root user
USER webatm

# Set environment variables with defaults
ENV WEB_HOST=0.0.0.0 \
    WEB_PORT=8082 

# Add current directory to Python path so WebATM package can be found
ENV PYTHONPATH="/home/webatm"

# Start WebATM with gunicorn for production (eventlet worker for Socket.IO support)
CMD ["gunicorn", "--worker-class", "eventlet", "-w", "1", "--bind", "0.0.0.0:8082", "wsgi:app"]
