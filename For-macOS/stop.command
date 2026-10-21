#!/bin/bash
# Stops the server started by start.command.
pids=$(lsof -nP -tiTCP:8867 -sTCP:LISTEN 2>/dev/null)
if [ -z "$pids" ]; then
  echo "The server is not running."
else
  kill $pids && echo "The server is stopped."
fi
