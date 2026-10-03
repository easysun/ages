import { execFileSync, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

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
const server = spawn(
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
    "8791",
    "--persist-to",
    persistence,
    "--var",
    "APP_ORIGIN:http://127.0.0.1:8791",
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
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => server.kill(signal));
server.on("exit", (code) => process.exit(code ?? 1));
