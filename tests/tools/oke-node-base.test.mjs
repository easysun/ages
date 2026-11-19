import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("OKE uses the intended Node 26 patch version pinned by image digest", () => {
  const dockerfile = readFileSync(
    new URL("../../Dockerfile.oke-dev", import.meta.url),
    "utf8",
  );
  const nodeVersion = readFileSync(
    new URL("../../.node-version", import.meta.url),
    "utf8",
  ).trim();
  assert.equal(nodeVersion, "26.13.1");
  assert.match(
    dockerfile,
    /^FROM node:26\.13\.1-bookworm-slim@sha256:[a-f0-9]{64}$/m,
  );
  assert.match(
    dockerfile,
    /apt-get install --no-install-recommends -y ca-certificates/,
  );
  assert.match(dockerfile, /^USER node$/m);
  assert.match(dockerfile, /^RUN npm ci --no-audit --no-fund$/m);
  assert.doesNotMatch(dockerfile, /node:latest|bookworm-slim\s*$/m);
});
