import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  allocateRunDirectory,
  buildLocalArgs,
  compareSnapshots,
  makeWranglerEnv,
  runRecoveryDrill,
} from "../../scripts/recovery-drill.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const scriptPath = fileURLToPath(
  new URL("../../scripts/recovery-drill.mjs", import.meta.url),
);
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  "base64",
);
const expectedHash =
  "d3c936ebdd73f46e6422d5946044c99d524554082272019ab738800318b04892";

function temporaryRepo(t) {
  const root = mkdtempSync(join(tmpdir(), "ages-recovery-drill-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function drillsRoot(root) {
  return resolve(root, ".wrangler", "recovery-drills");
}

function sampleSnapshot(ids = {}) {
  const assetId = ids.assetId ?? "synthetic-asset";
  return {
    row: {
      storage_limit_bytes: 1048576,
      storage_used_bytes: 69,
      max_asset_bytes: 262144,
      timeline_limit: 10,
      link_limit: 10,
      asset_id: assetId,
      asset_status: "ready",
      asset_original_name: "probe-image.png",
      asset_mime_type: "image/png",
      asset_size_bytes: 69,
      asset_r2_key: `originals/${ids.userId ?? "synthetic-user"}/${assetId}/probe-image.png`,
      asset_captured_at: "2026-10-12T06:30:00.000Z",
      asset_width: 1,
      asset_height: 1,
      asset_visibility: "private",
      timeline_id: ids.timelineId ?? "synthetic-timeline",
      timeline_title: "Synthetic recovery timeline",
      timeline_visibility: "private",
      timeline_item_id: ids.itemId ?? "synthetic-item",
      timeline_item_asset_id: assetId,
      timeline_item_position: 0,
      timeline_item_caption: "Synthetic recovery item",
      timeline_item_event_at:
        '{"kind":"date","date":"2026-10-13","calendar":"iso8601","time_zone":"Asia/Taipei"}',
    },
    object: { byteLength: 69, sha256: expectedHash },
  };
}

function queryResult(args) {
  const fileIndex = args.indexOf("--file");
  const query = readFileSync(args[fileIndex + 1], "utf8");
  const userId = query.match(/WHERE u\.id = '([^']+)'/)?.[1];
  const assetId = query.match(/AND a\.id = '([^']+)'/)?.[1];
  const timelineId = query.match(/AND t\.id = '([^']+)'/)?.[1];
  const itemId = query.match(/AND ti\.id = '([^']+)'/)?.[1];
  assert.ok(userId && assetId && timelineId && itemId);
  return JSON.stringify([
    {
      results: [sampleSnapshot({ userId, assetId, timelineId, itemId }).row],
    },
  ]);
}

function successfulExecutor(calls) {
  return (_file, args, options) => {
    calls.push({ args, options });
    const wranglerArgs = args.slice(1);
    if (
      wranglerArgs[0] === "d1" &&
      wranglerArgs[1] === "execute" &&
      wranglerArgs.includes("--json")
    )
      return queryResult(wranglerArgs);
    if (wranglerArgs[0] === "d1" && wranglerArgs[1] === "export") {
      const outputIndex = wranglerArgs.indexOf("--output");
      writeFileSync(wranglerArgs[outputIndex + 1], "-- synthetic export\n", {
        flag: "wx",
      });
      return "exported synthetic SQL";
    }
    if (wranglerArgs[0] === "r2" && wranglerArgs[2] === "get") {
      const fileIndex = wranglerArgs.indexOf("--file");
      writeFileSync(wranglerArgs[fileIndex + 1], png, { flag: "wx" });
    }
    return "synthetic command output";
  };
}

