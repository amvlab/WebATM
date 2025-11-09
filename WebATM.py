#!/usr/bin/env python
"""
Main BlueSky Web Application start script.

This web application provides a browser-based interface for BlueSky - The Open Air Traffic
Simulator developed by TU Delft (Delft University of Technology).
"""

import sys


def main():
    """Start the BlueSky web client."""
    from WebATM.main import start_WebATM

    start_WebATM()


if __name__ == "__main__":
    sys.exit(main())
