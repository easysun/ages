import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  "base64",
);
const PNG_SHA256 =
  "d3c936ebdd73f46e6422d5946044c99d524554082272019ab738800318b04892";
const CAPTURED_AT = "2026-10-12T06:30:00.000Z";
const CREATED_AT = "2026-10-14T00:00:00.000Z";
const EVENT_AT =
  '{"kind":"date","date":"2026-10-13","calendar":"iso8601","time_zone":"Asia/Taipei"}';
const AUTH_ENV_KEYS = [
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_API_KEY",
  "CLOUDFLARE_EMAIL",
  "CLOUDFLARE_ACCOUNT_ID",
  "CF_API_TOKEN",
  "CF_API_KEY",
  "CF_EMAIL",
  "CF_ACCOUNT_ID",
];
const SNAPSHOT_FIELDS = [
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
const LINK_SNAPSHOT_FIELDS = [
  "distribution_link_count",
  "reserved_slug_count",
  "live_link_id",
  "live_link_owner_id",
  "live_link_slug",
  "live_link_target_kind",
  "live_link_target_url",
  "live_link_timeline_id",
  "live_link_asset_id",
  "live_link_active",
  "live_link_expires_at",
  "live_link_created_at",
  "live_link_updated_at",
  "live_slug_reservation_count",
  "deleted_slug_reservation_count",
  "deleted_link_row_count",
];
const LOCAL_ONLY_OVERRIDES = new Set([
  "--",
  "--config",
  "-c",
  "--env",
  "-e",
  "--command",
  "--env-file",
  "--persist-to",
  "--remote",
  "-r",
  "--preview",
  "--profile",
  "--cwd",
  "--local",
]);

function optionName(argument) {
  if (argument === "--") return "--";
  if (argument.startsWith("--")) return argument.split("=", 1)[0];
  if (/^-[ce].+/.test(argument)) return argument.slice(0, 2);
  return argument;
}

class CommandFailure extends Error {
  constructor(label, exitCode, signal) {
    super("A local Wrangler command failed.");
    this.label = label;
    this.exitCode = exitCode;
    this.signal = signal;
  }
}

class VerificationFailure extends Error {
  constructor(mismatches) {
    super("Recovery verification failed.");
    this.mismatches = mismatches;
  }
}

function requireRunId(runId) {
  if (
    typeof runId !== "string" ||
    runId.length === 0 ||
    runId === "." ||
    runId === ".." ||
    /[\\/]/.test(runId) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId)
  )
    throw new Error("Recovery run ID must be one safe path component.");
}

function isBelow(root, target) {
  const pathFromRoot = relative(root, target);
  return (
    pathFromRoot !== "" &&
    pathFromRoot !== ".." &&
    !pathFromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromRoot)
  );
}

function createDirectoryChain(root, target) {
  if (!isBelow(root, target))
    throw new Error("Recovery output path must remain below the repository.");
  let current = root;
  for (const component of relative(root, target).split(sep)) {
    current = join(current, component);
    try {
      const stats = lstatSync(current);
      if (stats.isSymbolicLink() || !stats.isDirectory())
        throw new Error(
          "Recovery output path contains a non-directory or symlink.",
        );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      mkdirSync(current, { mode: 0o700 });
      const stats = lstatSync(current);
      if (stats.isSymbolicLink() || !stats.isDirectory())
        throw new Error(
          "Recovery output path contains a non-directory or symlink.",
        );
    }
  }
}

