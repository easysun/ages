import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const appPort = readPort("AGES_E2E_PORT", "8797");
const trackingPort = readPort("AGES_E2E_TRACKING_PORT", "8798");
if (appPort === trackingPort)
  throw new Error("AGES_E2E_PORT and AGES_E2E_TRACKING_PORT must differ.");

const appOrigin = `http://127.0.0.1:${appPort}`;
const trackingOrigin = `http://localhost:${trackingPort}`;
const cli = resolve(root, "node_modules/wrangler/bin/wrangler.js");
const persistence = resolve(root, ".wrangler/e2e");
const configDirectory = resolve(root, ".wrangler/e2e-runtime");
const appConfigPath = resolve(root, "wrangler.jsonc");
const trackingConfigPath = resolve(root, "wrangler.tracking.jsonc");
const gatewaySource = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "gateway.mjs",
);
mkdirSync(persistence, { recursive: true });
mkdirSync(configDirectory, { recursive: true });

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
  { cwd: root, stdio: "inherit" },
);

const appConfig = makeWorkerOverlay(appConfigPath, "app");
const trackingConfig = makeWorkerOverlay(trackingConfigPath, "tracking");
const gatewayConfig = resolve(configDirectory, "gateway.jsonc");
writeFileSync(
  gatewayConfig,
  JSON.stringify(
    {
      $schema: resolve(root, "node_modules/wrangler/config-schema.json"),
      name: "ages-e2e-gateway",
      main: gatewaySource,
      compatibility_date: "2026-10-01",
      compatibility_flags: ["nodejs_compat"],
      workers_dev: false,
      preview_urls: false,
      send_metrics: false,
      vars: { APP_ORIGIN: appOrigin, TRACKING_ORIGIN: trackingOrigin },
      services: [
        { binding: "APP", service: "ages-local" },
        { binding: "TRACKING", service: "ages-tracking-local" },
      ],
    },
    null,
    2,
  ),
);

const internalPort = await getAvailablePort(new Set([appPort, trackingPort]));
const worker = spawn(
  process.execPath,
  [
    cli,
    "dev",
    "--config",
    gatewayConfig,
    "--config",
    appConfig,
    "--config",
    trackingConfig,
    "--local",
    "--env",
    "",
    "--ip",
    "127.0.0.1",
    "--port",
    String(internalPort),
    "--persist-to",
    persistence,
  ],
  { cwd: root, stdio: "inherit" },
);

const servers = [];
let stopping = false;
let childExit;
const workerExited = new Promise((resolveExit) => {
  worker.once("close", (code, signal) => {
    childExit = { code, signal };
    if (!stopping) {
      stopping = true;
      closeServers();
      console.error(`The shared Wrangler runtime exited (${signal ?? code}).`);
      process.exitCode = code ?? 1;
    }
    resolveExit(childExit);
  });
  worker.once("error", (error) => {
    console.error(
      `Could not start the shared Wrangler runtime: ${error.message}`,
    );
  });
});

function closeServers() {
  for (const server of servers) {
    if (!server.listening) continue;
    server.close();
    server.closeAllConnections?.();
  }
}

function stop(signal) {
  if (stopping) return;
  stopping = true;
  closeServers();
  if (worker.pid && worker.exitCode === null && worker.signalCode === null)
    worker.kill(signal);
}

for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => stop(signal));

try {
  await waitForApp();
  await listenProxy("app", appPort);
  await listenProxy("tracking", trackingPort);
  console.log(`App origin: ${appOrigin}`);
  console.log(`Tracking origin: ${trackingOrigin}`);
  await workerExited;
} catch (failure) {
  stop("SIGTERM");
  if (worker.pid && worker.exitCode === null && worker.signalCode === null)
    await workerExited;
  throw failure;
}

function readPort(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > 65535)
    throw new Error(`${name} must be an integer between 1 and 65535.`);
  return value;
}

