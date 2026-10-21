#!/bin/bash
# First-time setup on Linux. Installs Node.js when it is missing or too old, then the packages.
cd "$(dirname "$0")/../app" || exit 1

node_major() { command -v node >/dev/null 2>&1 && node -p "process.versions.node.split('.')[0]" || echo 0; }

if [ "$(node_major)" -lt 18 ]; then
  if [ "$(node_major)" -eq 0 ]; then echo "Node.js is not installed."; else echo "Node.js $(node_major) is too old, version 18 or newer is needed."; fi
  echo "Trying to install Node.js with your package manager. It may ask for your password."
  if command -v apt-get >/dev/null 2>&1; then sudo apt-get update && sudo apt-get install -y nodejs npm
  elif command -v dnf >/dev/null 2>&1; then sudo dnf install -y nodejs npm
  elif command -v pacman >/dev/null 2>&1; then sudo pacman -S --noconfirm nodejs npm
  elif command -v zypper >/dev/null 2>&1; then sudo zypper install -y nodejs npm
  fi
  if [ "$(node_major)" -lt 18 ]; then
    echo "Node.js 18 or newer is still missing. Install the LTS version from https://nodejs.org and run setup.sh again."
    exit 1
  fi
fi

echo "Installing packages..."
npm install --no-audit --no-fund || { echo "The package install failed. Check your internet connection and run setup.sh again."; exit 1; }
npm run check || { echo "The code did not pass its check. Download the project again and run setup.sh."; exit 1; }

echo
echo "Setup is done. Run start.sh to start the server and open the panel."