export function allocateRunDirectory(drillsRoot, runId) {
  requireRunId(runId);
  const requestedRoot = resolve(drillsRoot);
  if (
    basename(requestedRoot) !== "recovery-drills" ||
    basename(dirname(requestedRoot)) !== ".wrangler"
  )
    throw new Error(
      "Recovery runs must be stored under .wrangler/recovery-drills.",
    );

  const repoRoot = realpathSync(resolve(requestedRoot, "../.."));
  const canonicalDrillsRoot = join(repoRoot, ".wrangler", "recovery-drills");
  createDirectoryChain(repoRoot, canonicalDrillsRoot);

  const root = join(canonicalDrillsRoot, runId);
  try {
    lstatSync(root);
    throw new Error("Refusing to reuse an existing recovery run path.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  mkdirSync(root, { mode: 0o700 });

  return {
    root,
    source: join(root, "source"),
    restored: join(root, "restored"),
    backup: join(root, "backup"),
    log: join(root, "commands.jsonl"),
    report: join(root, "report.md.log"),
  };
}

function supportedCommand(commandArgs) {
  return (
    (commandArgs[0] === "d1" &&
      commandArgs[1] === "migrations" &&
      commandArgs[2] === "apply" &&
      commandArgs[3] === "DB") ||
    (commandArgs[0] === "d1" &&
      commandArgs[1] === "execute" &&
      commandArgs[2] === "DB" &&
      commandArgs.includes("--file") &&
      !commandArgs.includes("--command")) ||
    (commandArgs[0] === "d1" &&
      commandArgs[1] === "export" &&
      commandArgs[2] === "DB" &&
      commandArgs.includes("--output") &&
      commandArgs.includes("--no-data") !==
        commandArgs.includes("--no-schema")) ||
    (commandArgs[0] === "r2" &&
      commandArgs[1] === "object" &&
      ["get", "put"].includes(commandArgs[2]) &&
      commandArgs[3] &&
      commandArgs.includes("--file"))
  );
}

export function buildLocalArgs(commandArgs, configPath, persistTo) {
  if (
    !Array.isArray(commandArgs) ||
    !commandArgs.every((argument) => typeof argument === "string") ||
    !isAbsolute(configPath)
  )
    throw new Error(
      "Local Wrangler commands require string args and an absolute scratch config.",
    );

  for (const argument of commandArgs) {
    const option = optionName(argument);
    if (LOCAL_ONLY_OVERRIDES.has(option))
      throw new Error(
        "Command input cannot alter local recovery options or use inline SQL.",
      );
  }
  if (!supportedCommand(commandArgs))
    throw new Error(
      "Unsupported Wrangler command for the local recovery drill.",
    );

  const isExport = commandArgs[0] === "d1" && commandArgs[1] === "export";
  if (isExport && persistTo !== null)
    throw new Error(
      "D1 export uses the scratch config's local persistence path.",
    );
  if (!isExport && (typeof persistTo !== "string" || !isAbsolute(persistTo)))
    throw new Error(
      "Local Wrangler resources require their scratch persistence directory.",
    );

  const args = [...commandArgs, "--config", configPath, "--env", "", "--local"];
  if (!isExport) args.push("--persist-to", persistTo);
  return args;
}

export function makeWranglerEnv(parentEnv, logPath) {
  const childEnv = { ...parentEnv };
  for (const key of AUTH_ENV_KEYS) delete childEnv[key];
  childEnv.DO_NOT_TRACK = "true";
  childEnv.WRANGLER_HIDE_BANNER = "true";
  childEnv.WRANGLER_SEND_METRICS = "false";
  childEnv.WRANGLER_LOG_PATH = logPath;
  return childEnv;
}

export function compareSnapshots(source, restored) {
  const mismatches = SNAPSHOT_FIELDS.filter(
    (field) => !Object.is(source.row[field], restored.row[field]),
  );
  for (const field of ["byteLength", "sha256"])
    if (!Object.is(source.object[field], restored.object[field]))
      mismatches.push(`object.${field}`);
  return mismatches;
}

function normalizeTriggerCaptures(triggerRows, { allowEmpty = false } = {}) {
  if (!Array.isArray(triggerRows) || (!allowEmpty && triggerRows.length === 0))
    throw new Error("Restored D1 trigger capture is empty or malformed.");

  const names = new Set();
  const triggers = triggerRows.map((trigger) => {
    if (
      trigger === null ||
      typeof trigger !== "object" ||
      typeof trigger.name !== "string" ||
      trigger.name.length === 0 ||
      trigger.name.includes("\0") ||
      typeof trigger.sql !== "string" ||
      !/^CREATE\s+(?:TEMP(?:ORARY)?\s+)?TRIGGER\b/i.test(
        trigger.sql.trimStart(),
      )
    )
      throw new Error("Restored D1 trigger capture is empty or malformed.");
    if (names.has(trigger.name))
      throw new Error("Restored D1 trigger capture has duplicate names.");
    names.add(trigger.name);
    return { name: trigger.name, sql: trigger.sql };
  });

  return triggers.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
}

export function buildTriggerReplaySql(triggerRows) {
  const triggers = normalizeTriggerCaptures(triggerRows);
  const dropSql = `${triggers
    .map(({ name }) => `DROP TRIGGER "${name.replaceAll('"', '""')}";`)
    .join("\n")}\n`;
  const createSql = `${triggers
    .map(({ sql }) => {
      const definition = sql.trimEnd();
      return definition.endsWith(";") ? definition : `${definition};`;
    })
    .join("\n")}\n`;
  return { dropSql, createSql };
}

export function compareTriggerCaptures(expectedRows, actualRows) {
  const expected = normalizeTriggerCaptures(expectedRows);
  const actual = normalizeTriggerCaptures(actualRows, { allowEmpty: true });
  const actualByName = new Map(
    actual.map((trigger) => [trigger.name, trigger]),
  );
  const expectedNames = new Set(expected.map((trigger) => trigger.name));
  const mismatches = [];

  for (const trigger of expected) {
    const restored = actualByName.get(trigger.name);
    if (!restored) mismatches.push(`trigger.missing.${trigger.name}`);
    else if (restored.sql !== trigger.sql)
      mismatches.push(`trigger.sql_mismatch.${trigger.name}`);
  }
  for (const trigger of actual)
    if (!expectedNames.has(trigger.name))
      mismatches.push(`trigger.unexpected.${trigger.name}`);

  return mismatches;
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function makeRunId() {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
}

function makeScratchConfig(directory, role, suffix, repoRoot) {
  const name = `ages-recovery-${role}-${suffix}`;
  const configPath = join(directory, "wrangler.jsonc");
  const config = {
    name,
    send_metrics: false,
    d1_databases: [
      {
        binding: "DB",
        database_name: name,
        database_id: randomUUID(),
        migrations_dir: join(repoRoot, "migrations"),
      },
    ],
    r2_buckets: [
      {
        binding: "MEDIA",
        bucket_name: `ages-recovery-${role}-${suffix}`,
      },
    ],
  };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, {
    flag: "wx",
  });
  return {
    path: configPath,
    bucket: config.r2_buckets[0].bucket_name,
    persist: join(directory, ".wrangler", "state"),
  };
}

function appendLog(logPath, record) {
  appendFileSync(logPath, `${JSON.stringify(record)}\n`, "utf8");
}

function asText(output) {
  if (Buffer.isBuffer(output)) return output.toString("utf8");
  return typeof output === "string" ? output : "";
}

function rowsFromD1(output) {
  let parsed;
  try {
    parsed = JSON.parse(asText(output).trim());
  } catch {
    throw new Error("D1 snapshot query returned invalid JSON.");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.some((statement) => statement.success === false)
  )
    throw new Error(
      "D1 snapshot query did not return a successful JSON result.",
    );
  return parsed.flatMap((statement) =>
    Array.isArray(statement.results) ? statement.results : [],
  );
}

function rowsFromSingleD1Statement(output) {
  let parsed;
  try {
    parsed = JSON.parse(asText(output).trim());
  } catch {
    throw new Error("D1 check query returned invalid JSON.");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 1 ||
    parsed[0]?.success !== true ||
    !Array.isArray(parsed[0].results)
  )
    throw new Error(
      "D1 check query did not return one successful statement with result rows.",
    );
  return parsed[0].results;
}

function fileFacts(filePath) {
  const bytes = readFileSync(filePath);
  return {
    byteLength: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function expectedRowMismatches(row, ids) {
  const expected = {
    storage_limit_bytes: 1048576,
    storage_used_bytes: 69,
    max_asset_bytes: 262144,
    timeline_limit: 10,
    link_limit: 10,
    asset_id: ids.assetId,
    asset_status: "ready",
    asset_original_name: "probe-image.png",
    asset_mime_type: "image/png",
    asset_size_bytes: 69,
    asset_r2_key: ids.r2Key,
    asset_captured_at: CAPTURED_AT,
    asset_width: 1,
    asset_height: 1,
    asset_visibility: "private",
    timeline_id: ids.timelineId,
    timeline_title: "Synthetic recovery timeline",
    timeline_visibility: "private",
    timeline_item_id: ids.itemId,
    timeline_item_asset_id: ids.assetId,
    timeline_item_position: 0,
    timeline_item_caption: "Synthetic recovery item",
    timeline_item_event_at: EVENT_AT,
  };
  return SNAPSHOT_FIELDS.filter(
    (field) => !Object.is(row[field], expected[field]),
  );
}

function expectedLinkRowMismatches(row, ids) {
  const expected = {
    distribution_link_count: 1,
    reserved_slug_count: 2,
    live_link_id: ids.linkId,
    live_link_owner_id: ids.userId,
    live_link_slug: "synthetic-recovery-live",
    live_link_target_kind: "url",
    live_link_target_url: "https://example.invalid/synthetic-recovery",
    live_link_timeline_id: null,
    live_link_asset_id: null,
    live_link_active: 1,
    live_link_expires_at: null,
    live_link_created_at: CREATED_AT,
    live_link_updated_at: CREATED_AT,
    live_slug_reservation_count: 1,
    deleted_slug_reservation_count: 1,
    deleted_link_row_count: 0,
  };
  return LINK_SNAPSHOT_FIELDS.filter(
    (field) => !Object.is(row[field], expected[field]),
  );
}

function expectedLinkProbeMismatches(row) {
  const expected = {
    distribution_link_count: 2,
    reserved_slug_count: 3,
    probe_link_count: 1,
    probe_slug_reservation_count: 1,
    deleted_slug_reservation_count: 1,
    deleted_link_row_count: 0,
  };
  return Object.keys(expected).filter(
    (field) => !Object.is(row[field], expected[field]),
  );
}

function formatObject(facts) {
  return facts
    ? `${facts.byteLength} bytes; SHA-256 ${facts.sha256}`
    : "not verified";
}

function writeFinalEvidence(paths, result) {
  const objectFacts = result.objectFacts;
  const failure = result.commandFailure
    ? `Command failed: ${result.commandFailure.label} (exit ${result.commandFailure.exitCode ?? "unknown"}${result.commandFailure.signal ? `, signal ${result.commandFailure.signal}` : ""}).`
    : result.failureMessage;
  const report = [
    "# Local synthetic recovery drill",
    "",
    `Status: **${result.status}**`,
    `Run directory: \`${paths.root}\``,
    `Wrangler commands completed or attempted: ${result.commandCount}`,
    `Source D1 joined rows: ${result.sourceRowCount ?? "not verified"}`,
    `Restored D1 joined rows: ${result.restoredRowCount ?? "not verified"}`,
    `Source D1 Link rows: ${result.sourceLinkRowCount ?? "not verified"}`,
    `Restored D1 Link rows: ${result.restoredLinkRowCount ?? "not verified"}`,
    `D1 field mismatches: ${result.mismatches.length ? result.mismatches.join(", ") : result.status === "PASS" ? "none" : "not verified"}`,
    "",
    "## R2 object bytes",
    "",
    `- Original synthetic PNG: ${formatObject(objectFacts.original)}`,
    `- Source R2 backup: ${formatObject(objectFacts.backup)}`,
    `- Restored R2 object: ${formatObject(objectFacts.restored)}`,
    `- Restored R2 Content-Type was requested as \`${result.restoreMimeType ?? "not verified"}\` from source D1 \`mime_type\`. The installed Wrangler CLI does not independently read back stored R2 HTTP metadata.`,
    "",
    "## Recovery comparisons",
    "",
    ...(result.comparisons
      ? Object.entries(result.comparisons).map(
          ([name, passed]) => `- ${name}: ${passed ? "PASS" : "FAIL"}`,
        )
      : ["- Not completed."]),
    "",
    failure
      ? `Failure: ${failure}`
      : "All local command and recovery comparisons passed.",
    "",
    "This is a synthetic local rehearsal. It does not validate Cloudflare recovery, production consistency, retention, Time Travel, cutover, or rollback.",
    "",
    `Structured command and comparison records: \`${paths.log}\``,
    "",
  ].join("\n");
  writeFileSync(paths.report, report, { flag: "wx", encoding: "utf8" });

  appendLog(paths.log, {
    event: "summary",
    status: result.status,
    command_count: result.commandCount,
    source_row_count: result.sourceRowCount ?? null,
    restored_row_count: result.restoredRowCount ?? null,
    source_link_row_count: result.sourceLinkRowCount ?? null,
    restored_link_row_count: result.restoredLinkRowCount ?? null,
    d1_mismatches: result.mismatches,
    comparisons: result.comparisons,
    object: {
      original: objectFacts.original,
      backup: objectFacts.backup,
      restored: objectFacts.restored,
      content_type_readback: "not available in installed Wrangler CLI",
    },
    failure: failure ?? null,
  });
}