function makeWorkerOverlay(configPath, worker) {
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const originalDirectory = dirname(configPath);
  resolveConfigPaths(config, originalDirectory);
  if (config.$schema)
    config.$schema = resolve(originalDirectory, config.$schema);
  config.workers_dev = false;
  config.preview_urls = false;
  config.send_metrics = false;
  config.vars = {
    ...config.vars,
    APP_ORIGIN: appOrigin,
    TRACKING_ORIGIN: trackingOrigin,
  };
  if (worker === "app")
    Object.assign(config.vars, {
      LOCAL_LOGIN_ENABLED: "true",
      R2_ACCOUNT_ID: "a".repeat(32),
      R2_BUCKET_NAME: "ages-media-local",
      R2_ACCESS_KEY_ID: "synthetic-browser-id",
      R2_SECRET_ACCESS_KEY: "synthetic-browser-secret",
    });

  const outputPath = resolve(configDirectory, `${worker}.jsonc`);
  writeFileSync(outputPath, JSON.stringify(config, null, 2));
  return outputPath;
}

function resolveConfigPaths(config, originalDirectory) {
  const resolveSection = (section) => {
    if (section.main) section.main = resolve(originalDirectory, section.main);
    if (section.assets?.directory)
      section.assets.directory = resolve(
        originalDirectory,
        section.assets.directory,
      );
    for (const database of section.d1_databases ?? [])
      if (database.migrations_dir)
        database.migrations_dir = resolve(
          originalDirectory,
          database.migrations_dir,
        );
  };
  resolveSection(config);
  for (const section of Object.values(config.env ?? {}))
    resolveSection(section);
}

async function getAvailablePort(excludedPorts) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const probe = net.createServer();
    await new Promise((resolveListen, rejectListen) => {
      probe.once("error", rejectListen);
      probe.listen(0, "127.0.0.1", resolveListen);
    });
    const address = probe.address();
    if (!address || typeof address === "string")
      throw new Error("Could not determine an available internal Worker port.");
    await new Promise((resolveClose, rejectClose) =>
      probe.close((error) => (error ? rejectClose(error) : resolveClose())),
    );
    if (!excludedPorts.has(address.port)) return address.port;
  }
  throw new Error(
    "Could not choose an internal port distinct from the public ports.",
  );
}

async function waitForApp() {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (childExit)
      throw new Error(
        "The shared Wrangler runtime exited before becoming ready.",
      );
    try {
      const response = await fetch(`http://127.0.0.1:${internalPort}/health`, {
        headers: { "x-e2e-target": "app" },
      });
      if (
        response.status === 200 &&
        JSON.stringify(await response.json()) ===
          JSON.stringify({ status: "ok", service: "ages" })
      )
        return;
    } catch {
      // Wrangler is still binding its local address.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(
    "The shared Wrangler runtime did not route the app health check in time.",
  );
}

async function listenProxy(target, port) {
  const server = http.createServer((incoming, outgoing) => {
    const headers = { ...incoming.headers, "x-e2e-target": target };
    const upstream = http.request(
      {
        host: "127.0.0.1",
        port: internalPort,
        method: incoming.method,
        path: incoming.url ?? "/",
        headers,
      },
      (upstreamResponse) => {
        outgoing.writeHead(
          upstreamResponse.statusCode ?? 502,
          proxyResponseHeaders(upstreamResponse.headers),
        );
        upstreamResponse.pipe(outgoing);
      },
    );
    upstream.once("error", (error) => {
      if (outgoing.headersSent) {
        outgoing.destroy(error);
        return;
      }
      outgoing.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      outgoing.end("The local Worker gateway is unavailable.");
    });
    incoming.pipe(upstream);
  });

  servers.push(server);
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, "127.0.0.1", resolveListen);
  });
}

function proxyResponseHeaders(headers) {
  const result = { ...headers };
  const connectionTokens = String(headers.connection ?? "")
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
  for (const header of [
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    ...connectionTokens,
  ])
    delete result[header];
  return result;
}
