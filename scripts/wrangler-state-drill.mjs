import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  constants,
  copyFileSync,
  cpSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
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
import { allocateRunDirectory, makeWranglerEnv } from "./recovery-drill.mjs";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  "base64",
);
const PNG_SHA256 =
  "d3c936ebdd73f46e6422d5946044c99d524554082272019ab738800318b04892";
const PROBE = {
  id: "synthetic-state-probe",
  r2Key: "recovery/probe-image.png",
  kvKey: "recovery/probe-cache-key",
  kvValue: "synthetic-kv-value",
  mimeType: "image/png",
  byteLength: PNG.byteLength,
};
const LOCAL_ONLY_OVERRIDES = new Set([
  "--",
  "--config",
  "-c",
  "--env",
  "-e",
  "--env-file",
  "--persist-to",
  "--remote",
  "-r",
  "--preview",
  "--profile",
  "--cwd",
  "--local",
  "--command",
]);

class CommandFailure extends Error {
  constructor(label, exitCode, signal) {
    super("A local Wrangler state-drill command failed.");
    this.label = label;
    this.exitCode = exitCode;
    this.signal = signal;
  }
}

function optionName(argument) {
  if (argument === "--") return "--";
  if (argument.startsWith("--")) return argument.split("=", 1)[0];
  if (/^-[ce].+/.test(argument)) return argument.slice(0, 2);
  return argument;
}

function isSupportedCommand(args) {
  return (
    (args[0] === "d1" &&
      args[1] === "migrations" &&
      args[2] === "apply" &&
      args.length === 4 &&
      args[3] === "DB") ||
    (args[0] === "d1" &&
      args[1] === "execute" &&
      args[2] === "DB" &&
      args.includes("--file") &&
      !args.includes("--command")) ||
    (args[0] === "r2" &&
      args[1] === "object" &&
      ["get", "put"].includes(args[2]) &&
      typeof args[3] === "string" &&
      args.includes("--file")) ||
    (args[0] === "kv" &&
      args[1] === "key" &&
      ["get", "put"].includes(args[2]) &&
      typeof args[3] === "string" &&
      args.includes("--binding") &&
      args[args.indexOf("--binding") + 1] === "LINK_CACHE")
  );
}

export function buildLocalArgs(commandArgs, configPath, persistTo) {
  if (
    !Array.isArray(commandArgs) ||
    !commandArgs.every((argument) => typeof argument === "string") ||
    !isAbsolute(configPath) ||
    !isAbsolute(persistTo)
  )
    throw new Error(
      "Local Wrangler commands require string args and absolute scratch paths.",
    );

  for (const argument of commandArgs) {
    if (LOCAL_ONLY_OVERRIDES.has(optionName(argument)))
      throw new Error(
        "Command input cannot alter local recovery options or use inline SQL.",
      );
  }
  if (!isSupportedCommand(commandArgs))
    throw new Error("Unsupported Wrangler command for the local state drill.");

  return [
    ...commandArgs,
    "--config",
    configPath,
    "--env",
    "",
    "--local",
    "--persist-to",
    persistTo,
  ];
}

function isWithin(root, target) {
  const pathFromRoot = relative(root, target);
  return (
    pathFromRoot === "" ||
    (pathFromRoot !== ".." &&
      !pathFromRoot.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromRoot))
  );
}

export function prepareRunDirectory(paths) {
  const root = resolve(paths?.root ?? "");
  const expected = [
    ["source", join(root, "source")],
    ["restored", join(root, "restored")],
    ["backup", join(root, "backup")],
  ];
  for (const [key, path] of expected) {
    if (resolve(paths[key] ?? "") !== path)
      throw new Error(
        "Recovery run paths must use the three fixed work areas.",
      );
    try {
      const stats = lstatSync(path);
      if (stats.isSymbolicLink() || !stats.isDirectory())
        throw new Error("Recovery run work areas must be real directories.");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      mkdirSync(path, { mode: 0o700 });
    }
  }
  return paths;
}

function canonicalDirectory(directory) {
  const requested = resolve(directory);
  const stats = lstatSync(requested);
  if (stats.isSymbolicLink() || !stats.isDirectory())
    throw new Error("State path must be a real directory, not a symlink.");
  return realpathSync(requested);
}

