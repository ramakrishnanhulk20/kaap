#!/bin/sh
# Starts the watcher in its container. A hosting platform creates the disk empty and lets a file be
# put on it only while the service is running, so on a first deploy the key file is not there yet:
# this waits for it, saying so, and starts the watcher the moment it appears. The key never comes
# from an environment variable or the image.
set -eu

key="${KAAP_WORKER_CREDENTIALS_FILE:-}"
if [ -z "$key" ]; then
  echo '{"level":"error","event":"boot_failed","message":"KAAP_WORKER_CREDENTIALS_FILE is not set"}'
  exit 1
fi

waited=0
while [ ! -s "$key" ]; do
  if [ $((waited % 30)) -eq 0 ]; then
    echo "{\"level\":\"warn\",\"event\":\"waiting_for_key_file\",\"path\":\"$key\",\"waited_s\":$waited}"
  fi
  sleep 5
  waited=$((waited + 5))
done

chmod 600 "$key" 2>/dev/null || true
exec node packages/worker/src/main.ts
