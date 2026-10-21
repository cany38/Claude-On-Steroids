#!/bin/bash
# First-time setup on a Mac. Installs Node.js when it is missing or too old, then the packages.
cd "$(dirname "$0")/../app" || exit 1

major=0
if command -v node >/dev/null 2>&1; then major=$(node -p "process.versions.node.split('.')[0]"); fi
if [ "$major" -lt 18 ]; then
  if [ "$major" -eq 0 ]; then echo "Node.js is not installed."; else echo "Node.js $major is too old, version 18 or newer is needed."; fi
  if command -v brew >/dev/null 2>&1; then
    echo "Installing Node.js with Homebrew..."
    brew install node || { echo "The Node.js install did not finish. Install it from https://nodejs.org and run setup.command again."; read -r -p "Press Enter to close."; exit 1; }
  else
    echo "Install Node.js LTS from https://nodejs.org and run setup.command again."
    read -r -p "Press Enter to close."
    exit 1
  fi
fi

echo "Installing packages..."
npm install --no-audit --no-fund || { echo "The package install failed. Check your internet connection and run setup.command again."; read -r -p "Press Enter to close."; exit 1; }
npm run check || { echo "The code did not pass its check. Download the project again and run setup.command."; read -r -p "Press Enter to close."; exit 1; }

echo
echo "Setup is done. Run start.command to start the server and open the panel."
read -r -p "Press Enter to close."
