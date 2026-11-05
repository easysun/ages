#!/bin/sh
# Intentionally local-only: never attach the cloud preview/production bindings.
set -eu
cd /app
umask 077

node <<'NODE'
const { writeFileSync } = require("node:fs");

const variables = {
  APP_ORIGIN: "http://127.0.0.1:8787",
  TRACKING_ORIGIN: "http://localhost:8798",
  ROBOTS_NOINDEX: "true",
};
for (const name of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]) {
  if (process.env[name]) variables[name] = process.env[name];
}
writeFileSync(
  ".dev.vars",
  Object.entries(variables).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join("\n") + "\n",
  { mode: 0o600 },
);
NODE

STATE_DIR="${AGES_LOCAL_DATA_DIR:-/data}"
mkdir -p "$STATE_DIR"

# Apply forward-only migrations against the *local* SQLite emulator only.
./node_modules/.bin/wrangler d1 migrations apply DB --env "" --local --persist-to "$STATE_DIR"

exec ./node_modules/.bin/wrangler dev --env "" --local \
  --ip 0.0.0.0 --port 8787 --persist-to "$STATE_DIR"
