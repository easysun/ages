import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { runInNewContext } from "node:vm";
import * as runner from "../../scripts/capture-chromium-method-pilot.mjs";
import {
  artifactRootsForBrowser,
  buildCaptureCases,
  buildLocalWorkerConfig,
  buildMeasurementSegment,
  buildSyntheticTimelineQuotaSql,
  createRunDirectory,
  describeTraceArtifact,
  isInitialChronologicalOverviewRequest,
  measurementWindows,
  outcomeStatus,
  parseRunnerArgs,
  parseViewportAttributes,
  probeTraceCategories,
  runAppend,
  runFitAll,
  runOpenStimuli,
  serializeActionDiagnostic,
  snapshotOwnedProcessGroup,
  stopOwnedProcess,
  stopOwnedProcessForRun,
  summarizeSafeFailure,
  summarizeTraceEvidence,
  validateCaptureTimeMetadata,
  verifyTraceArtifact,
} from "../../scripts/capture-chromium-method-pilot.mjs";
import { serializeOwnedCleanupReceipt } from "../../scripts/lib/owned-cleanup-receipt.mjs";

function createAppendHarness({ responsePromise, visibleFailure } = {}) {
  const response = {
    finished: async () => null,
    status: () => 204,
  };
  let released = false;
  const page = {
    evaluate: async () => undefined,
    waitForResponse: () => responsePromise ?? Promise.resolve(response),
    getByText: () => ({ waitFor: async () => undefined }),
    locator: (selector) => ({
      getByRole: (_role, { name }) => ({
        waitFor: async () => {
          if (visibleFailure && selector === ".undated-track" && name)
            throw visibleFailure;
        },
      }),
      waitFor: async () => undefined,
    }),
  };
  const setup = {
    dialog: {
      getByRole: (_role, { name }) => ({
        click: async () => undefined,
        waitFor: async () => {
          if (name === "Adding moments…") return;
        },
      }),
    },
    requestStarted: Promise.resolve(),
    release: () => {
      released = true;
    },
  };
  return { page, setup, wasReleased: () => released };
}

test("seed failure diagnostics identify the fixture and child error without exposing raw output", () => {
  const failure = Object.assign(
    new Error("raw child output must stay private"),
    {
      code: "ENOBUFS",
      status: 1,
      stderr: Buffer.from(
        "D1_ERROR: SQLITE_FULL at /Users/bay/private/run; email=user@example.test token=secret-value",
      ),
    },
  );

  const summary = summarizeSafeFailure(
    failure,
    "seed-fixture:10000-chronological:zoom",
  );

  assert.deepEqual(summary, {
    stage: "seed-fixture:10000-chronological:zoom",
    childExitCode: 1,
    processErrorCode: "ENOBUFS",
    sdkErrorCode: "SQLITE_FULL",
  });
  assert.doesNotMatch(
    JSON.stringify(summary),
    /private|user@example\.test|secret-value|D1_ERROR/,
  );
});

test("failure diagnostics replace unknown stages and ignore unrecognized child text", () => {
  const summary = summarizeSafeFailure(
    Object.assign(new Error("/Users/bay/private unexpected output"), {
      status: 1,
      stderr: Buffer.from("unrecognized user@example.test token=secret-value"),
    }),
    "private-stage",
  );

  assert.deepEqual(summary, { stage: "unknown", childExitCode: 1 });
  assert.doesNotMatch(
    JSON.stringify(summary),
    /private|user@example\.test|secret-value/,
  );
});

test("failure diagnostics report completed installed Brave category reads", () => {
  assert.deepEqual(
    summarizeSafeFailure(new Error("private error text"), "browser-startup", 2),
    { stage: "browser-startup", traceCategoryCatalogReadCount: 2 },
  );
  assert.deepEqual(
    summarizeSafeFailure(new Error("ignored"), "browser-startup"),
    { stage: "browser-startup" },
  );
});

test("owned process cleanup diagnostics identify the failing group syscall", async () => {
  const originalKill = process.kill;
  const cleanupCalls = [
    ["SIGTERM", "terminate-process-group"],
    [0, "probe-process-group"],
    ["SIGKILL", "kill-process-group"],
  ];

  try {
    for (const [failedSignal, expectedStep] of cleanupCalls) {
      const attemptedSignals = [];
      process.kill = (_pid, signal) => {
        attemptedSignals.push(signal);
        if (signal === failedSignal) {
          throw Object.assign(new Error("private process detail"), {
            code: "EPERM",
          });
        }
        return true;
      };

      const child = { pid: 98765, exitCode: 0, signalCode: null };
      await assert.rejects(stopOwnedProcess(child), (error) => {
        const summary = summarizeSafeFailure(error, "owned-process-cleanup");
        assert.equal(summary.stage, "owned-process-cleanup");
        assert.equal(summary.processErrorCode, "EPERM");
        assert.equal(summary.cleanupStep, expectedStep);
        if (expectedStep === "probe-process-group") {
          assert.equal(summary.processGroupSnapshot?.snapshotAvailable, true);
          assert.equal(summary.processGroupSnapshot?.childExitKnown, true);
          assert.ok(summary.processGroupSnapshot.memberCount <= 256);
        } else {
          assert.equal(Object.hasOwn(summary, "processGroupSnapshot"), false);
        }
        assert.doesNotMatch(JSON.stringify(summary), /private process detail/);
        assert.doesNotMatch(JSON.stringify(summary), /98765/);
        return true;
      });
      assert.deepEqual(
        attemptedSignals,
        cleanupCalls
          .slice(
            0,
            cleanupCalls.findIndex(([, step]) => step === expectedStep) + 1,
          )
          .map(([signal]) => signal),
      );
    }
  } finally {
    process.kill = originalKill;
  }
});

test("owned group snapshots summarize exact group rows and hide ps failures", () => {
  const groupId = 43210;
  const uid = process.getuid?.() ?? 501;
  const child = { pid: groupId, exitCode: null, signalCode: null };
  const rows = [
    `${groupId} 1 ${groupId} ${uid} S<`,
    `${groupId + 1} ${groupId} ${groupId} ${uid} Z`,
    `${groupId + 2} 1 ${groupId} ${uid} U`,
    `${groupId + 3} 1 ${groupId + 100} ${uid} R`,
  ].join("\n");

  const snapshot = snapshotOwnedProcessGroup(child, () => rows);
  assert.deepEqual(snapshot, {
    snapshotAvailable: true,
    childExitKnown: false,
    memberCount: 3,
    sameUidKnown: true,
    sameUidCount: 3,
    stateCounts: {
      running: 0,
      sleeping: 1,
      idle: 0,
      uninterruptible: 1,
      stopped: 0,
      zombie: 1,
      other: 0,
    },
  });
  assert.doesNotMatch(JSON.stringify(snapshot), /43210|43211|43310/);

  assert.deepEqual(
    snapshotOwnedProcessGroup(
      { pid: groupId, exitCode: 0, signalCode: null },
      () => {
        throw new Error("private ps output must stay private");
      },
    ),
    { snapshotAvailable: false, childExitKnown: true },
  );
});

test("owned cleanup waits for a remaining group member after the leader exits", async () => {
  const groupId = 43210;
  const child = { pid: groupId, exitCode: 0, signalCode: null };
  const uid = process.getuid?.() ?? 501;
  const memberRow = `${groupId + 1} ${groupId} ${groupId} ${uid} S`;
  const originalKill = process.kill;
  const attemptedSignals = [];
  let snapshots = 0;
  let lastSnapshotWasEmpty = false;
  process.kill = (_pid, signal) => {
    attemptedSignals.push(signal);
    if (signal === 0) {
      assert.equal(lastSnapshotWasEmpty, true);
      const missing = new Error("private process detail");
      missing.code = "ESRCH";
      throw missing;
    }
    return true;
  };

  try {
    await stopOwnedProcess(child, 500, () => {
      snapshots += 1;
      lastSnapshotWasEmpty = snapshots >= 3;
      return lastSnapshotWasEmpty ? "" : memberRow;
    });
    assert.ok(snapshots >= 3);
    assert.deepEqual(attemptedSignals, ["SIGTERM", 0]);
  } finally {
    process.kill = originalKill;
  }
});

test("owned group snapshots are capped by the remaining cleanup grace", async () => {
  const groupId = 43210;
  const uid = process.getuid?.() ?? 501;
  const child = { pid: groupId, exitCode: 0, signalCode: null };
  const memberRow = `${groupId + 1} ${groupId} ${groupId} ${uid} S`;
  const originalKill = process.kill;
  const attemptedSignals = [];
  const readTimeouts = [];
  const graceMs = 50;
  process.kill = (_pid, signal) => {
    attemptedSignals.push(signal);
    if (signal === 0) {
      const missing = new Error("private process detail");
      missing.code = "ESRCH";
      throw missing;
    }
    return true;
  };

  try {
    await stopOwnedProcess(child, graceMs, (timeoutMs) => {
      readTimeouts.push(timeoutMs);
      return memberRow;
    });
    assert.ok(readTimeouts.length >= 1);
    assert.ok(
      readTimeouts.every(
        (timeoutMs) =>
          Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs <= graceMs,
      ),
    );
    assert.deepEqual(attemptedSignals, ["SIGTERM", 0]);
  } finally {
    process.kill = originalKill;
  }
});

test("owned cleanup rejects when the group probe still succeeds after SIGKILL, even after leader exit", async () => {
  const groupId = 43210;
  const child = { pid: groupId, exitCode: 0, signalCode: null };
  const uid = process.getuid?.() ?? 501;
  const memberRow = `${groupId + 1} ${groupId} ${groupId} ${uid} S`;
  const originalKill = process.kill;
  const attemptedSignals = [];
  let killed = false;
  process.kill = (pid, signal) => {
    assert.equal(pid, -groupId);
    attemptedSignals.push(signal);
    if (signal === "SIGKILL") killed = true;
    return true;
  };

  try {
    await assert.rejects(
      stopOwnedProcess(child, 25, () => (killed ? "" : memberRow)),
      (error) => {
        const summary = summarizeSafeFailure(error, "owned-process-cleanup");
        assert.equal(summary.stage, "owned-process-cleanup");
        assert.equal(summary.processErrorCode, "EBUSY");
        assert.equal(summary.cleanupStep, "verify-process-group-after-kill");
        assert.doesNotMatch(JSON.stringify(summary), /43210/);
        return true;
      },
    );
    assert.deepEqual(attemptedSignals, ["SIGTERM", 0, "SIGKILL", 0]);
  } finally {
    process.kill = originalKill;
  }
});

test("owned cleanup resolves when the group disappears after SIGKILL", async () => {
  const groupId = 43210;
  const child = { pid: groupId, exitCode: 0, signalCode: null };
  const uid = process.getuid?.() ?? 501;
  const memberRow = `${groupId + 1} ${groupId} ${groupId} ${uid} S`;
  const originalKill = process.kill;
  const attemptedSignals = [];
  let killed = false;
  process.kill = (pid, signal) => {
    assert.equal(pid, -groupId);
    attemptedSignals.push(signal);
    if (signal === "SIGKILL") {
      killed = true;
      return true;
    }
    if (signal === 0 && killed) {
      throw Object.assign(new Error("private process detail"), {
        code: "ESRCH",
      });
    }
    return true;
  };

  try {
    await stopOwnedProcess(child, 25, () => (killed ? "" : memberRow));
    assert.deepEqual(attemptedSignals, ["SIGTERM", 0, "SIGKILL", 0]);
  } finally {
    process.kill = originalKill;
  }
});

test("post-kill EPERM remains a sanitized syscall-specific cleanup failure", async () => {
  const groupId = 43210;
  const child = { pid: groupId, exitCode: 0, signalCode: null };
  const uid = process.getuid?.() ?? 501;
  const memberRow = `${groupId + 1} ${groupId} ${groupId} ${uid} S`;
  const originalKill = process.kill;
  const attemptedSignals = [];
  let killed = false;
  process.kill = (pid, signal) => {
    assert.equal(pid, -groupId);
    attemptedSignals.push(signal);
    if (signal === "SIGKILL") {
      killed = true;
      return true;
    }
    if (signal === 0 && killed) {
      throw Object.assign(new Error("private process detail"), {
        code: "EPERM",
      });
    }
    return true;
  };

  try {
    await assert.rejects(
      stopOwnedProcess(child, 25, () => (killed ? "" : memberRow)),
      (error) => {
        const summary = summarizeSafeFailure(error, "owned-process-cleanup");
        assert.equal(summary.stage, "owned-process-cleanup");
        assert.equal(summary.processErrorCode, "EPERM");
        assert.equal(summary.cleanupStep, "verify-process-group-after-kill");
        assert.equal(summary.processGroupSnapshot?.snapshotAvailable, true);
        assert.equal(summary.processGroupSnapshot?.childExitKnown, true);
        assert.doesNotMatch(
          JSON.stringify(summary),
          /private process detail|43210/,
        );
        return true;
      },
    );
    assert.deepEqual(attemptedSignals, ["SIGTERM", 0, "SIGKILL", 0]);
  } finally {
    process.kill = originalKill;
  }
});

test("persistent or unknown group snapshots never suppress the original probe", async () => {
  const groupId = 43210;
  const uid = process.getuid?.() ?? 501;
  const child = { pid: groupId, exitCode: 0, signalCode: null };
  const memberRow = `${groupId + 1} ${groupId} ${groupId} ${uid} S`;
  const originalKill = process.kill;
  const attemptedSignals = [];
  let persistentSnapshots = 0;
  let failProbe = true;
  let killed = false;
  process.kill = (_pid, signal) => {
    attemptedSignals.push(signal);
    if (signal === 0) {
      if (killed) {
        throw Object.assign(new Error("private process detail"), {
          code: "ESRCH",
        });
      }
      if (!failProbe) return true;
      assert.ok(persistentSnapshots >= 2);
      throw Object.assign(new Error("private process detail"), {
        code: "EPERM",
      });
    }
    if (signal === "SIGKILL") killed = true;
    return true;
  };

  try {
    await assert.rejects(
      stopOwnedProcess(child, 250, () => {
        persistentSnapshots += 1;
        return memberRow;
      }),
      (error) => {
        assert.equal(error.code, "EPERM");
        assert.equal(error.cleanupStep, "probe-process-group");
        assert.equal(error.processGroupSnapshot?.snapshotAvailable, true);
        assert.equal(error.processGroupSnapshot?.memberCount, 1);
        return true;
      },
    );
    assert.deepEqual(attemptedSignals, ["SIGTERM", 0]);

    attemptedSignals.length = 0;
    let unknownSnapshots = 0;
    failProbe = false;
    await stopOwnedProcess(child, 250, () => {
      unknownSnapshots += 1;
      throw new Error("private ps output");
    });
    assert.ok(unknownSnapshots >= 2);
    assert.deepEqual(attemptedSignals, ["SIGTERM", 0, "SIGKILL", 0]);
  } finally {
    process.kill = originalKill;
  }
});

test("probe EPERM remains a cleanup failure with bounded owned-group state", async () => {
  const child = spawn(
    process.execPath,
    [
      "-e",
      "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000)",
    ],
    { detached: true, stdio: "ignore" },
  );
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });

  const originalKill = process.kill;
  let probeDenied = false;
  const failureState = { stage: "capture:100-interactive:append" };
  process.kill = (pid, signal) => {
    if (pid === -child.pid && signal === 0) {
      probeDenied = true;
      throw Object.assign(new Error("private process detail"), {
        code: "EPERM",
      });
    }
    return originalKill(pid, signal);
  };

  try {
    await assert.rejects(
      stopOwnedProcessForRun(child, (stage) => {
        failureState.stage = stage;
      }),
      (error) => {
        const summary = summarizeSafeFailure(error, failureState.stage);
        assert.equal(summary.stage, "owned-process-cleanup");
        assert.equal(summary.processErrorCode, "EPERM");
        assert.equal(summary.cleanupStep, "probe-process-group");
        assert.equal(summary.processGroupSnapshot?.snapshotAvailable, true);
        assert.equal(summary.processGroupSnapshot?.childExitKnown, true);
        assert.ok(summary.processGroupSnapshot.memberCount <= 256);
        assert.equal(Object.hasOwn(summary.processGroupSnapshot, "pid"), false);
        assert.doesNotMatch(JSON.stringify(summary), /private process detail/);
        return true;
      },
    );
    assert.equal(probeDenied, true);
  } finally {
    process.kill = originalKill;
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise((resolve) => child.once("close", resolve));
      child.kill("SIGKILL");
      await closed;
    }
  }
});

test("successful cleanup preserves the primary failure stage and error", async () => {
  const originalKill = process.kill;
  process.kill = () => {
    throw Object.assign(new Error("private process detail"), {
      code: "ESRCH",
    });
  };
  const failureState = { stage: "capture:100-interactive:append" };
  const primaryError = new Error("primary capture failure");
  const child = { pid: 98765, exitCode: 0, signalCode: null };

  try {
    let observedError;
    try {
      try {
        throw primaryError;
      } catch (error) {
        await stopOwnedProcessForRun(child, (stage) => {
          failureState.stage = stage;
        });
        throw error;
      }
    } catch (error) {
      observedError = error;
    }

    assert.equal(observedError, primaryError);
    assert.equal(failureState.stage, "capture:100-interactive:append");
  } finally {
    process.kill = originalKill;
  }
});

test("failed cleanup replaces the run stage with its syscall-specific stage", async () => {
  const originalKill = process.kill;
  process.kill = () => {
    throw Object.assign(new Error("private process detail"), {
      code: "EPERM",
    });
  };
  const failureState = { stage: "capture:100-interactive:append" };
  const child = { pid: 98765, exitCode: 0, signalCode: null };

  try {
    await assert.rejects(
      stopOwnedProcessForRun(child, (stage) => {
        failureState.stage = stage;
      }),
      (error) => {
        assert.equal(failureState.stage, "owned-process-cleanup");
        assert.deepEqual(summarizeSafeFailure(error, failureState.stage), {
          stage: "owned-process-cleanup",
          processErrorCode: "EPERM",
          cleanupStep: "terminate-process-group",
        });
        return true;
      },
    );
  } finally {
    process.kill = originalKill;
  }
});

function runCleanupReceiptFixture(t) {
  const runDirectory = mkdtempSync(join(tmpdir(), "ages-cleanup-receipt-"));
  t.after(() => rmSync(runDirectory, { recursive: true, force: true }));
  return {
    runDirectory,
    receiptPath: join(runDirectory, "owned-cleanup-receipt.json"),
  };
}

function finalizeRunCleanup(options) {
  assert.equal(
    typeof runner.finalizeRunCleanup,
    "function",
    "the runner must expose its real run finalizer for lifecycle testing",
  );
  return runner.finalizeRunCleanup(options);
}

test("run cleanup independently attempts APIs and server after close rejection and timeout", async (t) => {
  const { runDirectory, receiptPath } = runCleanupReceiptFixture(t);
  const events = [];
  const server = { pid: 43210, exitCode: null, signalCode: null };

  await assert.rejects(
    finalizeRunCleanup({
      runDirectory,
      manifestSha256: "a".repeat(64),
      context: {
        close: async () => {
          events.push("context");
          throw new Error("private context close detail");
        },
      },
      browser: {
        close: () => {
          events.push("browser");
          return new Promise(() => {});
        },
      },
      server,
      cleanupTimeoutMs: 5,
      stopServer: async (child) => {
        assert.equal(child, server);
        events.push("server");
      },
      readProcessTable: (timeoutMs) => {
        assert.ok(timeoutMs > 0 && timeoutMs <= 1500);
        events.push("snapshot");
        return "";
      },
      writeReceipt: (path, receipt) => {
        events.push("receipt");
        writeFileSync(path, `${JSON.stringify(receipt)}\n`, { flag: "wx" });
      },
      writeSuccess: () => events.push("success"),
    }),
    (error) => error.message === "METHOD_PILOT_CLEANUP_FAILED",
  );

  assert.deepEqual(events, [
    "context",
    "browser",
    "server",
    "snapshot",
    "receipt",
  ]);
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  assert.equal(receipt.context.outcome, "failed");
  assert.equal(receipt.context.errorCode, "CONTEXT_CLOSE_REJECTED");
  assert.equal(receipt.browser.outcome, "failed");
  assert.equal(receipt.browser.errorCode, "BROWSER_CLOSE_TIMEOUT");
  assert.equal(receipt.browser.descendants, "not_independently_verified");
  assert.equal(receipt.ownedServer.stopHelper, "returned");
  assert.deepEqual(receipt.ownedServer.processGroupSnapshot, {
    outcome: "empty",
    memberCount: 0,
  });
  assert.deepEqual(receipt.cleanupFailures, [
    { resource: "context", code: "CONTEXT_CLOSE_REJECTED" },
    { resource: "browser", code: "BROWSER_CLOSE_TIMEOUT" },
  ]);
  assert.doesNotMatch(JSON.stringify(receipt), /private context close detail/);
});

test("run success output waits until the receipt has been written", async (t) => {
  const { runDirectory, receiptPath } = runCleanupReceiptFixture(t);
  const events = [];
  const server = { pid: 43211, exitCode: 0, signalCode: null };

  await finalizeRunCleanup({
    runDirectory,
    manifestSha256: "b".repeat(64),
    context: { close: async () => events.push("context") },
    browser: { close: async () => events.push("browser") },
    server,
    stopServer: async () => events.push("server"),
    readProcessTable: () => {
      events.push("snapshot");
      return "";
    },
    writeReceipt: (path, receipt) => {
      writeFileSync(path, `${JSON.stringify(receipt)}\n`, { flag: "wx" });
      events.push("receipt");
    },
    writeSuccess: () => {
      JSON.parse(readFileSync(receiptPath, "utf8"));
      events.push("success");
    },
  });

  assert.deepEqual(events, [
    "context",
    "browser",
    "server",
    "snapshot",
    "receipt",
    "success",
  ]);
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  assert.equal(receipt.ownedServer.childExitKnown, true);
  assert.equal(receipt.ownedServer.exitCode, 0);
  assert.equal(receipt.ownedServer.signalCode, null);
});

test("receipt write failure fails the run without printing success", async (t) => {
  const { runDirectory } = runCleanupReceiptFixture(t);
  const events = [];
  const server = { pid: 43212, exitCode: null, signalCode: null };

  await assert.rejects(
    finalizeRunCleanup({
      runDirectory,
      manifestSha256: "c".repeat(64),
      context: { close: async () => events.push("context") },
      browser: { close: async () => events.push("browser") },
      server,
      stopServer: async () => events.push("server"),
      readProcessTable: () => "",
      writeReceipt: () => {
        events.push("receipt");
        throw new Error("private receipt filesystem detail");
      },
      writeSuccess: () => events.push("success"),
    }),
    (error) => error.message === "METHOD_PILOT_RECEIPT_WRITE_FAILED",
  );

  assert.deepEqual(events, ["context", "browser", "server", "receipt"]);
});