test("refuses_existing_and_symlinked_paths_without_writing", (t) => {
  const root = temporaryRepo(t);
  const existing = join(drillsRoot(root), "existing-run");
  mkdirSync(existing, { recursive: true });
  const marker = join(existing, "keep.txt");
  writeFileSync(marker, "preserve this", { flag: "wx" });
  assert.throws(() => allocateRunDirectory(drillsRoot(root), "existing-run"));
  assert.equal(readFileSync(marker, "utf8"), "preserve this");

  const outside = join(root, "outside");
  mkdirSync(outside);
  const outsideMarker = join(outside, "keep.txt");
  writeFileSync(outsideMarker, "preserve symlink target", { flag: "wx" });
  const symlinkedRun = join(drillsRoot(root), "linked-run");
  symlinkSync(outside, symlinkedRun, "dir");
  assert.throws(() => allocateRunDirectory(drillsRoot(root), "linked-run"));
  assert.equal(readFileSync(outsideMarker, "utf8"), "preserve symlink target");
  assert.ok(lstatSync(symlinkedRun).isSymbolicLink());

  const parentRoot = join(root, "parent-symlink-case");
  mkdirSync(parentRoot);
  const externalParent = join(root, "external-parent");
  mkdirSync(externalParent);
  symlinkSync(externalParent, join(parentRoot, ".wrangler"), "dir");
  assert.throws(() =>
    allocateRunDirectory(drillsRoot(parentRoot), "must-not-escape"),
  );
  assert.deepEqual(readdirSync(externalParent), []);
});

test("rejects_run_id_traversal_before_creating_any_directory", (t) => {
  const root = temporaryRepo(t);
  assert.throws(() => allocateRunDirectory(drillsRoot(root), "../escape"));
  assert.equal(existsSync(join(root, ".wrangler")), false);
});

test("builds_only_local_commands_with_scratch_persistence", () => {
  const config = "/repo/.wrangler/recovery-drills/run/source/wrangler.jsonc";
  const persist = "/repo/.wrangler/recovery-drills/run/source/.wrangler/state";
  assert.deepEqual(
    buildLocalArgs(
      ["d1", "execute", "DB", "--file", "/scratch/query.sql", "--json"],
      config,
      persist,
    ),
    [
      "d1",
      "execute",
      "DB",
      "--file",
      "/scratch/query.sql",
      "--json",
      "--config",
      config,
      "--env",
      "",
      "--local",
      "--persist-to",
      persist,
    ],
  );

  const exportArgs = buildLocalArgs(
    ["d1", "export", "DB", "--no-data", "--output", "/scratch/schema.sql"],
    config,
    null,
  );
  assert.ok(exportArgs.includes("--local"));
  assert.deepEqual(
    exportArgs.slice(
      exportArgs.indexOf("--env"),
      exportArgs.indexOf("--env") + 2,
    ),
    ["--env", ""],
  );
  assert.equal(exportArgs.includes("--persist-to"), false);
  assert.equal(exportArgs.includes("--remote"), false);

  const base = ["d1", "execute", "DB", "--file", "/scratch/query.sql"];
  for (const override of [
    "--remote",
    "--config",
    "--config=/elsewhere/wrangler.jsonc",
    "-c",
    "--env",
    "--env=production",
    "-e",
    "--persist-to",
    "--persist-to=/shared/state",
    "--local",
    "--preview",
  ])
    assert.throws(() => buildLocalArgs([...base, override], config, persist));
  assert.throws(() => buildLocalArgs(["deploy"], config, persist));
});

test("rejects_option_terminators_and_attached_overrides", async (t) => {
  const config = "/repo/.wrangler/recovery-drills/run/source/wrangler.jsonc";
  const persist = "/repo/.wrangler/recovery-drills/run/source/.wrangler/state";
  const base = ["d1", "execute", "DB", "--file", "/scratch/query.sql"];

  for (const [name, argument] of [
    ["option terminator", "--"],
    ["attached config alias", "-c=/shared/wrangler.jsonc"],
    ["attached environment alias", "-eproduction"],
    ["equals-form inline SQL", "--command=SELECT 1"],
  ]) {
    await t.test(name, () => {
      assert.throws(() => buildLocalArgs([...base, argument], config, persist));
    });
  }
});

