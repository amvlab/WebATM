#!/bin/bash
set -e

# Image/Dockerfile selected by the --integrated flag (see argument parsing).
IMAGE_NAME="webatm"
DOCKERFILE="Dockerfile"
INTEGRATED=0

# Function to display help
show_help() {
    echo "Usage: $0 [OPTIONS]"
    echo "Build the WebATM Docker image locally"
    echo ""
    echo "Options:"
    echo "  --integrated, -i  Build the integrated variant: bundles BlueSky so the"
    echo "                    container runs 'bluesky --headless' itself, and adds the"
    echo "                    server controls + live 'Server Log' tab. Uses"
    echo "                    Dockerfile.integrated, tags 'webatm-integrated', and runs"
    echo "                    the container directly (not docker compose)."
    echo "  --help, -h        Show this help message"
    echo ""
    echo "Examples:"
    echo "  $0                # Build the default image and start docker compose"
    echo "  $0 --integrated   # Build and run the integrated image"
}


# Function to cleanup existing containers and images for the selected image
cleanup_existing() {
    echo "Checking for existing $IMAGE_NAME containers and images..."

    # Stop and remove any running containers using the selected image
    RUNNING_CONTAINERS=$(docker ps -q --filter "ancestor=$IMAGE_NAME")
    if [ -n "$RUNNING_CONTAINERS" ]; then
        echo "Stopping running $IMAGE_NAME containers..."
        docker stop $RUNNING_CONTAINERS
        echo "Removing stopped $IMAGE_NAME containers..."
        docker rm $RUNNING_CONTAINERS
    else
        echo "No running $IMAGE_NAME containers found."
    fi

    # Remove any stopped containers that used the selected image
    STOPPED_CONTAINERS=$(docker ps -a -q --filter "ancestor=$IMAGE_NAME")
    if [ -n "$STOPPED_CONTAINERS" ]; then
        echo "Removing stopped $IMAGE_NAME containers..."
        docker rm $STOPPED_CONTAINERS
    fi

    # Remove existing images for the selected name. For the standalone build we
    # also clean up the GHCR-namespaced tag, since docker-compose.yml references
    # it and we want the local build to be picked up instead of the published one.
    if [ "$INTEGRATED" -eq 1 ]; then
        EXISTING_IMAGES=$(docker images -q "$IMAGE_NAME")
    else
        EXISTING_IMAGES=$(docker images -q "$IMAGE_NAME" ghcr.io/amvlab/webatm | sort -u)
    fi
    if [ -n "$EXISTING_IMAGES" ]; then
        echo "Removing existing $IMAGE_NAME images..."
        docker rmi $EXISTING_IMAGES -f
    else
        echo "No existing $IMAGE_NAME images found."
    fi

    echo "Cleanup completed."
}

# Function to build Docker image locally
build_image() {
    echo "Building Docker image '$IMAGE_NAME' from $DOCKERFILE..."

    # Get the script directory and project root
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

    echo "Building from project root: $PROJECT_ROOT"
    cd "$PROJECT_ROOT"

    # Cleanup existing containers and images
    cleanup_existing

    if [ "$INTEGRATED" -eq 1 ]; then
        docker buildx build -f "$DOCKERFILE" -t "$IMAGE_NAME" . --no-cache --load

        # The default docker-compose.yml targets the pure-client image (it
        # connects to a BlueSky server on the host). The integrated image runs
        # BlueSky inside the container, so run it directly instead.
        echo "Starting integrated container (BlueSky runs inside the container)..."
        docker rm -f "$IMAGE_NAME" >/dev/null 2>&1 || true
        docker run -d --name "$IMAGE_NAME" -p 8082:8082 "$IMAGE_NAME"
        echo "WebATM (integrated) is starting on http://localhost:8082"
        echo "Open the 'Server Log' tab and click Start to launch bluesky --headless."
    else
        # Tag with both the short name and the GHCR name so docker-compose.yml
        # (which references ghcr.io/amvlab/webatm:latest) picks up the local build
        # instead of pulling the published image.
        docker buildx build -f "$DOCKERFILE" \
            -t "$IMAGE_NAME:latest" \
            -t ghcr.io/amvlab/webatm:latest \
            . --no-cache --load

        echo "Starting local services with docker compose..."
        docker compose up -d
    fi
}


# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --integrated|-i)
            INTEGRATED=1
            IMAGE_NAME="webatm-integrated"
            DOCKERFILE="Dockerfile.integrated"
            shift
            ;;
        --help|-h)
            show_help
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            show_help
            exit 1
            ;;
    esac
done

# Execute build
echo "Starting local build process..."
build_image
echo "Local build completed successfully!"
