#!/bin/bash
# Starts the server and opens the panel. Press Ctrl+C or close the terminal to stop it.
cd "$(dirname "$0")/../app" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Run setup.sh first."
  exit 1
fi
if [ ! -d node_modules ]; then
  echo "Installing packages..."
  npm install --no-audit --no-fund || { echo "The package install failed. Run setup.sh."; exit 1; }
fi

node src/server.mjs
