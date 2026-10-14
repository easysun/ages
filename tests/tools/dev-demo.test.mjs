import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { demoAssets, samplePng, seedSql } from "../../scripts/dev-demo.mjs";

const root = resolve(import.meta.dirname, "../..");
const cli = resolve(root, "node_modules/wrangler/bin/wrangler.js");
const demo = resolve(root, "scripts/dev-demo.mjs");

test("sample PNGs have reproducible dimensions and distinct content", () => {
  const images = demoAssets.map(({ width, height, tone }) => {
    const png = samplePng(width, height, tone);
    assert.equal(png.subarray(1, 4).toString(), "PNG");
    assert.equal(png.readUInt32BE(16), width);
    assert.equal(png.readUInt32BE(20), height);
    return png.toString("base64");
  });
  assert.equal(new Set(images).size, 4);
});

test("seed SQL uses the fixed normal local account, seeded references, and conditional updates", () => {
  const media = demoAssets.map((asset) => ({ ...asset, size: 1024, etag: "a".repeat(32) }));
  const sql = seedSql(media, "2026-10-15T00:00:00.000Z");
  assert.match(sql, /us_local_test/);
  assert.match(sql, /tl_demo_weekend/);
  assert.match(sql, /tl_demo_everyday/);
  assert.match(sql, /demo-story/);
  assert.match(sql, /WHERE id='as_demo_coast' AND status='pending'/);
  assert.doesNotMatch(sql, /INSERT OR REPLACE|DROP TABLE|DELETE FROM users/);
});

test("demo seed is local-only and idempotent against real D1/R2 bindings", { timeout: 180_000 }, () => {
  const persistence = resolve(root, ".wrangler/demo-tests/" + randomUUID());
  const env = { ...process.env, AGES_DEMO_PERSIST_TO: persistence };
  delete env.CLOUDFLARE_API_TOKEN;
  delete env.CLOUDFLARE_ACCOUNT_ID;
  const opts = {
    cwd: root,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 180_000,
  };
  try {
    for (let iteration = 0; iteration < 2; iteration++)
      execFileSync(process.execPath, [demo, "--seed-only"], opts);
    const query = "SELECT " +
      "(SELECT COUNT(*) FROM assets WHERE owner_id='us_local_test' AND status='ready') AS photos," +
      "(SELECT COUNT(*) FROM timelines WHERE owner_id='us_local_test') AS timelines," +
      "(SELECT COUNT(*) FROM distribution_links WHERE owner_id='us_local_test') AS links," +
      "(SELECT storage_used_bytes FROM usage_quotas WHERE user_id='us_local_test') AS storage," +
      "(SELECT SUM(size_bytes) FROM assets WHERE owner_id='us_local_test' AND status='ready') AS expected";
    const output = execFileSync(process.execPath, [
      cli, "d1", "execute", "DB", "--command", query, "--json",
      "--local", "--env", "", "--persist-to", persistence,
    ], opts);
    assert.match(output, /"photos"\s*:\s*4/);
    assert.match(output, /"timelines"\s*:\s*2/);
    assert.match(output, /"links"\s*:\s*1/);
    const storage = /"storage"\s*:\s*(\d+)/.exec(output)?.[1];
    const expected = /"expected"\s*:\s*(\d+)/.exec(output)?.[1];
    assert.ok(storage);
    assert.equal(storage, expected);
  } finally {
    rmSync(persistence, { recursive: true, force: true });
  }
});
