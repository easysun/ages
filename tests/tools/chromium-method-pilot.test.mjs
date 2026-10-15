import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
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

test("persistent or unknown group snapshots never suppress the original probe", async () => {
  const groupId = 43210;
  const uid = process.getuid?.() ?? 501;
  const child = { pid: groupId, exitCode: 0, signalCode: null };
  const memberRow = `${groupId + 1} ${groupId} ${groupId} ${uid} S`;
  const originalKill = process.kill;
  const attemptedSignals = [];
  let persistentSnapshots = 0;
  let failProbe = true;
  process.kill = (_pid, signal) => {
    attemptedSignals.push(signal);
    if (signal === 0) {
      if (!failProbe) return true;
      assert.ok(persistentSnapshots >= 2);
      throw Object.assign(new Error("private process detail"), {
        code: "EPERM",
      });
    }
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
    assert.deepEqual(attemptedSignals, ["SIGTERM", 0, "SIGKILL"]);
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
  process.kill = () => true;
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
});

function createObserverBrowserHarness({ supported = true } = {}) {
  const listeners = new Map();
  const windowListeners = new Map();
  const observers = [];
  const performanceNow = { value: 10 };
  const target = { nodeType: 1, isConnected: true, parentNode: null };
  const document = {
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
  };
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
  }
  const sandbox = {
    document,
    performance: { now: () => performanceNow.value },
    PerformanceObserver: FakePerformanceObserver,
    TextEncoder,
    Uint8Array,
    WeakMap,
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
        bytes.fill(7);
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
    target,
    performanceNow,
    initialize(source) {
      runInNewContext(`(${source.toString()})()`, sandbox);
      return sandbox.__agesTrustedStimulusObserver;
    },
    dispatch({
      type = "click",
      timeStamp,
      isTrusted = true,
      eventTarget = target,
    } = {}) {
      const eventListeners = type === "resize" ? windowListeners : listeners;
      eventListeners.get(type)?.({
        type,
        timeStamp,
        isTrusted,
        target: type === "resize" ? sandbox : eventTarget,
      });
    },
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
    observation: payload,
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
        }),
      { message: "OBSERVATION_SIDECAR_BYTE_LIMIT_EXCEEDED" },
    );

    const payload = validTrustedStimulusPayload();
    const written = observerModule.writeTrustedStimulusSidecar({
      directory,
      fixture: "100-interactive-pan",
      payload,
    });
    const bytes = readFileSync(join(directory, written.fileName));
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
        }),
      { message: "OBSERVATION_SIDECAR_WRITE_FAILED" },
    );
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
