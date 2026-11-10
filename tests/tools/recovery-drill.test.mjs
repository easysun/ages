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
import * as recoveryTools from "../../scripts/recovery-drill.mjs";
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
const schemaExportBytes = Buffer.from("-- synthetic schema export\n", "utf8");
const dataExportBytes = Buffer.from("-- synthetic data export\n", "utf8");
const syntheticTriggers = [
  {
    name: 'audit"guard',
    sql: 'CREATE TRIGGER "audit""guard" BEFORE INSERT ON audit BEGIN SELECT 1; END',
  },
  {
    name: "distribution_links_reserve_slug",
    sql: "CREATE TRIGGER distribution_links_reserve_slug BEFORE INSERT ON distribution_links BEGIN SELECT 1; END",
  },
  {
    name: "legacy_reports_no_insert",
    sql: "CREATE TRIGGER legacy_reports_no_insert BEFORE INSERT ON content_reports BEGIN SELECT 1; END",
  },
];

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

function queryResult(
  args,
  {
    quickCheckRows = [{ quick_check: "ok" }],
    foreignKeyRows = [],
    foreignKeyResponse,
  } = {},
) {
  const fileIndex = args.indexOf("--file");
  const query = readFileSync(args[fileIndex + 1], "utf8");
  if (
    query.includes("FROM sqlite_schema") &&
    query.includes("type = 'trigger'")
  )
    return JSON.stringify([{ results: syntheticTriggers }]);
  if (query.includes("PRAGMA quick_check"))
    return JSON.stringify([{ results: quickCheckRows }]);
  if (query.includes("PRAGMA foreign_key_check"))
    return JSON.stringify(
      foreignKeyResponse ?? [{ success: true, results: foreignKeyRows }],
    );
  if (query.includes("probe_slug_reservation_count"))
    return JSON.stringify([
      {
        results: [
          {
            distribution_link_count: 2,
            reserved_slug_count: 3,
            probe_link_count: 1,
            probe_slug_reservation_count: 1,
            deleted_slug_reservation_count: 1,
            deleted_link_row_count: 0,
          },
        ],
      },
    ]);
  if (query.includes("live_link_id")) {
    const linkId = query.match(/WHERE live_link\.id = '([^']+)'/)?.[1];
    const userId = query.match(/AND live_link\.owner_id = '([^']+)'/)?.[1];
    assert.ok(linkId && userId);
    return JSON.stringify([
      {
        results: [
          {
            distribution_link_count: 1,
            reserved_slug_count: 2,
            live_link_id: linkId,
            live_link_owner_id: userId,
            live_link_slug: "synthetic-recovery-live",
            live_link_target_kind: "url",
            live_link_target_url: "https://example.invalid/synthetic-recovery",
            live_link_timeline_id: null,
            live_link_asset_id: null,
            live_link_active: 1,
            live_link_expires_at: null,
            live_link_created_at: "2026-10-14T00:00:00.000Z",
            live_link_updated_at: "2026-10-14T00:00:00.000Z",
            live_slug_reservation_count: 1,
            deleted_slug_reservation_count: 1,
            deleted_link_row_count: 0,
          },
        ],
      },
    ]);
  }
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