function canonicalNewDirectory(directory) {
  const requested = resolve(directory);
  const parent = realpathSync(dirname(requested));
  const canonical = join(parent, basename(requested));
  try {
    lstatSync(canonical);
    throw new Error(
      "State destination already exists; refusing to overwrite it.",
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return canonical;
}

function sameFileVersion(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function hashFile(filePath) {
  const before = lstatSync(filePath, { bigint: true });
  if (!before.isFile())
    throw new Error("State tree contains a non-regular file.");

  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", rejectHash);
    stream.on("end", () => {
      try {
        const after = lstatSync(filePath, { bigint: true });
        if (!sameFileVersion(before, after))
          throw new Error("State file changed while it was being hashed.");
        resolveHash(hash.digest("hex"));
      } catch (error) {
        rejectHash(error);
      }
    });
  });
}

export async function createManifest(directory) {
  const root = canonicalDirectory(directory);
  const entries = [];

  async function visit(current, prefix = "") {
    const names = readdirSync(current).sort();
    for (const name of names) {
      const path = join(current, name);
      const entryPath = prefix ? `${prefix}/${name}` : name;
      const stats = lstatSync(path, { bigint: true });
      if (stats.isSymbolicLink())
        throw new Error(`State tree contains a symlink: ${entryPath}`);
      if (stats.isDirectory()) {
        entries.push({
          path: entryPath,
          type: "directory",
          mode: Number(stats.mode & 0o777n),
        });
        await visit(path, entryPath);
      } else if (stats.isFile()) {
        entries.push({
          path: entryPath,
          type: "file",
          mode: Number(stats.mode & 0o777n),
          size: Number(stats.size),
          sha256: await hashFile(path),
        });
      } else {
        throw new Error(
          `State tree contains an unsupported file type: ${entryPath}`,
        );
      }
    }
  }

  await visit(root);
  entries.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  return { format: "ages-wrangler-state-tree-v1", entries };
}

export function compareManifests(expected, actual) {
  if (
    expected?.format !== "ages-wrangler-state-tree-v1" ||
    actual?.format !== "ages-wrangler-state-tree-v1" ||
    !Array.isArray(expected.entries) ||
    !Array.isArray(actual.entries)
  )
    return ["manifest format is invalid"];

  const expectedByPath = new Map(
    expected.entries.map((entry) => [entry.path, entry]),
  );
  const actualByPath = new Map(
    actual.entries.map((entry) => [entry.path, entry]),
  );
  const mismatches = [];
  for (const [path, entry] of expectedByPath) {
    const found = actualByPath.get(path);
    if (!found) mismatches.push(path);
    else if (JSON.stringify(found) !== JSON.stringify(entry))
      mismatches.push(path);
  }
  for (const path of actualByPath.keys())
    if (!expectedByPath.has(path)) mismatches.push(path);
  return [...new Set(mismatches)].sort();
}

export async function verifyManifest(directory, expected) {
  return compareManifests(expected, await createManifest(directory));
}

async function copyTree(source, destination) {
  const names = readdirSync(source).sort();
  for (const name of names) {
    const sourcePath = join(source, name);
    const destinationPath = join(destination, name);
    const stats = lstatSync(sourcePath, { bigint: true });
    if (stats.isSymbolicLink())
      throw new Error(`State tree contains a symlink: ${name}`);
    if (stats.isDirectory()) {
      mkdirSync(destinationPath, { mode: Number(stats.mode & 0o777n) });
      await copyTree(sourcePath, destinationPath);
      chmodSync(destinationPath, Number(stats.mode & 0o777n));
    } else if (stats.isFile()) {
      copyFileSync(sourcePath, destinationPath, constants.COPYFILE_EXCL);
      chmodSync(destinationPath, Number(stats.mode & 0o777n));
    } else {
      throw new Error(`State tree contains an unsupported file type: ${name}`);
    }
  }
}

function assertDisjoint(source, destination) {
  if (isWithin(source, destination) || isWithin(destination, source))
    throw new Error("State source and destination paths overlap.");
}

export async function snapshotDirectory(sourceDirectory, destinationDirectory) {
  const source = canonicalDirectory(sourceDirectory);
  const destination = canonicalNewDirectory(destinationDirectory);
  assertDisjoint(source, destination);

  const before = await createManifest(source);
  mkdirSync(destination, { mode: 0o700 });
  await copyTree(source, destination);
  const [sourceAfter, backup] = await Promise.all([
    createManifest(source),
    createManifest(destination),
  ]);
  const sourceMismatches = compareManifests(before, sourceAfter);
  const backupMismatches = compareManifests(before, backup);
  if (sourceMismatches.length || backupMismatches.length)
    throw new Error(
      "State changed during capture or the backup copy is incomplete.",
    );
  return before;
}

export async function restoreDirectory(
  backupDirectory,
  destinationDirectory,
  expectedManifest,
) {
  const backup = canonicalDirectory(backupDirectory);
  const destination = canonicalNewDirectory(destinationDirectory);
  assertDisjoint(backup, destination);
  const backupMismatches = await verifyManifest(backup, expectedManifest);
  if (backupMismatches.length)
    throw new Error(`Backup manifest mismatch: ${backupMismatches.join(", ")}`);

  mkdirSync(destination, { mode: 0o700 });
  await copyTree(backup, destination);
  const restoredManifest = await createManifest(destination);
  const restoreMismatches = compareManifests(
    expectedManifest,
    restoredManifest,
  );
  if (restoreMismatches.length)
    throw new Error(
      `Restored manifest mismatch: ${restoreMismatches.join(", ")}`,
    );
  return restoredManifest;
}

export function nextMigrationFilename(migrationNames) {
  if (
    !Array.isArray(migrationNames) ||
    !migrationNames.every((name) => typeof name === "string")
  )
    throw new Error("Migration history must be an array of filenames.");
  const numbers = migrationNames.map((name) => {
    const match = /^(\d{4})_.+\.sql$/.exec(basename(name));
    if (!match)
      throw new Error(
        "Migration filename does not use the four-digit SQL convention.",
      );
    return Number(match[1]);
  });
  const next = (numbers.length ? Math.max(...numbers) : 0) + 1;
  if (next > 9999) throw new Error("Migration number space is exhausted.");
  return `${String(next).padStart(4, "0")}_state_recovery_probe.sql`;
}

export function compareMigrationLedger(
  previousNames,
  restoredNames,
  newMigrationName,
) {
  if (!Array.isArray(previousNames) || !Array.isArray(restoredNames))
    return ["migration ledger is malformed"];
  if (previousNames.some((name, index) => restoredNames[index] !== name))
    return ["migration ledger was not preserved exactly"];
  const appended = restoredNames.slice(previousNames.length);
  if (appended.length !== 1 || appended[0] !== newMigrationName)
    return ["new migration is not the sole appended ledger entry"];
  return [];
}

function makeRunId() {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function writeScratchConfig(
  directory,
  name,
  bindings,
  migrationsDirectory,
  persist,
) {
  const config = {
    name,
    send_metrics: false,
    d1_databases: [
      {
        binding: "DB",
        database_name: name,
        database_id: bindings.databaseId,
        migrations_dir: migrationsDirectory,
      },
    ],
    r2_buckets: [{ binding: "MEDIA", bucket_name: bindings.bucketName }],
    kv_namespaces: [{ binding: "LINK_CACHE", id: bindings.kvId }],
  };
  const path = join(directory, "wrangler.jsonc");
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  return { path, persist, bucket: bindings.bucketName };
}

function parseD1Rows(output) {
  let statements;
  try {
    statements = JSON.parse(String(output).trim());
  } catch {
    throw new Error("Local D1 command returned invalid JSON.");
  }
  if (
    !Array.isArray(statements) ||
    statements.length === 0 ||
    statements.some(
      (statement) =>
        statement?.success !== true || !Array.isArray(statement.results),
    )
  )
    throw new Error("Local D1 command returned an unsuccessful result.");
  return statements.flatMap((statement) => statement.results);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function treeDigest(manifest) {
  return sha256(Buffer.from(JSON.stringify(manifest), "utf8"));
}

function writeSqlFile(filePath, lines) {
  writeFileSync(filePath, `${lines.join("\n")}\n`, {
    flag: "wx",
    mode: 0o600,
    encoding: "utf8",
  });
}

function writeReport(paths, result) {
  const lines = [
    "# Local synthetic Wrangler state recovery drill",
    "",
    `Status: **${result.status}**`,
    `Run directory: \`${paths.root}\``,
    `Local Wrangler commands completed: ${result.commandCount}`,
    `Source and restored binding IDs matched: ${result.sameBindings ? "yes" : "not verified"}`,
    `State tree entries: ${result.manifest?.entries.length ?? "not verified"}`,
    `State tree SHA-256 manifest: ${result.manifest ? treeDigest(result.manifest) : "not verified"}`,
    `Initial D1 migrations: ${result.initialMigrationCount ?? "not verified"}`,
    `Forward migration: ${result.forwardMigration ?? "not applied"}`,
    "",
    "## Checks",
    "",
    ...(result.comparisons
      ? Object.entries(result.comparisons).map(
          ([name, passed]) => `- ${name}: ${passed ? "PASS" : "FAIL"}`,
        )
      : ["- Not completed."]),
    "",
    result.failure
      ? `Failure: ${result.failure}`
      : "All offline synthetic state checks passed.",
    "",
    "This drill runs only isolated Wrangler local resources. It exits each Wrangler command before capture, copies the complete synthetic persistence tree, and verifies restore. It does not read or modify OKE, prove an online or cross-cloud snapshot, create a durable backup, or verify the current Ages `/data` volume.",
    "",
    `Structured command records: \`${paths.log}\``,
    "",
  ];
  writeFileSync(paths.report, lines.join("\n"), {
    flag: "wx",
    encoding: "utf8",
    mode: 0o600,
  });
  const manifestPath = join(paths.backup, "manifest.json");
  if (!existsSync(manifestPath))
    writeFileSync(
      manifestPath,
      `${JSON.stringify(result.manifest, null, 2)}\n`,
      {
        flag: "wx",
        encoding: "utf8",
        mode: 0o600,
      },
    );
}

export async function runStateDrill({
  repoRoot = REPO_ROOT,
  execute = execFileSync,
} = {}) {
  const canonicalRoot = realpathSync(resolve(repoRoot));
  const paths = allocateRunDirectory(
    join(canonicalRoot, ".wrangler", "recovery-drills"),
    makeRunId(),
  );
  prepareRunDirectory(paths);
  const migrationDirectory = join(paths.root, "migrations");
  const backupState = join(paths.backup, "wrangler-state");
  const sourceObject = join(paths.source, "source-probe.png");
  const restoredObject = join(paths.restored, "restored-probe.png");
  const sqlFiles = {
    seed: join(paths.root, "seed.sql"),
    probe: join(paths.root, "probe.sql"),
    ledger: join(paths.root, "migration-ledger.sql"),
    quickCheck: join(paths.root, "quick-check.sql"),
    foreignKeyCheck: join(paths.root, "foreign-key-check.sql"),
    forwardCheck: join(paths.root, "forward-check.sql"),
  };
  const bindings = {
    databaseId: randomUUID(),
    bucketName: `ages-state-${randomUUID().replaceAll("-", "").slice(0, 20)}`,
    kvId: randomUUID().replaceAll("-", ""),
  };
  const scratchName = `ages-state-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const source = writeScratchConfig(
    paths.source,
    scratchName,
    bindings,
    migrationDirectory,
    join(paths.source, "persist"),
  );
  const restored = writeScratchConfig(
    paths.restored,
    scratchName,
    bindings,
    migrationDirectory,
    join(paths.restored, "persist"),
  );
  mkdirSync(source.persist, { mode: 0o700 });
  const wranglerPath = resolve(
    canonicalRoot,
    "node_modules/wrangler/bin/wrangler.js",
  );
  if (!existsSync(wranglerPath))
    throw new Error(
      "Install the repository dependencies before running this drill.",
    );
  cpSync(resolve(canonicalRoot, "migrations"), migrationDirectory, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });

  const result = {
    status: "FAIL",
    commandCount: 0,
    sameBindings: true,
    comparisons: {},
    manifest: null,
    failure: null,
  };
  const commandRecords = [];
  const childEnv = makeWranglerEnv(
    process.env,
    join(paths.root, "wrangler.log"),
  );

  function runCommand(label, args, side) {
    const resource = side === "source" ? source : restored;
    const wranglerArgs = buildLocalArgs(args, resource.path, resource.persist);
    const record = { label, side, command_family: args.slice(0, 2).join(" ") };
    commandRecords.push(record);
    try {
      const output = execute(
        process.execPath,
        [wranglerPath, ...wranglerArgs],
        {
          cwd: canonicalRoot,
          env: childEnv,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          maxBuffer: 2 * 1024 * 1024,
        },
      );
      record.exit_code = 0;
      return output;
    } catch (error) {
      record.exit_code = typeof error.status === "number" ? error.status : null;
      record.signal = error.signal ?? null;
      throw new CommandFailure(label, record.exit_code, record.signal);
    }
  }

  const probeSql = [
    `CREATE TABLE state_recovery_probe (id TEXT PRIMARY KEY, r2_key TEXT NOT NULL, kv_key TEXT NOT NULL, mime_type TEXT NOT NULL, byte_length INTEGER NOT NULL);`,
    `INSERT INTO state_recovery_probe (id, r2_key, kv_key, mime_type, byte_length) VALUES (${sqlString(PROBE.id)}, ${sqlString(PROBE.r2Key)}, ${sqlString(PROBE.kvKey)}, ${sqlString(PROBE.mimeType)}, ${PROBE.byteLength});`,
  ];
  writeSqlFile(sqlFiles.seed, probeSql);
  writeSqlFile(sqlFiles.probe, [
    "SELECT id, r2_key, kv_key, mime_type, byte_length FROM state_recovery_probe WHERE id = 'synthetic-state-probe';",
  ]);
  writeSqlFile(sqlFiles.ledger, [
    "SELECT name FROM d1_migrations ORDER BY name;",
  ]);
  writeSqlFile(sqlFiles.quickCheck, ["PRAGMA quick_check;"]);
  writeSqlFile(sqlFiles.foreignKeyCheck, ["PRAGMA foreign_key_check;"]);

  try {
    writeFileSync(sourceObject, PNG, { flag: "wx", mode: 0o600 });
    runCommand(
      "Apply checked-in migrations to synthetic source",
      ["d1", "migrations", "apply", "DB"],
      "source",
    );
    runCommand(
      "Seed synthetic D1 probe row",
      ["d1", "execute", "DB", "--file", sqlFiles.seed],
      "source",
    );
    runCommand(
      "Write synthetic R2 probe object",
      [
        "r2",
        "object",
        "put",
        `${source.bucket}/${PROBE.r2Key}`,
        "--file",
        sourceObject,
        "--content-type",
        PROBE.mimeType,
      ],
      "source",
    );
    runCommand(
      "Write synthetic KV probe value",
      [
        "kv",
        "key",
        "put",
        PROBE.kvKey,
        PROBE.kvValue,
        "--binding",
        "LINK_CACHE",
      ],
      "source",
    );

    const sourceRows = parseD1Rows(
      runCommand(
        "Read source D1 probe row",
        ["d1", "execute", "DB", "--file", sqlFiles.probe, "--json"],
        "source",
      ),
    );
    const sourceMigrations = parseD1Rows(
      runCommand(
        "Read source migration ledger",
        ["d1", "execute", "DB", "--file", sqlFiles.ledger, "--json"],
        "source",
      ),
    ).map((row) => row.name);
    if (sourceRows.length !== 1 || sourceMigrations.length === 0)
      throw new Error(
        "Synthetic source D1 probe or migration ledger is empty.",
      );
    runCommand(
      "Read source R2 probe object",
      [
        "r2",
        "object",
        "get",
        `${source.bucket}/${PROBE.r2Key}`,
        "--file",
        sourceObject,
      ],
      "source",
    );
    const sourceObjectFacts = fileFacts(sourceObject);
    const sourceKvValue = String(
      runCommand(
        "Read source KV probe value",
        ["kv", "key", "get", PROBE.kvKey, "--binding", "LINK_CACHE", "--text"],
        "source",
      ),
    ).trim();
    if (
      sourceRows[0]?.id !== PROBE.id ||
      sourceRows[0]?.r2_key !== PROBE.r2Key ||
      sourceRows[0]?.kv_key !== PROBE.kvKey ||
      sourceRows[0]?.mime_type !== PROBE.mimeType ||
      sourceRows[0]?.byte_length !== PROBE.byteLength ||
      sourceObjectFacts.sha256 !== PNG_SHA256 ||
      sourceKvValue !== PROBE.kvValue
    )
      throw new Error("Synthetic source D1, R2, and KV values do not match.");

    const quickRows = parseD1Rows(
      runCommand(
        "Check source SQLite integrity",
        ["d1", "execute", "DB", "--file", sqlFiles.quickCheck, "--json"],
        "source",
      ),
    );
    const foreignKeyRows = parseD1Rows(
      runCommand(
        "Check source SQLite foreign keys",
        ["d1", "execute", "DB", "--file", sqlFiles.foreignKeyCheck, "--json"],
        "source",
      ),
    );
    if (
      quickRows.length !== 1 ||
      quickRows[0].quick_check !== "ok" ||
      foreignKeyRows.length !== 0
    )
      throw new Error("Synthetic source D1 integrity checks failed.");

    result.manifest = await snapshotDirectory(source.persist, backupState);
    const restoredManifest = await restoreDirectory(
      backupState,
      restored.persist,
      result.manifest,
    );
    result.comparisons.complete_persistence_tree_restored =
      compareManifests(result.manifest, restoredManifest).length === 0;

    const restoredRows = parseD1Rows(
      runCommand(
        "Read restored D1 probe row",
        ["d1", "execute", "DB", "--file", sqlFiles.probe, "--json"],
        "restored",
      ),
    );
    const restoredMigrations = parseD1Rows(
      runCommand(
        "Read restored migration ledger",
        ["d1", "execute", "DB", "--file", sqlFiles.ledger, "--json"],
        "restored",
      ),
    ).map((row) => row.name);
    runCommand(
      "Read restored R2 probe object",
      [
        "r2",
        "object",
        "get",
        `${restored.bucket}/${PROBE.r2Key}`,
        "--file",
        restoredObject,
      ],
      "restored",
    );
    const restoredObjectFacts = await fileFacts(restoredObject);
    const restoredKvValue = String(
      runCommand(
        "Read restored KV probe value",
        ["kv", "key", "get", PROBE.kvKey, "--binding", "LINK_CACHE", "--text"],
        "restored",
      ),
    ).trim();
    const restoredQuickRows = parseD1Rows(
      runCommand(
        "Check restored SQLite integrity",
        ["d1", "execute", "DB", "--file", sqlFiles.quickCheck, "--json"],
        "restored",
      ),
    );
    const restoredForeignKeyRows = parseD1Rows(
      runCommand(
        "Check restored SQLite foreign keys",
        ["d1", "execute", "DB", "--file", sqlFiles.foreignKeyCheck, "--json"],
        "restored",
      ),
    );
    if (
      restoredRows.length !== 1 ||
      restoredMigrations.length !== sourceMigrations.length
    )
      throw new Error(
        "Restored D1 probe row or migration ledger does not match the source.",
      );
    if (
      JSON.stringify(restoredRows[0]) !== JSON.stringify(sourceRows[0]) ||
      JSON.stringify(restoredMigrations) !== JSON.stringify(sourceMigrations) ||
      restoredObjectFacts.sha256 !== sourceObjectFacts.sha256 ||
      restoredObjectFacts.byteLength !== sourceObjectFacts.byteLength ||
      restoredKvValue !== sourceKvValue
    )
      throw new Error("Restored D1, R2, or KV state differs from the source.");
    if (
      restoredQuickRows.length !== 1 ||
      restoredQuickRows[0].quick_check !== "ok" ||
      restoredForeignKeyRows.length !== 0
    )
      throw new Error("Restored D1 integrity checks failed.");
    result.initialMigrationCount = sourceMigrations.length;
    result.comparisons.d1_probe_and_migration_ledger_match = true;
    result.comparisons.r2_bytes_match = true;
    result.comparisons.kv_value_matches = true;
    result.comparisons.d1_quick_check_ok = true;
    result.comparisons.d1_foreign_key_check_clear = true;

    const migrationName = nextMigrationFilename(sourceMigrations);
    const migrationPath = join(migrationDirectory, migrationName);
    writeFileSync(
      migrationPath,
      "CREATE TABLE state_recovery_forward_probe (id TEXT PRIMARY KEY, value TEXT NOT NULL);\nINSERT INTO state_recovery_forward_probe (id, value) VALUES ('forward-probe', 'applied-after-restore');\n",
      { flag: "wx", encoding: "utf8", mode: 0o600 },
    );
    writeSqlFile(sqlFiles.forwardCheck, [
      "SELECT id, value FROM state_recovery_forward_probe WHERE id = 'forward-probe';",
    ]);
    runCommand(
      "Apply a new additive migration only to restored D1",
      ["d1", "migrations", "apply", "DB"],
      "restored",
    );
    const afterForwardMigration = parseD1Rows(
      runCommand(
        "Read forward-migrated ledger",
        ["d1", "execute", "DB", "--file", sqlFiles.ledger, "--json"],
        "restored",
      ),
    ).map((row) => row.name);
    const forwardProbeRows = parseD1Rows(
      runCommand(
        "Verify additive migration result",
        ["d1", "execute", "DB", "--file", sqlFiles.forwardCheck, "--json"],
        "restored",
      ),
    );
    const forwardMismatches = compareMigrationLedger(
      sourceMigrations,
      afterForwardMigration,
      migrationName,
    );
    if (
      forwardMismatches.length ||
      forwardProbeRows.length !== 1 ||
      forwardProbeRows[0].id !== "forward-probe" ||
      forwardProbeRows[0].value !== "applied-after-restore"
    )
      throw new Error(
        "Forward-only migration did not append cleanly after restore.",
      );
    const sourceLedgerAfter = parseD1Rows(
      runCommand(
        "Confirm source migration ledger remains unchanged",
        ["d1", "execute", "DB", "--file", sqlFiles.ledger, "--json"],
        "source",
      ),
    ).map((row) => row.name);
    if (JSON.stringify(sourceLedgerAfter) !== JSON.stringify(sourceMigrations))
      throw new Error(
        "The source migration ledger changed during the restore check.",
      );
    result.forwardMigration = migrationName;
    result.comparisons.forward_migration_appends_to_restored_ledger = true;
    result.status = "PASS";
  } catch (error) {
    if (error instanceof CommandFailure) {
      result.failure = `Command failed: ${error.label} (exit ${error.exitCode ?? "unknown"}${error.signal ? `, signal ${error.signal}` : ""}).`;
    } else {
      result.failure =
        error instanceof Error ? error.message : "State drill failed.";
    }
  }

  result.commandCount = commandRecords.length;
  const logContents = commandRecords
    .map((record) => JSON.stringify(record))
    .join("\n");
  writeFileSync(paths.log, `${logContents}${logContents ? "\n" : ""}`, {
    flag: "wx",
    encoding: "utf8",
    mode: 0o600,
  });
  writeReport(paths, result);
  return { ...result, paths };
}

function fileFacts(filePath) {
  const bytes = readFileSync(filePath);
  return { byteLength: bytes.byteLength, sha256: sha256(bytes) };
}

function validateCliArgs(args) {
  if (args.length)
    throw new Error(
      "The local Wrangler state drill accepts no arguments. Usage: npm run recovery:state-drill",
    );
}

async function main() {
  try {
    validateCliArgs(process.argv.slice(2));
    const result = await runStateDrill();
    console.log(
      `Local Wrangler state drill ${result.status}. Evidence: ${result.paths.report}`,
    );
    if (result.status !== "PASS") process.exitCode = 1;
  } catch (error) {
    console.error(
      error instanceof Error
        ? error.message
        : "Local Wrangler state drill could not start.",
    );
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