test("the receipt preserves a primary run failure alongside cleanup failures", async (t) => {
  const { runDirectory, receiptPath } = runCleanupReceiptFixture(t);
  const primaryError = new Error("primary private failure detail");
  const server = { pid: 43213, exitCode: 0, signalCode: null };
  let observedError;

  try {
    await finalizeRunCleanup({
      runDirectory,
      manifestSha256: "d".repeat(64),
      primaryError,
      failureStage: "capture:100-interactive:append",
      context: {
        close: async () => {
          throw new Error("private close error");
        },
      },
      browser: { close: async () => undefined },
      server,
      stopServer: async () => undefined,
      readProcessTable: () => "",
      writeSuccess: () =>
        assert.fail("a primary failure must not print success"),
    });
  } catch (error) {
    observedError = error;
  }

  assert.equal(observedError, primaryError);
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  assert.deepEqual(receipt.primaryRunFailure, {
    stage: "capture:100-interactive:append",
    code: "METHOD_PILOT_FAILED",
  });
  assert.deepEqual(receipt.cleanupFailures, [
    { resource: "context", code: "CONTEXT_CLOSE_REJECTED" },
  ]);
  assert.doesNotMatch(
    JSON.stringify(receipt),
    /primary private failure detail|private close error/,
  );
});

test("owned server stop rejection persists only its safe code and still snapshots", async (t) => {
  const { runDirectory, receiptPath } = runCleanupReceiptFixture(t);
  const server = { pid: 43215, exitCode: null, signalCode: "SIGTERM" };

  await assert.rejects(
    finalizeRunCleanup({
      runDirectory,
      manifestSha256: "f".repeat(64),
      context: { close: async () => undefined },
      browser: { close: async () => undefined },
      server,
      stopServer: async () => {
        throw new Error("private server cleanup details");
      },
      readProcessTable: () => {
        return "";
      },
      writeSuccess: () =>
        assert.fail("a rejected stop helper must fail the run"),
    }),
    (error) => error.message === "METHOD_PILOT_CLEANUP_FAILED",
  );

  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  assert.equal(receipt.ownedServer.stopHelper, "rejected");
  assert.equal(receipt.ownedServer.errorCode, "OWNED_SERVER_STOP_FAILED");
  assert.deepEqual(receipt.ownedServer.processGroupSnapshot, {
    outcome: "empty",
    memberCount: 0,
  });
  assert.equal(receipt.ownedServer.childExitKnown, true);
  assert.equal(receipt.ownedServer.exitCode, null);
  assert.equal(receipt.ownedServer.signalCode, "SIGTERM");
  assert.deepEqual(receipt.cleanupFailures, [
    { resource: "ownedServer", code: "OWNED_SERVER_STOP_FAILED" },
  ]);
  assert.doesNotMatch(
    JSON.stringify(receipt),
    /private server cleanup details/,
  );
});

test("post-stop server snapshots keep unknown and nonempty groups distinct", async (t) => {
  for (const scenario of [
    {
      name: "unavailable",
      readProcessTable: () => {
        throw new Error("private process table detail");
      },
      expected: { outcome: "unavailable", memberCount: null },
      shouldReject: false,
    },
    {
      name: "nonempty",
      readProcessTable: (server) =>
        `${server.pid} 1 ${server.pid} ${process.getuid?.() ?? 501} S`,
      expected: { outcome: "nonempty", memberCount: 1 },
      shouldReject: true,
    },
  ]) {
    await t.test(scenario.name, async (subtest) => {
      const { runDirectory, receiptPath } = runCleanupReceiptFixture(subtest);
      const server = { pid: 43214, exitCode: null, signalCode: null };
      let stopFinished = false;
      const operation = finalizeRunCleanup({
        runDirectory,
        manifestSha256: "e".repeat(64),
        context: { close: async () => undefined },
        browser: { close: async () => undefined },
        server,
        stopServer: async () => {
          stopFinished = true;
        },
        readProcessTable: () => {
          assert.equal(
            stopFinished,
            true,
            "snapshot must follow the stop attempt",
          );
          return scenario.readProcessTable(server);
        },
        writeReceipt: (path, receipt) =>
          writeFileSync(path, `${JSON.stringify(receipt)}\n`, { flag: "wx" }),
      });

      if (scenario.shouldReject) {
        await assert.rejects(
          operation,
          (error) => error.message === "METHOD_PILOT_CLEANUP_FAILED",
        );
      } else {
        await operation;
      }
      const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
      assert.deepEqual(
        receipt.ownedServer.processGroupSnapshot,
        scenario.expected,
      );
      assert.equal(receipt.ownedServer.childExitKnown, false);
      assert.notEqual(
        receipt.ownedServer.processGroupSnapshot.outcome,
        "empty",
      );
    });
  }
});

test("append accepts a successful bodyless response without waiting for response.finished", async () => {
  const diagnostics = {};
  let finishedCalls = 0;
  const response = {
    finished: () => {
      finishedCalls += 1;
      return new Promise(() => {});
    },
    status: () => 204,
  };
  const { page, setup } = createAppendHarness({
    responsePromise: Promise.resolve(response),
  });
  let timeout;

  try {
    const result = await Promise.race([
      runAppend(
        page,
        { workload: "100-interactive" },
        "synthetic-timeline",
        setup,
        diagnostics,
      ),
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("append did not reach visible completion")),
          1000,
        );
      }),
    ]);

    assert.equal(result.committedResponseStatus, 204);
    assert.equal(result.visibleCompletionObserved, true);
    assert.equal(finishedCalls, 0);
    assert.deepEqual(serializeActionDiagnostic(diagnostics), {
      phase: "append-completion-paint",
      responseHeadersReceived: true,
      responseFinished: false,
      responseFinishWaitSkippedFor204: true,
      responseStatus: 204,
      commitAcknowledged: true,
    });
  } finally {
    clearTimeout(timeout);
  }
});

test("append response-header failures retain the awaited stage without raw errors", async () => {
  const diagnostics = {};
  const { page, setup, wasReleased } = createAppendHarness({
    responsePromise: Promise.reject(
      new Error("private URL and response body must stay private"),
    ),
  });

  await assert.rejects(
    runAppend(
      page,
      { workload: "100-interactive" },
      "synthetic-timeline",
      setup,
      diagnostics,
    ),
    /APPEND_RESPONSE_HEADERS_FAILED/,
  );

  assert.equal(wasReleased(), true);
  assert.equal(diagnostics.responseHeadersReceived, false);
  assert.deepEqual(serializeActionDiagnostic(diagnostics), {
    phase: "append-response-headers",
    reasonCode: "APPEND_RESPONSE_HEADERS_FAILED",
    responseHeadersReceived: false,
    responseFinished: false,
    responseFinishWaitSkippedFor204: false,
    commitAcknowledged: false,
  });
});

test("append records only the sanitized status when the commit acknowledgement is wrong", async () => {
  const diagnostics = {};
  let finishedCalls = 0;
  const response = {
    finished: () => {
      finishedCalls += 1;
      return new Promise(() => {});
    },
    status: () => 503,
  };
  const { page, setup } = createAppendHarness({
    responsePromise: Promise.resolve(response),
  });

  await assert.rejects(
    runAppend(
      page,
      { workload: "10000-chronological" },
      "synthetic-timeline",
      setup,
      diagnostics,
    ),
    /APPEND_COMMIT_ACK_FAILED/,
  );

  assert.deepEqual(serializeActionDiagnostic(diagnostics), {
    phase: "append-commit-ack",
    reasonCode: "APPEND_COMMIT_ACK_FAILED",
    responseHeadersReceived: true,
    responseFinished: false,
    responseFinishWaitSkippedFor204: false,
    responseStatus: 503,
    commitAcknowledged: false,
  });
  assert.equal(finishedCalls, 0);
});

test("append records a completed write separately from a missing visible update", async () => {
  const diagnostics = {};
  const { page, setup } = createAppendHarness({
    visibleFailure: new Error("private DOM details"),
  });

  await assert.rejects(
    runAppend(
      page,
      { workload: "10000-chronological" },
      "synthetic-timeline",
      setup,
      diagnostics,
    ),
    /APPEND_VISIBLE_COMPLETION_FAILED/,
  );

  assert.deepEqual(serializeActionDiagnostic(diagnostics), {
    phase: "append-visible-count",
    reasonCode: "APPEND_VISIBLE_COMPLETION_FAILED",
    responseHeadersReceived: true,
    responseFinished: false,
    responseFinishWaitSkippedFor204: true,
    responseStatus: 204,
    commitAcknowledged: true,
  });
});

test("fit-all clicks controls inside the requested Calendar viewport", async () => {
  const selectedControls = [];
  const diagnostics = {};
  let bounds = { center: 15, span: 80, extent: 100, width: 820 };
  const page = {
    evaluate: async () => undefined,
    getByRole: (_role, { name }) => ({
      count: async () => 2,
      click: async () => {
        throw new Error(`global ${name} locator is ambiguous`);
      },
    }),
  };
  const viewport = {
    evaluate: async () => ({
      center: String(bounds.center),
      span: String(bounds.span),
      extent: String(bounds.extent),
      width: bounds.width,
    }),
    getByRole: (_role, { name }) => ({
      click: async () => {
        selectedControls.push(name);
        if (name === "Zoom in") bounds = { ...bounds, span: bounds.span / 2 };
        if (name === "Pan earlier")
          bounds = { ...bounds, center: bounds.center + 10 };
        if (name === "Fit all")
          bounds = { center: 15, span: 80, extent: 100, width: 820 };
      },
    }),
  };

  const result = await runFitAll(
    page,
    { workload: "10000-chronological", action: "fit-all" },
    viewport,
    diagnostics,
  );

  assert.deepEqual(diagnostics.controlMatchCounts, {
    zoomIn: 2,
    panEarlier: 2,
    fitAll: 2,
  });
  assert.deepEqual(selectedControls, ["Zoom in", "Pan earlier", "Fit all"]);
  assert.deepEqual(result, {
    manualFrameChanged: true,
    fitRestoredInitialBounds: true,
  });
});

test("fit-all diagnostics expose both viewport control sets and initial bounds", async () => {
  const diagnostics = {};
  const page = {
    evaluate: async () => undefined,
    getByRole: (_role, { name }) => ({
      count: async () => 2,
      click: async () => {
        if (name === "Zoom in") throw new Error("private strict-mode details");
      },
    }),
  };
  const viewport = {
    evaluate: async () => ({
      center: "15",
      span: "80",
      extent: "100",
      width: 820,
      privateCaption: "must not be recorded",
    }),
    getByRole: () => ({
      click: async () => {
        throw new Error("private strict-mode details");
      },
    }),
  };

  await assert.rejects(
    runFitAll(
      page,
      { workload: "10000-chronological", action: "fit-all" },
      viewport,
      diagnostics,
    ),
  );

  assert.deepEqual(serializeActionDiagnostic(diagnostics), {
    phase: "fit-all-zoom-in",
    reasonCode: "FIT_ALL_GROUND_TRUTH_FAILED",
    controlMatchCounts: { zoomIn: 2, panEarlier: 2, fitAll: 2 },
    viewportBounds: {
      initial: { center: 15, span: 80, extent: 100, width: 820 },
    },
  });
  assert.doesNotMatch(
    JSON.stringify(serializeActionDiagnostic(diagnostics)),
    /private|strict-mode|Caption/,
  );
});

test("synthetic fixture quota admits every planned timeline without changing another owner", () => {
  const database = new DatabaseSync(":memory:");
  try {
    for (const migration of [
      "0001_identity.sql",
      "0002_oauth.sql",
      "0003_assets.sql",
      "0004_asset_tags.sql",
      "0005_timelines.sql",
    ]) {
      database.exec(
        readFileSync(resolve(process.cwd(), "migrations", migration), "utf8"),
      );
    }
    const insertUser = database.prepare(
      "INSERT INTO users (id,email,created_at,updated_at) VALUES (?,?,?,?)",
    );
    const insertQuota = database.prepare(
      "INSERT INTO usage_quotas (user_id,storage_limit_bytes,max_asset_bytes,timeline_limit,link_limit,updated_at) VALUES (?,10000,10000,?,10,?)",
    );
    const owner = "synthetic-owner";
    const otherOwner = "other-owner";
    const timestamp = "2026-10-14T00:00:00.000Z";
    insertUser.run(owner, "synthetic@example.test", timestamp, timestamp);
    insertUser.run(otherOwner, "other@example.test", timestamp, timestamp);
    insertQuota.run(owner, 10, timestamp);
    insertQuota.run(otherOwner, 1, timestamp);

    const insertTimeline = database.prepare(
      "INSERT INTO timelines (id,owner_id,title,created_at,updated_at) VALUES (?,?,?,?,?)",
    );
    const insertForOwner = (ordinal) =>
      insertTimeline.run(
        `synthetic-${ordinal}`,
        owner,
        `Synthetic timeline ${ordinal}`,
        timestamp,
        timestamp,
      );
    for (let ordinal = 0; ordinal < 10; ordinal += 1) {
      insertForOwner(ordinal);
    }
    assert.throws(() => insertForOwner(10), /timeline_quota_exceeded/);

    database.exec(
      buildSyntheticTimelineQuotaSql(owner, buildCaptureCases().length),
    );
    for (let ordinal = 10; ordinal < buildCaptureCases().length; ordinal += 1) {
      insertForOwner(ordinal);
    }

    assert.equal(
      database
        .prepare("SELECT count(*) AS count FROM timelines WHERE owner_id=?")
        .get(owner).count,
      buildCaptureCases().length,
    );
    assert.equal(
      database
        .prepare("SELECT timeline_limit FROM usage_quotas WHERE user_id=?")
        .get(otherOwner).timeline_limit,
      1,
    );
  } finally {
    database.close();
  }
});

test("the synthetic pilot keeps one case for each action in each workload", () => {
  assert.deepEqual(
    buildCaptureCases().map(({ workload, action }) => `${workload}/${action}`),
    [
      "100-interactive/open",
      "100-interactive/fit-all",
      "100-interactive/pan",
      "100-interactive/zoom",
      "100-interactive/resize",
      "100-interactive/append",
      "100-interactive/scroll",
      "10000-chronological/open",
      "10000-chronological/fit-all",
      "10000-chronological/pan",
      "10000-chronological/zoom",
      "10000-chronological/resize",
      "10000-chronological/append",
      "10000-chronological/scroll",
    ],
  );
  assert.deepEqual(
    buildCaptureCases().map(({ rowCount }) => rowCount),
    [
      100, 100, 100, 100, 100, 100, 100, 10_000, 10_000, 10_000, 10_000, 10_000,
      10_000, 10_000,
    ],
  );
});

test("trace category probe reports required candidates as available or absent", () => {
  const probe = probeTraceCategories([
    "devtools.timeline",
    "input",
    "latencyInfo",
    "cc",
  ]);
  assert.deepEqual(probe.available, [
    "cc",
    "devtools.timeline",
    "input",
    "latencyInfo",
  ]);
  assert.ok(probe.unavailable.includes("latency"));
  assert.ok(probe.unavailable.includes("input.scrolling"));
  assert.ok(
    probe.unavailable.includes("disabled-by-default-devtools.timeline"),
  );
  assert.equal(JSON.stringify(probe).includes("private"), false);
});

test("installed Brave category discovery uses the populated read after an empty first read", async () => {
  const browserCategories = [
    "blink.user_timing",
    "devtools.timeline",
    "disabled-by-default-devtools.timeline",
    "disabled-by-default-devtools.timeline.frame",
    "disabled-by-default-devtools.timeline.inputs",
    "input",
    "input.scrolling",
    "latency",
    "latencyInfo",
    "cc",
    "benchmark",
    "toplevel",
    "vendor.extra",
  ];
  const browserResponses = [
    { categories: [] },
    { categories: browserCategories },
  ];
  const page = {};
  const calls = [];
  const readCounts = [];
  const browser = {
    newBrowserCDPSession: async () => {
      calls.push("browser.session");
      return {
        send: async (method) => {
          calls.push(`browser.send:${method}`);
          return browserResponses.shift();
        },
        detach: async () => calls.push("browser.detach"),
      };
    },
  };
  const context = {
    newCDPSession: async () => {
      calls.push("page.session");
      return {
        send: async () => ({ categories: browserCategories }),
        detach: async () => calls.push("page.detach"),
      };
    },
  };

  const categories = await runner.readTraceCategoriesForMode({
    browser,
    context,
    page,
    browserMode: "installed-brave",
    onRead: (count) => readCounts.push(count),
  });

  assert.deepEqual(calls, [
    "browser.session",
    "browser.send:Tracing.getCategories",
    "browser.send:Tracing.getCategories",
    "browser.detach",
  ]);
  assert.deepEqual(categories, browserCategories);
  assert.deepEqual(readCounts, [1, 2]);
  assert.deepEqual(probeTraceCategories(categories), {
    available: [
      "benchmark",
      "blink.user_timing",
      "cc",
      "devtools.timeline",
      "disabled-by-default-devtools.timeline",
      "disabled-by-default-devtools.timeline.frame",
      "disabled-by-default-devtools.timeline.inputs",
      "input",
      "input.scrolling",
      "latency",
      "latencyInfo",
      "toplevel",
    ],
    unavailable: [],
  });
});

test("installed Brave category discovery fails closed after two empty reads without page fallback", async () => {
  const page = {};
  const calls = [];
  const readCounts = [];
  const browser = {
    newBrowserCDPSession: async () => {
      calls.push("browser.session");
      return {
        send: async (method) => {
          calls.push(`browser.send:${method}`);
          return { categories: [] };
        },
        detach: async () => calls.push("browser.detach"),
      };
    },
  };
  const context = {
    newCDPSession: async () => {
      calls.push("page.session");
      return {
        send: async () => ({ categories: ["devtools.timeline"] }),
        detach: async () => calls.push("page.detach"),
      };
    },
  };

  const categories = await runner.readTraceCategoriesForMode({
    browser,
    context,
    page,
    browserMode: "installed-brave",
    onRead: (count) => readCounts.push(count),
  });

  assert.deepEqual(calls, [
    "browser.session",
    "browser.send:Tracing.getCategories",
    "browser.send:Tracing.getCategories",
    "browser.detach",
  ]);
  assert.deepEqual(readCounts, [1, 2]);
  assert.deepEqual(categories, []);
  assert.throws(
    () => runner.requireTraceCategories(probeTraceCategories(categories)),
    { message: "TRACE_CATEGORIES_UNAVAILABLE" },
  );
});

test("installed Brave does not retry a malformed category response", async () => {
  const page = {};
  const calls = [];
  const readCounts = [];
  const malformedCategories = { count: 0 };
  const browser = {
    newBrowserCDPSession: async () => {
      calls.push("browser.session");
      return {
        send: async (method) => {
          calls.push(`browser.send:${method}`);
          return { categories: malformedCategories };
        },
        detach: async () => calls.push("browser.detach"),
      };
    },
  };
  const context = {
    newCDPSession: async () => {
      calls.push("page.session");
      return {
        send: async () => ({ categories: ["devtools.timeline"] }),
        detach: async () => calls.push("page.detach"),
      };
    },
  };

  const categories = await runner.readTraceCategoriesForMode({
    browser,
    context,
    page,
    browserMode: "installed-brave",
    onRead: (count) => readCounts.push(count),
  });

  assert.deepEqual(calls, [
    "browser.session",
    "browser.send:Tracing.getCategories",
    "browser.detach",
  ]);
  assert.deepEqual(readCounts, [1]);
  assert.deepEqual(categories, malformedCategories);
  assert.throws(
    () => runner.requireTraceCategories(probeTraceCategories(categories)),
    { message: "TRACE_CATEGORIES_UNAVAILABLE" },
  );
});

test("installed Brave does not repeat a nonempty category catalog", async () => {
  const page = {};
  const calls = [];
  const readCounts = [];
  const browser = {
    newBrowserCDPSession: async () => {
      calls.push("browser.session");
      return {
        send: async (method) => {
          calls.push(`browser.send:${method}`);
          return { categories: ["devtools.timeline"] };
        },
        detach: async () => calls.push("browser.detach"),
      };
    },
  };
  const context = {
    newCDPSession: async () => {
      calls.push("page.session");
      return {
        send: async () => ({ categories: ["input"] }),
        detach: async () => calls.push("page.detach"),
      };
    },
  };

  const categories = await runner.readTraceCategoriesForMode({
    browser,
    context,
    page,
    browserMode: "installed-brave",
    onRead: (count) => readCounts.push(count),
  });

  assert.deepEqual(calls, [
    "browser.session",
    "browser.send:Tracing.getCategories",
    "browser.detach",
  ]);
  assert.deepEqual(categories, ["devtools.timeline"]);
  assert.deepEqual(readCounts, [1]);
});

test("Playwright Chromium category discovery retains its single page-level read", async () => {
  const page = {};
  const pageCategories = ["input"];
  const calls = [];
  const browser = {
    newBrowserCDPSession: async () => {
      calls.push("browser.session");
      return {
        send: async () => ({ categories: ["devtools.timeline"] }),
        detach: async () => calls.push("browser.detach"),
      };
    },
  };
  const context = {
    newCDPSession: async (targetPage) => {
      calls.push(targetPage === page ? "page.session" : "wrong-page.session");
      return {
        send: async (method) => {
          calls.push(`page.send:${method}`);
          return { categories: pageCategories };
        },
        detach: async () => calls.push("page.detach"),
      };
    },
  };

  const categories = await runner.readTraceCategoriesForMode({
    browser,
    context,
    page,
    browserMode: "playwright-chromium",
  });

  assert.deepEqual(categories, pageCategories);
  assert.deepEqual(calls, [
    "page.session",
    "page.send:Tracing.getCategories",
    "page.detach",
  ]);
});

