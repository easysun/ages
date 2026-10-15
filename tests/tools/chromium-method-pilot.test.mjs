import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
import {
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
