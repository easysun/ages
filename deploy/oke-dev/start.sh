#!/bin/sh
# Intentionally local-only: never attach the cloud preview/production bindings.
set -eu
cd /app
umask 077

STATE_DIR="${AGES_LOCAL_DATA_DIR:-/data}"
mkdir -p "$STATE_DIR"
RUNTIME_DIR=$(mktemp -d "${TMPDIR:-/tmp}/ages-runtime.XXXXXX")
export WRANGLER_REGISTRY_PATH="$RUNTIME_DIR/registry"
export WRANGLER_LOG_PATH="$RUNTIME_DIR/logs"
node deploy/oke-dev/configure-runtime.mjs "$RUNTIME_DIR"

# Apply migrations and serve the same local SQLite, R2 and KV state.
./node_modules/.bin/wrangler d1 migrations apply DB --config "$RUNTIME_DIR/wrangler.json" \
  --env "" --local --persist-to "$STATE_DIR"

exec ./node_modules/.bin/wrangler dev --config "$RUNTIME_DIR/wrangler.json" --env "" --local \
  --ip 0.0.0.0 --port 8787 --log-level warn --persist-to "$STATE_DIR"