test("sanitizes_child_credentials_without_changing_host_paths", () => {
  const authNames = [
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_API_KEY",
    "CLOUDFLARE_EMAIL",
    "CLOUDFLARE_ACCOUNT_ID",
    "CF_API_TOKEN",
    "CF_API_KEY",
    "CF_EMAIL",
    "CF_ACCOUNT_ID",
  ];
  const parentEnv = {
    HOME: "/host/home",
    TMPDIR: "/host/tmp",
    CODEX_HOME: "/host/codex",
    PATH: "/host/bin",
    DO_NOT_TRACK: "false",
    WRANGLER_HIDE_BANNER: "false",
    WRANGLER_SEND_METRICS: "true",
    CLOUDFLARE_ENV: "production",
    unrelated: "preserve",
    ...Object.fromEntries(authNames.map((name) => [name, "secret-fixture"])),
  };
  const originalEnv = { ...parentEnv };
  const childEnv = makeWranglerEnv(parentEnv, "/scratch/run/wrangler-logs");

  assert.equal(childEnv.HOME, "/host/home");
  assert.equal(childEnv.TMPDIR, "/host/tmp");
  assert.equal(childEnv.CODEX_HOME, "/host/codex");
  assert.equal(childEnv.PATH, "/host/bin");
  assert.equal(childEnv.CLOUDFLARE_ENV, "production");
  assert.equal(childEnv.unrelated, "preserve");
  for (const name of authNames) assert.equal(name in childEnv, false);
  assert.equal(childEnv.DO_NOT_TRACK, "true");
  assert.equal(childEnv.WRANGLER_HIDE_BANNER, "true");
  assert.equal(childEnv.WRANGLER_SEND_METRICS, "false");
  assert.equal(childEnv.WRANGLER_LOG_PATH, "/scratch/run/wrangler-logs");
  assert.deepEqual(parentEnv, originalEnv);
});

test("uses_generated_scratch_configs_not_ancestor_configs", async (t) => {
  const root = temporaryRepo(t);
  mkdirSync(join(root, "migrations"));
  writeFileSync(join(root, "wrangler.jsonc"), '{"name":"unsafe-ancestor"}');
  writeFileSync(
    join(root, "wrangler.tracking.jsonc"),
    '{"name":"also-unsafe"}',
  );
  const calls = [];
  const result = await runRecoveryDrill({
    repoRoot: root,
    execute: successfulExecutor(calls),
  });

  assert.equal(result.status, "PASS");
  const canonicalRoot = realpathSync(root);
  assert.ok(result.paths.root.startsWith(drillsRoot(canonicalRoot)));
  const sourceConfigPath = join(result.paths.source, "wrangler.jsonc");
  const restoredConfigPath = join(result.paths.restored, "wrangler.jsonc");
  const sourceConfig = JSON.parse(readFileSync(sourceConfigPath, "utf8"));
  const restoredConfig = JSON.parse(readFileSync(restoredConfigPath, "utf8"));
  assert.equal(sourceConfig.d1_databases[0].binding, "DB");
  assert.equal(restoredConfig.d1_databases[0].binding, "DB");
  assert.equal(
    sourceConfig.d1_databases[0].migrations_dir,
    join(canonicalRoot, "migrations"),
  );
  assert.notEqual(
    sourceConfig.d1_databases[0].database_id,
    restoredConfig.d1_databases[0].database_id,
  );
  assert.notEqual(
    sourceConfig.r2_buckets[0].bucket_name,
    restoredConfig.r2_buckets[0].bucket_name,
  );

  const resourceCommands = calls.map(({ args }) => args.slice(1));
  assert.ok(resourceCommands.length > 8);
  for (const args of resourceCommands) {
    assert.ok(args.includes("--local"));
    const envIndex = args.indexOf("--env");
    assert.notEqual(envIndex, -1);
    assert.equal(args[envIndex + 1], "");
    const configIndex = args.indexOf("--config");
    assert.notEqual(configIndex, -1);
    assert.ok(
      [sourceConfigPath, restoredConfigPath].includes(args[configIndex + 1]),
    );
    assert.equal(args.includes("--remote"), false);
    assert.equal(args.includes(join(root, "wrangler.jsonc")), false);
    assert.equal(args.includes(join(root, "wrangler.tracking.jsonc")), false);
  }
  for (const args of resourceCommands.filter(
    (command) => command[1] === "export",
  )) {
    assert.equal(args.includes("--persist-to"), false);
    assert.ok(args.includes("--no-data") || args.includes("--no-schema"));
  }
  const restoredPut = resourceCommands.find(
    (args) =>
      args[0] === "r2" && args[2] === "put" && args.includes("--content-type"),
  );
  assert.ok(restoredPut);
  assert.equal(
    restoredPut[restoredPut.indexOf("--content-type") + 1],
    "image/png",
  );
  assert.deepEqual(result.mismatches, []);
  assert.deepEqual(result.comparisons, {
    quota_used_is_69_bytes: true,
    quota_usage_matches_asset_size: true,
    captured_at_preserved: true,
    timeline_event_at_preserved: true,
    asset_visibility_private: true,
    timeline_visibility_private: true,
    mime_type_image_png: true,
    timeline_item_asset_relationship: true,
    original_backup_restored_size: true,
    original_backup_restored_sha256: true,
  });
});

