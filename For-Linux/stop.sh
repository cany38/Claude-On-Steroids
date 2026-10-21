#!/bin/bash
# Stops the server started by start.sh.
port_pids() {
  if command -v lsof >/dev/null 2>&1; then lsof -nP -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null
  elif command -v ss >/dev/null 2>&1; then ss -ltnpH "sport = :$1" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u
  elif command -v fuser >/dev/null 2>&1; then fuser "$1/tcp" 2>/dev/null
  fi
}

pids=$(port_pids 8867)
if [ -z "$pids" ]; then
  echo "The server is not running."
else
  kill $pids && echo "The server is stopped."
fi