test("isolated Worker configs preserve the service and fixture bucket contracts", () => {
  const appSource = JSON.parse(
    readFileSync(resolve(process.cwd(), "wrangler.jsonc"), "utf8"),
  );
  const trackingSource = JSON.parse(
    readFileSync(resolve(process.cwd(), "wrangler.tracking.jsonc"), "utf8"),
  );
  const appConfig = buildLocalWorkerConfig(
    appSource,
    "synthetic-database-id",
    "synthetic-kv-id",
    true,
  );
  const trackingConfig = buildLocalWorkerConfig(
    trackingSource,
    "synthetic-database-id",
    "synthetic-kv-id",
    false,
  );
  const serverSource = readFileSync(
    resolve(process.cwd(), "tests/e2e/start-server.mjs"),
    "utf8",
  );
  const fixtureSource = readFileSync(
    resolve(process.cwd(), "tests/e2e/fixtures.ts"),
    "utf8",
  );
  const gatewayServices = [...serverSource.matchAll(/service: "([^"]+)"/g)].map(
    (match) => match[1],
  );
  const fixtureBucket = fixtureSource.match(/`([^/`]+)\/\$\{key\}`/)?.[1];

  assert.ok(gatewayServices.includes(appConfig.name));
  assert.ok(gatewayServices.includes(trackingConfig.name));
  assert.equal(
    appConfig.d1_databases[0].database_name,
    appSource.d1_databases[0].database_name,
  );
  assert.equal(
    trackingConfig.d1_databases[0].database_name,
    trackingSource.d1_databases[0].database_name,
  );
  assert.equal(appConfig.r2_buckets[0].bucket_name, fixtureBucket);
});

test("open delays the app's actual chronological projection request", () => {
  const timelineId = "synthetic-timeline";
  const initialRequest = new URL(
    `http://127.0.0.1/api/timelines/${timelineId}/overview?limit=1000&projection=chronological`,
  );
  assert.equal(
    isInitialChronologicalOverviewRequest(initialRequest, timelineId),
    true,
  );
  assert.equal(
    isInitialChronologicalOverviewRequest(
      new URL(
        `http://127.0.0.1/api/timelines/${timelineId}/overview?limit=1000`,
      ),
      timelineId,
    ),
    false,
  );
  assert.equal(
    isInitialChronologicalOverviewRequest(
      new URL(
        "http://127.0.0.1/api/timelines/other/overview?projection=chronological",
      ),
      timelineId,
    ),
    false,
  );
  assert.equal(
    isInitialChronologicalOverviewRequest(
      new URL(
        `http://127.0.0.1/api/timelines/${timelineId}/overview?projection=chronological&version=1&cursor=next-page`,
      ),
      timelineId,
    ),
    false,
  );
});

test("10k open completes cold route loading before separate Chronological mode input", async () => {
  const events = [];
  await runOpenStimuli("10000-chronological", {
    primaryOpen: async () => {
      events.push("timeline-route-activation");
      events.push("loading-index-paint");
      events.push("initial-projection-ready-story");
    },
    secondaryChronological: async () => {
      events.push("chronological-button-activation");
      events.push("complete-overview-visible");
    },
    finish: async () => events.push("segment-end"),
  });
  assert.deepEqual(events, [
    "timeline-route-activation",
    "loading-index-paint",
    "initial-projection-ready-story",
    "chronological-button-activation",
    "complete-overview-visible",
    "segment-end",
  ]);

  const windows = measurementWindows(
    { action: "open", workload: "10000-chronological" },
    {
      start: "primary-start",
      immediateEnd: "loading-paint",
      completionStart: "primary-completion-start",
      completionEnd: "story-ready",
      secondaryStart: "secondary-start",
      secondaryEnd: "overview-visible",
    },
  );
  assert.deepEqual(
    windows.map(({ id }) => id),
    [
      "primary-immediate-input",
      "primary-operation-completion",
      "secondary-chronological-mode",
    ],
  );
  assert.equal(windows[1].endMarker, "story-ready");
  assert.equal(windows[2].startMarker, "secondary-start");

  const interactiveEvents = [];
  await runOpenStimuli("100-interactive", {
    primaryOpen: async () => interactiveEvents.push("timeline-route-ready"),
    secondaryChronological: async () =>
      interactiveEvents.push("unexpected-secondary-input"),
    finish: async () => interactiveEvents.push("segment-end"),
  });
  assert.deepEqual(interactiveEvents, ["timeline-route-ready", "segment-end"]);
  assert.deepEqual(
    measurementWindows(
      { action: "open", workload: "100-interactive" },
      {
        start: "primary-start",
        immediateEnd: "loading-paint",
        completionStart: "completion-start",
        completionEnd: "story-ready",
      },
    ).map(({ id }) => id),
    ["primary-immediate-input", "primary-operation-completion"],
  );
});

test("missing viewport bounds stay unavailable instead of becoming zero", () => {
  assert.deepEqual(
    parseViewportAttributes({
      center: "12.5",
      span: "40",
      extent: "50",
      width: 800,
    }),
    { center: 12.5, span: 40, extent: 50, width: 800 },
  );
  const missing = parseViewportAttributes({
    center: null,
    span: "",
    extent: undefined,
    width: 800,
  });
  assert.equal(Number.isFinite(missing.center), false);
  assert.equal(Number.isFinite(missing.span), false);
  assert.equal(Number.isFinite(missing.extent), false);
});

test("action completion remains distinct from a trace capture failure", () => {
  assert.deepEqual(
    outcomeStatus({
      actionOutcome: { viewportCenterChanged: true },
      captureFailureCode: "TRACE_DATA_LOSS",
    }),
    { actionStatus: "completed" },
  );
  assert.deepEqual(
    outcomeStatus({
      actionOutcome: null,
      actionFailureCode: "PAN_GROUND_TRUTH_FAILED",
      captureFailureCode: "TRACE_DATA_LOSS",
    }),
    {
      actionStatus: "unavailable",
      actionReasonCode: "PAN_GROUND_TRUTH_FAILED",
    },
  );
});