test("halts_on_command_failure_without_false_pass", async (t) => {
  const root = temporaryRepo(t);
  mkdirSync(join(root, "migrations"));
  const calls = [];
  const execute = successfulExecutor(calls);
  const failWith = Object.assign(
    new Error("synthetic failure with query rows that must stay private"),
    { status: 21, stdout: Buffer.from("PRIVATE QUERY ROW") },
  );
  const failureExecutor = (file, args, options) => {
    if (
      args[1] === "d1" &&
      args[2] === "export" &&
      args.includes("--no-schema")
    ) {
      calls.push({ args, options });
      throw failWith;
    }
    return execute(file, args, options);
  };
  const result = await runRecoveryDrill({
    repoRoot: root,
    execute: failureExecutor,
  });

  assert.equal(result.status, "FAIL");
  assert.equal(result.commandFailure.exitCode, 21);
  const wranglerArgs = calls.map(({ args }) => args.slice(1));
  assert.equal(
    wranglerArgs.some(
      (args) =>
        args[0] === "d1" && args[1] === "execute" && !args.includes("--json"),
    ),
    true,
  );
  const restoredConfigPath = join(result.paths.restored, "wrangler.jsonc");
  assert.equal(
    wranglerArgs.some(
      (args) =>
        args[0] === "r2" &&
        args[2] === "put" &&
        args.includes("--content-type") &&
        args[args.indexOf("--config") + 1] === restoredConfigPath,
    ),
    false,
  );
  const report = readFileSync(result.paths.report, "utf8");
  const log = readFileSync(result.paths.log, "utf8");
  assert.match(report, /FAIL/);
  assert.doesNotMatch(report, /PASS/);
  assert.match(log, /"exit_code":21/);
  assert.doesNotMatch(
    report,
    /PRIVATE QUERY ROW|query rows that must stay private/,
  );
  assert.doesNotMatch(
    log,
    /PRIVATE QUERY ROW|query rows that must stay private/,
  );
});

