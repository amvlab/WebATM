#!/bin/bash
set -e

# Function to display help
show_help() {
    echo "Usage: $0 [OPTIONS]"
    echo "Build WebATM Docker image locally"
    echo ""
    echo "Options:"
    echo "  --help, -h        Show this help message"
    echo ""
    echo "Examples:"
    echo "  $0                # Build image locally"
}


# Function to cleanup existing containers and images
cleanup_existing() {
    echo "Checking for existing WebATM containers and images..."
    
    # Stop and remove any running containers using the webatm image
    RUNNING_CONTAINERS=$(docker ps -q --filter ancestor=webatm)
    if [ ! -z "$RUNNING_CONTAINERS" ]; then
        echo "Stopping running WebATM containers..."
        docker stop $RUNNING_CONTAINERS
        echo "Removing stopped WebATM containers..."
        docker rm $RUNNING_CONTAINERS
    else
        echo "No running WebATM containers found."
    fi
    
    # Remove any stopped containers that used the webatm image
    STOPPED_CONTAINERS=$(docker ps -a -q --filter ancestor=webatm)
    if [ ! -z "$STOPPED_CONTAINERS" ]; then
        echo "Removing stopped WebATM containers..."
        docker rm $STOPPED_CONTAINERS
    fi
    
    # Remove existing webatm images
    EXISTING_IMAGES=$(docker images -q webatm)
    if [ ! -z "$EXISTING_IMAGES" ]; then
        echo "Removing existing WebATM images..."
        docker rmi $EXISTING_IMAGES -f
    else
        echo "No existing WebATM images found."
    fi
    
    echo "Cleanup completed."
}

# Function to build Docker image locally
build_image() {
    echo "Building Docker image..."
    
    # Get the script directory and project root
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
    
    echo "Building from project root: $PROJECT_ROOT"
    cd "$PROJECT_ROOT"
    
    # Cleanup existing containers and images
    cleanup_existing

    docker buildx build -f Dockerfile -t webatm . --no-cache --load
    
    echo "Starting local services with docker compose..."
    docker compose up -d
}


# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
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
