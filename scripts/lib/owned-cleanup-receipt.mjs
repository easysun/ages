import { createHash } from "node:crypto";

export const OWNED_CLEANUP_RECEIPT_FILENAME = "owned-cleanup-receipt.json";
export const OWNED_CLEANUP_RECEIPT_BYTE_LIMIT = 16 * 1024;

const ACTIONS = [
  "open",
  "fit-all",
  "pan",
  "zoom",
  "resize",
  "append",
  "scroll",
];
const WORKLOADS = ["100-interactive", "10000-chronological"];
const SAFE_FAILURE_STAGES = new Set([
  "preflight",
  "browser-installation-preflight",
  "workspace",
  "server-startup",
  "browser-startup",
  "seed-library",
  "manifest",
  "owned-process-cleanup",
  "run-cleanup",
  "unknown",
  ...["seed-fixture", "capture"].flatMap((kind) =>
    WORKLOADS.flatMap((workload) =>
      ACTIONS.map((action) => `${kind}:${workload}:${action}`),
    ),
  ),
]);
const SAFE_PRIMARY_FAILURE_CODES = new Set([
  "UNSUPPORTED_HOST",
  "INSTALLED_BRAVE_UNAVAILABLE",
  "LOCAL_DEPENDENCIES_UNAVAILABLE",
  "LOCAL_APP_HEALTH_FAILED",
  "OWNED_SERVER_START_FAILED",
  "OWNED_SERVER_EXITED_EARLY",
  "OWNED_SERVER_OUTPUT_CLOSED",
  "OWNED_SERVER_READINESS_TIMEOUT",
  "SYNTHETIC_FIXTURE_MISSING",
  "BROWSER_METADATA_UNAVAILABLE",
  "TRACE_CATEGORIES_UNAVAILABLE",
  "METHOD_PILOT_FAILED",
]);
const CONTEXT_FAILURE_CODES = new Set([
  "CONTEXT_CLOSE_REJECTED",
  "CONTEXT_CLOSE_TIMEOUT",
]);
const BROWSER_FAILURE_CODES = new Set([
  "BROWSER_CLOSE_REJECTED",
  "BROWSER_CLOSE_TIMEOUT",
]);
const SAFE_SIGNALS = new Set([
  "SIGHUP",
  "SIGINT",
  "SIGQUIT",
  "SIGILL",
  "SIGTRAP",
  "SIGABRT",
  "SIGBUS",
  "SIGFPE",
  "SIGKILL",
  "SIGUSR1",
  "SIGSEGV",
  "SIGUSR2",
  "SIGPIPE",
  "SIGALRM",
  "SIGTERM",
  "SIGCHLD",
  "SIGCONT",
  "SIGSTOP",
  "SIGTSTP",
  "SIGTTIN",
  "SIGTTOU",
  "SIGURG",
  "SIGXCPU",
  "SIGXFSZ",
  "SIGVTALRM",
  "SIGPROF",
  "SIGWINCH",
  "SIGIO",
  "SIGPWR",
  "SIGSYS",
  "OTHER",
]);