test("fails_when_source_and_restore_share_invalid_seed_invariants", async (t) => {
  const root = temporaryRepo(t);
  mkdirSync(join(root, "migrations"));
  const calls = [];
  const executor = successfulExecutor(calls);
  const invalidExecutor = (file, args, options) => {
    const output = executor(file, args, options);
    const wranglerArgs = args.slice(1);
    if (
      wranglerArgs[0] !== "d1" ||
      wranglerArgs[1] !== "execute" ||
      !wranglerArgs.includes("--json")
    )
      return output;
    const parsed = JSON.parse(output);
    Object.assign(parsed[0].results[0], {
      storage_used_bytes: 0,
      asset_mime_type: "image/jpeg",
      asset_size_bytes: 68,
      timeline_item_asset_id: "unrelated-asset",
    });
    return JSON.stringify(parsed);
  };
  const result = await runRecoveryDrill({
    repoRoot: root,
    execute: invalidExecutor,
  });

  assert.equal(result.status, "FAIL");
  assert.ok(result.mismatches.includes("storage_used_bytes"));
  assert.ok(result.mismatches.includes("asset_mime_type"));
  assert.ok(result.mismatches.includes("asset_size_bytes"));
  assert.ok(result.mismatches.includes("timeline_item_asset_id"));
  assert.doesNotMatch(readFileSync(result.paths.report, "utf8"), /PASS/);
});

test("compares_asset_timeline_quota_and_object_transfer_fields", () => {
  const source = sampleSnapshot();
  const restored = structuredClone(source);
  assert.deepEqual(compareSnapshots(source, restored), []);

  restored.row.storage_used_bytes = 70;
  restored.row.asset_captured_at = "2026-10-11T06:30:00.000Z";
  restored.row.asset_visibility = "public";
  restored.row.timeline_visibility = "unlisted";
  restored.row.asset_mime_type = "image/jpeg";
  restored.row.timeline_item_asset_id = "another-asset";
  restored.row.asset_size_bytes = 70;
  restored.object.byteLength = 70;
  restored.object.sha256 = "different-hash";
  assert.deepEqual(compareSnapshots(source, restored), [
    "storage_used_bytes",
    "asset_mime_type",
    "asset_size_bytes",
    "asset_captured_at",
    "asset_visibility",
    "timeline_visibility",
    "timeline_item_asset_id",
    "object.byteLength",
    "object.sha256",
  ]);
});

test("detects_each_recovery_snapshot_mismatch", () => {
  const source = sampleSnapshot();
  const fields = [
    "storage_limit_bytes",
    "storage_used_bytes",
    "max_asset_bytes",
    "timeline_limit",
    "link_limit",
    "asset_id",
    "asset_status",
    "asset_original_name",
    "asset_mime_type",
    "asset_size_bytes",
    "asset_r2_key",
    "asset_captured_at",
    "asset_width",
    "asset_height",
    "asset_visibility",
    "timeline_id",
    "timeline_title",
    "timeline_visibility",
    "timeline_item_id",
    "timeline_item_asset_id",
    "timeline_item_position",
    "timeline_item_caption",
    "timeline_item_event_at",
  ];

  for (const field of fields) {
    const changed = structuredClone(source);
    const value = changed.row[field];
    changed.row[field] =
      typeof value === "number" ? value + 1 : `${value}-changed`;
    assert.deepEqual(compareSnapshots(source, changed), [field], field);
  }
  for (const [field, value] of [
    ["object.byteLength", 70],
    ["object.sha256", "different-hash"],
  ]) {
    const changed = structuredClone(source);
    const key = field.slice("object.".length);
    changed.object[key] = value;
    assert.deepEqual(compareSnapshots(source, changed), [field], field);
  }
});

test("rejects_unknown_cli_arguments_before_allocating_a_run", () => {
  const rootDrills = join(repoRoot, ".wrangler", "recovery-drills");
  const before = existsSync(rootDrills) ? readdirSync(rootDrills).sort() : null;
  const result = spawnSync(
    process.execPath,
    [scriptPath, "--output", "/tmp/escape"],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /argument|usage/i);
  const after = existsSync(rootDrills) ? readdirSync(rootDrills).sort() : null;
  assert.deepEqual(after, before);
});