function createSeedSql(ids) {
  return [
    `INSERT INTO users (id, email, display_name, plan, created_at, updated_at) VALUES (${sqlString(ids.userId)}, ${sqlString(`${ids.userId}@example.invalid`)}, 'Synthetic recovery drill', 'free', ${sqlString(CREATED_AT)}, ${sqlString(CREATED_AT)});`,
    `INSERT INTO usage_quotas (user_id, storage_limit_bytes, storage_used_bytes, max_asset_bytes, timeline_limit, link_limit, updated_at) VALUES (${sqlString(ids.userId)}, 1048576, 0, 262144, 10, 10, ${sqlString(CREATED_AT)});`,
    `INSERT INTO assets (id, owner_id, kind, status, original_name, mime_type, size_bytes, r2_key, captured_at, width, height, visibility, upload_expires_at, created_at, updated_at) VALUES (${sqlString(ids.assetId)}, ${sqlString(ids.userId)}, 'image', 'pending', 'probe-image.png', 'image/png', 69, ${sqlString(ids.r2Key)}, ${sqlString(CAPTURED_AT)}, 1, 1, 'private', '2026-10-15T00:00:00.000Z', ${sqlString(CREATED_AT)}, ${sqlString(CREATED_AT)});`,
    `UPDATE assets SET status = 'ready', updated_at = ${sqlString(CREATED_AT)} WHERE id = ${sqlString(ids.assetId)} AND status = 'pending';`,
    `INSERT INTO timelines (id, owner_id, title, visibility, cover_asset_id, created_at, updated_at) VALUES (${sqlString(ids.timelineId)}, ${sqlString(ids.userId)}, 'Synthetic recovery timeline', 'private', ${sqlString(ids.assetId)}, ${sqlString(CREATED_AT)}, ${sqlString(CREATED_AT)});`,
    `INSERT INTO timeline_items (id, timeline_id, owner_id, asset_id, position, caption, event_at, created_at, updated_at) VALUES (${sqlString(ids.itemId)}, ${sqlString(ids.timelineId)}, ${sqlString(ids.userId)}, ${sqlString(ids.assetId)}, 0, 'Synthetic recovery item', ${sqlString(EVENT_AT)}, ${sqlString(CREATED_AT)}, ${sqlString(CREATED_AT)});`,
    `INSERT INTO distribution_links (id, owner_id, slug, target_kind, target_url, active, created_at, updated_at) VALUES (${sqlString(ids.linkId)}, ${sqlString(ids.userId)}, 'synthetic-recovery-live', 'url', 'https://example.invalid/synthetic-recovery', 1, ${sqlString(CREATED_AT)}, ${sqlString(CREATED_AT)});`,
    `INSERT INTO distribution_links (id, owner_id, slug, target_kind, target_url, active, created_at, updated_at) VALUES (${sqlString(ids.deletedLinkId)}, ${sqlString(ids.userId)}, 'synthetic-recovery-deleted', 'url', 'https://example.invalid/deleted-synthetic-recovery', 0, ${sqlString(CREATED_AT)}, ${sqlString(CREATED_AT)});`,
    `DELETE FROM distribution_links WHERE id = ${sqlString(ids.deletedLinkId)};`,
    "",
  ].join("\n");
}