export function sanitizeOwnedChildSignal(signalCode) {
  if (typeof signalCode !== "string") return null;
  return SAFE_SIGNALS.has(signalCode) ? signalCode : "OTHER";
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  return (
    isRecord(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function isSafeTimestamp(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  ) {
    return false;
  }
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function isSafeSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function expectedCleanupFailures(receipt) {
  const failures = [];
  if (receipt.context.outcome === "failed") {
    failures.push({ resource: "context", code: receipt.context.errorCode });
  }
  if (receipt.browser.outcome === "failed") {
    failures.push({ resource: "browser", code: receipt.browser.errorCode });
  }
  if (receipt.ownedServer.stopHelper === "rejected") {
    failures.push({
      resource: "ownedServer",
      code: receipt.ownedServer.errorCode,
    });
  }
  if (receipt.ownedServer.processGroupSnapshot.outcome === "nonempty") {
    failures.push({
      resource: "ownedServer",
      code: "OWNED_SERVER_GROUP_REMAINS",
    });
  }
  return failures;
}

function sameFailureList(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every(
      (failure, index) =>
        hasExactKeys(failure, ["resource", "code"]) &&
        failure.resource === expected[index].resource &&
        failure.code === expected[index].code,
    )
  );
}

export function summarizePrimaryRunFailure(error, stage) {
  return {
    stage: SAFE_FAILURE_STAGES.has(stage) ? stage : "unknown",
    code:
      typeof error?.message === "string" &&
      SAFE_PRIMARY_FAILURE_CODES.has(error.message)
        ? error.message
        : "METHOD_PILOT_FAILED",
  };
}

export function validateOwnedCleanupReceipt(receipt) {
  if (
    !hasExactKeys(receipt, [
      "schemaVersion",
      "completedAtUtc",
      "manifestSha256",
      "primaryRunFailure",
      "context",
      "browser",
      "ownedServer",
      "cleanupFailures",
    ]) ||
    receipt.schemaVersion !== 1 ||
    !isSafeTimestamp(receipt.completedAtUtc) ||
    (receipt.manifestSha256 !== null && !isSafeSha256(receipt.manifestSha256))
  ) {
    throw new Error("Invalid owned cleanup receipt.");
  }

  if (receipt.primaryRunFailure !== null) {
    if (
      !hasExactKeys(receipt.primaryRunFailure, ["stage", "code"]) ||
      !SAFE_FAILURE_STAGES.has(receipt.primaryRunFailure.stage) ||
      !SAFE_PRIMARY_FAILURE_CODES.has(receipt.primaryRunFailure.code)
    ) {
      throw new Error("Invalid owned cleanup receipt.");
    }
  }

  if (
    !hasExactKeys(receipt.context, ["outcome", "errorCode"]) ||
    !["closed", "failed", "not_created"].includes(receipt.context.outcome) ||
    (receipt.context.outcome === "failed"
      ? !CONTEXT_FAILURE_CODES.has(receipt.context.errorCode)
      : receipt.context.errorCode !== null)
  ) {
    throw new Error("Invalid owned cleanup receipt.");
  }

  if (
    !hasExactKeys(receipt.browser, ["outcome", "errorCode", "descendants"]) ||
    !["closed", "failed", "not_created"].includes(receipt.browser.outcome) ||
    (receipt.browser.outcome === "failed"
      ? !BROWSER_FAILURE_CODES.has(receipt.browser.errorCode)
      : receipt.browser.errorCode !== null) ||
    receipt.browser.descendants !== "not_independently_verified"
  ) {
    throw new Error("Invalid owned cleanup receipt.");
  }

  const server = receipt.ownedServer;
  if (
    !hasExactKeys(server, [
      "stopHelper",
      "errorCode",
      "processGroupSnapshot",
      "childExitKnown",
      "exitCode",
      "signalCode",
    ]) ||
    !["returned", "rejected", "not_created"].includes(server.stopHelper) ||
    (server.stopHelper === "rejected"
      ? server.errorCode !== "OWNED_SERVER_STOP_FAILED"
      : server.errorCode !== null)
  ) {
    throw new Error("Invalid owned cleanup receipt.");
  }

  const snapshot = server.processGroupSnapshot;
  if (
    !hasExactKeys(snapshot, ["outcome", "memberCount"]) ||
    !["empty", "nonempty", "unavailable", "not_created"].includes(
      snapshot.outcome,
    ) ||
    (snapshot.outcome === "empty"
      ? snapshot.memberCount !== 0
      : snapshot.outcome === "nonempty"
        ? !Number.isInteger(snapshot.memberCount) ||
          snapshot.memberCount < 1 ||
          snapshot.memberCount > 256
        : snapshot.memberCount !== null)
  ) {
    throw new Error("Invalid owned cleanup receipt.");
  }

  if (server.stopHelper === "not_created") {
    if (
      snapshot.outcome !== "not_created" ||
      server.childExitKnown !== null ||
      server.exitCode !== null ||
      server.signalCode !== null
    ) {
      throw new Error("Invalid owned cleanup receipt.");
    }
  } else {
    if (
      snapshot.outcome === "not_created" ||
      typeof server.childExitKnown !== "boolean"
    ) {
      throw new Error("Invalid owned cleanup receipt.");
    }
    if (server.childExitKnown) {
      const validExitCode =
        Number.isInteger(server.exitCode) &&
        server.exitCode >= 0 &&
        server.exitCode <= 255 &&
        server.signalCode === null;
      const validSignalCode =
        server.exitCode === null &&
        typeof server.signalCode === "string" &&
        SAFE_SIGNALS.has(server.signalCode);
      if (!validExitCode && !validSignalCode) {
        throw new Error("Invalid owned cleanup receipt.");
      }
    } else if (server.exitCode !== null || server.signalCode !== null) {
      throw new Error("Invalid owned cleanup receipt.");
    }
  }

  if (
    !sameFailureList(receipt.cleanupFailures, expectedCleanupFailures(receipt))
  ) {
    throw new Error("Invalid owned cleanup receipt.");
  }
  return receipt;
}

export function serializeOwnedCleanupReceipt(receipt) {
  validateOwnedCleanupReceipt(receipt);
  const serialized = `${JSON.stringify(receipt, null, 2)}\n`;
  if (
    Buffer.byteLength(serialized, "utf8") > OWNED_CLEANUP_RECEIPT_BYTE_LIMIT
  ) {
    throw new Error("Owned cleanup receipt exceeds its size limit.");
  }
  return serialized;
}

export function parseOwnedCleanupReceipt(bytes, manifestBytes) {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.byteLength > OWNED_CLEANUP_RECEIPT_BYTE_LIMIT
  ) {
    throw new Error("Invalid owned cleanup receipt.");
  }

  let receipt;
  try {
    receipt = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Invalid owned cleanup receipt.");
  }
  validateOwnedCleanupReceipt(receipt);

  if (
    !Buffer.isBuffer(manifestBytes) ||
    !isSafeSha256(receipt.manifestSha256) ||
    createHash("sha256").update(manifestBytes).digest("hex") !==
      receipt.manifestSha256
  ) {
    throw new Error("Owned cleanup receipt manifest binding failed.");
  }
  return receipt;
}

export function summarizeOwnedCleanupReceipt(receipt) {
  validateOwnedCleanupReceipt(receipt);
  return {
    scope: "run",
    primaryRunFailure: receipt.primaryRunFailure,
    context: {
      apiOutcome: receipt.context.outcome,
      errorCode: receipt.context.errorCode,
    },
    browser: {
      apiOutcome: receipt.browser.outcome,
      errorCode: receipt.browser.errorCode,
      descendants: "not_independently_verified",
    },
    ownedServer: {
      stopHelper: receipt.ownedServer.stopHelper,
      errorCode: receipt.ownedServer.errorCode,
      processGroupSnapshot: {
        outcome: receipt.ownedServer.processGroupSnapshot.outcome,
        memberCount: receipt.ownedServer.processGroupSnapshot.memberCount,
      },
      childExitKnown: receipt.ownedServer.childExitKnown,
      exitCode: receipt.ownedServer.exitCode,
      signalCode: receipt.ownedServer.signalCode,
    },
    cleanupFailures: receipt.cleanupFailures.map(({ resource, code }) => ({
      resource,
      code,
    })),
  };
}
