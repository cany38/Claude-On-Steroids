#!/bin/bash
# First-time setup on a Mac. Installs Node.js, or updates it to the newest patched release, then the packages.
# Run it again any time to pick up Node.js security releases.
cd "$(dirname "$0")/../app" || exit 1

fail() { echo "$1"; read -r -p "Press Enter to close."; exit 1; }

# Sets cur (empty when Node.js is missing), want and rc from scripts/node-check.mjs.
check_node() {
  cur=""; want="lts"; rc=1
  command -v node >/dev/null 2>&1 || return 0
  cur=$(node -p "process.version")
  want=$(node scripts/node-check.mjs); rc=$?
  [ -n "$want" ] || want="lts"
}

# The official installer from nodejs.org, checked against its SHA256 list.
install_pkg() {
  local v="$1"
  if [ "$v" = "lts" ]; then
    v=$(curl -fsSL https://nodejs.org/dist/index.json | grep '"version"' | grep -v '"lts":false' | head -1 | sed 's/.*"version":"\([^"]*\)".*/\1/')
    [ -n "$v" ] || return 1
  fi
  local pkg="node-$v.pkg" tmp
  tmp=$(mktemp -d) || return 1
  echo "Downloading $pkg..."
  curl -fsSL -o "$tmp/$pkg" "https://nodejs.org/dist/$v/$pkg" || return 1
  local sum
  sum=$(curl -fsSL "https://nodejs.org/dist/$v/SHASUMS256.txt" | grep " $pkg\$" | cut -d' ' -f1)
  if [ -z "$sum" ] || [ "$(shasum -a 256 "$tmp/$pkg" | cut -d' ' -f1)" != "$sum" ]; then
    echo "The SHA256 of $pkg does not match nodejs.org."
    rm -rf "$tmp"
    return 1
  fi
  echo "Installing Node.js $v. macOS asks for your password."
  sudo installer -pkg "$tmp/$pkg" -target / || { rm -rf "$tmp"; return 1; }
  rm -rf "$tmp"
  export PATH="/usr/local/bin:$PATH"
  hash -r
}

check_node
if [ "$rc" -eq 2 ]; then
  echo "Could not reach nodejs.org to look for Node.js security releases."
  [ "$(node -p "process.versions.node.split('.')[0]")" -ge 18 ] || fail "Node.js $cur is too old. Connect to the internet and run setup.command again."
  echo "Going on with Node.js $cur. Run setup.command again when you are online."
elif [ "$rc" -ne 0 ]; then
  if [ -z "$cur" ]; then echo "Node.js is not installed."; else echo "Node.js $cur is out of date, $want has the latest security fixes."; fi
  # nvm comes first in PATH, so a system install would not be used.
  case "$(command -v node)" in */.nvm/*) fail "This Node.js comes from nvm. Run: nvm install ${want/lts/--lts} && nvm alias default node, then run setup.command again." ;; esac
  # Homebrew keeps its own copy, so update that one when it is the Node.js in use.
  if command -v brew >/dev/null 2>&1 && { [ -z "$cur" ] || brew list node >/dev/null 2>&1; }; then
    echo "Updating Node.js with Homebrew..."
    brew update >/dev/null && { brew upgrade node 2>/dev/null || brew install node; }
    hash -r
    check_node
    [ "$rc" -eq 1 ] && echo "Homebrew does not have $want yet. Run setup.command again later, or remove Homebrew's node and run it again for the nodejs.org installer."
  else
    install_pkg "$want" || fail "The Node.js install did not finish. Install it from https://nodejs.org and run setup.command again."
    check_node
    [ "$rc" -eq 1 ] && fail "Node.js is installed, but this window still sees $cur. Close it and run setup.command again."
  fi
  [ -n "$cur" ] || fail "Node.js is still missing. Install it from https://nodejs.org and run setup.command again."
fi
[ "$rc" -eq 0 ] && echo "Node.js $cur is up to date."

echo "Installing packages..."
npm install --no-audit --no-fund || fail "The package install failed. Check your internet connection and run setup.command again."
npm run check || fail "The code did not pass its check. Download the project again and run setup.command."

echo
echo "Setup is done. Run start.command to start the server and open the panel."
read -r -p "Press Enter to close."