function createSnapshotSql(ids) {
  return [
    "SELECT",
    "  q.storage_limit_bytes, q.storage_used_bytes, q.max_asset_bytes, q.timeline_limit, q.link_limit,",
    "  a.id AS asset_id, a.status AS asset_status, a.original_name AS asset_original_name,",
    "  a.mime_type AS asset_mime_type, a.size_bytes AS asset_size_bytes, a.r2_key AS asset_r2_key,",
    "  a.captured_at AS asset_captured_at, a.width AS asset_width, a.height AS asset_height,",
    "  a.visibility AS asset_visibility, t.id AS timeline_id, t.title AS timeline_title,",
    "  t.visibility AS timeline_visibility, ti.id AS timeline_item_id,",
    "  ti.asset_id AS timeline_item_asset_id, ti.position AS timeline_item_position,",
    "  ti.caption AS timeline_item_caption, ti.event_at AS timeline_item_event_at",
    "FROM users u",
    "JOIN usage_quotas q ON q.user_id = u.id",
    "JOIN assets a ON a.owner_id = u.id",
    "JOIN timelines t ON t.owner_id = u.id",
    "JOIN timeline_items ti ON ti.timeline_id = t.id AND ti.asset_id = a.id AND ti.owner_id = u.id",
    `WHERE u.id = ${sqlString(ids.userId)}`,
    `  AND a.id = ${sqlString(ids.assetId)}`,
    `  AND t.id = ${sqlString(ids.timelineId)}`,
    `  AND ti.id = ${sqlString(ids.itemId)};`,
    "",
  ].join("\n");
}

function createLinkSnapshotSql(ids) {
  return [
    "SELECT",
    "  (SELECT count(*) FROM distribution_links) AS distribution_link_count,",
    "  (SELECT count(*) FROM reserved_link_slugs) AS reserved_slug_count,",
    "  live_link.id AS live_link_id, live_link.owner_id AS live_link_owner_id,",
    "  live_link.slug AS live_link_slug, live_link.target_kind AS live_link_target_kind,",
    "  live_link.target_url AS live_link_target_url, live_link.timeline_id AS live_link_timeline_id,",
    "  live_link.asset_id AS live_link_asset_id, live_link.active AS live_link_active,",
    "  live_link.expires_at AS live_link_expires_at, live_link.created_at AS live_link_created_at,",
    "  live_link.updated_at AS live_link_updated_at,",
    `  (SELECT count(*) FROM reserved_link_slugs WHERE slug = ${sqlString("synthetic-recovery-live")}) AS live_slug_reservation_count,`,
    `  (SELECT count(*) FROM reserved_link_slugs WHERE slug = ${sqlString("synthetic-recovery-deleted")}) AS deleted_slug_reservation_count,`,
    `  (SELECT count(*) FROM distribution_links WHERE slug = ${sqlString("synthetic-recovery-deleted")}) AS deleted_link_row_count`,
    "FROM distribution_links live_link",
    `WHERE live_link.id = ${sqlString(ids.linkId)}`,
    `  AND live_link.owner_id = ${sqlString(ids.userId)};`,
    "",
  ].join("\n");
}

function createTriggerSnapshotSql() {
  return "SELECT name, sql FROM sqlite_schema WHERE type = 'trigger' ORDER BY name;\n";
}

function createLinkReservationProbeSql(ids) {
  return [
    "INSERT INTO distribution_links (id, owner_id, slug, target_kind, target_url, active, created_at, updated_at)",
    `VALUES (${sqlString(ids.probeLinkId)}, ${sqlString(ids.userId)}, 'synthetic-recovery-probe', 'url', 'https://example.invalid/recovery-probe', 1, ${sqlString(CREATED_AT)}, ${sqlString(CREATED_AT)});`,
    "",
  ].join("\n");
}

