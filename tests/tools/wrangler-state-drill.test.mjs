import assert from "node:assert/strict";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildLocalArgs,
  compareMigrationLedger,
  createManifest,
  nextMigrationFilename,
  prepareRunDirectory,
  restoreDirectory,
  runStateDrill,
  snapshotDirectory,
  verifyManifest,
} from "../../scripts/wrangler-state-drill.mjs";

function temporaryDirectory(t) {
  const root = mkdtempSync(join(tmpdir(), "ages-wrangler-state-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("github_ci_runs_the_state_recovery_guard", () => {
  const workflow = readFileSync(
    new URL("../../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /^\s*-\s+run:\s+npm run test:state-drill\s*$/m);
});

test("snapshot_and_restore_copy_all_files_and_detect_tampering", async (t) => {
  const root = temporaryDirectory(t);
  const source = join(root, "source");
  mkdirSync(join(source, "d1"), { recursive: true });
  mkdirSync(join(source, "r2", "bucket"), { recursive: true });
  mkdirSync(join(source, "kv", "namespace"), { recursive: true });
  writeFileSync(join(source, "d1", "database.sqlite"), "synthetic sqlite");
  writeFileSync(join(source, "d1", "database.sqlite-wal"), "synthetic wal");
  writeFileSync(
    join(source, "r2", "bucket", "object.bin"),
    Buffer.from([0, 255, 8]),
  );
  writeFileSync(
    join(source, "kv", "namespace", "index.sqlite"),
    "synthetic kv",
  );
  const backup = join(root, "backup");
  const restored = join(root, "restored");

  const manifest = await snapshotDirectory(source, backup);
  const restoredManifest = await restoreDirectory(backup, restored, manifest);

  assert.deepEqual(restoredManifest, manifest);
  assert.deepEqual(await createManifest(restored), manifest);
  assert.equal(
    readFileSync(join(restored, "d1", "database.sqlite-wal"), "utf8"),
    "synthetic wal",
  );
  assert.deepEqual(
    readFileSync(join(restored, "r2", "bucket", "object.bin")),
    Buffer.from([0, 255, 8]),
  );
  assert.deepEqual(await verifyManifest(backup, manifest), []);

  writeFileSync(join(backup, "kv", "namespace", "index.sqlite"), "tampered kv");
  assert.deepEqual(await verifyManifest(backup, manifest), [
    "kv/namespace/index.sqlite",
  ]);
  await assert.rejects(
    restoreDirectory(backup, join(root, "bad-restore"), manifest),
    /manifest mismatch/,
  );
});

test("snapshot_refuses_overwrites_overlapping_paths_and_symlinks", async (t) => {
  const root = temporaryDirectory(t);
  const source = join(root, "source");
  mkdirSync(source);
  const marker = join(source, "marker.txt");
  writeFileSync(marker, "preserve source");
  const backup = join(root, "backup");

  await snapshotDirectory(source, backup);
  await assert.rejects(snapshotDirectory(source, backup), /already exists/);
  assert.equal(readFileSync(marker, "utf8"), "preserve source");
  await assert.rejects(
    snapshotDirectory(source, join(source, "nested")),
    /overlap/,
  );

  const outside = join(root, "outside");
  mkdirSync(outside);
  const outsideMarker = join(outside, "keep.txt");
  writeFileSync(outsideMarker, "preserve symlink target");
  symlinkSync(outside, join(source, "linked"), "dir");
  await assert.rejects(createManifest(source), /symlink/);
  assert.equal(readFileSync(outsideMarker, "utf8"), "preserve symlink target");
  assert.ok(lstatSync(join(source, "linked")).isSymbolicLink());
});

test("local_wrangler_args_pin_config_env_persistence_and_reject_remote_flags", () => {
  const config = "/tmp/scratch/wrangler.jsonc";
  const persist = "/tmp/scratch/state";
  const args = buildLocalArgs(
    ["kv", "key", "get", "cache-key", "--binding", "LINK_CACHE", "--text"],
    config,
    persist,
  );

  assert.ok(args.includes("--config"));
  assert.ok(args.includes(config));
  assert.deepEqual(args.slice(-5), [
    "--env",
    "",
    "--local",
    "--persist-to",
    persist,
  ]);
  assert.throws(
    () =>
      buildLocalArgs(
        [
          "kv",
          "key",
          "get",
          "cache-key",
          "--binding",
          "LINK_CACHE",
          "--remote",
        ],
        config,
        persist,
      ),
    /cannot alter local recovery options/,
  );
  assert.throws(
    () =>
      buildLocalArgs(
        ["kv", "namespace", "delete", "LINK_CACHE"],
        config,
        persist,
      ),
    /Unsupported Wrangler command/,
  );
});

test("forward_migration_ledger_comparison_only_accepts_a_new_appended_entry", () => {
  const previous = ["0001_identity.sql", "0002_assets.sql"];
  const next = nextMigrationFilename(previous);

  assert.equal(next, "0003_state_recovery_probe.sql");
  assert.deepEqual(
    compareMigrationLedger(previous, [...previous, next], next),
    [],
  );
  assert.deepEqual(
    compareMigrationLedger(previous, ["0001_identity.sql", next], next),
    ["migration ledger was not preserved exactly"],
  );
  assert.deepEqual(
    compareMigrationLedger(previous, [...previous, "0004_gap.sql", next], next),
    ["new migration is not the sole appended ledger entry"],
  );
});

test("run_directory_preparation_creates_only_the_three_expected_work_areas", (t) => {
  const root = temporaryDirectory(t);
  const runRoot = join(root, "run");
  mkdirSync(runRoot);
  const paths = {
    root: runRoot,
    source: join(runRoot, "source"),
    restored: join(runRoot, "restored"),
    backup: join(runRoot, "backup"),
  };

  prepareRunDirectory(paths);

  for (const path of [paths.source, paths.restored, paths.backup])
    assert.ok(lstatSync(path).isDirectory());
  assert.deepEqual(prepareRunDirectory(paths), paths);
});

test("local_state_drill_restores_d1_r2_kv_and_applies_only_an_appended_migration", async (t) => {
  const result = await runStateDrill();
  if (result.status === "PASS")
    t.after(() => rmSync(result.paths.root, { recursive: true, force: true }));

  assert.equal(result.status, "PASS", result.failure);
  assert.equal(result.comparisons.complete_persistence_tree_restored, true);
  assert.equal(result.comparisons.d1_probe_and_migration_ledger_match, true);
  assert.equal(result.comparisons.r2_bytes_match, true);
  assert.equal(result.comparisons.kv_value_matches, true);
  assert.equal(
    result.comparisons.forward_migration_appends_to_restored_ledger,
    true,
  );
});