function successfulExecutor(
  calls,
  {
    capturedTriggers = syntheticTriggers,
    verifiedTriggers = capturedTriggers,
    quickCheckRows,
    foreignKeyRows,
    foreignKeyResponse,
  } = {},
) {
  let triggerCaptures = 0;
  return (_file, args, options) => {
    calls.push({ args, options });
    const wranglerArgs = args.slice(1);
    if (
      wranglerArgs[0] === "d1" &&
      wranglerArgs[1] === "execute" &&
      wranglerArgs.includes("--json")
    ) {
      const fileIndex = wranglerArgs.indexOf("--file");
      const query = readFileSync(wranglerArgs[fileIndex + 1], "utf8");
      if (
        query.includes("FROM sqlite_schema") &&
        query.includes("type = 'trigger'")
      ) {
        const rows =
          triggerCaptures++ === 0 ? capturedTriggers : verifiedTriggers;
        return JSON.stringify([{ results: rows }]);
      }
      return queryResult(wranglerArgs, {
        quickCheckRows,
        foreignKeyRows,
        foreignKeyResponse,
      });
    }
    if (
      wranglerArgs[0] === "d1" &&
      wranglerArgs[1] === "execute" &&
      wranglerArgs.includes("--file")
    ) {
      const fileIndex = wranglerArgs.indexOf("--file");
      const sql = readFileSync(wranglerArgs[fileIndex + 1], "utf8");
      if (sql.includes("reuse-tombstoned-link-probe"))
        throw Object.assign(new Error("synthetic slug reservation conflict"), {
          status: 1,
          stderr: Buffer.from(
            "UNIQUE constraint failed: reserved_link_slugs.slug: SQLITE_CONSTRAINT",
          ),
        });
    }
    if (wranglerArgs[0] === "d1" && wranglerArgs[1] === "export") {
      const outputIndex = wranglerArgs.indexOf("--output");
      const contents = wranglerArgs.includes("--no-data")
        ? schemaExportBytes
        : dataExportBytes;
      writeFileSync(wranglerArgs[outputIndex + 1], contents, { flag: "wx" });
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

  const commandRecords = readFileSync(result.paths.log, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((record) => record.event === "command");
  const labels = commandRecords.map((record) => record.label);
  const replaySteps = [
    "Restore source D1 schema into the fresh synthetic database",
    "Capture restored D1 triggers before row replay",
    "Drop restored D1 triggers for row replay",
    "Restore source D1 rows after schema and indexes",
    "Reinstall the captured D1 triggers",
    "Verify restored D1 trigger definitions",
  ].map((label) => labels.indexOf(label));
  assert.ok(replaySteps.every((index) => index >= 0));
  assert.deepEqual(
    replaySteps,
    [...replaySteps].sort((a, b) => a - b),
  );

  assert.deepEqual(
    readFileSync(join(result.paths.backup, "d1-schema.sql")),
    schemaExportBytes,
  );
  assert.deepEqual(
    readFileSync(join(result.paths.backup, "d1-data.sql")),
    dataExportBytes,
  );
  const seed = readFileSync(join(result.paths.source, "seed.sql"), "utf8");
  assert.match(seed, /INSERT INTO distribution_links/);
  assert.match(seed, /'synthetic-recovery-live', 'url'/);
  assert.match(seed, /'synthetic-recovery-deleted', 'url'/);
  assert.match(seed, /DELETE FROM distribution_links/);
  const replayFiles = commandRecords
    .filter((record) =>
      [
        "Drop restored D1 triggers for row replay",
        "Reinstall the captured D1 triggers",
      ].includes(record.label),
    )
    .map((record) => record.argv[record.argv.indexOf("--file") + 1]);
  const dropSql = readFileSync(replayFiles[0], "utf8");
  const createSql = readFileSync(replayFiles[1], "utf8");
  for (const trigger of syntheticTriggers) {
    assert.ok(dropSql.includes(trigger.name.replaceAll('"', '""')));
    assert.ok(createSql.includes(trigger.sql));
  }
  assert.doesNotMatch(dropSql, /synthetic (?:schema|data) export/);
  assert.doesNotMatch(createSql, /synthetic (?:schema|data) export/);

  assert.deepEqual(result.mismatches, []);
  assert.deepEqual(result.comparisons, {
    triggers_restored_exactly: true,
    distribution_link_count_is_one: true,
    reserved_slug_count_is_two: true,
    live_url_link_preserved: true,
    deleted_slug_reservation_preserved: true,
    link_snapshot_preserved: true,
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
    probe_link_reserves_slug: true,
    tombstoned_slug_reuse_rejected: true,
    quick_check_ok: true,
    foreign_key_check_clear: true,
  });
});

test("builds_deterministic_trigger_replay_sql_with_quoted_identifiers", () => {
  const replay = recoveryTools.buildTriggerReplaySql(syntheticTriggers);

  assert.equal(
    replay.dropSql,
    'DROP TRIGGER "audit""guard";\n' +
      'DROP TRIGGER "distribution_links_reserve_slug";\n' +
      'DROP TRIGGER "legacy_reports_no_insert";\n',
  );
  assert.equal(
    replay.createSql,
    `${syntheticTriggers.map(({ sql }) => `${sql};`).join("\n")}\n`,
  );
});

test("rejects_empty_or_malformed_trigger_captures", () => {
  assert.equal(typeof recoveryTools.buildTriggerReplaySql, "function");
  const malformedCaptures = [
    null,
    [],
    [
      {
        name: "",
        sql: "CREATE TRIGGER guard BEFORE INSERT ON t BEGIN SELECT 1; END",
      },
    ],
    [{ name: "guard", sql: "SELECT 1" }],
    [syntheticTriggers[0], syntheticTriggers[0]],
  ];

  for (const capture of malformedCaptures)
    assert.throws(
      () => recoveryTools.buildTriggerReplaySql(capture),
      /trigger/i,
    );
});

test("compares_restored_trigger_names_and_ddl_exactly", () => {
  assert.deepEqual(
    recoveryTools.compareTriggerCaptures(syntheticTriggers, syntheticTriggers),
    [],
  );
  assert.deepEqual(
    recoveryTools.compareTriggerCaptures(syntheticTriggers, [
      syntheticTriggers[1],
      syntheticTriggers[2],
    ]),
    ['trigger.missing.audit"guard'],
  );
  const replaced = syntheticTriggers.map((trigger) => ({ ...trigger }));
  replaced[0].sql = `${replaced[0].sql} SELECT 2;`;
  assert.deepEqual(
    recoveryTools.compareTriggerCaptures(syntheticTriggers, replaced),
    ['trigger.sql_mismatch.audit"guard'],
  );
});

test("fails_if_the_restored_trigger_set_differs_after_reinstall", async (t) => {
  const root = temporaryRepo(t);
  mkdirSync(join(root, "migrations"));
  const calls = [];
  const result = await runRecoveryDrill({
    repoRoot: root,
    execute: successfulExecutor(calls, {
      verifiedTriggers: syntheticTriggers.slice(1),
    }),
  });

  assert.equal(result.status, "FAIL");
  assert.ok(result.mismatches.includes('trigger.missing.audit"guard'));
  assert.doesNotMatch(readFileSync(result.paths.report, "utf8"), /PASS/);
  const restoredConfig = join(result.paths.restored, "wrangler.jsonc");
  assert.equal(
    calls.some(({ args }) => {
      const wranglerArgs = args.slice(1);
      return (
        wranglerArgs[0] === "r2" &&
        wranglerArgs[2] === "put" &&
        wranglerArgs[wranglerArgs.indexOf("--config") + 1] === restoredConfig
      );
    }),
    false,
  );
});

test("halts_when_captured_triggers_cannot_be_reinstalled", async (t) => {
  const root = temporaryRepo(t);
  mkdirSync(join(root, "migrations"));
  const calls = [];
  const executor = successfulExecutor(calls);
  const failureExecutor = (file, args, options) => {
    const wranglerArgs = args.slice(1);
    const fileIndex = wranglerArgs.indexOf("--file");
    if (
      wranglerArgs[0] === "d1" &&
      wranglerArgs[1] === "execute" &&
      fileIndex !== -1 &&
      wranglerArgs[fileIndex + 1].endsWith("/create-triggers.sql")
    ) {
      calls.push({ args, options });
      throw Object.assign(new Error("synthetic reinstall failure"), {
        status: 19,
      });
    }
    return executor(file, args, options);
  };
  const result = await runRecoveryDrill({
    repoRoot: root,
    execute: failureExecutor,
  });

  assert.equal(result.status, "FAIL");
  assert.equal(result.commandFailure.exitCode, 19);
  assert.doesNotMatch(readFileSync(result.paths.report, "utf8"), /PASS/);
  const restoredConfig = join(result.paths.restored, "wrangler.jsonc");
  assert.equal(
    calls.some(({ args }) => {
      const wranglerArgs = args.slice(1);
      return (
        wranglerArgs[0] === "r2" &&
        wranglerArgs[2] === "put" &&
        wranglerArgs[wranglerArgs.indexOf("--config") + 1] === restoredConfig
      );
    }),
    false,
  );
});

test("does_not_accept_an_unrelated_failure_as_tombstone_enforcement", async (t) => {
  const root = temporaryRepo(t);
  mkdirSync(join(root, "migrations"));
  const calls = [];
  const executor = successfulExecutor(calls);
  const failureExecutor = (file, args, options) => {
    const wranglerArgs = args.slice(1);
    const fileIndex = wranglerArgs.indexOf("--file");
    if (
      wranglerArgs[0] === "d1" &&
      wranglerArgs[1] === "execute" &&
      fileIndex !== -1 &&
      readFileSync(wranglerArgs[fileIndex + 1], "utf8").includes(
        "reuse-tombstoned-link-probe",
      )
    ) {
      calls.push({ args, options });
      throw Object.assign(new Error("synthetic local command error"), {
        status: 23,
        stderr: Buffer.from("A different local D1 failure"),
      });
    }
    return executor(file, args, options);
  };
  const result = await runRecoveryDrill({
    repoRoot: root,
    execute: failureExecutor,
  });

  assert.equal(result.status, "FAIL");
  assert.equal(result.commandFailure.exitCode, 23);
  assert.match(
    readFileSync(result.paths.report, "utf8"),
    /Status: \*\*FAIL\*\*/,
  );
  assert.doesNotMatch(
    readFileSync(result.paths.report, "utf8"),
    /Status: \*\*PASS\*\*/,
  );
  assert.equal(
    calls.some(({ args }) => {
      const wranglerArgs = args.slice(1);
      return (
        wranglerArgs[0] === "d1" &&
        wranglerArgs[1] === "execute" &&
        wranglerArgs.includes("--json") &&
        readFileSync(
          wranglerArgs[wranglerArgs.indexOf("--file") + 1],
          "utf8",
        ).includes("probe_slug_reservation_count")
      );
    }),
    false,
  );
});

test("fails_closed_when_quick_check_is_not_ok", async (t) => {
  const root = temporaryRepo(t);
  mkdirSync(join(root, "migrations"));
  const result = await runRecoveryDrill({
    repoRoot: root,
    execute: successfulExecutor([], {
      quickCheckRows: [{ quick_check: "database disk image is malformed" }],
    }),
  });

  assert.equal(result.status, "FAIL");
  assert.ok(result.mismatches.includes("restored.quick_check"));
  assert.match(
    readFileSync(result.paths.report, "utf8"),
    /Status: \*\*FAIL\*\*/,
  );
});

test("fails_closed_when_foreign_key_check_returns_rows", async (t) => {
  const root = temporaryRepo(t);
  mkdirSync(join(root, "migrations"));
  const result = await runRecoveryDrill({
    repoRoot: root,
    execute: successfulExecutor([], {
      foreignKeyRows: [{ table: "synthetic_table", rowid: 1 }],
    }),
  });

  assert.equal(result.status, "FAIL");
  assert.ok(result.mismatches.includes("restored.foreign_key_check"));
  assert.match(
    readFileSync(result.paths.report, "utf8"),
    /Status: \*\*FAIL\*\*/,
  );
});

test("fails_closed_when_foreign_key_check_envelope_is_malformed", async (t) => {
  const malformedResponses = [
    ["empty statement list", []],
    ["missing results", [{}]],
    ["missing success state", [{ results: [] }]],
    ["non-array results", [{ success: true, results: null }]],
    [
      "multiple statements",
      [
        { success: true, results: [] },
        { success: true, results: [] },
      ],
    ],
  ];

  for (const [name, foreignKeyResponse] of malformedResponses)
    await t.test(name, async (t) => {
      const root = temporaryRepo(t);
      mkdirSync(join(root, "migrations"));
      const result = await runRecoveryDrill({
        repoRoot: root,
        execute: successfulExecutor([], { foreignKeyResponse }),
      });

      assert.equal(result.status, "FAIL");
      assert.match(
        readFileSync(result.paths.report, "utf8"),
        /Status: \*\*FAIL\*\*/,
      );
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

test("seeds_a_live_url_link_and_a_deleted_slug_reservation", async (t) => {
  const root = temporaryRepo(t);
  mkdirSync(join(root, "migrations"));
  const result = await runRecoveryDrill({
    repoRoot: root,
    execute: successfulExecutor([]),
  });
  const seed = readFileSync(join(result.paths.source, "seed.sql"), "utf8");

  assert.match(seed, /INSERT INTO distribution_links/);
  assert.match(seed, /'synthetic-recovery-live', 'url'/);
  assert.match(seed, /'synthetic-recovery-deleted', 'url'/);
  assert.match(seed, /DELETE FROM distribution_links/);
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
