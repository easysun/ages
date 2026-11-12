import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("OKE uses the intended Node 22 patch version pinned by image digest", () => {
  const dockerfile = readFileSync(
    new URL("../../Dockerfile.oke-dev", import.meta.url),
    "utf8",
  );
  const nodeVersion = readFileSync(
    new URL("../../.node-version", import.meta.url),
    "utf8",
  ).trim();
  assert.equal(nodeVersion, "22.23.5");
  assert.match(
    dockerfile,
    /^FROM node:22\.23\.5-bookworm-slim@sha256:[a-f0-9]{64}$/m,
  );
  assert.match(dockerfile, /^USER node$/m);
  assert.match(dockerfile, /^RUN npm ci --no-audit --no-fund$/m);
  assert.doesNotMatch(dockerfile, /node:latest|bookworm-slim\s*$/m);
});