function createTombstoneReuseProbeSql(ids) {
  return [
    "-- reuse-tombstoned-link-probe",
    "INSERT INTO distribution_links (id, owner_id, slug, target_kind, target_url, active, created_at, updated_at)",
    `VALUES (${sqlString(ids.reuseLinkId)}, ${sqlString(ids.userId)}, 'synthetic-recovery-deleted', 'url', 'https://example.invalid/reused-synthetic-recovery', 1, ${sqlString(CREATED_AT)}, ${sqlString(CREATED_AT)});`,
    "",
  ].join("\n");
}

function createLinkProbeSnapshotSql(ids) {
  return [
    "SELECT",
    "  (SELECT count(*) FROM distribution_links) AS distribution_link_count,",
    "  (SELECT count(*) FROM reserved_link_slugs) AS reserved_slug_count,",
    `  (SELECT count(*) FROM distribution_links WHERE id = ${sqlString(ids.probeLinkId)} AND owner_id = ${sqlString(ids.userId)} AND slug = 'synthetic-recovery-probe' AND target_kind = 'url' AND target_url = 'https://example.invalid/recovery-probe' AND active = 1) AS probe_link_count,`,
    "  (SELECT count(*) FROM reserved_link_slugs WHERE slug = 'synthetic-recovery-probe') AS probe_slug_reservation_count,",
    "  (SELECT count(*) FROM reserved_link_slugs WHERE slug = 'synthetic-recovery-deleted') AS deleted_slug_reservation_count,",
    "  (SELECT count(*) FROM distribution_links WHERE slug = 'synthetic-recovery-deleted') AS deleted_link_row_count;",
    "",
  ].join("\n");
}

function isExpectedSlugReservationConflict(error) {
  const output = [
    error.message,
    asText(error.stdout),
    asText(error.stderr),
  ].join("\n");
  return (
    typeof error.status === "number" &&
    error.status !== 0 &&
    !error.signal &&
    /UNIQUE constraint failed:\s*reserved_link_slugs\.slug\b/.test(output)
  );
}

function verifyObjectFacts(name, facts) {
  const mismatches = [];
  if (facts.byteLength !== PNG.byteLength)
    mismatches.push(`${name}.byteLength`);
  if (facts.sha256 !== PNG_SHA256) mismatches.push(`${name}.sha256`);
  return mismatches;
}

