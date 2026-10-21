#!/bin/bash
# Starts the server and opens the panel. Closing this window stops the server.
cd "$(dirname "$0")/../app" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Run setup.command first."
  read -r -p "Press Enter to close."
  exit 1
fi
if [ ! -d node_modules ]; then
  echo "Installing packages..."
  npm install --no-audit --no-fund || { echo "The package install failed. Run setup.command."; read -r -p "Press Enter to close."; exit 1; }
fi

node src/server.mjs
read -r -p "The server stopped. Press Enter to close."
