#!/bin/bash
# First-time setup on Linux. Installs Node.js, or updates it to the newest patched release, then the packages.
# Run it again any time to pick up Node.js security releases.
cd "$(dirname "$0")/../app" || exit 1

# Sets cur (empty when Node.js is missing), want and rc from scripts/node-check.mjs.
check_node() {
  cur=""; want="lts"; rc=1
  command -v node >/dev/null 2>&1 || return 0
  cur=$(node -p "process.version")
  want=$(node scripts/node-check.mjs); rc=$?
  [ -n "$want" ] || want="lts"
}

# The official build from nodejs.org, checked against its SHA256 list and unpacked
# into /usr/local. Distribution packages often lag months behind security releases.
install_tarball() {
  local v="$1" arch
  case "$(uname -m)" in
    x86_64) arch=x64 ;;
    aarch64|arm64) arch=arm64 ;;
    armv7l) arch=armv7l ;;
    *) echo "No official Node.js build for $(uname -m)."; return 1 ;;
  esac
  if [ "$v" = "lts" ]; then
    v=$(curl -fsSL https://nodejs.org/dist/index.json | grep '"version"' | grep -v '"lts":false' | head -1 | sed 's/.*"version":"\([^"]*\)".*/\1/')
    [ -n "$v" ] || return 1
  fi
  local tar="node-$v-linux-$arch.tar.gz" tmp sum
  tmp=$(mktemp -d) || return 1
  echo "Downloading $tar..."
  curl -fsSL -o "$tmp/$tar" "https://nodejs.org/dist/$v/$tar" || { rm -rf "$tmp"; return 1; }
  sum=$(curl -fsSL "https://nodejs.org/dist/$v/SHASUMS256.txt" | grep " $tar\$" | cut -d' ' -f1)
  if [ -z "$sum" ] || [ "$(sha256sum "$tmp/$tar" | cut -d' ' -f1)" != "$sum" ]; then
    echo "The SHA256 of $tar does not match nodejs.org."
    rm -rf "$tmp"
    return 1
  fi
  echo "Installing Node.js $v into /usr/local. It may ask for your password."
  sudo tar -xzf "$tmp/$tar" -C /usr/local --strip-components=1 \
    --exclude='*/CHANGELOG.md' --exclude='*/README.md' --exclude='*/LICENSE' || { rm -rf "$tmp"; return 1; }
  rm -rf "$tmp"
  export PATH="/usr/local/bin:$PATH"
  hash -r
}

command -v curl >/dev/null 2>&1 || { echo "curl is missing. Install it with your package manager and run setup.sh again."; exit 1; }

check_node
if [ "$rc" -eq 2 ]; then
  echo "Could not reach nodejs.org to look for Node.js security releases."
  [ "$(node -p "process.versions.node.split('.')[0]")" -ge 18 ] || { echo "Node.js $cur is too old. Connect to the internet and run setup.sh again."; exit 1; }
  echo "Going on with Node.js $cur. Run setup.sh again when you are online."
elif [ "$rc" -ne 0 ]; then
  if [ -z "$cur" ]; then echo "Node.js is not installed."; else echo "Node.js $cur is out of date, $want has the latest security fixes."; fi
  # nvm comes first in PATH, so a system install would not be used.
  case "$(command -v node)" in */.nvm/*) echo "This Node.js comes from nvm. Run: nvm install ${want/lts/--lts} && nvm alias default node, then run setup.sh again."; exit 1 ;; esac
  install_tarball "$want" || { echo "The Node.js install did not finish. Install it from https://nodejs.org and run setup.sh again."; exit 1; }
  check_node
  if [ "$rc" -eq 1 ]; then
    echo "Node.js is installed in /usr/local/bin, but this shell still finds $cur at $(command -v node). Remove that copy or put /usr/local/bin first in PATH, then run setup.sh again."
    exit 1
  fi
fi
[ "$rc" -eq 0 ] && echo "Node.js $cur is up to date."

echo "Installing packages..."
npm install --no-audit --no-fund || { echo "The package install failed. Check your internet connection and run setup.sh again."; exit 1; }
npm run check || { echo "The code did not pass its check. Download the project again and run setup.sh."; exit 1; }

echo
echo "Setup is done. Run start.sh to start the server and open the panel."