export function runRecoveryDrill({
  repoRoot = REPO_ROOT,
  execute = execFileSync,
} = {}) {
  const canonicalRepoRoot = realpathSync(resolve(repoRoot));
  const paths = allocateRunDirectory(
    join(canonicalRepoRoot, ".wrangler", "recovery-drills"),
    makeRunId(),
  );
  const suffix = paths.root.slice(-36).replaceAll("-", "");
  const wranglerEntry = join(
    canonicalRepoRoot,
    "node_modules",
    "wrangler",
    "bin",
    "wrangler.js",
  );
  const wranglerLogs = join(paths.root, "wrangler-logs");
  const childEnv = makeWranglerEnv(process.env, wranglerLogs);
  let sourceConfig;
  let restoredConfig;
  const commandRecords = [];
  const result = {
    status: "FAIL",
    paths,
    commandCount: 0,
    commandFailure: null,
    failureMessage: null,
    sourceRowCount: null,
    restoredRowCount: null,
    sourceLinkRowCount: null,
    restoredLinkRowCount: null,
    mismatches: [],
    comparisons: null,
    objectFacts: { original: null, backup: null, restored: null },
    restoreMimeType: null,
  };

  function runCommand(label, commandArgs, role, acceptFailure = null) {
    const config = role === "restored" ? restoredConfig : sourceConfig;
    const persistTo =
      commandArgs[0] === "d1" && commandArgs[1] === "export"
        ? null
        : config.persist;
    const args = buildLocalArgs(commandArgs, config.path, persistTo);
    const argv = [wranglerEntry, ...args];
    const record = {
      event: "command",
      label,
      at: new Date().toISOString(),
      argv: [process.execPath, ...argv],
    };
    let output;
    let error;
    try {
      output = execute(process.execPath, argv, {
        cwd: role === "restored" ? paths.restored : paths.source,
        env: childEnv,
        encoding: "utf8",
        maxBuffer: 20 * 1024 * 1024,
        shell: false,
      });
    } catch (caught) {
      error = caught;
    }
    const acceptedFailure = Boolean(error && acceptFailure?.(error));
    record.exit_code = error
      ? typeof error.status === "number"
        ? error.status
        : null
      : 0;
    record.signal = error?.signal ?? null;
    if (acceptedFailure) record.expected_failure = true;
    appendLog(paths.log, record);
    commandRecords.push(record);
    result.commandCount = commandRecords.length;

    if (error && acceptedFailure) return { expectedFailure: true };
    if (error) throw new CommandFailure(label, record.exit_code, record.signal);
    if (acceptFailure)
      throw new VerificationFailure([
        "tombstoned_slug_reuse_unexpectedly_succeeded",
      ]);
    return output;
  }

  const ids = {
    userId: `synthetic-user-${randomUUID()}`,
    assetId: `synthetic-asset-${randomUUID()}`,
    timelineId: `synthetic-timeline-${randomUUID()}`,
    itemId: `synthetic-item-${randomUUID()}`,
    linkId: `synthetic-link-${randomUUID()}`,
    deletedLinkId: `synthetic-deleted-link-${randomUUID()}`,
    probeLinkId: `synthetic-probe-link-${randomUUID()}`,
    reuseLinkId: `synthetic-reuse-link-${randomUUID()}`,
  };
  ids.r2Key = `originals/${ids.userId}/${ids.assetId}/probe-image.png`;

  const originalPng = join(paths.root, "synthetic.png");
  const backupPng = join(paths.backup, "synthetic.png");
  const restoredPng = join(paths.restored, "synthetic.png");
  const schemaExport = join(paths.backup, "d1-schema.sql");
  const dataExport = join(paths.backup, "d1-data.sql");
  const seedFile = join(paths.source, "seed.sql");
  const snapshotFile = join(paths.source, "snapshot.sql");
  const linkSnapshotFile = join(paths.source, "links-snapshot.sql");
  const triggerSnapshotFile = join(paths.restored, "trigger-snapshot.sql");
  const triggerDropFile = join(paths.restored, "drop-triggers.sql");
  const triggerCreateFile = join(paths.restored, "create-triggers.sql");
  const linkReservationProbeFile = join(
    paths.restored,
    "link-reservation-probe.sql",
  );
  const tombstoneReuseProbeFile = join(
    paths.restored,
    "tombstoned-link-reuse-probe.sql",
  );
  const linkProbeSnapshotFile = join(paths.restored, "link-probe-snapshot.sql");
  const quickCheckFile = join(paths.restored, "quick-check.sql");
  const foreignKeyCheckFile = join(paths.restored, "foreign-key-check.sql");
  const expectedRow = {
    source: null,
    restored: null,
  };
  const expectedLink = {
    source: null,
    restored: null,
  };

  try {
    for (const directory of [
      paths.source,
      paths.restored,
      paths.backup,
      wranglerLogs,
    ])
      mkdirSync(directory, { mode: 0o700 });
    writeFileSync(paths.log, "", { flag: "wx" });
    sourceConfig = makeScratchConfig(
      paths.source,
      "source",
      suffix,
      canonicalRepoRoot,
    );
    restoredConfig = makeScratchConfig(
      paths.restored,
      "restored",
      suffix,
      canonicalRepoRoot,
    );

    if (
      PNG.byteLength !== 69 ||
      createHash("sha256").update(PNG).digest("hex") !== PNG_SHA256
    )
      throw new Error(
        "The built-in synthetic PNG does not match its expected bytes.",
      );
    writeFileSync(originalPng, PNG, { flag: "wx" });
    result.objectFacts.original = fileFacts(originalPng);

    runCommand(
      "Apply repository migrations to synthetic source D1",
      ["d1", "migrations", "apply", "DB"],
      "source",
    );

    runCommand(
      "Write the synthetic PNG to source R2",
      [
        "r2",
        "object",
        "put",
        `${sourceConfig.bucket}/${ids.r2Key}`,
        "--file",
        originalPng,
        "--content-type",
        "image/png",
      ],
      "source",
    );

    writeFileSync(seedFile, createSeedSql(ids), {
      flag: "wx",
      encoding: "utf8",
    });
    writeFileSync(snapshotFile, createSnapshotSql(ids), {
      flag: "wx",
      encoding: "utf8",
    });
    writeFileSync(linkSnapshotFile, createLinkSnapshotSql(ids), {
      flag: "wx",
      encoding: "utf8",
    });
    writeFileSync(triggerSnapshotFile, createTriggerSnapshotSql(), {
      flag: "wx",
      encoding: "utf8",
    });
    writeFileSync(
      linkReservationProbeFile,
      createLinkReservationProbeSql(ids),
      {
        flag: "wx",
        encoding: "utf8",
      },
    );
    writeFileSync(tombstoneReuseProbeFile, createTombstoneReuseProbeSql(ids), {
      flag: "wx",
      encoding: "utf8",
    });
    writeFileSync(linkProbeSnapshotFile, createLinkProbeSnapshotSql(ids), {
      flag: "wx",
      encoding: "utf8",
    });
    writeFileSync(quickCheckFile, "PRAGMA quick_check;\n", {
      flag: "wx",
      encoding: "utf8",
    });
    writeFileSync(foreignKeyCheckFile, "PRAGMA foreign_key_check;\n", {
      flag: "wx",
      encoding: "utf8",
    });
    runCommand(
      "Seed the synthetic user, quota, Asset, Timeline, and item",
      ["d1", "execute", "DB", "--file", seedFile],
      "source",
    );

    const sourceRows = rowsFromD1(
      runCommand(
        "Query the source D1 recovery relationship",
        ["d1", "execute", "DB", "--file", snapshotFile, "--json"],
        "source",
      ),
    );
    result.sourceRowCount = sourceRows.length;
    if (sourceRows.length !== 1)
      throw new VerificationFailure(["source.joined_row_count"]);
    expectedRow.source = sourceRows[0];
    const sourceMismatches = expectedRowMismatches(expectedRow.source, ids);
    if (sourceMismatches.length)
      throw new VerificationFailure(sourceMismatches);

    const sourceLinkRows = rowsFromD1(
      runCommand(
        "Query source distribution Links and reserved slugs",
        ["d1", "execute", "DB", "--file", linkSnapshotFile, "--json"],
        "source",
      ),
    );
    result.sourceLinkRowCount = sourceLinkRows.length;
    if (sourceLinkRows.length !== 1)
      throw new VerificationFailure(["source.link_snapshot_row_count"]);
    expectedLink.source = sourceLinkRows[0];
    const sourceLinkMismatches = expectedLinkRowMismatches(
      expectedLink.source,
      ids,
    );
    if (sourceLinkMismatches.length)
      throw new VerificationFailure(sourceLinkMismatches);

    runCommand(
      "Export source D1 schema without data",
      ["d1", "export", "DB", "--no-data", "--output", schemaExport],
      "source",
    );
    runCommand(
      "Export source D1 data without schema",
      ["d1", "export", "DB", "--no-schema", "--output", dataExport],
      "source",
    );

    runCommand(
      "Retrieve the source R2 object backup",
      [
        "r2",
        "object",
        "get",
        `${sourceConfig.bucket}/${expectedRow.source.asset_r2_key}`,
        "--file",
        backupPng,
      ],
      "source",
    );
    result.objectFacts.backup = fileFacts(backupPng);
    const sourceObjectMismatches = verifyObjectFacts(
      "source",
      result.objectFacts.original,
    ).concat(verifyObjectFacts("backup", result.objectFacts.backup));
    if (
      result.objectFacts.original.byteLength !==
        result.objectFacts.backup.byteLength ||
      result.objectFacts.original.sha256 !== result.objectFacts.backup.sha256
    )
      sourceObjectMismatches.push("source-to-backup.object");
    if (sourceObjectMismatches.length)
      throw new VerificationFailure(sourceObjectMismatches);

    runCommand(
      "Restore source D1 schema into the fresh synthetic database",
      ["d1", "execute", "DB", "--file", schemaExport],
      "restored",
    );

    const capturedTriggers = rowsFromD1(
      runCommand(
        "Capture restored D1 triggers before row replay",
        ["d1", "execute", "DB", "--file", triggerSnapshotFile, "--json"],
        "restored",
      ),
    );
    const triggerReplaySql = buildTriggerReplaySql(capturedTriggers);
    writeFileSync(triggerDropFile, triggerReplaySql.dropSql, {
      flag: "wx",
      encoding: "utf8",
    });
    writeFileSync(triggerCreateFile, triggerReplaySql.createSql, {
      flag: "wx",
      encoding: "utf8",
    });
    runCommand(
      "Drop restored D1 triggers for row replay",
      ["d1", "execute", "DB", "--file", triggerDropFile],
      "restored",
    );
    runCommand(
      "Restore source D1 rows after schema and indexes",
      ["d1", "execute", "DB", "--file", dataExport],
      "restored",
    );
    runCommand(
      "Reinstall the captured D1 triggers",
      ["d1", "execute", "DB", "--file", triggerCreateFile],
      "restored",
    );
    const restoredTriggers = rowsFromD1(
      runCommand(
        "Verify restored D1 trigger definitions",
        ["d1", "execute", "DB", "--file", triggerSnapshotFile, "--json"],
        "restored",
      ),
    );
    const triggerMismatches = compareTriggerCaptures(
      capturedTriggers,
      restoredTriggers,
    );
    if (triggerMismatches.length)
      throw new VerificationFailure(triggerMismatches);

    result.restoreMimeType = expectedRow.source.asset_mime_type;
    runCommand(
      "Restore the R2 object using source D1 MIME metadata",
      [
        "r2",
        "object",
        "put",
        `${restoredConfig.bucket}/${expectedRow.source.asset_r2_key}`,
        "--file",
        backupPng,
        "--content-type",
        result.restoreMimeType,
      ],
      "restored",
    );

    const restoredRows = rowsFromD1(
      runCommand(
        "Query the restored D1 recovery relationship",
        ["d1", "execute", "DB", "--file", snapshotFile, "--json"],
        "restored",
      ),
    );
    result.restoredRowCount = restoredRows.length;
    if (restoredRows.length !== 1)
      throw new VerificationFailure(["restored.joined_row_count"]);
    expectedRow.restored = restoredRows[0];
    const restoredMismatches = expectedRowMismatches(expectedRow.restored, ids);
    if (restoredMismatches.length)
      throw new VerificationFailure(restoredMismatches);

    const restoredLinkRows = rowsFromD1(
      runCommand(
        "Query restored distribution Links and reserved slugs",
        ["d1", "execute", "DB", "--file", linkSnapshotFile, "--json"],
        "restored",
      ),
    );
    result.restoredLinkRowCount = restoredLinkRows.length;
    if (restoredLinkRows.length !== 1)
      throw new VerificationFailure(["restored.link_snapshot_row_count"]);
    expectedLink.restored = restoredLinkRows[0];
    const restoredLinkMismatches = expectedLinkRowMismatches(
      expectedLink.restored,
      ids,
    );
    if (restoredLinkMismatches.length)
      throw new VerificationFailure(restoredLinkMismatches);
    const linkSnapshotMismatches = LINK_SNAPSHOT_FIELDS.filter(
      (field) =>
        !Object.is(expectedLink.source[field], expectedLink.restored[field]),
    ).map((field) => `link.${field}`);
    if (linkSnapshotMismatches.length)
      throw new VerificationFailure(linkSnapshotMismatches);

    runCommand(
      "Retrieve the restored R2 object for byte comparison",
      [
        "r2",
        "object",
        "get",
        `${restoredConfig.bucket}/${expectedRow.restored.asset_r2_key}`,
        "--file",
        restoredPng,
      ],
      "restored",
    );
    result.objectFacts.restored = fileFacts(restoredPng);
    const restoredObjectMismatches = verifyObjectFacts(
      "restored",
      result.objectFacts.restored,
    );
    if (
      result.objectFacts.backup.byteLength !==
        result.objectFacts.restored.byteLength ||
      result.objectFacts.backup.sha256 !== result.objectFacts.restored.sha256
    )
      restoredObjectMismatches.push("backup-to-restored.object");
    if (restoredObjectMismatches.length)
      throw new VerificationFailure(restoredObjectMismatches);

    const mismatches = compareSnapshots(
      { row: expectedRow.source, object: result.objectFacts.backup },
      { row: expectedRow.restored, object: result.objectFacts.restored },
    );
    result.mismatches = mismatches;
    if (mismatches.length) throw new VerificationFailure(mismatches);
    if (
      result.objectFacts.original.byteLength !==
        expectedRow.source.asset_size_bytes ||
      result.objectFacts.backup.byteLength !==
        expectedRow.source.asset_size_bytes ||
      result.objectFacts.restored.byteLength !==
        expectedRow.restored.asset_size_bytes
    )
      throw new VerificationFailure(["asset_to_object.size"]);

    result.comparisons = {
      triggers_restored_exactly: true,
      distribution_link_count_is_one:
        expectedLink.source.distribution_link_count === 1 &&
        expectedLink.restored.distribution_link_count === 1,
      reserved_slug_count_is_two:
        expectedLink.source.reserved_slug_count === 2 &&
        expectedLink.restored.reserved_slug_count === 2,
      live_url_link_preserved:
        expectedLink.source.live_link_target_kind === "url" &&
        expectedLink.source.live_link_active === 1 &&
        expectedLink.restored.live_link_target_kind === "url" &&
        expectedLink.restored.live_link_active === 1,
      deleted_slug_reservation_preserved:
        expectedLink.source.deleted_slug_reservation_count === 1 &&
        expectedLink.source.deleted_link_row_count === 0 &&
        expectedLink.restored.deleted_slug_reservation_count === 1 &&
        expectedLink.restored.deleted_link_row_count === 0,
      link_snapshot_preserved: linkSnapshotMismatches.length === 0,
      quota_used_is_69_bytes:
        expectedRow.source.storage_used_bytes === 69 &&
        expectedRow.restored.storage_used_bytes === 69,
      quota_usage_matches_asset_size:
        expectedRow.source.storage_used_bytes ===
          expectedRow.source.asset_size_bytes &&
        expectedRow.restored.storage_used_bytes ===
          expectedRow.restored.asset_size_bytes,
      captured_at_preserved:
        expectedRow.source.asset_captured_at === CAPTURED_AT &&
        expectedRow.source.asset_captured_at ===
          expectedRow.restored.asset_captured_at,
      timeline_event_at_preserved:
        expectedRow.source.timeline_item_event_at === EVENT_AT &&
        expectedRow.source.timeline_item_event_at ===
          expectedRow.restored.timeline_item_event_at,
      asset_visibility_private:
        expectedRow.source.asset_visibility === "private" &&
        expectedRow.restored.asset_visibility === "private",
      timeline_visibility_private:
        expectedRow.source.timeline_visibility === "private" &&
        expectedRow.restored.timeline_visibility === "private",
      mime_type_image_png:
        expectedRow.source.asset_mime_type === "image/png" &&
        expectedRow.restored.asset_mime_type === "image/png",
      timeline_item_asset_relationship:
        expectedRow.source.timeline_item_asset_id ===
          expectedRow.source.asset_id &&
        expectedRow.restored.timeline_item_asset_id ===
          expectedRow.restored.asset_id &&
        expectedRow.source.asset_id === expectedRow.restored.asset_id,
      original_backup_restored_size:
        result.objectFacts.original.byteLength ===
          result.objectFacts.backup.byteLength &&
        result.objectFacts.backup.byteLength ===
          result.objectFacts.restored.byteLength,
      original_backup_restored_sha256:
        result.objectFacts.original.sha256 ===
          result.objectFacts.backup.sha256 &&
        result.objectFacts.backup.sha256 === result.objectFacts.restored.sha256,
    };

    runCommand(
      "Probe restored Link reservation trigger",
      ["d1", "execute", "DB", "--file", linkReservationProbeFile],
      "restored",
    );
    const reuseResult = runCommand(
      "Verify restored tombstoned slug cannot be reused",
      ["d1", "execute", "DB", "--file", tombstoneReuseProbeFile],
      "restored",
      isExpectedSlugReservationConflict,
    );
    if (!reuseResult?.expectedFailure)
      throw new VerificationFailure(["tombstoned_slug_reuse_not_rejected"]);

    const linkProbeRows = rowsFromD1(
      runCommand(
        "Verify restored Link reservation probe state",
        ["d1", "execute", "DB", "--file", linkProbeSnapshotFile, "--json"],
        "restored",
      ),
    );
    if (linkProbeRows.length !== 1)
      throw new VerificationFailure(["restored.link_probe_row_count"]);
    const linkProbeMismatches = expectedLinkProbeMismatches(linkProbeRows[0]);
    if (linkProbeMismatches.length)
      throw new VerificationFailure(linkProbeMismatches);
    result.comparisons.probe_link_reserves_slug =
      linkProbeRows[0].probe_link_count === 1 &&
      linkProbeRows[0].probe_slug_reservation_count === 1;
    result.comparisons.tombstoned_slug_reuse_rejected =
      reuseResult.expectedFailure &&
      linkProbeRows[0].deleted_slug_reservation_count === 1 &&
      linkProbeRows[0].deleted_link_row_count === 0;

    const quickCheckRows = rowsFromD1(
      runCommand(
        "Check restored D1 quick_check",
        ["d1", "execute", "DB", "--file", quickCheckFile, "--json"],
        "restored",
      ),
    );
    if (quickCheckRows.length !== 1 || quickCheckRows[0].quick_check !== "ok")
      throw new VerificationFailure(["restored.quick_check"]);
    result.comparisons.quick_check_ok = true;

    const foreignKeyRows = rowsFromSingleD1Statement(
      runCommand(
        "Check restored D1 foreign keys",
        ["d1", "execute", "DB", "--file", foreignKeyCheckFile, "--json"],
        "restored",
      ),
    );
    if (foreignKeyRows.length !== 0)
      throw new VerificationFailure(["restored.foreign_key_check"]);
    result.comparisons.foreign_key_check_clear = true;

    const failedComparisons = Object.entries(result.comparisons)
      .filter(([, passed]) => !passed)
      .map(([name]) => name);
    if (failedComparisons.length)
      throw new VerificationFailure(failedComparisons);

    result.status = "PASS";
  } catch (error) {
    result.status = "FAIL";
    if (error instanceof CommandFailure) {
      result.commandFailure = {
        label: error.label,
        exitCode: error.exitCode,
        signal: error.signal,
      };
    } else if (error instanceof VerificationFailure) {
      result.mismatches = error.mismatches;
      result.failureMessage = `Verification mismatches: ${error.mismatches.join(", ")}.`;
    } else {
      result.failureMessage =
        error instanceof Error ? error.message : "Recovery drill failed.";
    }
  }

  result.commandCount = commandRecords.length;
  writeFinalEvidence(paths, result);
  return result;
}

function validateCliArgs(args) {
  if (args.length)
    throw new Error(
      "The recovery drill accepts no arguments. Usage: npm run recovery:drill",
    );
}

function main() {
  try {
    validateCliArgs(process.argv.slice(2));
    const result = runRecoveryDrill();
    const state = result.status === "PASS" ? "PASS" : "FAIL";
    console.log(
      `Local recovery drill ${state}. Evidence: ${result.paths.report}`,
    );
    if (result.status !== "PASS") process.exitCode = 1;
  } catch (error) {
    console.error(
      error instanceof Error
        ? error.message
        : "Local recovery drill could not start.",
    );
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main();