test("run directories reject traversal and existing destinations without replacing contents", () => {
  const root = mkdtempSync(join(tmpdir(), "ages-method-pilot-"));
  try {
    const first = createRunDirectory(root, "run-first");
    assert.equal(first, join(root, "run-first"));
    writeFileSync(join(first, "marker.txt"), "keep this run");
    assert.throws(
      () => createRunDirectory(root, "run-first"),
      /already exists/,
    );
    assert.equal(
      readFileSync(join(first, "marker.txt"), "utf8"),
      "keep this run",
    );
    assert.throws(() => createRunDirectory(root, "../outside"), /safe run ID/);

    const outside = join(root, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(root, "linked-runs"));
    assert.throws(
      () => createRunDirectory(join(root, "linked-runs"), "run-next"),
      /Unsafe run root/,
    );
    assert.equal(
      readFileSync(join(first, "marker.txt"), "utf8"),
      "keep this run",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("raw trace metadata uses exact bytes and detects any later change", () => {
  const root = mkdtempSync(join(tmpdir(), "ages-method-trace-"));
  try {
    const path = join(root, "case.trace.json");
    const raw = Buffer.from('{"traceEvents":[{"name":"PilotEvent"}]}\n');
    writeFileSync(path, raw);
    const metadata = describeTraceArtifact(path);
    assert.equal(metadata.byteCount, raw.byteLength);
    assert.equal(
      metadata.sha256,
      "9fa0699d9a1673149827b6c175e52d9e686c09a64da2cbe5471fb802c50ec759",
    );
    assert.equal(verifyTraceArtifact(path, metadata), true);
    writeFileSync(path, Buffer.concat([raw, Buffer.from(" ")]));
    assert.equal(verifyTraceArtifact(path, metadata), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("measurement windows use exact monotonic trace markers and never nearest timestamps", () => {
  const events = [
    {
      cat: "devtools.timeline",
      name: "TimeStamp",
      ph: "I",
      ts: 100,
      pid: 71,
      args: { data: { message: "case:start" } },
    },
    {
      cat: "latency",
      name: "EventProcessing",
      ph: "X",
      ts: 110,
      dur: 5,
      pid: 71,
      args: { event_timing: { duration: 4 } },
    },
    {
      cat: "cc",
      name: "PipelineReporter",
      ph: "b",
      ts: 112,
      pid: 71,
      tid: 1,
      id2: { local: "0x7" },
      args: {
        frame_reporter: {
          state: "STATE_PRESENTED_ALL",
          surface_frame_trace_id: "s1",
          display_trace_id: "d1",
          layer_tree_host_id: 3,
          frame_source: 9,
        },
      },
    },
    {
      cat: "cc",
      name: "PipelineReporter",
      ph: "e",
      ts: 120,
      pid: 71,
      tid: 1,
      id2: { local: "0x7" },
      args: {},
    },
    {
      cat: "devtools.timeline",
      name: "TimeStamp",
      ph: "I",
      ts: 130,
      pid: 71,
      args: { data: { message: "case:active-end" } },
    },
    {
      cat: "devtools.timeline",
      name: "TimeStamp",
      ph: "I",
      ts: 160,
      pid: 71,
      args: { data: { message: "case:completion-start" } },
    },
    {
      cat: "cc",
      name: "PipelineReporter",
      ph: "b",
      ts: 170,
      pid: 71,
      tid: 1,
      id2: { local: "0x8" },
      args: {
        frame_reporter: {
          state: "STATE_PRESENTED_ALL",
          surface_frame_trace_id: "s2",
          display_trace_id: "d2",
          layer_tree_host_id: 3,
          frame_source: 9,
        },
      },
    },
    {
      cat: "cc",
      name: "PipelineReporter",
      ph: "e",
      ts: 180,
      pid: 71,
      tid: 1,
      id2: { local: "0x8" },
      args: {},
    },
    {
      cat: "devtools.timeline",
      name: "TimeStamp",
      ph: "I",
      ts: 190,
      pid: 71,
      args: { data: { message: "case:completion-end" } },
    },
    {
      cat: "devtools.timeline",
      name: "TimeStamp",
      ph: "I",
      ts: 200,
      pid: 71,
      args: { data: { message: "case:end" } },
    },
  ];
  const segment = buildMeasurementSegment({
    trace: "100-interactive-open.trace.json",
    action: "open",
    traceEvents: events,
    startMarker: "case:start",
    endMarker: "case:end",
    activeWindows: [
      {
        id: "open-immediate",
        startMarker: "case:start",
        endMarker: "case:active-end",
      },
      {
        id: "open-completion",
        startMarker: "case:completion-start",
        endMarker: "case:completion-end",
      },
    ],
  });
  assert.deepEqual(segment, {
    status: "resolved",
    segment: {
      trace: "100-interactive-open.trace.json",
      action: "open",
      startUs: 100,
      endUs: 200,
      rendererPid: 71,
      layerTreeHostId: 3,
      frameSource: 9,
      activeWindows: [
        { id: "open-immediate", startUs: 100, endUs: 130 },
        { id: "open-completion", startUs: 160, endUs: 190 },
      ],
    },
  });

  const missing = buildMeasurementSegment({
    trace: "missing-marker.trace.json",
    action: "pan",
    traceEvents: [
      events[0],
      events[1],
      events[2],
      events[3],
      events[4],
      events[7],
    ],
    startMarker: "case:start",
    endMarker: "case:end",
    activeWindows: [
      { id: "pan", startMarker: "case:start", endMarker: "missing:active-end" },
    ],
  });
  assert.equal(missing.status, "unavailable");
  assert.equal(missing.reasonCode, "TRACE_MARKER_MISSING");

  const duplicate = buildMeasurementSegment({
    trace: "duplicate-marker.trace.json",
    action: "zoom",
    traceEvents: [...events, { ...events[0], ts: 120 }],
    startMarker: "case:start",
    endMarker: "case:end",
    activeWindows: [
      { id: "zoom", startMarker: "case:start", endMarker: "case:active-end" },
    ],
  });
  assert.equal(duplicate.status, "unavailable");
  assert.equal(duplicate.reasonCode, "TRACE_MARKER_AMBIGUOUS");

  const reversed = buildMeasurementSegment({
    trace: "reversed-marker.trace.json",
    action: "scroll",
    traceEvents: events.map((event) =>
      event.name === "TimeStamp" &&
      event.args.data.message === "case:active-end"
        ? { ...event, ts: 90 }
        : event,
    ),
    startMarker: "case:start",
    endMarker: "case:end",
    activeWindows: [
      { id: "scroll", startMarker: "case:start", endMarker: "case:active-end" },
    ],
  });
  assert.equal(reversed.status, "unavailable");
  assert.equal(reversed.reasonCode, "TRACE_MARKER_NON_MONOTONIC");

  const changedStream = buildMeasurementSegment({
    trace: "changed-stream.trace.json",
    action: "open",
    traceEvents: events.map((event, index) =>
      index === 6
        ? {
            ...event,
            args: {
              frame_reporter: {
                ...event.args.frame_reporter,
                frame_source: 10,
              },
            },
          }
        : event,
    ),
    startMarker: "case:start",
    endMarker: "case:end",
    activeWindows: [
      {
        id: "open-immediate",
        startMarker: "case:start",
        endMarker: "case:active-end",
      },
      {
        id: "open-completion",
        startMarker: "case:completion-start",
        endMarker: "case:completion-end",
      },
    ],
  });
  assert.equal(changedStream.status, "unavailable");
  assert.equal(changedStream.reasonCode, "FRAME_STREAM_AMBIGUOUS");
});

test("trace PID epoch is accepted only from raw trace ordering before the marker", () => {
  const markerName = "pilot-100-interactive-open:segment-start";
  const tracingStarted = {
    name: "TracingStartedInBrowser",
    ph: "I",
    pid: 1,
    tid: 1,
    ts: 100,
    args: {
      data: {
        frames: [
          { frame: "root-frame-1", processId: 71 },
          { frame: "child-frame-1", processId: 72, parent: "root-frame-1" },
        ],
      },
    },
  };
  const marker = {
    name: "TimeStamp",
    cat: "blink.user_timing",
    ph: "I",
    ts: 50,
    pid: 71,
    args: { data: { message: markerName } },
  };
  const inspect = runner.inspectTraceEpochBeforeInput;
  const valid = inspect(
    Buffer.from(JSON.stringify({ traceEvents: [tracingStarted, marker] })),
    markerName,
  );
  assert.deepEqual(valid, {
    status: "complete",
    rootFrameId: "root-frame-1",
    rendererPid: 71,
    tracingStartedEventIndex: 0,
    markerEventIndex: 1,
  });

  for (const scenario of [
    {
      traceEvents: [marker, tracingStarted],
      reasonCode: "TRACE_FRAME_ASSOCIATION_INVALID",
    },
    {
      traceEvents: [tracingStarted, marker, { ...marker }],
      reasonCode: "TRACE_MARKER_AMBIGUOUS",
    },
    {
      traceEvents: [tracingStarted, { ...marker, pid: 72 }],
      reasonCode: "TRACE_MARKER_PID_MISMATCH",
    },
    {
      traceEvents: [
        {
          ...tracingStarted,
          args: { data: { frames: [] } },
        },
        marker,
      ],
      reasonCode: "TRACE_FRAME_ASSOCIATION_INVALID",
    },
    {
      traceEvents: [
        {
          ...tracingStarted,
          args: {
            data: {
              frames: [
                { frame: "root-frame-1", processId: 71 },
                { frame: "another-root", processId: 72 },
              ],
            },
          },
        },
        marker,
      ],
      reasonCode: "TRACE_FRAME_ASSOCIATION_INVALID",
    },
  ]) {
    const result = inspect(
      Buffer.from(JSON.stringify({ traceEvents: scenario.traceEvents })),
      markerName,
    );
    assert.equal(result.status, "unavailable");
    assert.equal(result.reasonCode, scenario.reasonCode);
  }
});

test("trace evidence reports recognized event shapes while dropping arbitrary arguments", () => {
  const summary = summarizeTraceEvidence(
    [
      {
        cat: "latency",
        name: "EventProcessing",
        ph: "X",
        ts: 10,
        pid: 7,
        args: {
          chrome_track_event: {
            event_timing: {
              duration: 8,
              interaction_id: 42,
              target: ".private-caption",
            },
          },
          private_url: "https://private.invalid/story",
        },
      },
      {
        cat: "cc",
        name: "PipelineReporter",
        ph: "E",
        ts: 15,
        pid: 7,
        id2: { local: "0x1" },
        args: {
          frame_reporter: {
            surface_frame_trace_id: "s1",
            display_trace_id: "d1",
            layer_tree_host_id: 3,
            frame_source: 9,
          },
          caption: "private caption",
        },
      },
      {
        cat: "input",
        name: "EventCreation",
        ph: "I",
        ts: 9,
        pid: 7,
        args: { id: 17, secret: "private argument" },
      },
    ],
    ["latency", "devtools.timeline", "input"],
  );
  const text = JSON.stringify(summary);
  assert.deepEqual(summary.enabledCategories, [
    "devtools.timeline",
    "input",
    "latency",
  ]);
  assert.deepEqual(summary.eventCounts, {
    EventCreation: 1,
    EventProcessing: 1,
    PipelineReporter: 1,
  });
  assert.equal(
    summary.fieldTypes.EventProcessing[
      "args.chrome_track_event.event_timing.interaction_id"
    ],
    "number",
  );
  assert.equal(
    summary.fieldTypes.PipelineReporter[
      "args.frame_reporter.layer_tree_host_id"
    ],
    "number",
  );
  assert.equal(summary.fieldTypes.PipelineReporter["id2.local"], "string");
  assert.equal(text.includes("private.invalid"), false);
  assert.equal(text.includes("private caption"), false);
  assert.equal(text.includes("private argument"), false);
  assert.equal(text.includes(".private-caption"), false);
});

test("capture metadata requires a capture-time browser version and ordered timestamps", () => {
  assert.throws(
    () =>
      validateCaptureTimeMetadata({
        capturedAtUtc: "2026-10-14T00:00:00.000Z",
        browser: { product: "Playwright Chromium" },
      }),
    /capture-time browser version/,
  );
  assert.throws(
    () =>
      validateCaptureTimeMetadata({
        captureStartedAtUtc: "2026-10-14T00:00:01.000Z",
        captureEndedAtUtc: "2026-10-14T00:00:00.000Z",
        browser: { product: "Playwright Chromium", version: "140.0.0.0" },
      }),
    /capture timestamps/,
  );
  assert.equal(
    validateCaptureTimeMetadata({
      captureStartedAtUtc: "2026-10-14T00:00:00.000Z",
      captureEndedAtUtc: "2026-10-14T00:00:01.000Z",
      browser: { product: "Playwright Chromium", version: "140.0.0.0" },
    }),
    true,
  );
});

test("runner starts capture only for the explicit run flag", () => {
  assert.deepEqual(parseRunnerArgs([]), { mode: "preview" });
  assert.deepEqual(parseRunnerArgs(["--run"]), { mode: "run" });
  assert.throws(
    () => parseRunnerArgs(["--device", "phone"]),
    /unsupported capture option/,
  );
  assert.throws(
    () => parseRunnerArgs(["--run", "--remote"]),
    /unsupported capture option/,
  );
});

test("installed Brave mode requires its exact explicit flag pair", () => {
  assert.deepEqual(parseRunnerArgs(["--run", "--browser=installed-brave"]), {
    mode: "run",
    browser: "installed-brave",
  });
  for (const args of [
    ["--browser=installed-brave"],
    ["--run", "--run", "--browser=installed-brave"],
    ["--run", "--browser=installed-brave", "--browser=installed-brave"],
    ["--run", "--browser=chrome"],
    ["--run", "--browser=installed-brave", "--executable-path=/tmp/brave"],
    ["--run", "--browser=installed-brave", "--user-data-dir=/tmp/profile"],
    ["--run", "--browser=installed-brave", "--profile-directory=Default"],
    ["--run", "--browser=installed-brave", "--fallback=chromium"],
    ["--run", "--observe-inputs"],
    ["--observe-inputs", "--run", "--browser=installed-brave"],
    [
      "--run",
      "--browser=installed-brave",
      "--observe-inputs",
      "--observe-inputs",
    ],
    ["--browser=installed-brave", "--run"],
  ]) {
    assert.throws(() => parseRunnerArgs(args), /unsupported capture option/);
  }
  assert.deepEqual(parseRunnerArgs([]), { mode: "preview" });
  assert.deepEqual(parseRunnerArgs(["--run"]), { mode: "run" });
  assert.deepEqual(
    parseRunnerArgs(["--run", "--browser=installed-brave", "--observe-inputs"]),
    { mode: "run", browser: "installed-brave", observeInputs: true },
  );
  assert.deepEqual(
    parseRunnerArgs([
      "--run",
      "--browser=installed-brave",
      "--observe-inputs",
      "--retain-input-nodes",
    ]),
    {
      mode: "run",
      browser: "installed-brave",
      observeInputs: true,
      retainInputNodes: true,
    },
  );
  for (const args of [
    ["--retain-input-nodes"],
    ["--run", "--retain-input-nodes"],
    ["--run", "--browser=installed-brave", "--retain-input-nodes"],
    [
      "--run",
      "--browser=installed-brave",
      "--observe-inputs",
      "--retain-input-nodes",
      "--retain-input-nodes",
    ],
    [
      "--run",
      "--browser=installed-brave",
      "--retain-input-nodes",
      "--observe-inputs",
    ],
  ]) {
    assert.throws(() => parseRunnerArgs(args), /unsupported capture option/);
  }
});

test("v3 runner option is exact and selects only the primary 100-item open", () => {
  const args = [
    "--run",
    "--browser=installed-brave",
    "--observe-inputs",
    "--retain-input-nodes-v3",
  ];
  assert.deepEqual(parseRunnerArgs(args), {
    mode: "run",
    browser: "installed-brave",
    observeInputs: true,
    retainInputNodesV3: true,
  });
  for (const invalidArgs of [
    ["--retain-input-nodes-v3"],
    ["--run", "--retain-input-nodes-v3"],
    ["--run", "--browser=installed-brave", "--retain-input-nodes-v3"],
    ["--run", "--observe-inputs", "--retain-input-nodes-v3"],
    [
      "--run",
      "--browser=installed-brave",
      "--observe-inputs",
      "--retain-input-nodes-v3",
      "--retain-input-nodes",
    ],
    [
      "--run",
      "--browser=installed-brave",
      "--retain-input-nodes-v3",
      "--observe-inputs",
    ],
    [...args, "--retain-input-nodes-v3"],
  ]) {
    assert.throws(
      () => parseRunnerArgs(invalidArgs),
      /unsupported capture option/,
    );
  }
  assert.deepEqual(artifactRootsForBrowser("installed-brave", true, true), {
    artifactRoot: resolve(
      process.cwd(),
      ".superpowers/sdd/same-document-retained-node-v3",
    ),
    runsRoot: resolve(
      process.cwd(),
      ".superpowers/sdd/same-document-retained-node-v3/runs",
    ),
  });
  assert.deepEqual(runner.buildCaptureCases({ retainInputNodesV3: true }), [
    { workload: "100-interactive", rowCount: 100, action: "open" },
  ]);
  assert.equal(buildCaptureCases().length, 14);
});

test("producer fingerprint inputs are explicit, sorted, and exclude the analyzer", () => {
  const inputs = runner.producerSourceHashInputs();
  assert.deepEqual(inputs, [...new Set(inputs)].sort());
  for (const path of [
    "scripts/capture-chromium-method-pilot.mjs",
    "scripts/browser-stimulus-observer.mjs",
    "scripts/retained-input-node-evidence.mjs",
    "scripts/lib/owned-cleanup-receipt.mjs",
  ]) {
    assert.ok(inputs.includes(path), path);
  }
  assert.equal(inputs.includes("scripts/chromium-trace-metrics.mjs"), false);
});

function createObserverBrowserHarness({ supported = true } = {}) {
  const listeners = new Map();
  const windowListeners = new Map();
  const observers = [];
  const performanceNow = { value: 10 };
  let randomCallCount = 0;
  class FakeNode {
    constructor(ownerDocument, parentNode = null) {
      this.nodeType = 1;
      this.ownerDocument = ownerDocument;
      this.parentNode = parentNode;
      this.isConnected = true;
      this.capturedPointerIds = new Set();
    }

    hasPointerCapture(pointerId) {
      return this.capturedPointerIds.has(pointerId);
    }

    contains(node) {
      for (let current = node; current; current = current.parentNode) {
        if (current === this) return true;
      }
      return false;
    }
  }
  const root = new FakeNode(null);
  const target = new FakeNode(null, root);
  const document = {
    nodeType: 9,
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
  };
  root.ownerDocument = document;
  target.ownerDocument = document;
  document.documentElement = root;
  class FakePerformanceObserver {
    static supportedEntryTypes = supported ? ["event"] : [];

    constructor(callback) {
      this.callback = callback;
      this.pending = [];
      this.disconnected = false;
      observers.push(this);
    }

    observe(options) {
      this.options = options;
    }

    takeRecords() {
      const pending = this.pending;
      this.pending = [];
      return pending;
    }

    disconnect() {
      this.disconnected = true;
    }

    emit(entries) {
      this.callback({ getEntries: () => entries });
    }
  }
  const sandbox = {
    document,
    performance: { now: () => performanceNow.value },
    PerformanceObserver: FakePerformanceObserver,
    TextEncoder,
    Uint8Array,
    WeakMap,
    Node: FakeNode,
    Map,
    Array,
    Object,
    Number,
    Math,
    JSON,
    Promise,
    setTimeout: (callback) => {
      callback();
      return 1;
    },
    clearTimeout: () => undefined,
    crypto: {
      getRandomValues(bytes) {
        const value = randomCallCount < 2 ? 7 : randomCallCount + 6;
        randomCallCount += 1;
        bytes.fill(value);
        return bytes;
      },
    },
    addEventListener(type, listener) {
      windowListeners.set(type, listener);
    },
    removeEventListener(type, listener) {
      if (windowListeners.get(type) === listener) windowListeners.delete(type);
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  return {
    sandbox,
    listeners,
    windowListeners,
    observers,
    root,
    target,
    performanceNow,
    initialize(source, options) {
      sandbox.options = options;
      runInNewContext(`(${source.toString()})(options)`, sandbox);
      delete sandbox.options;
      return sandbox.__agesTrustedStimulusObserver;
    },
    dispatch({
      type = "click",
      timeStamp,
      isTrusted = true,
      eventTarget = target,
      pointerId = 1,
      composedPath = [eventTarget],
      afterWindowCapture,
    } = {}) {
      const event = {
        type,
        timeStamp,
        isTrusted,
        pointerId,
        target: type === "resize" ? sandbox : eventTarget,
        composedPath: () => composedPath,
      };
      windowListeners.get(type)?.(event);
      afterWindowCapture?.();
      listeners.get(type)?.(event);
    },
    createNode(parentNode = root) {
      return new FakeNode(document, parentNode);
    },
    emitPerformanceEntries(entries) {
      for (const observer of observers) observer.emit(entries);
    },
  };
}

function deferredCapture() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createV3CaptureHarness({
  holdRelease = false,
  delayedLifecycle = false,
  includeEventTiming = false,
  includeEventTimingTrace = false,
  backendNodeId = 42,
  earlyLifecycleFailure = false,
  traceGateFailure = false,
} = {}) {
  const observerHarness = createObserverBrowserHarness();
  const releaseStarted = deferredCapture();
  const releaseAck = deferredCapture();
  const response = deferredCapture();
  const state = {
    log: [],
    traceEvents: [],
    traceEventTail: [],
    observer: null,
  };
  if (includeEventTimingTrace) {
    state.traceEventTail = JSON.parse(
      readFileSync(
        new URL(
          "../fixtures/chromium-traces/event-timing-fallback.trace.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ).traceEvents.map((event) => {
      const copy = structuredClone(event);
      copy.pid = 71;
      if (copy.args?.data?.frame === "frame-A") {
        copy.args.data.frame = "root-frame-1";
      }
      if (copy.args?.event_timing?.frame === "frame-A") {
        copy.args.event_timing.frame = "root-frame-1";
      }
      if (copy.args?.data && Object.hasOwn(copy.args.data, "interactionId")) {
        copy.args.data.interactionId = 17;
        copy.args.data.interactionOffset = 18;
      }
      if (
        copy.args?.event_timing &&
        Object.hasOwn(copy.args.event_timing, "interaction_id")
      ) {
        copy.args.event_timing.interaction_id = 17;
        copy.args.event_timing.interaction_offset = 18;
      }
      return copy;
    });
  }
  const browser = new EventEmitter();
  let runtimeEnabled = false;
  let page;
  let pageSession;
  let browserSession;

  class FakeSession extends EventEmitter {
    constructor(name, sessionId) {
      super();
      this.name = name;
      this._session = { _sessionId: sessionId };
      this.requests = [];
      this.detachCount = 0;
    }

    async send(method, params = {}) {
      this.requests.push({ method, params });
      state.log.push(`${this.name}:${method}`);
      if (method === "Runtime.enable" && !runtimeEnabled) {
        runtimeEnabled = true;
        this.emit("Runtime.executionContextCreated", {
          context: {
            id: 1,
            uniqueId: "unique-context-1",
            auxData: {
              isDefault: true,
              type: "default",
              frameId: "root-frame-1",
            },
          },
        });
      }
      if (method === "Page.getFrameTree") {
        return {
          frameTree: {
            frame: { id: "root-frame-1", loaderId: "root-loader-1" },
          },
        };
      }
      if (method === "Target.getTargetInfo") {
        return { targetInfo: { targetId: "selected-target-1", type: "page" } };
      }
      if (method === "Target.getTargets") {
        return {
          targetInfos: [{ targetId: "selected-target-1", type: "page" }],
        };
      }
      if (method === "Tracing.start") {
        state.traceEvents = [
          {
            name: "TracingStartedInBrowser",
            ph: "I",
            pid: 1,
            tid: 1,
            ts: 1,
            args: {
              data: {
                frames: [
                  { frame: "root-frame-1", processId: 71 },
                  {
                    frame: "child-frame-1",
                    processId: 72,
                    parent: "root-frame-1",
                  },
                ],
              },
            },
          },
        ];
        return {};
      }
      if (method === "Tracing.end") {
        queueMicrotask(() =>
          this.emit("Tracing.tracingComplete", {
            stream: "trace-stream-1",
            dataLossOccurred: false,
          }),
        );
        return {};
      }
      if (method === "IO.read") {
        return {
          data: JSON.stringify({ traceEvents: state.traceEvents }),
          base64Encoded: false,
          eof: true,
        };
      }
      if (method === "Runtime.evaluate" && params.returnByValue === true) {
        state.log.push("page-cdp:final-reference-proof");
        return {
          result: {
            type: "object",
            value: {
              savedDocumentSame: true,
              savedRootSame: true,
              savedTargetSame: true,
              targetOwnerDocumentMatches: true,
              rootContainsTarget: true,
              connected: true,
            },
          },
        };
      }
      if (method === "Runtime.evaluate") {
        return {
          result: {
            type: "object",
            subtype: "node",
            objectId: "retained-node-object-1",
          },
        };
      }
      if (method === "DOM.describeNode") {
        return { node: { backendNodeId } };
      }
      if (method === "Runtime.releaseObjectGroup") {
        releaseStarted.resolve();
        return holdRelease ? releaseAck.promise : {};
      }
      return {};
    }

    async detach() {
      this.detachCount += 1;
      state.log.push(`${this.name}:detach`);
      this.emit("close");
    }
  }

  pageSession = new FakeSession("page-cdp", "selected-session-1");
  browserSession = new FakeSession("browser-cdp", "browser-session-1");

  class FakeLocator {
    constructor(name, click = null) {
      this.name = name;
      this.clickAction = click;
    }

    getByRole(role, options = {}) {
      return new FakeLocator(`${role}:${options.name ?? ""}`);
    }

    locator(selector) {
      return new FakeLocator(selector);
    }

    filter() {
      return this;
    }

    async waitFor() {
      return undefined;
    }

    async evaluate(_callback, argument) {
      state.log.push(`locator:register:${argument}:${Boolean(state.observer)}`);
      state.observer?.registerTarget(observerHarness.target, argument);
      return true;
    }

    async click() {
      if (this.clickAction) return this.clickAction();
      return undefined;
    }
  }

  page = new EventEmitter();
  page.context = () => context;
  page.addInitScript = async (initializer, options) => {
    state.observer = observerHarness.initialize(initializer, options);
  };
  page.evaluate = async (callback, argument) => {
    const source = String(callback);
    if (source.includes("observer.arm()")) {
      state.log.push(`observer:arm:${Boolean(state.observer)}`);
      return state.observer.arm();
    }
    if (source.includes("observer.setPhase(nextPhase)")) {
      return state.observer.setPhase(argument);
    }
    if (source.includes("observer.freeze(expected)")) {
      state.log.push("observer:freeze");
      return state.observer.freeze(argument);
    }
    if (source.includes("observer.clearRetainedNodes()")) {
      state.log.push("observer:clear-references");
      return state.observer.clearRetainedNodes();
    }
    if (source.includes("observer.close()")) {
      state.observer.close();
      return undefined;
    }
    if (source.includes("console.timeStamp")) {
      state.log.push(`marker:${argument}`);
      state.traceEvents.push({
        name: "TimeStamp",
        cat: "blink.user_timing",
        ph: "I",
        ts: state.traceEvents.length + 2,
        pid: 71,
        args: { data: { message: argument } },
      });
      return undefined;
    }
    if (source.includes("innerWidth")) {
      return {
        innerWidth: 1280,
        innerHeight: 800,
        devicePixelRatio: 1,
        screenWidth: 1280,
        screenHeight: 800,
      };
    }
    return undefined;
  };
  page.goto = async () => undefined;
  page.route = async (_pattern, handler) => {
    page.routeHandler = handler;
  };
  page.unroute = async () => {
    page.routeHandler = null;
  };
  page.getByRole = (role, options = {}) =>
    new FakeLocator(
      `${role}:${options.name ?? ""}`,
      role === "link" ? () => page.clickPrimary() : null,
    );
  page.locator = (selector) => new FakeLocator(selector);
  page.getByText = (text) => new FakeLocator(text);
  page.waitForResponse = () => response.promise;
  page.close = async () => {
    state.log.push("page:close");
    page.emit("close");
  };
  page.clickPrimary = async () => {
    state.log.push("page:click-primary");
    state.log.push(`observer:dispatch:${Boolean(state.observer)}`);
    observerHarness.dispatch({
      timeStamp: 12,
      eventTarget: observerHarness.target,
    });
    if (earlyLifecycleFailure) {
      pageSession.emit("Inspector.targetCrashed", {});
    }
    if (includeEventTiming) {
      observerHarness.emitPerformanceEntries([
        {
          name: "click",
          startTime: 12,
          processingStart: 13,
          processingEnd: 17,
          duration: 20,
          interactionId: 17,
          target: null,
        },
      ]);
    }
    state.traceEvents.push(...state.traceEventTail);
    if (traceGateFailure) {
      state.traceEvents = state.traceEvents.filter(
        (event) => event.name !== "TimeStamp",
      );
    }
    const payload = delayedLifecycle
      ? {
          frameId: "root-frame-1",
          timestamp: 1,
          url: "https://private.invalid",
        }
      : { frameId: "root-frame-1" };
    pageSession.emit("Page.frameStartedLoading", payload);
    pageSession.emit("Page.navigatedWithinDocument", {
      frameId: "root-frame-1",
      navigationType: "historyApi",
      timestamp: 2,
      url: "https://private.invalid/current",
    });
    const routeHandler = page.routeHandler;
    if (routeHandler) {
      void routeHandler({
        request: () => ({
          url: () =>
            "http://127.0.0.1/api/timelines/timeline-1/overview?projection=chronological",
        }),
        continue: async () => response.resolve({ ok: () => true }),
        abort: async () => undefined,
      });
    }
  };

  const context = {
    async newPage() {
      return page;
    },
    async newCDPSession(targetPage) {
      assert.equal(targetPage, page);
      return pageSession;
    },
    browser: () => browser,
  };
  browser.newBrowserCDPSession = async () => browserSession;

  return {
    state,
    page,
    pageSession,
    browserSession,
    context,
    releaseStarted: releaseStarted.promise,
    acknowledgeRelease: () => releaseAck.resolve(),
  };
}

async function captureOneV3Case(harness, runDirectory) {
  return runner.captureCase(
    harness.context,
    { workload: "100-interactive", action: "open" },
    "timeline-1",
    "http://127.0.0.1/timelines",
    runDirectory,
    ["blink.user_timing", "devtools.timeline"],
    100,
    true,
    true,
    true,
  );
}

function sidecarPath(runDirectory) {
  return join(runDirectory, "100-interactive-open.stimulus.json");
}

function fileExists(path) {
  try {
    readFileSync(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

test("v3 capture preserves references until post-trace proof and cleanup closure", async () => {
  const harness = createV3CaptureHarness();
  const runDirectory = mkdtempSync(join(tmpdir(), "ages-v3-producer-"));
  try {
    const result = await captureOneV3Case(harness, runDirectory);
    const bytes = readFileSync(sidecarPath(runDirectory));
    const sidecar = JSON.parse(bytes.toString("utf8"));
    const witness = sidecar.observation.sameDocumentLoadingWitness;
    const index = (entry) => harness.state.log.indexOf(entry);

    assert.equal(
      sidecar.schemaVersion,
      3,
      `${harness.state.log.join(",")} records=${sidecar.observation.records.length} observerReason=${sidecar.observation.retainedNodeEvidence.reasonCode} token=${sidecar.observation.records[0]?.targetToken}`,
    );
    assert.equal(sidecar.observation.schemaVersion, 3);
    assert.equal(witness.status, "complete");
    assert.equal(witness.sourceOrder, "unknown");
    assert.equal(witness.retainedTargetProof.sourceRecordIndex, 0);
    assert.equal(
      witness.retainedTargetProof.finalProof.stage,
      "post-trace-before-release",
    );
    assert.equal(
      witness.retainedTargetProof.finalProof.mappedBackendNodeId,
      witness.retainedTargetProof.finalProof.finalBackendNodeId,
    );
    assert.deepEqual(
      witness.events
        .filter(({ method }) =>
          ["Page.frameStartedLoading", "Page.navigatedWithinDocument"].includes(
            method,
          ),
        )
        .map(({ method, phase }) => ({ method, phase })),
      [
        { method: "Page.frameStartedLoading", phase: "primary-action" },
        { method: "Page.navigatedWithinDocument", phase: "primary-action" },
      ],
    );
    assert.ok(
      index("marker:pilot-100-interactive-open:segment-start") <
        index("page:click-primary"),
    );
    assert.ok(index("observer:arm:true") < index("page-cdp:Tracing.start"));
    assert.ok(
      index("page-cdp:IO.read") < index("page-cdp:final-reference-proof"),
    );
    assert.ok(
      index("page-cdp:final-reference-proof") <
        index("observer:clear-references"),
    );
    assert.ok(
      index("observer:clear-references") <
        index("page-cdp:Runtime.releaseObjectGroup"),
    );
    assert.equal(result.caseRecord.measurementStatus, "unavailable");
    assert.equal(result.segment, null);
    assert.equal(result.caseRecord.rowCount, 100);
    assert.equal(
      result.caseRecord.trustedStimulusObservation.sha256,
      createHash("sha256").update(bytes).digest("hex"),
    );
    assert.equal(
      harness.pageSession.listenerCount("Page.frameStartedLoading"),
      0,
    );
    assert.equal(
      harness.browserSession.listenerCount("Target.targetCrashed"),
      0,
    );
  } finally {
    rmSync(runDirectory, { recursive: true, force: true });
  }
});

test("v3 producer output proves retained-node association through manifest-bound CLI analysis", async (t) => {
  const harness = createV3CaptureHarness({
    includeEventTiming: true,
    includeEventTimingTrace: true,
    backendNodeId: 311,
  });
  const runDirectory = mkdtempSync(join(tmpdir(), "ages-v3-cli-composition-"));
  t.after(() => rmSync(runDirectory, { recursive: true, force: true }));
  const captured = await captureOneV3Case(harness, runDirectory);
  const sidecar = JSON.parse(readFileSync(sidecarPath(runDirectory), "utf8"));
  const proof =
    sidecar.observation.sameDocumentLoadingWitness.retainedTargetProof;
  const sourceRecord = sidecar.observation.records[proof.sourceRecordIndex];
  const tracePath = join(runDirectory, captured.traceRecord.trace);
  const traceBytes = readFileSync(tracePath);
  const trace = JSON.parse(traceBytes.toString("utf8"));
  const markerIndex = trace.traceEvents.findIndex(
    (event) =>
      event.name === "TimeStamp" &&
      event.args?.data?.message === "pilot-100-interactive-open:segment-start",
  );
  const eventTimingIndex = trace.traceEvents.findIndex(
    (event) => event.name === "EventTiming" && event.ph === "b",
  );
  assert.equal(captured.caseRecord.actionStatus, "completed");
  assert.equal(sourceRecord.kind, "dom");
  assert.equal(sourceRecord.isTrusted, true);
  assert.equal(
    sidecar.observation.records.find(({ kind }) => kind === "event-timing")
      .targetToken,
    null,
  );
  assert.ok(markerIndex >= 0 && markerIndex < eventTimingIndex);
  assert.equal(trace.traceEvents[eventTimingIndex].args.data.nodeId, 311);

  const manifest = {
    schemaVersion: 1,
    status: "diagnostic-only",
    browser: {
      product: "Runtime browser observation",
      version: "155.0.8059.85",
    },
    browserIdentity: {
      bundle: {
        identifier: "com.brave.Browser",
        shortVersion: "155.1.97.59",
        bundleVersion: "197.59",
        scmRevision: "c7357bfd2a76c2467ba1ae62593a81ae92c05205",
      },
      executableSha256:
        "67539969b31e7579456d87ea62d9556f928f9c92af86bb3f43fe33b57d1cfad7",
      runtime: {
        version: "155.0.8059.85",
        product: "Chrome/155.0.8059.85",
        revision: "@c7357bfd2a76c2467ba1ae62593a81ae92c0520",
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/155.0.0.0 Safari/537.36",
      },
      chromiumSourceIdentity: "unverified",
    },
    sourceHashSha256:
      "1800489f4942aefe4ab642da9350af4177c39c06c44eb29b7ec2ee84a398996a",
    observationEvidence: runner.buildObservationEvidenceDeclaration(
      [captured.caseRecord],
      true,
      3,
    ),
    traces: [captured.traceRecord],
    cases: [captured.caseRecord],
  };
  const manifestPath = join(runDirectory, "manifest.json");
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  writeFileSync(manifestPath, manifestBytes, { flag: "wx" });
  const cleanupReceipt = {
    schemaVersion: 1,
    completedAtUtc: "2026-10-22T00:00:00.000Z",
    manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
    primaryRunFailure: null,
    context: { outcome: "closed", errorCode: null },
    browser: {
      outcome: "closed",
      errorCode: null,
      descendants: "not_independently_verified",
    },
    ownedServer: {
      stopHelper: "returned",
      errorCode: null,
      processGroupSnapshot: { outcome: "unavailable", memberCount: null },
      childExitKnown: false,
      exitCode: null,
      signalCode: null,
    },
    cleanupFailures: [],
  };
  writeFileSync(
    join(runDirectory, "owned-cleanup-receipt.json"),
    serializeOwnedCleanupReceipt(cleanupReceipt),
    { flag: "wx" },
  );

  const analysis = spawnSync(
    process.execPath,
    [
      resolve(process.cwd(), "scripts/analyze-chromium-traces.mjs"),
      manifestPath,
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.equal(analysis.status, 0, analysis.stderr);
  const report = JSON.parse(analysis.stdout);
  const observed = report.traces[0].observedDiscreteInputs;
  assert.equal(observed.status, "diagnostic-only");
  assert.deepEqual(observed.counts, {
    apiEntries: 1,
    accepted: 1,
    rejected: 0,
  });
  assert.equal(observed.formalActionStatus, "unavailable");
  assert.deepEqual(observed.formalActionSamples, []);
  assert.equal(
    report.traces[0].discreteEventTimingCrosswalk.methodScope
      .observedBrowserVersion,
    "155.0.8059.85",
  );
  assert.equal(analysis.stdout.includes(proof.targetToken), false);
  assert.equal(analysis.stdout.includes("backendNodeId"), false);
});

test("delayed pre-marker lifecycle delivery remains source-order unknown", async () => {
  const harness = createV3CaptureHarness({ delayedLifecycle: true });
  const runDirectory = mkdtempSync(join(tmpdir(), "ages-v3-delayed-callback-"));
  try {
    await captureOneV3Case(harness, runDirectory);
    const sidecar = JSON.parse(readFileSync(sidecarPath(runDirectory), "utf8"));
    assert.equal(sidecar.schemaVersion, 3);
    const witness = sidecar.observation.sameDocumentLoadingWitness;
    const loading = witness.events.find(
      ({ method }) => method === "Page.frameStartedLoading",
    );

    assert.equal(witness.status, "complete");
    assert.equal(witness.orderingBasis, "cdp-receipt");
    assert.equal(witness.sourceOrder, "unknown");
    assert.equal(loading.phase, "primary-action");
    assert.equal(Object.hasOwn(loading, "timestamp"), false);
    assert.equal(Object.hasOwn(loading, "url"), false);
  } finally {
    rmSync(runDirectory, { recursive: true, force: true });
  }
});

test("late fatal and unknown CDP events after provisional pass make final v3 sidecar unavailable", async (t) => {
  const lateEvents = [
    {
      name: "fatal target crash",
      eventName: "Inspector.targetCrashed",
      payload: undefined,
    },
    {
      name: "unknown foreign frame scope",
      eventName: "Page.frameStartedLoading",
      payload: { frameId: "foreign-frame-1" },
    },
    {
      name: "page-session Target callback",
      eventName: "Target.targetDestroyed",
      payload: { targetId: "selected-target-1" },
      source: "page",
    },
  ];

  for (const scenario of lateEvents) {
    await t.test(scenario.name, async () => {
      const harness = createV3CaptureHarness({ holdRelease: true });
      const runDirectory = mkdtempSync(join(tmpdir(), "ages-v3-late-event-"));
      const pendingCapture = captureOneV3Case(harness, runDirectory);
      try {
        let releaseTimer;
        try {
          const releaseStarted = await Promise.race([
            harness.releaseStarted.then(() => true),
            new Promise((resolveStarted) => {
              releaseTimer = setTimeout(() => resolveStarted(false), 1500);
            }),
          ]);
          assert.equal(
            releaseStarted,
            true,
            `cleanup release was not reached: ${harness.state.log.join(",")}`,
          );
          assert.ok(
            harness.state.log.includes("page-cdp:final-reference-proof"),
          );
          assert.equal(fileExists(sidecarPath(runDirectory)), false);
          assert.ok(
            harness.pageSession.listenerCount(scenario.eventName) > 0,
            "the collector must still observe cleanup-time lifecycle callbacks",
          );
          harness.pageSession.emit(scenario.eventName, scenario.payload);
        } finally {
          clearTimeout(releaseTimer);
        }
      } finally {
        harness.acknowledgeRelease();
        await pendingCapture;
      }

      const sidecar = JSON.parse(
        readFileSync(sidecarPath(runDirectory), "utf8"),
      );
      assert.equal(
        sidecar.observation.sameDocumentLoadingWitness.status,
        "unavailable",
      );
      const journalEvent =
        sidecar.observation.sameDocumentLoadingWitness.events.find(
          ({ method, source }) =>
            method === scenario.eventName &&
            (scenario.source === undefined || source === scenario.source),
        );
      assert.ok(
        journalEvent,
        "cleanup callback must be retained in the journal",
      );
      assert.equal(
        sidecar.observation.retainedNodeEvidence.status,
        "unavailable",
      );
      assert.equal(
        sidecar.observation.sameDocumentLoadingWitness.collectorCleanup
          .objectGroupReleased,
        true,
      );
      assert.equal(
        sidecar.observation.sameDocumentLoadingWitness.collectorCleanup
          .cdpListenersRemoved,
        true,
      );
      assert.equal(harness.pageSession.listenerCount(scenario.eventName), 0);
      rmSync(runDirectory, { recursive: true, force: true });
    });
  }
});

test("v3 serializes source-only proof when an early gate blocks final identity", async (t) => {
  const scenarios = [
    {
      name: "early lifecycle failure",
      options: { earlyLifecycleFailure: true },
      invalidationMethod: "Inspector.targetCrashed",
    },
    {
      name: "trace gate failure",
      options: { traceGateFailure: true },
      invalidationMethod: null,
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const harness = createV3CaptureHarness(scenario.options);
      const runDirectory = mkdtempSync(
        join(tmpdir(), "ages-v3-source-only-proof-"),
      );
      try {
        const result = await captureOneV3Case(harness, runDirectory);
        const serialized = JSON.parse(
          readFileSync(sidecarPath(runDirectory), "utf8"),
        );
        const observation = serialized.observation;
        const witness = observation.sameDocumentLoadingWitness;
        const proof = witness.retainedTargetProof;
        const sourceRecord = observation.records[proof.sourceRecordIndex];

        assert.equal(serialized.schemaVersion, 3);
        assert.equal(witness.status, "unavailable");
        assert.ok(sourceRecord);
        assert.equal(sourceRecord.kind, "dom");
        assert.equal(sourceRecord.type, "click");
        assert.equal(sourceRecord.isTrusted, true);
        assert.equal(sourceRecord.phase, "primary");
        assert.equal(proof.documentId, sourceRecord.documentId);
        assert.equal(proof.targetToken, sourceRecord.targetToken);
        assert.ok(Object.values(proof.sourceCapture).every(Boolean));
        assert.equal(proof.mappingIndex, null);
        assert.equal(proof.baselineScope, null);
        assert.equal(proof.finalProof, null);
        assert.deepEqual(witness.collectorCleanup, {
          windowListenersRemoved: true,
          strongReferencesCleared: true,
          objectGroupReleased: true,
          cdpListenersRemoved: true,
        });
        assert.notEqual(
          result.caseRecord.trustedStimulusObservation.reasonCode,
          "OBSERVATION_SIDECAR_WRITE_FAILED",
        );

        if (scenario.invalidationMethod) {
          assert.equal(
            witness.firstInvalidation.method,
            scenario.invalidationMethod,
          );
          assert.ok(
            witness.events.some(
              ({ method }) => method === scenario.invalidationMethod,
            ),
          );
        } else {
          assert.equal(witness.firstInvalidation, null);
        }
      } finally {
        rmSync(runDirectory, { recursive: true, force: true });
      }
    });
  }
});

const RETAINED_NODE_PROTOCOL_CATALOG_ID =
  "chromium-43a195105613ac83c21d3f14de279f4a045c7da0+v8-d89479ac5446a374c55a35be19b5a23437558d99";

function validRetainedNodeEvidence(overrides = {}) {
  const snapshot = {
    documentId: "d-0123456789abcdef01234567",
    frameId: "root-frame-1",
    loaderId: "root-loader-1",
  };
  return {
    status: "complete",
    reasonCode: null,
    mappings: [
      {
        targetToken: "t-0123456789abcdef01234567",
        backendNodeId: 1,
      },
    ],
    executionContext: {
      uniqueId: "context-1",
      frameId: "root-frame-1",
      isDefault: true,
    },
    documentId: snapshot.documentId,
    snapshots: {
      beforeArm: snapshot,
      afterArm: snapshot,
      afterDrain: snapshot,
      afterMapping: snapshot,
      afterCleanup: snapshot,
    },
    protocolCatalogId: RETAINED_NODE_PROTOCOL_CATALOG_ID,
    lifecycle: {
      coverage: "complete",
      lossReasonCode: null,
      overflow: false,
    },
    scope: {
      rootIsSelectedDocument: true,
      pointerCaptureUncertain: false,
      shadowTreeUncertain: false,
    },
    cleanup: {
      windowListenersRemoved: true,
      strongReferencesCleared: true,
      objectGroupReleased: true,
      cdpListenersRemoved: true,
    },
    ...overrides,
  };
}

function validTrustedStimulusPayload(overrides = {}) {
  const records = overrides.records ?? [];
  const recordBytes = new TextEncoder().encode(
    JSON.stringify(records),
  ).byteLength;
  return {
    schemaVersion: 1,
    status: "diagnostic",
    reasonCode: null,
    documentId: "d-0123456789abcdef01234567",
    apiStatus: "thresholded",
    apiMetadata: {
      entryType: "event",
      durationThresholdMs: 16,
      buffered: false,
      quantized: true,
      continuousInputExcluded: true,
    },
    records,
    recordCount: records.length,
    recordBytes,
    ...overrides,
  };
}

function validSameDocumentLoadingWitness(overrides = {}) {
  const documentId = "d-0123456789abcdef01234567";
  const targetToken = "t-0123456789abcdef01234567";
  const scope = {
    frameId: "root-frame-1",
    loaderId: "root-loader-1",
    contextUniqueId: "context-1",
    targetId: "selected-target-1",
    sessionId: "selected-session-1",
  };
  return {
    status: "complete",
    reasonCode: null,
    protocolCatalogId: RETAINED_NODE_PROTOCOL_CATALOG_ID,
    events: [
      {
        sequence: 0,
        phase: "primary-action",
        source: "page",
        method: "Page.frameStartedLoading",
        frameId: "root-frame-1",
      },
      {
        sequence: 1,
        phase: "route-ready",
        source: "page",
        method: "Page.navigatedWithinDocument",
        frameId: "root-frame-1",
        navigationType: "historyApi",
      },
    ],
    droppedCount: 0,
    overflow: false,
    loadingCount: 1,
    historyApiCount: 1,
    orderingBasis: "cdp-receipt",
    sourceOrder: "unknown",
    retainedTargetProof: {
      sourceRecordIndex: 0,
      documentId,
      targetToken,
      mappingIndex: 0,
      sourceCapture: {
        targetIsNode: true,
        ownerDocumentMatches: true,
        rootContainsTarget: true,
        connected: true,
        composedPathStartsAtTarget: true,
      },
      baselineScope: { ...scope },
      finalProof: {
        stage: "post-trace-before-release",
        savedDocumentSame: true,
        savedRootSame: true,
        savedTargetSame: true,
        targetOwnerDocumentMatches: true,
        rootContainsTarget: true,
        connected: true,
        mappedBackendNodeId: 1,
        finalBackendNodeId: 1,
        cdpScope: { ...scope },
      },
    },
    firstInvalidation: null,
    collectorCleanup: {
      windowListenersRemoved: true,
      strongReferencesCleared: true,
      objectGroupReleased: true,
      cdpListenersRemoved: true,
    },
    ...overrides,
  };
}

function validVersionThreeTrustedStimulusPayload(overrides = {}) {
  const documentId = "d-0123456789abcdef01234567";
  const records = overrides.records ?? [
    {
      kind: "dom",
      documentId,
      type: "click",
      timeStamp: 12,
      isTrusted: true,
      targetToken: "t-0123456789abcdef01234567",
      targetLabel: "open-primary",
      targetResolution: "registered-target",
      phase: "primary",
    },
  ];
  const {
    records: _records,
    sameDocumentLoadingWitness,
    retainedNodeEvidence,
    ...payloadOverrides
  } = overrides;
  return {
    ...validTrustedStimulusPayload({
      ...payloadOverrides,
      schemaVersion: 3,
      documentId,
      records,
    }),
    retainedNodeEvidence: retainedNodeEvidence ?? validRetainedNodeEvidence(),
    sameDocumentLoadingWitness:
      sameDocumentLoadingWitness ?? validSameDocumentLoadingWitness(),
  };
}

function maximumEventTimingRecords(documentId, count) {
  return Array.from({ length: count }, () => ({
    kind: "event-timing",
    documentId,
    type: "pointerdown",
    startTime: Number.MAX_VALUE,
    processingStart: Number.MAX_VALUE,
    processingEnd: Number.MAX_VALUE,
    duration: Number.MAX_VALUE,
    interactionId: Number.MAX_SAFE_INTEGER,
    targetToken: "t-0123456789abcdef01234567",
    targetLabel: "calendar-viewport",
    targetResolution: "registered-target",
    deliveryPhase: "completion-hold",
  }));
}

function maximumEventTimingEntries(target, count) {
  return Array.from({ length: count }, () => ({
    name: "pointerdown",
    startTime: Number.MAX_VALUE,
    processingStart: Number.MAX_VALUE,
    processingEnd: Number.MAX_VALUE,
    duration: Number.MAX_VALUE,
    interactionId: Number.MAX_SAFE_INTEGER,
    target,
  }));
}

test("version three observation accepts only the closed loading witness schema", async () => {
  const observerModule = await import(
    "../../scripts/browser-stimulus-observer.mjs"
  );
  const payload = validVersionThreeTrustedStimulusPayload();
  const validated = observerModule.validateTrustedStimulusObservation(
    payload,
    payload.documentId,
  );
  const witness = validated.sameDocumentLoadingWitness;

  assert.equal(validated.schemaVersion, 3);
  assert.deepEqual(Object.keys(witness).sort(), [
    "collectorCleanup",
    "droppedCount",
    "events",
    "firstInvalidation",
    "historyApiCount",
    "loadingCount",
    "orderingBasis",
    "overflow",
    "protocolCatalogId",
    "reasonCode",
    "retainedTargetProof",
    "sourceOrder",
    "status",
  ]);
  assert.equal(witness.orderingBasis, "cdp-receipt");
  assert.equal(witness.sourceOrder, "unknown");
  assert.deepEqual(witness.events[0], {
    sequence: 0,
    phase: "primary-action",
    source: "page",
    method: "Page.frameStartedLoading",
    frameId: "root-frame-1",
  });

  const invalidWitnesses = [
    { ...witness, unexpected: "private" },
    { ...witness, sourceOrder: "cdp-receipt" },
    {
      ...witness,
      events: [{ ...witness.events[0], timestamp: 12 }, witness.events[1]],
    },
    {
      ...witness,
      collectorCleanup: { ...witness.collectorCleanup, cookies: true },
    },
    {
      ...witness,
      retainedTargetProof: {
        ...witness.retainedTargetProof,
        sourceCapture: {
          ...witness.retainedTargetProof.sourceCapture,
          pageText: "private",
        },
      },
    },
    {
      ...witness,
      collectorCleanup: {
        ...witness.collectorCleanup,
        strongReferencesCleared: false,
      },
    },
    {
      ...witness,
      retainedTargetProof: {
        ...witness.retainedTargetProof,
        sourceCapture: {
          ...witness.retainedTargetProof.sourceCapture,
          connected: false,
        },
      },
    },
    {
      ...witness,
      retainedTargetProof: {
        ...witness.retainedTargetProof,
        baselineScope: null,
      },
    },
    {
      ...witness,
      retainedTargetProof: {
        ...witness.retainedTargetProof,
        finalProof: null,
      },
    },
    {
      ...witness,
      retainedTargetProof: {
        ...witness.retainedTargetProof,
        finalProof: {
          ...witness.retainedTargetProof.finalProof,
          finalBackendNodeId: 2,
        },
      },
    },
  ];
  for (const invalidWitness of invalidWitnesses) {
    assert.throws(
      () =>
        observerModule.validateTrustedStimulusObservation(
          {
            ...payload,
            sameDocumentLoadingWitness: invalidWitness,
          },
          payload.documentId,
        ),
      { message: "RETAINED_NODE_EVIDENCE_INVALID" },
    );
  }
});

test("version three accepts historyApi during primary action or route readiness only after loading", async () => {
  const observerModule = await import(
    "../../scripts/browser-stimulus-observer.mjs"
  );
  const payload = validVersionThreeTrustedStimulusPayload();
  const baseWitness = payload.sameDocumentLoadingWitness;

  for (const phase of ["primary-action", "route-ready"]) {
    const witness = {
      ...baseWitness,
      events: [baseWitness.events[0], { ...baseWitness.events[1], phase }],
    };
    const validated = observerModule.validateTrustedStimulusObservation(
      { ...payload, sameDocumentLoadingWitness: witness },
      payload.documentId,
    );
    assert.equal(validated.sameDocumentLoadingWitness.status, "complete");
    assert.equal(validated.sameDocumentLoadingWitness.events[1].phase, phase);
  }

  for (const phase of [
    "baseline",
    "before-input",
    "post-trace-analysis",
    "cleanup",
  ]) {
    const witness = {
      ...baseWitness,
      events: [baseWitness.events[0], { ...baseWitness.events[1], phase }],
    };
    assert.throws(
      () =>
        observerModule.validateTrustedStimulusObservation(
          { ...payload, sameDocumentLoadingWitness: witness },
          payload.documentId,
        ),
      { message: "RETAINED_NODE_EVIDENCE_INVALID" },
    );
  }

  const reordered = {
    ...baseWitness,
    events: [
      { ...baseWitness.events[1], sequence: 0 },
      { ...baseWitness.events[0], sequence: 1 },
    ],
  };
  assert.throws(
    () =>
      observerModule.validateTrustedStimulusObservation(
        { ...payload, sameDocumentLoadingWitness: reordered },
        payload.documentId,
      ),
    { message: "RETAINED_NODE_EVIDENCE_INVALID" },
  );
});

test("loading witness accepts 128 entries but rejects dropped and overflowed events", async () => {
  const observerModule = await import(
    "../../scripts/browser-stimulus-observer.mjs"
  );
  const baseWitness = validSameDocumentLoadingWitness();
  const events = [
    ...baseWitness.events,
    ...Array.from({ length: 126 }, (_, index) => ({
      sequence: index + 2,
      phase: "cleanup",
      source: "browser",
      method: "Target.targetInfoChanged",
      targetId: `other-target-${index + 1}`,
    })),
  ];
  const atLimit = {
    ...baseWitness,
    events,
  };
  const payload = validVersionThreeTrustedStimulusPayload({
    sameDocumentLoadingWitness: atLimit,
  });
  assert.equal(
    observerModule.validateTrustedStimulusObservation(
      payload,
      payload.documentId,
    ).sameDocumentLoadingWitness.events.length,
    128,
  );

  for (const invalidWitness of [
    { ...atLimit, droppedCount: 1 },
    { ...atLimit, overflow: true },
    {
      ...atLimit,
      events: [
        ...events,
        {
          sequence: 128,
          phase: "cleanup",
          source: "browser",
          method: "Target.targetInfoChanged",
          targetId: "other-target-overflow",
        },
      ],
    },
  ]) {
    assert.throws(
      () =>
        observerModule.validateTrustedStimulusObservation(
          { ...payload, sameDocumentLoadingWitness: invalidWitness },
          payload.documentId,
        ),
      { message: "RETAINED_NODE_EVIDENCE_INVALID" },
    );
  }

  const unavailableOverflow = {
    ...atLimit,
    status: "unavailable",
    reasonCode: "RETAINED_NODE_LIMIT_EXCEEDED",
    droppedCount: 1,
    overflow: true,
    firstInvalidation: {
      sequence: 128,
      phase: "cleanup",
      method: "Target.targetInfoChanged",
      reasonCode: "RETAINED_NODE_LIMIT_EXCEEDED",
    },
  };
  const preserved = observerModule.validateTrustedStimulusObservation(
    { ...payload, sameDocumentLoadingWitness: unavailableOverflow },
    payload.documentId,
  ).sameDocumentLoadingWitness;
  assert.equal(preserved.status, "unavailable");
  assert.equal(preserved.droppedCount, 1);
  assert.equal(preserved.overflow, true);
  assert.equal(preserved.firstInvalidation.sequence, 128);
});

test("trusted DOM source proof binds capture scope to one record index", async () => {
  const observerModule = await import(
    "../../scripts/browser-stimulus-observer.mjs"
  );
  const cases = [
    {
      name: "non-node target",
      createTarget: () => ({}),
      falseFields: [
        "targetIsNode",
        "ownerDocumentMatches",
        "rootContainsTarget",
        "connected",
      ],
    },
    {
      name: "foreign-document target",
      createTarget: (harness) => {
        const target = harness.createNode();
        target.ownerDocument = {};
        return target;
      },
      falseFields: ["ownerDocumentMatches"],
    },
    {
      name: "target outside the saved root",
      createTarget: (harness) => {
        const target = harness.createNode();
        target.parentNode = null;
        return target;
      },
      falseFields: ["rootContainsTarget"],
    },
    {
      name: "disconnected target",
      createTarget: (harness) => {
        const target = harness.createNode();
        target.isConnected = false;
        return target;
      },
      falseFields: ["connected"],
    },
    {
      name: "composed path does not start at target",
      createTarget: (harness) => harness.createNode(),
      falseFields: ["composedPathStartsAtTarget"],
      composedPath: (harness) => [harness.createNode()],
    },
  ];

  for (const testCase of cases) {
    const harness = createObserverBrowserHarness();
    const state = harness.initialize(
      observerModule.initializeTrustedStimulusObserver,
      { retainInputNodes: true, retainedNodeEvidenceVersion: 3 },
    );
    const target = testCase.createTarget(harness);
    state.arm();
    harness.dispatch({
      timeStamp: 11,
      eventTarget: target,
      composedPath: testCase.composedPath?.(harness) ?? [target],
      afterWindowCapture: () => {
        if (testCase.name === "disconnected target") {
          target.isConnected = false;
        }
      },
    });
    harness.dispatch({
      timeStamp: 12,
      isTrusted: false,
      eventTarget: harness.createNode(),
    });

    const payload = await state.freeze(state.documentId);
    const validated = observerModule.validateTrustedStimulusObservation(
      payload,
      payload.documentId,
    );
    const proof = validated.sameDocumentLoadingWitness.retainedTargetProof;
    const expectedCapture = {
      targetIsNode: true,
      ownerDocumentMatches: true,
      rootContainsTarget: true,
      connected: true,
      composedPathStartsAtTarget: true,
    };
    for (const field of testCase.falseFields) {
      expectedCapture[field] = false;
    }

    assert.equal(validated.schemaVersion, 3, testCase.name);
    assert.equal(validated.records[proof.sourceRecordIndex].isTrusted, true);
    assert.equal(validated.records[proof.sourceRecordIndex].phase, "primary");
    assert.equal(
      validated.records[proof.sourceRecordIndex].targetToken,
      proof.targetToken,
    );
    assert.deepEqual(proof.sourceCapture, expectedCapture, testCase.name);
    assert.equal(proof.sourceRecordIndex, 0, testCase.name);
    if (proof.targetToken === null) {
      assert.equal(proof.mappingIndex, null, testCase.name);
      assert.equal(proof.finalProof, null, testCase.name);
    }

    const mismatched = {
      ...validated,
      sameDocumentLoadingWitness: {
        ...validated.sameDocumentLoadingWitness,
        retainedTargetProof: {
          ...proof,
          sourceRecordIndex: 1,
        },
      },
    };
    assert.throws(
      () =>
        observerModule.validateTrustedStimulusObservation(
          mismatched,
          payload.documentId,
        ),
      { message: "RETAINED_NODE_EVIDENCE_INVALID" },
      testCase.name,
    );
    state.clearRetainedNodes();
  }

  const harness = createObserverBrowserHarness();
  const state = harness.initialize(
    observerModule.initializeTrustedStimulusObserver,
    { retainInputNodes: true, retainedNodeEvidenceVersion: 3 },
  );
  const target = harness.createNode();
  state.arm();
  harness.dispatch({
    timeStamp: 11,
    eventTarget: target,
    afterWindowCapture: () => {
      target.isConnected = false;
    },
  });
  const payload = await state.freeze(state.documentId);
  const validated = observerModule.validateTrustedStimulusObservation(
    payload,
    payload.documentId,
  );
  assert.equal(
    validated.sameDocumentLoadingWitness.retainedTargetProof.sourceCapture
      .connected,
    true,
  );
  const sourceProof = validated.sameDocumentLoadingWitness.retainedTargetProof;
  const expression = observerModule.retainedNodeFinalReferenceProofExpression({
    documentId: sourceProof.documentId,
    sourceRecordIndex: sourceProof.sourceRecordIndex,
    targetToken: sourceProof.targetToken,
  });
  const finalReference = runInNewContext(expression, harness.sandbox);
  assert.equal(finalReference.savedDocumentSame, true);
  assert.equal(finalReference.savedRootSame, true);
  assert.equal(finalReference.savedTargetSame, true);
  assert.equal(finalReference.targetOwnerDocumentMatches, true);
  assert.equal(finalReference.rootContainsTarget, true);
  assert.equal(finalReference.connected, false);
  assert.equal(target.isConnected, false);
  const wrongIndexExpression =
    observerModule.retainedNodeFinalReferenceProofExpression({
      documentId: sourceProof.documentId,
      sourceRecordIndex: sourceProof.sourceRecordIndex + 1,
      targetToken: sourceProof.targetToken,
    });
  assert.equal(runInNewContext(wrongIndexExpression, harness.sandbox), null);
  assert.throws(
    () =>
      observerModule.retainedNodeFinalReferenceProofExpression({
        documentId: sourceProof.documentId,
        sourceRecordIndex: sourceProof.sourceRecordIndex,
        targetToken: `t-${'"; globalThis.compromised = true; //'}`,
      }),
    { message: "RETAINED_NODE_EVIDENCE_INVALID" },
  );
  state.clearRetainedNodes();
  assert.equal(runInNewContext(expression, harness.sandbox), null);
});

test("version-three source reference cannot bypass the retained-node budget", async () => {
  const observerModule = await import(
    "../../scripts/browser-stimulus-observer.mjs"
  );
  const harness = createObserverBrowserHarness();
  const state = harness.initialize(
    observerModule.initializeTrustedStimulusObserver,
    { retainInputNodes: true, retainedNodeEvidenceVersion: 3 },
  );
  state.arm();
  const retainedNodes = Array.from({ length: 32 }, () => harness.createNode());
  for (const [index, target] of retainedNodes.entries()) {
    harness.dispatch({
      type: "pointermove",
      timeStamp: 11 + index,
      eventTarget: target,
    });
  }
  harness.dispatch({
    timeStamp: 50,
    eventTarget: harness.createNode(),
  });

  const payload = await state.freeze(state.documentId);
  const validated = observerModule.validateTrustedStimulusObservation(
    payload,
    payload.documentId,
  );
  const proof = validated.sameDocumentLoadingWitness.retainedTargetProof;
  assert.equal(validated.sameDocumentLoadingWitness.status, "unavailable");
  assert.equal(
    validated.sameDocumentLoadingWitness.reasonCode,
    "RETAINED_NODE_LIMIT_EXCEEDED",
  );
  assert.equal(state.retainedInputNodeCount, 32);
  assert.equal(proof.sourceRecordIndex, 32);
  assert.equal(proof.targetToken, payload.records[32].targetToken);
  assert.equal(proof.mappingIndex, null);
  assert.equal(proof.finalProof, null);
  assert.equal(state.getRetainedInputNode(proof.targetToken), null);
  const expression = observerModule.retainedNodeFinalReferenceProofExpression({
    documentId: proof.documentId,
    sourceRecordIndex: proof.sourceRecordIndex,
    targetToken: proof.targetToken,
  });
  assert.equal(runInNewContext(expression, harness.sandbox), null);
  state.clearRetainedNodes();
});

test("observer releases version-three document and root references on repeated cleanup", async () => {
  const observerModule = await import(
    "../../scripts/browser-stimulus-observer.mjs"
  );

  const versionTwoHarness = createObserverBrowserHarness();
  const versionTwoDocument = versionTwoHarness.sandbox.document;
  let versionTwoDocumentReads = 0;
  Object.defineProperty(versionTwoHarness.sandbox, "document", {
    configurable: true,
    get() {
      versionTwoDocumentReads += 1;
      return versionTwoDocument;
    },
  });
  versionTwoHarness.initialize(
    observerModule.initializeTrustedStimulusObserver,
    { retainInputNodes: true },
  );
  assert.equal(versionTwoDocumentReads, 0);

  const versionOneHarness = createObserverBrowserHarness();
  let versionOneRootReads = 0;
  Object.defineProperty(versionOneHarness.sandbox.document, "documentElement", {
    configurable: true,
    get() {
      versionOneRootReads += 1;
      return versionOneHarness.root;
    },
  });
  versionOneHarness.initialize(
    observerModule.initializeTrustedStimulusObserver,
    {},
  );
  assert.equal(versionOneRootReads, 0);

  const versionThreeHarness = createObserverBrowserHarness();
  const versionThree = versionThreeHarness.initialize(
    observerModule.initializeTrustedStimulusObserver,
    { retainInputNodes: true, retainedNodeEvidenceVersion: 3 },
  );
  versionThree.arm();
  const firstFreeze = await versionThree.freeze(versionThree.documentId);
  assert.equal(
    firstFreeze.sameDocumentLoadingWitness.collectorCleanup
      .strongReferencesCleared,
    false,
  );

  versionThree.close();
  const afterRepeatedClose = await versionThree.freeze(versionThree.documentId);
  assert.equal(
    afterRepeatedClose.sameDocumentLoadingWitness.collectorCleanup
      .strongReferencesCleared,
    true,
  );
  assert.equal(versionThree.clearRetainedNodes().strongReferencesCleared, true);

  const clearHarness = createObserverBrowserHarness();
  const clearState = clearHarness.initialize(
    observerModule.initializeTrustedStimulusObserver,
    { retainInputNodes: true, retainedNodeEvidenceVersion: 3 },
  );
  clearState.arm();
  const beforeClear = await clearState.freeze(clearState.documentId);
  assert.equal(
    beforeClear.sameDocumentLoadingWitness.collectorCleanup
      .strongReferencesCleared,
    false,
  );
  assert.equal(clearState.clearRetainedNodes().strongReferencesCleared, true);
  const afterClear = await clearState.freeze(clearState.documentId);
  assert.equal(
    afterClear.sameDocumentLoadingWitness.collectorCleanup
      .strongReferencesCleared,
    true,
  );
});

function inputFrameTreeResponse(
  frameId = "root-frame-1",
  loaderId = "root-loader-1",
) {
  return {
    frameTree: {
      frame: {
        id: frameId,
        loaderId,
        url: "https://private.invalid/story",
        name: "private frame name",
        securityOrigin: "https://private.invalid",
      },
    },
  };
}

function createInputFrameProvenanceSession(responses = []) {
  const session = new EventEmitter();
  session.requests = [];
  let frameTreeRequestCount = 0;
  session.send = async (method, params) => {
    session.requests.push({
      method,
      params,
      lifecycleListenerCount: [
        "Page.frameNavigated",
        "Page.frameDetached",
        "Runtime.executionContextsCleared",
        "Inspector.detached",
        "Inspector.targetCrashed",
        "close",
      ].reduce(
        (total, eventName) => total + session.listenerCount(eventName),
        0,
      ),
    });
    if (method === "Page.enable" || method === "Runtime.enable") return {};
    if (method !== "Page.getFrameTree")
      throw new Error("unexpected CDP request");
    const response = responses[frameTreeRequestCount] ?? responses.at(-1);
    frameTreeRequestCount += 1;
    return typeof response === "function" ? response() : response;
  };
  return session;
}

function requireInputFrameProvenanceTracker() {
  assert.equal(typeof runner.createInputFrameProvenanceTracker, "function");
  return runner.createInputFrameProvenanceTracker;
}

function validInputFrameProvenance(documentId = "d-0123456789abcdef01234567") {
  const root = { frameId: "root-frame-1", loaderId: "root-loader-1" };
  return {
    schemaVersion: 1,
    status: "stable",
    reasonCode: null,
    documentId,
    beforeArm: root,
    afterArm: root,
    afterDrain: root,
  };
}

test("observer initialization is serializable and excludes pre-arm DOM input", async () => {
  const observerModule = await import(
    "../../scripts/browser-stimulus-observer.mjs"
  );
  const harness = createObserverBrowserHarness();
  const state = harness.initialize(
    observerModule.initializeTrustedStimulusObserver,
  );
  assert.ok(state);
  assert.equal(
    JSON.stringify(harness.observers[0].options),
    JSON.stringify({
      type: "event",
      buffered: false,
      durationThreshold: 16,
    }),
  );
  harness.dispatch({ timeStamp: 9 });
  harness.performanceNow.value = 20;
  assert.equal(state.arm().status, "armed");
  state.setPhase("primary");
  harness.dispatch({ timeStamp: 19 });
  harness.dispatch({ timeStamp: 21, isTrusted: false });
  const payload = await state.finish(state.documentId);
  assert.equal(payload.status, "diagnostic");
  assert.equal(payload.records.length, 1);
  assert.equal(
    JSON.stringify(payload.records[0]),
    JSON.stringify({
      kind: "dom",
      documentId: state.documentId,
      type: "click",
      timeStamp: 21,
      isTrusted: false,
      targetToken: "t-070707070707070707070707",
      targetLabel: null,
      targetResolution: "unknown",
      phase: "primary",
    }),
  );
  assert.equal(harness.observers[0].disconnected, true);
  assert.equal(harness.listeners.size, 0);
});

test("retained-node mode captures actual connected and removed targets without borrowing API identity", async () => {
  const observerModule = await import(
    "../../scripts/browser-stimulus-observer.mjs"
  );
  const harness = createObserverBrowserHarness();
  const state = harness.initialize(
    observerModule.initializeTrustedStimulusObserver,
    { retainInputNodes: true },
  );
  assert.equal(typeof state.freeze, "function");
  assert.equal(typeof state.clearRetainedNodes, "function");
  const parent = harness.createNode();
  const child = harness.createNode(parent);
  state.registerTarget(parent, "fit-all");
  state.arm();
  harness.dispatch({
    timeStamp: 11,
    eventTarget: child,
    afterWindowCapture: () => {
      child.isConnected = false;
    },
  });
  harness.observers[0].callback({
    getEntries: () => [
      {
        name: "click",
        startTime: 11,
        processingStart: 12,
        processingEnd: 13,
        duration: 18,
        interactionId: 1,
        target: null,
      },
    ],
  });

  const payload = await state.freeze(state.documentId);
  const domRecord = payload.records.find((record) => record.kind === "dom");
  const apiRecord = payload.records.find(
    (record) => record.kind === "event-timing",
  );
  assert.equal(payload.schemaVersion, 2);
  assert.equal(domRecord.targetResolution, "registered-ancestor");
  assert.equal(domRecord.targetLabel, "fit-all");
  assert.equal(state.getRetainedInputNode(domRecord.targetToken), child);
  assert.equal(child.isConnected, false);
  assert.equal(apiRecord.targetToken, null);
  assert.equal(apiRecord.targetLabel, null);
  assert.equal(apiRecord.targetResolution, "unknown");
  assert.equal(harness.listeners.size, 0);
  assert.equal(harness.windowListeners.size, 0);
  const cleanup = state.clearRetainedNodes();
  assert.equal(cleanup.windowListenersRemoved, true);
  assert.equal(cleanup.strongReferencesCleared, true);
  assert.equal(state.getRetainedInputNode(domRecord.targetToken), null);
});

test("retained-node mode records shadow and pointer-capture uncertainty without using composed-path identity", async () => {
  const observerModule = await import(
    "../../scripts/browser-stimulus-observer.mjs"
  );
  const harness = createObserverBrowserHarness();
  const state = harness.initialize(
    observerModule.initializeTrustedStimulusObserver,
    { retainInputNodes: true },
  );
  assert.equal(typeof state.freeze, "function");
  const host = harness.createNode();
  const shadowTarget = harness.createNode(host);
  host.capturedPointerIds.add(1);
  state.arm();
  harness.dispatch({
    type: "pointerdown",
    timeStamp: 11,
    eventTarget: host,
    composedPath: [shadowTarget, host],
  });

  const payload = await state.freeze(state.documentId);
  const record = payload.records[0];
  assert.equal(state.getRetainedInputNode(record.targetToken), host);
  assert.equal(state.getRetainedInputNode("t-080808080808080808080808"), null);
  assert.equal(payload.retainedNodeEvidence.status, "unavailable");
  assert.equal(
    payload.retainedNodeEvidence.reasonCode,
    "RETAINED_NODE_SCOPE_UNSUPPORTED",
  );
  assert.equal(
    payload.retainedNodeEvidence.scope.pointerCaptureUncertain,
    true,
  );
  assert.equal(payload.retainedNodeEvidence.scope.shadowTreeUncertain, true);
  assert.equal(payload.retainedNodeEvidence.mappings.length, 0);
  state.clearRetainedNodes();
});

test("retained-node cleanup retries failed listener removal and reports the actual receipt", async () => {
  const observerModule = await import(
    "../../scripts/browser-stimulus-observer.mjs"
  );
  const harness = createObserverBrowserHarness();
  const state = harness.initialize(
    observerModule.initializeTrustedStimulusObserver,
    { retainInputNodes: true },
  );
  state.arm();
  const removeListener = harness.sandbox.removeEventListener.bind(
    harness.sandbox,
  );
  let clickRemovalFailures = 2;
  harness.sandbox.removeEventListener = (type, listener) => {
    if (type === "click" && clickRemovalFailures > 0) {
      clickRemovalFailures -= 1;
      throw new Error("simulated listener removal failure");
    }
    return removeListener(type, listener);
  };

  const frozen = await state.freeze(state.documentId);
  assert.equal(
    frozen.retainedNodeEvidence.cleanup.windowListenersRemoved,
    false,
  );
  assert.equal(harness.windowListeners.has("click"), true);

  const failedRetry = state.clearRetainedNodes();
  assert.equal(failedRetry.windowListenersRemoved, false);
  assert.equal(failedRetry.strongReferencesCleared, true);
  assert.equal(harness.windowListeners.has("click"), true);

  const successfulRetry = state.clearRetainedNodes();
  assert.equal(successfulRetry.windowListenersRemoved, true);
  assert.equal(successfulRetry.strongReferencesCleared, true);
  assert.equal(harness.windowListeners.size, 0);
});

test("retained-node overflow is permanent and never evicts a contender", async () => {
  const observerModule = await import(
    "../../scripts/browser-stimulus-observer.mjs"
  );
  const harness = createObserverBrowserHarness();
  const state = harness.initialize(
    observerModule.initializeTrustedStimulusObserver,
    { retainInputNodes: true },
  );
  assert.equal(typeof state.freeze, "function");
  state.arm();
  const nodes = Array.from({ length: 33 }, () => harness.createNode());
  for (const [index, node] of nodes.entries()) {
    harness.dispatch({ timeStamp: 11 + index, eventTarget: node });
  }
  const payload = await state.freeze(state.documentId);
  assert.equal(payload.retainedNodeEvidence.status, "unavailable");
  assert.equal(
    payload.retainedNodeEvidence.reasonCode,
    "RETAINED_NODE_LIMIT_EXCEEDED",
  );
  assert.equal(state.retainedInputNodeCount, 32);
  assert.equal(
    state.getRetainedInputNode(payload.records[0].targetToken),
    nodes[0],
  );
  assert.equal(
    state.getRetainedInputNode(payload.records[31].targetToken),
    nodes[31],
  );
  assert.match(payload.records[32].targetToken, /^t-[a-f0-9]{24}$/);
  assert.equal(
    state.getRetainedInputNode(payload.records[32].targetToken),
    null,
  );
  state.clearRetainedNodes();
});

test("version-two retained-node evidence is closed, bounded, and gates complete status", async () => {
  const observerModule = await import(
    "../../scripts/browser-stimulus-observer.mjs"
  );
  assert.equal(typeof observerModule.validateRetainedNodeEvidence, "function");
  assert.equal(typeof observerModule.RETAINED_NODE_EVIDENCE_POLICY, "object");
  assert.deepEqual(observerModule.RETAINED_NODE_EVIDENCE_POLICY, {
    enabled: true,
    maxNodes: 32,
    mappingByteLimit: 16384,
    protocolCatalogId: RETAINED_NODE_PROTOCOL_CATALOG_ID,
  });
  assert.deepEqual(
    observerModule.validateRetainedNodeEvidence(validRetainedNodeEvidence()),
    validRetainedNodeEvidence(),
  );
  const valid32Mappings = Array.from({ length: 32 }, (_, index) => ({
    targetToken: `t-${index.toString(16).padStart(24, "0")}`,
    backendNodeId: index + 1,
  }));
  const atNodeLimit = observerModule.validateRetainedNodeEvidence(
    validRetainedNodeEvidence({ mappings: valid32Mappings }),
  );
  assert.equal(atNodeLimit.mappings.length, 32);
  assert.ok(
    Buffer.byteLength(JSON.stringify(atNodeLimit.mappings)) <=
      observerModule.RETAINED_NODE_EVIDENCE_POLICY.mappingByteLimit,
  );

  for (const evidence of [
    { ...validRetainedNodeEvidence(), extra: "private" },
    {
      ...validRetainedNodeEvidence(),
      mappings: [
        {
          targetToken: "t-0123456789abcdef01234567",
          backendNodeId: 1,
          extra: 1,
        },
      ],
    },
    {
      ...validRetainedNodeEvidence(),
      mappings: [
        { targetToken: "t-0123456789abcdef01234567", backendNodeId: 0 },
      ],
    },
    {
      ...validRetainedNodeEvidence(),
      mappings: [
        {
          targetToken: "t-0123456789abcdef01234567",
          backendNodeId: 2147483648,
        },
      ],
    },
    {
      ...validRetainedNodeEvidence(),
      mappings: [
        { targetToken: "t-0123456789abcdef01234567", backendNodeId: 1 },
        { targetToken: "t-0123456789abcdef01234567", backendNodeId: 2 },
      ],
    },
    { ...validRetainedNodeEvidence(), documentId: null },
    {
      ...validRetainedNodeEvidence(),
      snapshots: {
        ...validRetainedNodeEvidence().snapshots,
        afterMapping: {
          ...validRetainedNodeEvidence().snapshots.afterMapping,
          privateValue: "not serialized",
        },
      },
    },
    {
      ...validRetainedNodeEvidence(),
      lifecycle: {
        coverage: "complete",
        lossReasonCode: "PRIVATE",
        overflow: false,
      },
    },
    {
      ...validRetainedNodeEvidence(),
      scope: {
        rootIsSelectedDocument: true,
        pointerCaptureUncertain: true,
        shadowTreeUncertain: false,
      },
    },
    {
      ...validRetainedNodeEvidence(),
      cleanup: {
        windowListenersRemoved: true,
        strongReferencesCleared: false,
        objectGroupReleased: true,
        cdpListenersRemoved: true,
      },
    },
  ]) {
    assert.throws(() => observerModule.validateRetainedNodeEvidence(evidence), {
      message: "RETAINED_NODE_EVIDENCE_INVALID",
    });
  }
  const tooManyMappings = Array.from({ length: 33 }, (_, index) => ({
    targetToken: `t-${index.toString(16).padStart(24, "0")}`,
    backendNodeId: index + 1,
  }));
  assert.throws(
    () =>
      observerModule.validateRetainedNodeEvidence(
        validRetainedNodeEvidence({ mappings: tooManyMappings }),
      ),
    { message: "RETAINED_NODE_LIMIT_EXCEEDED" },
  );
  assert.throws(
    () =>
      observerModule.validateRetainedNodeEvidence({
        ...validRetainedNodeEvidence(),
        status: "unavailable",
        reasonCode: null,
      }),
    { message: "RETAINED_NODE_EVIDENCE_INVALID" },
  );
  const observationDocumentId = "d-aaaaaaaaaaaaaaaaaaaaaaaa";
  const otherDocumentId = "d-bbbbbbbbbbbbbbbbbbbbbbbb";
  const otherDocumentSnapshot = {
    documentId: otherDocumentId,
    frameId: "root-frame-1",
    loaderId: "root-loader-1",
  };
  const mismatchedCompleteEvidence = validRetainedNodeEvidence({
    documentId: otherDocumentId,
    snapshots: {
      beforeArm: otherDocumentSnapshot,
      afterArm: otherDocumentSnapshot,
      afterDrain: otherDocumentSnapshot,
      afterMapping: otherDocumentSnapshot,
      afterCleanup: otherDocumentSnapshot,
    },
  });
  const mismatchedCompletePayload = {
    ...validTrustedStimulusPayload({ documentId: observationDocumentId }),
    schemaVersion: 2,
    retainedNodeEvidence: mismatchedCompleteEvidence,
  };
  assert.throws(
    () =>
      observerModule.validateTrustedStimulusObservation(
        mismatchedCompletePayload,
        observationDocumentId,
      ),
    { message: "OBSERVATION_PAYLOAD_INVALID" },
  );
  const mismatchedUnavailableEvidence = validRetainedNodeEvidence({
    status: "unavailable",
    reasonCode: "RETAINED_NODE_MAPPING_FAILED",
    documentId: observationDocumentId,
    snapshots: {
      beforeArm: null,
      afterArm: null,
      afterDrain: null,
      afterMapping: otherDocumentSnapshot,
      afterCleanup: null,
    },
  });
  const mismatchedUnavailablePayload = {
    ...validTrustedStimulusPayload({ documentId: observationDocumentId }),
    schemaVersion: 2,
    retainedNodeEvidence: mismatchedUnavailableEvidence,
  };
  assert.throws(
    () =>
      observerModule.validateTrustedStimulusObservation(
        mismatchedUnavailablePayload,
        observationDocumentId,
      ),
    { message: "OBSERVATION_PAYLOAD_INVALID" },
  );
  assert.equal(observerModule.OBSERVATION_LIMITS.records, 512);
  assert.equal(observerModule.OBSERVATION_LIMITS.recordBytes, 240 * 1024);
  assert.equal(observerModule.OBSERVATION_LIMITS.sidecarBytes, 256 * 1024);
  assert.equal(observerModule.RETAINED_NODE_ENVELOPE_RESERVE_BYTES, 36 * 1024);
  assert.equal(
    observerModule.RETAINED_NODE_RECORD_BYTE_LIMIT +
      observerModule.RETAINED_NODE_ENVELOPE_RESERVE_BYTES,
    observerModule.OBSERVATION_LIMITS.sidecarBytes,
  );
});

test("version-two observation sidecars retain their closed extension and exact bytes", async () => {
  const observerModule = await import(
    "../../scripts/browser-stimulus-observer.mjs"
  );
  const directory = mkdtempSync(join(tmpdir(), "ages-retained-node-sidecar-"));
  const payload = {
    ...validTrustedStimulusPayload(),
    schemaVersion: 2,
    retainedNodeEvidence: validRetainedNodeEvidence(),
  };
  try {
    assert.equal(
      typeof observerModule.validateRetainedNodeEvidence,
      "function",
    );
    let written;
    assert.doesNotThrow(() => {
      written = observerModule.writeTrustedStimulusSidecar({
        directory,
        fixture: "100-interactive-pan",
        payload,
        frameProvenance: validInputFrameProvenance(),
      });
    });
    const bytes = readFileSync(join(directory, written.fileName));
    const sidecar = JSON.parse(bytes.toString("utf8"));
    assert.equal(sidecar.schemaVersion, 2);
    assert.equal(sidecar.observation.schemaVersion, 2);
    assert.deepEqual(
      Object.keys(sidecar.observation.retainedNodeEvidence).sort(),
      [
        "cleanup",
        "documentId",
        "executionContext",
        "lifecycle",
        "mappings",
        "protocolCatalogId",
        "reasonCode",
        "scope",
        "snapshots",
        "status",
      ].sort(),
    );
    assert.ok(
      Buffer.byteLength(
        JSON.stringify(sidecar.observation.retainedNodeEvidence.mappings),
      ) <= observerModule.RETAINED_NODE_EVIDENCE_POLICY.mappingByteLimit,
    );
    assert.equal(written.byteCount, bytes.byteLength);
    assert.equal(
      written.sha256,
      createHash("sha256").update(bytes).digest("hex"),
    );
    assert.ok(
      bytes.byteLength <= observerModule.OBSERVATION_LIMITS.sidecarBytes,
    );
    assert.ok(
      payload.recordBytes <= observerModule.OBSERVATION_LIMITS.recordBytes,
    );
    assert.equal(
      observerModule.validateTrustedStimulusObservation(
        payload,
        payload.documentId,
      ).schemaVersion,
      2,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("version-three sidecars serialize the closed witness as schema version three", async () => {
  const observerModule = await import(
    "../../scripts/browser-stimulus-observer.mjs"
  );
  const directory = mkdtempSync(join(tmpdir(), "ages-retained-node-v3-"));
  const payload = validVersionThreeTrustedStimulusPayload();
  try {
    const written = observerModule.writeTrustedStimulusSidecar({
      directory,
      fixture: "100-interactive-open",
      payload,
      frameProvenance: validInputFrameProvenance(),
    });
    const bytes = readFileSync(join(directory, written.fileName));
    const sidecar = JSON.parse(bytes.toString("utf8"));
    assert.equal(sidecar.schemaVersion, 3);
    assert.equal(sidecar.observation.schemaVersion, 3);
    assert.deepEqual(
      sidecar.observation.sameDocumentLoadingWitness,
      payload.sameDocumentLoadingWitness,
    );
    assert.equal(written.byteCount, bytes.byteLength);
    assert.ok(
      bytes.byteLength <= observerModule.OBSERVATION_LIMITS.sidecarBytes,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("version-two near-limit records fit a maximal valid extension without truncation", async () => {
  const observerModule = await import(
    "../../scripts/browser-stimulus-observer.mjs"
  );
  const directory = mkdtempSync(join(tmpdir(), "ages-retained-node-budget-"));
  const documentId = "d-0123456789abcdef01234567";
  const records = maximumEventTimingRecords(documentId, 512);
  const longSnapshot = {
    documentId,
    frameId: "f".repeat(128),
    loaderId: "l".repeat(128),
  };
  const mappings = Array.from({ length: 32 }, (_, index) => ({
    targetToken: `t-${index.toString(16).padStart(24, "0")}`,
    backendNodeId: 2147483647,
  }));
  const payload = {
    ...validTrustedStimulusPayload({ documentId, records }),
    schemaVersion: 2,
    retainedNodeEvidence: validRetainedNodeEvidence({
      mappings,
      executionContext: {
        uniqueId: "c".repeat(128),
        frameId: longSnapshot.frameId,
        isDefault: true,
      },
      documentId,
      snapshots: {
        beforeArm: longSnapshot,
        afterArm: longSnapshot,
        afterDrain: longSnapshot,
        afterMapping: longSnapshot,
        afterCleanup: longSnapshot,
      },
    }),
  };
  const longRoot = {
    frameId: longSnapshot.frameId,
    loaderId: longSnapshot.loaderId,
  };
  const frameProvenance = {
    ...validInputFrameProvenance(documentId),
    beforeArm: longRoot,
    afterArm: longRoot,
    afterDrain: longRoot,
  };
  try {
    assert.equal(payload.recordCount, 512);
    assert.ok(payload.recordBytes > 200 * 1024);
    assert.ok(
      payload.recordBytes <= observerModule.RETAINED_NODE_RECORD_BYTE_LIMIT,
    );
    const written = observerModule.writeTrustedStimulusSidecar({
      directory,
      fixture: "x".repeat(101),
      payload,
      frameProvenance,
    });
    const bytes = readFileSync(join(directory, written.fileName));
    const sidecar = JSON.parse(bytes.toString("utf8"));
    assert.equal(written.recordCount, 512);
    assert.equal(sidecar.observation.recordCount, 512);
    assert.deepEqual(sidecar.observation.records, records);
    assert.equal(written.byteCount, bytes.byteLength);
    assert.ok(
      bytes.byteLength <= observerModule.OBSERVATION_LIMITS.sidecarBytes,
    );

    const beyondReservedBudget = {
      ...payload,
      recordBytes: observerModule.RETAINED_NODE_RECORD_BYTE_LIMIT + 1,
    };
    assert.throws(
      () =>
        observerModule.writeTrustedStimulusSidecar({
          directory,
          fixture: "beyond-reserved-budget",
          payload: beyondReservedBudget,
          frameProvenance,
        }),
      { message: "OBSERVATION_RECORD_BYTES_EXCEEDED" },
    );
    assert.equal(payload.records.length, 512);
    assert.equal(beyondReservedBudget.records.length, 512);
    assert.deepEqual(beyondReservedBudget.records, records);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("late pre-arm event timing is ignored without failing later entries", async () => {
  const observerModule = await import(
    "../../scripts/browser-stimulus-observer.mjs"
  );
  const harness = createObserverBrowserHarness();
  const state = harness.initialize(
    observerModule.initializeTrustedStimulusObserver,
  );
  harness.performanceNow.value = 20;
  state.arm();
  harness.observers[0].callback({
    getEntries: () => [
      {
        name: "click",
        startTime: 19,
        processingStart: 20,
        processingEnd: 21,
        duration: 18,
        interactionId: 1,
        target: harness.target,
      },
      {
        name: "click",
        startTime: 21,
        processingStart: 22,
        processingEnd: 23,
        duration: 18,
        interactionId: 2,
        target: harness.target,
      },
    ],
  });
  harness.dispatch({ timeStamp: 21 });
  const payload = await state.finish(state.documentId);
  assert.equal(payload.status, "diagnostic");
  assert.equal(payload.apiStatus, "thresholded");
  assert.deepEqual(
    Array.from(payload.records)
      .filter((record) => record.kind === "event-timing")
      .map((record) => record.startTime),
    [21],
  );
  assert.equal(payload.records.length, 2);
});

test("observer records DOM dispatch phase and API delivery phase separately", async () => {
  const observerModule = await import(
    "../../scripts/browser-stimulus-observer.mjs"
  );
  const harness = createObserverBrowserHarness();
  const state = harness.initialize(
    observerModule.initializeTrustedStimulusObserver,
  );
  const parent = { nodeType: 1, isConnected: true, parentNode: null };
  const child = { nodeType: 1, isConnected: true, parentNode: parent };
  state.registerTarget(parent, "fit-all");
  state.arm();
  state.setPhase("immediate");
  harness.dispatch({ timeStamp: 11, eventTarget: child });
  state.setPhase("completion");
  harness.observers[0].callback({
    getEntries: () => [
      {
        name: "click",
        startTime: 11,
        processingStart: 12,
        processingEnd: 13,
        duration: 17,
        interactionId: 0,
        target: parent,
      },
    ],
  });
  const payload = await state.finish(state.documentId);
  assert.equal(payload.records[0].phase, "immediate");
  assert.equal(payload.records[0].targetLabel, "fit-all");
  assert.equal(payload.records[1].deliveryPhase, "completion");
  assert.equal(Object.hasOwn(payload.records[1], "phase"), false);
  assert.equal(Object.hasOwn(payload.records[1], "isTrusted"), false);
  assert.equal(payload.records[1].interactionId, 0);
});

test("drain resets quiet periods when API callbacks arrive during sleep", async () => {
  const observerModule = await import(
    "../../scripts/browser-stimulus-observer.mjs"
  );
  const harness = createObserverBrowserHarness();
  const state = harness.initialize(
    observerModule.initializeTrustedStimulusObserver,
  );
  state.arm();
  const observer = harness.observers[0];
  const deliveries = [
    { at: 10, startTime: 11, interactionId: 1 },
    { at: 30, startTime: 31, interactionId: 2 },
    { at: 50, startTime: 51, interactionId: 3 },
  ];
  let elapsed = 0;
  harness.sandbox.setTimeout = (callback, delay) => {
    const next = elapsed + delay;
    for (const delivery of deliveries) {
      if (delivery.at > elapsed && delivery.at <= next) {
        observer.callback({
          getEntries: () => [
            {
              name: "click",
              startTime: delivery.startTime,
              processingStart: delivery.startTime + 1,
              processingEnd: delivery.startTime + 2,
              duration: 18,
              interactionId: delivery.interactionId,
              target: harness.target,
            },
          ],
        });
      }
    }
    elapsed = next;
    harness.performanceNow.value += delay;
    callback();
    return 1;
  };
  const payload = await state.finish(state.documentId);
  assert.equal(payload.status, "diagnostic");
  assert.deepEqual(
    Array.from(payload.records)
      .filter((record) => record.kind === "event-timing")
      .map((record) => record.startTime),
    [11, 31, 51],
  );
  assert.ok(elapsed >= 80);
  assert.ok(elapsed <= observerModule.OBSERVATION_LIMITS.drainTimeoutMs);
});

test("observer caps combined records and validates record byte budgets", async () => {
  const observerModule = await import(
    "../../scripts/browser-stimulus-observer.mjs"
  );
  const harness = createObserverBrowserHarness();
  const state = harness.initialize(
    observerModule.initializeTrustedStimulusObserver,
  );
  state.arm();
  state.setPhase("primary");
  for (let index = 0; index < 256; index += 1) {
    harness.dispatch({ timeStamp: 11 + index });
  }
  harness.observers[0].callback({
    getEntries: () =>
      Array.from({ length: 257 }, (_, index) => ({
        name: "click",
        startTime: 300 + index,
        processingStart: 301 + index,
        processingEnd: 302 + index,
        duration: 17,
        interactionId: index,
        target: harness.target,
      })),
  });
  const payload = await state.finish(state.documentId);
  assert.equal(payload.records.length, 512);
  assert.equal(payload.status, "censored");
  assert.equal(payload.reasonCode, "OBSERVATION_RECORD_LIMIT_EXCEEDED");
  assert.equal(payload.recordCount, 512);
  assert.ok(
    payload.recordBytes <= observerModule.OBSERVATION_LIMITS.recordBytes,
  );

  const oversized = validTrustedStimulusPayload({
    recordBytes: observerModule.OBSERVATION_LIMITS.recordBytes + 1,
  });
  assert.throws(
    () =>
      observerModule.validateTrustedStimulusObservation(
        oversized,
        oversized.documentId,
      ),
    { message: "OBSERVATION_RECORD_BYTES_EXCEEDED" },
  );
});

test("browser caps the exact serialized sidecar before transport", async () => {
  const observerModule = await import(
    "../../scripts/browser-stimulus-observer.mjs"
  );
  const harness = createObserverBrowserHarness();
  const state = harness.initialize(
    observerModule.initializeTrustedStimulusObserver,
  );
  state.registerTarget(harness.target, "calendar-viewport");
  state.arm();
  harness.observers[0].callback({
    getEntries: () => maximumEventTimingEntries(harness.target, 512),
  });
  const payload = await state.finish(state.documentId);
  assert.equal(payload.status, "censored");
  assert.equal(payload.reasonCode, "OBSERVATION_SIDECAR_BYTE_LIMIT_EXCEEDED");
  assert.ok(payload.recordCount < 512);
  assert.ok(
    payload.recordBytes <= observerModule.OBSERVATION_LIMITS.recordBytes,
  );
  const sidecar = {
    schemaVersion: 1,
    evidenceClass: observerModule.TRUSTED_STIMULUS_EVIDENCE_CLASS,
    instrumented: true,
    qualification: "diagnostic-only",
    fixture: "x".repeat(101),
    inputMethod:
      "Synthetic Playwright stimulus; DOM isTrusted means browser-dispatched only and does not establish human input or physical equivalence.",
    interpretation: {
      eventTiming:
        "PerformanceEventTiming is thresholded at 16 ms and browser-quantized; continuous input is excluded.",
      targets:
        "Target IDs are opaque per-document tokens; unknown, null, and removed targets remain uncertain.",
    },
    observation: {
      ...payload,
      frameProvenance: {
        schemaVersion: 1,
        status: "unknown",
        reasonCode: "PROVENANCE_DOCUMENT_ID_MISMATCH",
        documentId: payload.documentId,
        beforeArm: { frameId: "f".repeat(128), loaderId: "l".repeat(128) },
        afterArm: { frameId: "f".repeat(128), loaderId: "l".repeat(128) },
        afterDrain: { frameId: "f".repeat(128), loaderId: "l".repeat(128) },
      },
    },
  };
  assert.ok(
    Buffer.byteLength(`${JSON.stringify(sidecar, null, 2)}\n`) <=
      observerModule.OBSERVATION_LIMITS.sidecarBytes,
  );
  assert.equal(harness.observers[0].disconnected, true);
  assert.equal(harness.listeners.size, 0);
});

test("unsupported event timing is explicit while DOM observations remain censored", async () => {
  const observerModule = await import(
    "../../scripts/browser-stimulus-observer.mjs"
  );
  const harness = createObserverBrowserHarness({ supported: false });
  const state = harness.initialize(
    observerModule.initializeTrustedStimulusObserver,
  );
  state.arm();
  harness.dispatch({ timeStamp: 11 });
  const payload = await state.finish(state.documentId);
  assert.equal(payload.status, "censored");
  assert.equal(payload.reasonCode, "PERFORMANCE_EVENT_TIMING_UNSUPPORTED");
  assert.equal(payload.apiStatus, "unsupported");
  assert.equal(payload.records.length, 1);
  assert.equal(payload.records[0].kind, "dom");
});

test("observer validation rejects unknown fields without echoing private values", async () => {
  const observerModule = await import(
    "../../scripts/browser-stimulus-observer.mjs"
  );
  const payload = validTrustedStimulusPayload({ privateValue: "secret-value" });
  assert.throws(
    () =>
      observerModule.validateTrustedStimulusObservation(
        payload,
        payload.documentId,
      ),
    (error) => {
      assert.equal(error.message, "OBSERVATION_PAYLOAD_INVALID");
      assert.doesNotMatch(error.message, /secret-value/);
      return true;
    },
  );
});

test("observer marks replacement documents lost and bounds drain failures", async () => {
  const observerModule = await import(
    "../../scripts/browser-stimulus-observer.mjs"
  );
  const harness = createObserverBrowserHarness();
  const state = harness.initialize(
    observerModule.initializeTrustedStimulusObserver,
  );
  const armed = state.arm();
  harness.dispatch({ timeStamp: 11 });
  const lost = await state.finish("d-ffffffffffffffffffffffff");
  assert.equal(lost.status, "censored");
  assert.equal(lost.reasonCode, "NAVIGATION_OBSERVATION_LOST");
  assert.equal(lost.records.length, 0);
  assert.equal(harness.observers[0].disconnected, true);
  assert.equal(harness.listeners.size, 0);

  const drainHarness = createObserverBrowserHarness();
  const drainState = drainHarness.initialize(
    observerModule.initializeTrustedStimulusObserver,
  );
  drainState.arm();
  drainHarness.observers[0].takeRecords = () => {
    throw new Error("private browser detail");
  };
  const drainFailure = await drainState.finish(drainState.documentId);
  assert.equal(drainFailure.status, "censored");
  assert.equal(drainFailure.reasonCode, "OBSERVATION_DRAIN_TIMEOUT");
  assert.equal(drainHarness.observers[0].disconnected, true);
  assert.equal(drainHarness.listeners.size, 0);

  let evaluationCount = 0;
  let closedAfterTimeout = false;
  const timedOut = await observerModule.finishTrustedStimulusObserver(
    {
      async evaluate() {
        evaluationCount += 1;
        if (evaluationCount === 1) return new Promise(() => {});
        closedAfterTimeout = true;
        return undefined;
      },
    },
    armed.documentId,
    5,
  );
  assert.equal(timedOut.status, "unavailable");
  assert.equal(timedOut.reasonCode, "OBSERVATION_DRAIN_TIMEOUT");
  assert.equal(evaluationCount, 2);
  assert.equal(closedAfterTimeout, true);
});

test("missing observer at drain censors the whole document observation", async () => {
  const observerModule = await import(
    "../../scripts/browser-stimulus-observer.mjs"
  );
  const page = {
    async evaluate(callback, expected) {
      return runInNewContext(`(${callback.toString()})(expected)`, {
        expected,
        globalThis: {},
      });
    },
  };
  const payload = await observerModule.finishTrustedStimulusObserver(
    page,
    "d-0123456789abcdef01234567",
  );
  assert.equal(payload.status, "censored");
  assert.equal(payload.reasonCode, "NAVIGATION_OBSERVATION_LOST");
  assert.equal(payload.recordCount, 0);
  assert.deepEqual(payload.records, []);
});

test("observer sidecars use exclusive writes and return verified hashes", async () => {
  const observerModule = await import(
    "../../scripts/browser-stimulus-observer.mjs"
  );
  const directory = mkdtempSync(join(tmpdir(), "ages-stimulus-sidecar-"));
  const frameProvenance = validInputFrameProvenance();
  try {
    const oversized = validTrustedStimulusPayload({
      records: maximumEventTimingRecords("d-0123456789abcdef01234567", 512),
    });
    assert.ok(
      oversized.recordBytes <= observerModule.OBSERVATION_LIMITS.recordBytes,
    );
    assert.throws(
      () =>
        observerModule.writeTrustedStimulusSidecar({
          directory,
          fixture: "x".repeat(101),
          payload: oversized,
          frameProvenance,
        }),
      { message: "OBSERVATION_SIDECAR_BYTE_LIMIT_EXCEEDED" },
    );

    const payload = validTrustedStimulusPayload();
    const written = observerModule.writeTrustedStimulusSidecar({
      directory,
      fixture: "100-interactive-pan",
      payload,
      frameProvenance,
    });
    const bytes = readFileSync(join(directory, written.fileName));
    const sidecar = JSON.parse(bytes.toString("utf8"));
    assert.equal(sidecar.schemaVersion, 1);
    assert.equal(sidecar.observation.schemaVersion, 1);
    assert.equal(
      Object.hasOwn(sidecar.observation, "retainedNodeEvidence"),
      false,
    );
    assert.equal(written.byteCount, bytes.byteLength);
    assert.ok(
      bytes.byteLength <= observerModule.OBSERVATION_LIMITS.sidecarBytes,
    );
    assert.equal(
      written.sha256,
      createHash("sha256").update(bytes).digest("hex"),
    );
    assert.equal(written.recordCount, 0);
    assert.equal(
      written.evidenceClass,
      "synthetic-Playwright-stimulus-discovery",
    );
    assert.throws(
      () =>
        observerModule.writeTrustedStimulusSidecar({
          directory,
          fixture: "100-interactive-pan",
          payload,
          frameProvenance,
        }),
      { message: "OBSERVATION_SIDECAR_WRITE_FAILED" },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("frame provenance binds three unchanged root snapshots to the observer document", async () => {
  const createTracker = requireInputFrameProvenanceTracker();
  const session = createInputFrameProvenanceSession([
    inputFrameTreeResponse(),
    inputFrameTreeResponse(),
    inputFrameTreeResponse(),
  ]);
  const tracker = createTracker(session, { enabled: true, timeoutMs: 25 });
  const documentId = "d-0123456789abcdef01234567";

  await tracker.captureBeforeArm();
  await tracker.captureAfterArm(documentId);
  const provenance = await tracker.finish(documentId);

  assert.deepEqual(provenance, {
    schemaVersion: 1,
    status: "stable",
    reasonCode: null,
    documentId,
    beforeArm: { frameId: "root-frame-1", loaderId: "root-loader-1" },
    afterArm: { frameId: "root-frame-1", loaderId: "root-loader-1" },
    afterDrain: { frameId: "root-frame-1", loaderId: "root-loader-1" },
  });
  assert.deepEqual(
    session.requests.map(({ method }) => method),
    [
      "Page.enable",
      "Runtime.enable",
      "Page.getFrameTree",
      "Page.getFrameTree",
      "Page.getFrameTree",
    ],
  );
  assert.ok(
    session.requests
      .filter(({ method }) => method === "Page.getFrameTree")
      .every(({ lifecycleListenerCount }) => lifecycleListenerCount === 6),
  );
  assert.doesNotMatch(
    JSON.stringify(provenance),
    /private\.invalid|private frame/,
  );
  assert.equal(session.listenerCount("Page.frameNavigated"), 0);
  assert.equal(session.listenerCount("Page.frameDetached"), 0);
});

test("disabled frame provenance adds no CDP requests or lifecycle listeners", () => {
  const createTracker = requireInputFrameProvenanceTracker();
  const session = createInputFrameProvenanceSession();

  assert.equal(createTracker(session, { enabled: false }), null);
  assert.deepEqual(session.requests, []);
  assert.equal(session.eventNames().length, 0);
});

test("only stable frame provenance permits trace measurement", () => {
  assert.equal(
    typeof runner.inputFrameProvenanceMeasurementFailure,
    "function",
  );
  const measurementFailure = runner.inputFrameProvenanceMeasurementFailure;
  assert.equal(measurementFailure(validInputFrameProvenance()), null);
  assert.equal(
    measurementFailure({ ...validInputFrameProvenance(), status: "invalid" }),
    "INPUT_FRAME_PROVENANCE_UNAVAILABLE",
  );
  assert.equal(
    measurementFailure({ ...validInputFrameProvenance(), status: "unknown" }),
    "INPUT_FRAME_PROVENANCE_UNAVAILABLE",
  );
});

test("frame provenance permanently invalidates every root lifecycle loss", async () => {
  const createTracker = requireInputFrameProvenanceTracker();
  const documentId = "d-0123456789abcdef01234567";
  const cases = [
    [
      "Page.frameNavigated",
      { frame: { id: "root-frame-1", loaderId: "root-loader-2" } },
      "ROOT_DOCUMENT_NAVIGATED",
    ],
    [
      "Page.frameDetached",
      { frameId: "root-frame-1", reason: "remove" },
      "ROOT_FRAME_DETACHED",
    ],
    ["Runtime.executionContextsCleared", {}, "EXECUTION_CONTEXTS_CLEARED"],
    ["Inspector.detached", { reason: "target_closed" }, "CDP_SESSION_LOST"],
    ["Inspector.targetCrashed", {}, "TARGET_CRASHED"],
    ["close", undefined, "CDP_SESSION_LOST"],
  ];

  for (const [eventName, eventPayload, reasonCode] of cases) {
    const session = createInputFrameProvenanceSession([
      inputFrameTreeResponse(),
      inputFrameTreeResponse(),
      inputFrameTreeResponse(),
    ]);
    const tracker = createTracker(session, { enabled: true, timeoutMs: 25 });
    await tracker.captureBeforeArm();
    await tracker.captureAfterArm(documentId);
    session.emit(eventName, eventPayload);
    const provenance = await tracker.finish(documentId);

    assert.equal(provenance.status, "invalid", eventName);
    assert.equal(provenance.reasonCode, reasonCode, eventName);
    assert.equal(session.listenerCount(eventName), 0, eventName);
  }
});

test("root navigation followed by restoration stays invalid despite matching final IDs", async () => {
  const createTracker = requireInputFrameProvenanceTracker();
  const session = createInputFrameProvenanceSession([
    inputFrameTreeResponse(),
    inputFrameTreeResponse(),
    inputFrameTreeResponse(),
  ]);
  const tracker = createTracker(session, { enabled: true, timeoutMs: 25 });
  const documentId = "d-0123456789abcdef01234567";
  await tracker.captureBeforeArm();
  await tracker.captureAfterArm(documentId);
  session.emit("Page.frameNavigated", {
    frame: { id: "root-frame-1", loaderId: "temporary-loader" },
  });
  session.emit("Page.frameNavigated", {
    frame: { id: "root-frame-1", loaderId: "root-loader-1" },
  });
  const provenance = await tracker.finish(documentId);

  assert.deepEqual(provenance.afterDrain, {
    frameId: "root-frame-1",
    loaderId: "root-loader-1",
  });
  assert.equal(provenance.status, "invalid");
  assert.equal(provenance.reasonCode, "ROOT_DOCUMENT_NAVIGATED");
});

test("frame provenance invalidates changed root frame or loader snapshots", async () => {
  const createTracker = requireInputFrameProvenanceTracker();
  const documentId = "d-0123456789abcdef01234567";
  const cases = [
    [
      [
        inputFrameTreeResponse("root-frame-1", "root-loader-1"),
        inputFrameTreeResponse("root-frame-2", "root-loader-2"),
        inputFrameTreeResponse("root-frame-2", "root-loader-2"),
      ],
      "ROOT_FRAME_CHANGED",
    ],
    [
      [
        inputFrameTreeResponse("root-frame-1", "root-loader-1"),
        inputFrameTreeResponse("root-frame-1", "root-loader-2"),
        inputFrameTreeResponse("root-frame-1", "root-loader-2"),
      ],
      "ROOT_DOCUMENT_CHANGED",
    ],
  ];

  for (const [responses, reasonCode] of cases) {
    const session = createInputFrameProvenanceSession(responses);
    const tracker = createTracker(session, { enabled: true, timeoutMs: 25 });
    await tracker.captureBeforeArm();
    await tracker.captureAfterArm(documentId);
    const provenance = await tracker.finish(documentId);

    assert.equal(provenance.status, "invalid");
    assert.equal(provenance.reasonCode, reasonCode);
    assert.equal(session.listenerCount("Page.frameNavigated"), 0);
  }
});

test("root lifecycle events before the first snapshot conservatively invalidate ownership", async () => {
  const createTracker = requireInputFrameProvenanceTracker();
  const session = createInputFrameProvenanceSession([
    inputFrameTreeResponse(),
    inputFrameTreeResponse(),
    inputFrameTreeResponse(),
  ]);
  const tracker = createTracker(session, { enabled: true, timeoutMs: 25 });
  session.emit("Page.frameDetached", { frameId: "unknown-root-or-child" });
  await tracker.captureBeforeArm();
  await tracker.captureAfterArm("d-0123456789abcdef01234567");
  const provenance = await tracker.finish("d-0123456789abcdef01234567");

  assert.equal(provenance.status, "invalid");
  assert.equal(provenance.reasonCode, "ROOT_EVENT_BEFORE_BASELINE");
});

test("frame provenance marks malformed snapshots unknown and rejects private or unknown fields", async () => {
  const createTracker = requireInputFrameProvenanceTracker();
  const observerModule = await import(
    "../../scripts/browser-stimulus-observer.mjs"
  );
  const malformed = createInputFrameProvenanceSession([
    {
      frameTree: {
        frame: {
          id: "root-frame-1",
          url: "https://private.invalid/secret-path",
          securityOrigin: "https://private.invalid",
        },
      },
    },
    inputFrameTreeResponse(),
    inputFrameTreeResponse(),
  ]);
  const tracker = createTracker(malformed, { enabled: true, timeoutMs: 25 });
  const documentId = "d-0123456789abcdef01234567";
  await tracker.captureBeforeArm();
  await tracker.captureAfterArm(documentId);
  const result = await tracker.finish(documentId);

  assert.equal(result.status, "unknown");
  assert.equal(result.reasonCode, "PROVENANCE_MALFORMED_RESPONSE");
  assert.equal(result.beforeArm, null);
  assert.doesNotMatch(JSON.stringify(result), /private\.invalid|secret-path/);
  assert.deepEqual(
    observerModule.validateInputFrameProvenance(
      validInputFrameProvenance(documentId),
      documentId,
    ),
    validInputFrameProvenance(documentId),
  );
  assert.throws(
    () =>
      observerModule.validateInputFrameProvenance(
        { ...validInputFrameProvenance(documentId), privateValue: "secret" },
        documentId,
      ),
    { message: "INPUT_FRAME_PROVENANCE_INVALID" },
  );
  assert.throws(
    () =>
      observerModule.validateInputFrameProvenance(
        {
          ...validInputFrameProvenance(documentId),
          beforeArm: { frameId: "f".repeat(129), loaderId: "root-loader-1" },
        },
        documentId,
      ),
    { message: "INPUT_FRAME_PROVENANCE_INVALID" },
  );
});

test("frame provenance snapshot timeout remains bounded and removes listeners", async () => {
  const createTracker = requireInputFrameProvenanceTracker();
  const session = createInputFrameProvenanceSession([
    () => new Promise(() => {}),
    () => new Promise(() => {}),
    () => new Promise(() => {}),
  ]);
  const tracker = createTracker(session, { enabled: true, timeoutMs: 10 });
  const documentId = "d-0123456789abcdef01234567";
  const startedAt = Date.now();
  await tracker.captureBeforeArm();
  await tracker.captureAfterArm(documentId);
  const provenance = await tracker.finish(documentId);

  assert.equal(provenance.status, "unknown");
  assert.equal(provenance.reasonCode, "PROVENANCE_TIMEOUT");
  assert.ok(Date.now() - startedAt < 250);
  assert.equal(session.listenerCount("Page.frameNavigated"), 0);
  assert.equal(session.listenerCount("Page.frameDetached"), 0);
  assert.equal(session.listenerCount("Runtime.executionContextsCleared"), 0);
  assert.equal(session.listenerCount("Inspector.detached"), 0);
  assert.equal(session.listenerCount("Inspector.targetCrashed"), 0);
  assert.equal(session.listenerCount("close"), 0);
});

test("frame provenance domain enable timeout prevents untracked snapshots", async () => {
  const createTracker = requireInputFrameProvenanceTracker();
  const session = createInputFrameProvenanceSession([inputFrameTreeResponse()]);
  session.send = async (method) => {
    session.requests.push({ method });
    if (method === "Page.enable") return new Promise(() => {});
    if (method === "Runtime.enable") return {};
    if (method === "Page.getFrameTree") return inputFrameTreeResponse();
    throw new Error("unexpected CDP request");
  };
  const tracker = createTracker(session, { enabled: true, timeoutMs: 10 });
  const startedAt = Date.now();
  await tracker.captureBeforeArm();
  await tracker.captureAfterArm("d-0123456789abcdef01234567");
  const provenance = await tracker.finish("d-0123456789abcdef01234567");

  assert.equal(provenance.status, "unknown");
  assert.equal(provenance.reasonCode, "PROVENANCE_TIMEOUT");
  assert.ok(Date.now() - startedAt < 250);
  assert.deepEqual(
    session.requests.map(({ method }) => method),
    ["Page.enable", "Runtime.enable"],
  );
  assert.equal(session.listenerCount("Page.frameNavigated"), 0);
  assert.equal(session.listenerCount("Runtime.executionContextsCleared"), 0);
});

test("frame provenance sidecars validate closed metadata and enforce the byte cap", async () => {
  const observerModule = await import(
    "../../scripts/browser-stimulus-observer.mjs"
  );
  const directory = mkdtempSync(join(tmpdir(), "ages-frame-provenance-"));
  const documentId = "d-0123456789abcdef01234567";
  const frameProvenance = {
    ...validInputFrameProvenance(documentId),
    beforeArm: { frameId: "f".repeat(128), loaderId: "l".repeat(128) },
    afterArm: { frameId: "f".repeat(128), loaderId: "l".repeat(128) },
    afterDrain: { frameId: "f".repeat(128), loaderId: "l".repeat(128) },
  };
  try {
    const written = observerModule.writeTrustedStimulusSidecar({
      directory,
      fixture: "100-interactive-pan",
      payload: validTrustedStimulusPayload({ documentId }),
      frameProvenance,
    });
    const sidecar = JSON.parse(
      readFileSync(join(directory, written.fileName), "utf8"),
    );
    assert.deepEqual(sidecar.observation.frameProvenance, frameProvenance);
    assert.ok(
      written.byteCount <= observerModule.OBSERVATION_LIMITS.sidecarBytes,
    );
    assert.throws(
      () =>
        observerModule.writeTrustedStimulusSidecar({
          directory,
          fixture: "100-interactive-zoom",
          payload: validTrustedStimulusPayload({ documentId }),
          frameProvenance: {
            ...frameProvenance,
            url: "https://private.invalid",
          },
        }),
      { message: "INPUT_FRAME_PROVENANCE_INVALID" },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("frame provenance failures censor observations while preserving raw evidence", async () => {
  const observerModule = await import(
    "../../scripts/browser-stimulus-observer.mjs"
  );
  const directory = mkdtempSync(join(tmpdir(), "ages-provenance-censored-"));
  const documentId = "d-0123456789abcdef01234567";
  const records = maximumEventTimingRecords(documentId, 1);
  const failures = [
    {
      status: "invalid",
      reasonCode: "ROOT_DOCUMENT_NAVIGATED",
    },
    {
      status: "unknown",
      reasonCode: "PROVENANCE_TIMEOUT",
      beforeArm: null,
      afterArm: null,
      afterDrain: null,
    },
  ];
  try {
    for (const [index, failure] of failures.entries()) {
      const frameProvenance = {
        ...validInputFrameProvenance(documentId),
        ...failure,
      };
      const payload = validTrustedStimulusPayload({ documentId, records });
      const summary = observerModule.writeTrustedStimulusSidecar({
        directory,
        fixture: `100-interactive-provenance-${index}`,
        payload,
        frameProvenance,
      });
      const sidecar = JSON.parse(
        readFileSync(join(directory, summary.fileName), "utf8"),
      );

      assert.equal(summary.status, "censored");
      assert.equal(summary.reasonCode, "INPUT_FRAME_PROVENANCE_UNAVAILABLE");
      assert.equal(summary.apiStatus, "thresholded");
      assert.equal(summary.recordCount, records.length);
      assert.equal(sidecar.observation.status, "censored");
      assert.equal(
        sidecar.observation.reasonCode,
        "INPUT_FRAME_PROVENANCE_UNAVAILABLE",
      );
      assert.equal(sidecar.observation.apiStatus, "thresholded");
      assert.deepEqual(sidecar.observation.apiMetadata, payload.apiMetadata);
      assert.deepEqual(sidecar.observation.records, records);
      assert.deepEqual(sidecar.observation.frameProvenance, frameProvenance);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("opt-in observation keeps default modes and case matrix unchanged", () => {
  assert.deepEqual(parseRunnerArgs([]), { mode: "preview" });
  assert.deepEqual(parseRunnerArgs(["--run"]), { mode: "run" });
  assert.deepEqual(
    artifactRootsForBrowser("installed-brave"),
    artifactRootsForBrowser("installed-brave", false),
  );
  assert.notDeepEqual(
    artifactRootsForBrowser("installed-brave", true),
    artifactRootsForBrowser("installed-brave"),
  );
  assert.equal(buildCaptureCases().length, 14);
});

test("version-two manifest declaration pins one closed retained-node policy", () => {
  const cases = [{ trustedStimulusObservation: { apiStatus: "thresholded" } }];
  assert.equal(typeof runner.buildObservationEvidenceDeclaration, "function");
  const versionOne = runner.buildObservationEvidenceDeclaration(cases);
  assert.equal(Object.hasOwn(versionOne, "schemaVersion"), false);
  assert.equal(Object.hasOwn(versionOne, "retainedNodeEvidence"), false);
  const versionTwo = runner.buildObservationEvidenceDeclaration(cases, true);
  assert.equal(versionTwo.schemaVersion, 2);
  assert.deepEqual(versionTwo.retainedNodeEvidence, {
    enabled: true,
    maxNodes: 32,
    mappingByteLimit: 16384,
    protocolCatalogId: RETAINED_NODE_PROTOCOL_CATALOG_ID,
  });
  assert.equal(versionTwo.recordByteLimit, 220 * 1024);
  assert.deepEqual(Object.keys(versionTwo.retainedNodeEvidence).sort(), [
    "enabled",
    "mappingByteLimit",
    "maxNodes",
    "protocolCatalogId",
  ]);
  const versionThree = runner.buildObservationEvidenceDeclaration(
    cases,
    true,
    3,
  );
  assert.equal(versionThree.schemaVersion, 3);
  assert.equal(versionThree.recordByteLimit, 140 * 1024);
  assert.deepEqual(
    versionThree.retainedNodeEvidence,
    versionTwo.retainedNodeEvidence,
  );
  assert.deepEqual(versionOne, {
    evidenceClass: "synthetic-Playwright-stimulus-discovery",
    instrumented: true,
    qualification: "diagnostic-only",
    inputMethod:
      "Synthetic Playwright stimuli against local fixtures; not human input or physical equivalence.",
    performanceEventTiming: {
      status: "thresholded",
      durationThresholdMs: 16,
      buffered: false,
      quantized: true,
      continuousInputExcluded: true,
    },
    recordLimit: 512,
    recordByteLimit: 240 * 1024,
    sidecarByteLimit: 256 * 1024,
    nextPaint: {
      status: "unproven",
      reasonCode: "NEXT_PAINT_METHOD_UNPROVEN",
    },
  });
});

test("observation manifest status aggregates actual per-case API outcomes", () => {
  const aggregate = runner.aggregateTrustedStimulusApiStatus;
  assert.equal(typeof aggregate, "function");
  assert.equal(aggregate([]), "unknown");
  assert.equal(
    aggregate([
      { trustedStimulusObservation: { apiStatus: "thresholded" } },
      { trustedStimulusObservation: { apiStatus: "thresholded" } },
    ]),
    "thresholded",
  );
  assert.equal(
    aggregate([
      { trustedStimulusObservation: { apiStatus: "unsupported" } },
      { trustedStimulusObservation: { apiStatus: "unsupported" } },
    ]),
    "unsupported",
  );
  assert.equal(
    aggregate([
      { trustedStimulusObservation: { apiStatus: "thresholded" } },
      { trustedStimulusObservation: { apiStatus: "failed" } },
    ]),
    "mixed",
  );
  assert.equal(aggregate([{}]), "unknown");
});

test("installed Brave validation fails closed for missing and redirected bundles", async () => {
  const runner = await import(
    "../../scripts/capture-chromium-method-pilot.mjs"
  );
  assert.equal(typeof runner.validateInstalledBraveInstallation, "function");

  let bundleInfoRead = false;
  const missing = Object.assign(new Error("private path detail"), {
    code: "ENOENT",
  });
  assert.throws(
    () =>
      runner.validateInstalledBraveInstallation({
        lstat: () => {
          throw missing;
        },
        readBundleInfo: () => {
          bundleInfoRead = true;
          return {};
        },
      }),
    { message: "INSTALLED_BRAVE_UNAVAILABLE" },
  );
  assert.equal(bundleInfoRead, false);

  assert.throws(
    () =>
      runner.validateInstalledBraveInstallation({
        lstat: (path) =>
          path === "/Applications/Brave Browser.app"
            ? {
                isDirectory: () => false,
                isFile: () => false,
                isSymbolicLink: () => true,
                mode: 0,
              }
            : {
                isDirectory: () => true,
                isFile: () => false,
                isSymbolicLink: () => false,
                mode: 0o40755,
              },
        readBundleInfo: () => ({ CFBundleIdentifier: "com.brave.Browser" }),
      }),
    { message: "INSTALLED_BRAVE_UNAVAILABLE" },
  );
});

test("installed Brave metadata keeps bundle and runtime observations separate", async () => {
  const runner = await import(
    "../../scripts/capture-chromium-method-pilot.mjs"
  );
  assert.equal(typeof runner.buildInstalledBraveBrowserIdentity, "function");
  const identity = runner.buildInstalledBraveBrowserIdentity({
    bundleInfo: {
      CFBundleIdentifier: "com.brave.Browser",
      CFBundleShortVersionString: "155.1.97.56",
      CFBundleVersion: "155.1.97.56",
      SCMRevision: "971a7443b0c9b0a9b2860529b33331b76077ec62",
    },
    executableSha256: "a".repeat(64),
    runtime: {
      version: "153.0.8010.12",
      product: "Chrome/153.0.8010.12",
      revision: "@971a7443b0c9b0a9b2860529b33331b76077ec62",
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.8010.12 Safari/537.36",
    },
  });

  assert.deepEqual(identity.bundle, {
    identifier: "com.brave.Browser",
    shortVersion: "155.1.97.56",
    bundleVersion: "155.1.97.56",
    scmRevision: "971a7443b0c9b0a9b2860529b33331b76077ec62",
  });
  assert.equal(identity.executableSha256, "a".repeat(64));
  assert.deepEqual(identity.runtime, {
    version: "153.0.8010.12",
    product: "Chrome/153.0.8010.12",
    revision: "@971a7443b0c9b0a9b2860529b33331b76077ec62",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.8010.12 Safari/537.36",
  });
  assert.equal(identity.chromiumSourceIdentity, "unverified");
  assert.doesNotMatch(JSON.stringify(identity), /\/Users\/|https?:/);

  const bundleInfo = {
    CFBundleIdentifier: "com.brave.Browser",
    CFBundleShortVersionString: "155.1.97.56",
    CFBundleVersion: "155.1.97.56",
  };
  const runtime = {
    version: "153.0.8010.12",
    product: "Chrome/153.0.8010.12",
    revision: "971a7443b0c9b0a9b2860529b33331b76077ec62",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.8010.12 Safari/537.36",
  };
  const bareRevisionIdentity = runner.buildInstalledBraveBrowserIdentity({
    bundleInfo,
    executableSha256: "a".repeat(64),
    runtime,
  });
  assert.equal(
    bareRevisionIdentity.runtime.revision,
    "971a7443b0c9b0a9b2860529b33331b76077ec62",
  );
  const syntheticShortRevision = `@${"1234567890abcdef".repeat(2)}1234567`;
  const shortRevisionIdentity = runner.buildInstalledBraveBrowserIdentity({
    bundleInfo,
    executableSha256: "a".repeat(64),
    runtime: { ...runtime, revision: syntheticShortRevision },
  });
  assert.equal(shortRevisionIdentity.runtime.revision, syntheticShortRevision);
  for (const revision of [
    `@${"a".repeat(38)}`,
    `@${"a".repeat(41)}`,
    "user@example.test",
    "revision with whitespace",
    "revision\nwith-control",
    "/Users/private/Chromium/source",
  ]) {
    assert.throws(
      () =>
        runner.buildInstalledBraveBrowserIdentity({
          bundleInfo,
          executableSha256: "a".repeat(64),
          runtime: { ...runtime, revision },
        }),
      { message: "BROWSER_METADATA_UNAVAILABLE" },
    );
  }
});

test("installed Brave probe evidence stays qualified and next-paint remains unavailable", async () => {
  const runner = await import(
    "../../scripts/capture-chromium-method-pilot.mjs"
  );
  assert.equal(typeof runner.qualifyInstalledBraveProbeEvidence, "function");
  const caseRecord = {
    action: "open",
    inputToNextPaint: {
      status: "unproven",
      reasonCode: "NEXT_PAINT_METHOD_UNPROVEN",
    },
  };
  const segment = { action: "open", trace: "open.trace.json" };
  const result = runner.qualifyInstalledBraveProbeEvidence(
    [caseRecord],
    [segment],
  );

  assert.equal(result.cases[0].qualification, "installed-brave-schema-probe");
  assert.equal(
    result.measurementSegments[0].qualification,
    "installed-brave-schema-probe",
  );
  assert.deepEqual(result.cases[0].inputToNextPaint, {
    status: "unproven",
    reasonCode: "NEXT_PAINT_METHOD_UNPROVEN",
  });
  assert.deepEqual(result.measurementSegments[0].inputToNextPaint, {
    status: "unproven",
    reasonCode: "NEXT_PAINT_METHOD_UNPROVEN",
  });
  assert.equal(caseRecord.qualification, undefined);
  assert.equal(segment.qualification, undefined);
});

test("installed Brave launch options use the fixed executable and owned profile", async () => {
  const runner = await import(
    "../../scripts/capture-chromium-method-pilot.mjs"
  );
  assert.equal(typeof runner.buildChromiumLaunchOptions, "function");
  const options = runner.buildChromiumLaunchOptions("installed-brave");
  assert.equal(
    options.executablePath,
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  );
  assert.deepEqual(options.args, [
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--no-first-run",
  ]);
  assert.equal(Object.hasOwn(options, "userDataDir"), false);
  assert.equal(
    options.args.some((argument) => /profile|user-data-dir/i.test(argument)),
    false,
  );

  const legacyOptions = runner.buildChromiumLaunchOptions();
  assert.deepEqual(legacyOptions, {
    headless: false,
    args: [
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--no-first-run",
    ],
  });
});

test("installed Brave probe runs use a dedicated artifact root", async () => {
  const runner = await import(
    "../../scripts/capture-chromium-method-pilot.mjs"
  );
  assert.equal(typeof runner.artifactRootsForBrowser, "function");
  const installedBraveRoots = runner.artifactRootsForBrowser("installed-brave");
  const legacyRoots = runner.artifactRootsForBrowser();

  assert.ok(
    installedBraveRoots.artifactRoot.endsWith(
      "/.superpowers/sdd/installed-brave-schema-probe",
    ),
  );
  assert.equal(
    installedBraveRoots.runsRoot,
    join(installedBraveRoots.artifactRoot, "runs"),
  );
  assert.ok(
    legacyRoots.artifactRoot.endsWith(
      "/.superpowers/sdd/chromium-method-runner",
    ),
  );
  assert.notEqual(installedBraveRoots.artifactRoot, legacyRoots.artifactRoot);
});

test("cleanup terminates only its owned subprocess", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
  });
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  await stopOwnedProcess(child, 1000);
  assert.ok(child.exitCode !== null || child.signalCode !== null);
});
