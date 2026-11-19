import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

test("Wrangler upgrades a populated media timeline to support standalone text", (t) => {
  const root = resolve(import.meta.dirname, "../..");
  const cli = join(root, "node_modules/wrangler/bin/wrangler.js");
  const work = mkdtempSync(join(tmpdir(), "ages-text-migration-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const config = join(work, "wrangler.json");
  writeFileSync(
    config,
    JSON.stringify({
      name: "ages-text-migration-test",
      compatibility_date: "2026-10-01",
      send_metrics: false,
      d1_databases: [
        {
          binding: "DB",
          database_name: "ages-local",
          database_id: "00000000-0000-0000-0000-000000000001",
          migrations_dir: "migrations",
        },
      ],
    }),
  );
  const source = join(root, "migrations");
  const migrations = join(work, "migrations");
  const upgrade = "0020_timeline_text_moments.sql";
  mkdirSync(migrations);
  for (const name of readdirSync(source).filter(
    (name) => name.endsWith(".sql") && name < upgrade,
  ))
    copyFileSync(join(source, name), join(migrations, name));

  const wrangler = (...args) =>
    execFileSync(
      process.execPath,
      [
        cli,
        "d1",
        ...args,
        "--config",
        config,
        "--local",
        "--persist-to",
        join(work, "state"),
      ],
      {
        encoding: "utf8",
        cwd: work,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, WRANGLER_LOG_PATH: join(work, "logs") },
      },
    );
  const query = (sql) =>
    JSON.parse(wrangler("execute", "DB", "--json", "--command", sql))[0]
      .results;
  wrangler("migrations", "apply", "DB");
  query(`
    INSERT INTO users(id,email,created_at,updated_at) VALUES('owner','owner@example.test','now','now');
    INSERT INTO usage_quotas(user_id,storage_limit_bytes,max_asset_bytes,timeline_limit,link_limit,updated_at)
      VALUES('owner',50,50,10,10,'now');
    INSERT INTO assets(id,owner_id,kind,status,original_name,mime_type,size_bytes,r2_key,upload_expires_at,created_at,updated_at)
      VALUES('photo','owner','image','ready','photo.png','image/png',8,'photo','now','now','now');
    INSERT INTO timelines(id,owner_id,title,created_at,updated_at) VALUES('trip','owner','Trip','now','now');
    INSERT INTO timeline_items(id,timeline_id,owner_id,asset_id,position,caption,created_at,updated_at)
      VALUES('pic','trip','owner','photo',12,'At the station','before','before');`);
  const before = query("SELECT * FROM timeline_items");
  assert.equal(before.length, 1);

  copyFileSync(join(source, upgrade), join(migrations, upgrade));
  wrangler("migrations", "apply", "DB");
  assert.deepEqual(query("SELECT * FROM timeline_items"), before);
  query(`INSERT INTO timeline_items(id,timeline_id,owner_id,asset_id,position,caption,created_at,updated_at)
      VALUES('note','trip','owner',NULL,13,'We waved goodbye','after','after')`);
  assert.deepEqual(
    query("SELECT id,asset_id,position FROM timeline_items ORDER BY position"),
    [
      { id: "pic", asset_id: "photo", position: 12 },
      { id: "note", asset_id: null, position: 13 },
    ],
  );
  assert.deepEqual(query("PRAGMA foreign_key_check"), []);
});
