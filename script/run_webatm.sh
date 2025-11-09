#!/bin/bash

# WebATM Startup Script
# This script starts the WebATM web server

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Get the project root directory (one level up from script/)
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Change to the project root directory
cd "$PROJECT_ROOT"

echo "Starting WebATM from: $PROJECT_ROOT"
echo "Running: python WebATM.py"

# Run the WebATM application
python WebATM.py