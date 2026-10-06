import { execFileSync, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const port = process.env.AGES_E2E_PORT ?? "8797";
const cli = resolve("node_modules/wrangler/bin/wrangler.js");
const persistence = resolve(".wrangler/e2e");
mkdirSync(persistence, { recursive: true });
execFileSync(
  process.execPath,
  [
    cli,
    "d1",
    "migrations",
    "apply",
    "DB",
    "--local",
    "--env",
    "",
    "--persist-to",
    persistence,
  ],
  { stdio: "inherit" },
);
const appServer = spawn(
  process.execPath,
  [
    cli,
    "dev",
    "--local",
    "--env",
    "",
    "--ip",
    "127.0.0.1",
    "--port",
    port,
    "--persist-to",
    persistence,
    "--var",
    `APP_ORIGIN:http://127.0.0.1:${port}`,
    "--var",
    "TRACKING_ORIGIN:http://localhost:8798",
    "--var",
    `R2_ACCOUNT_ID:${"a".repeat(32)}`,
    "--var",
    "R2_BUCKET_NAME:ages-media-local",
    "--var",
    "R2_ACCESS_KEY_ID:synthetic-browser-id",
    "--var",
    "R2_SECRET_ACCESS_KEY:synthetic-browser-secret",
  ],
  { stdio: "inherit" },
);
const servers = [appServer];
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    stopping = true;
    for (const server of servers) server.kill(signal);
  });

function watchServer(server) {
  server.on("exit", (code) => {
    if (stopping) return;
    stopping = true;
    for (const child of servers) {
      if (child !== server) child.kill("SIGTERM");
    }
    process.exit(code ?? 1);
  });
}

async function waitFor(url, isReady, server, label) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (server.exitCode !== null || server.signalCode !== null)
      throw new Error(`${label} Worker exited before becoming ready.`);
    try {
      const response = await fetch(url);
      if (isReady(response)) return;
    } catch {
      // Wrangler is still binding its local address.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(`${label} Worker did not become ready in time.`);
}

watchServer(appServer);
await waitFor(
  `http://127.0.0.1:${port}/health`,
  (response) => response.ok,
  appServer,
  "App",
);

const trackingServer = spawn(
  process.execPath,
  [
    cli,
    "dev",
    "--config",
    "wrangler.tracking.jsonc",
    "--local",
    "--ip",
    "127.0.0.1",
    "--port",
    "8798",
    "--persist-to",
    persistence,
    "--var",
    `APP_ORIGIN:http://127.0.0.1:${port}`,
    "--var",
    "TRACKING_ORIGIN:http://localhost:8798",
  ],
  { stdio: "inherit" },
);
servers.push(trackingServer);
watchServer(trackingServer);
await waitFor(
  "http://localhost:8798/not-found",
  (response) => response.status === 404,
  trackingServer,
  "Tracking",
);
