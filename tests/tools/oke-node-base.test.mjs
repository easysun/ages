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

test("the built OKE image receives a blocking vulnerability scan on scheduled runs", () => {
  const workflow = readFileSync(
    new URL("../../.github/workflows/oke-base-scan.yml", import.meta.url),
    "utf8",
  );
  const nativeJob = workflow.split("  native-arm64-smoke:")[1];
  assert.ok(nativeJob);
  assert.doesNotMatch(nativeJob, /^    if: github\.event_name != 'schedule'$/m);
  assert.match(
    nativeJob,
    /docker build --file Dockerfile\.oke-dev --tag ages-security-smoke \.[\s\S]*?image-ref: ages-security-smoke[\s\S]*?severity: CRITICAL[\s\S]*?ignore-unfixed: true[\s\S]*?exit-code: "1"/,
  );
});
