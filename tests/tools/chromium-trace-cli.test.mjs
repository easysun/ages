import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const scriptPath = fileURLToPath(
  new URL("../../scripts/analyze-chromium-traces.mjs", import.meta.url),
);
const fixturePath = fileURLToPath(
  new URL("../fixtures/chromium-traces/exact-ids.trace.json", import.meta.url),
);
const eventTimingFixturePath = fileURLToPath(
  new URL(
    "../fixtures/chromium-traces/event-timing-fallback.trace.json",
    import.meta.url,
  ),
);
const privateMarker = "TRACE_PRIVATE_DATABASE_MARKER";

function makeFixture(
  t,
  { traceText, traceName = "synthetic.trace.json" } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "ages-chromium-trace-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const traceBytes = Buffer.from(
    traceText ?? readFileSync(fixturePath, "utf8"),
    "utf8",
  );
  const tracePath = join(directory, traceName);
  const manifestPath = join(directory, "manifest.json");
  const manifest = {
    purpose: "Synthetic trace summary test.",
    inputMethod: "Synthetic input.",
    renderer: "Synthetic renderer.",
    hardware: {
      qualification: "Synthetic only.",
      modelIdentifier: "test-machine",
      chip: "test-chip",
      memoryGB: 8,
      os: "test-os",
      osBuild: "test-build",
      activeDisplay: { width: 100, height: 200, refreshRateHz: 60 },
    },
    browser: { product: "Synthetic Chromium", version: "153.0.0.0" },
    viewport: {
      innerWidth: 100,
      innerHeight: 200,
      devicePixelRatio: 1,
      screenWidth: 100,
      screenHeight: 200,
    },
    cache: "Synthetic cache state.",
    sourceRevision: "synthetic-revision",
    sourceHashSha256: "synthetic-source-hash",
    databaseId: privateMarker,
    percentiles: "Do not include this manifest field in reports.",
    traces: [
      {
        fixture: "synthetic-fixture",
        trace: traceName,
        byteCount: traceBytes.length,
        dataLossOccurred: false,
        categories: ["synthetic"],
        mountedMedia: { before: 100, after: 100 },
      },
    ],
  };
  writeFileSync(tracePath, traceBytes, { flag: "wx" });
  writeFileSync(manifestPath, JSON.stringify(manifest), { flag: "wx" });
  return { directory, manifest, manifestPath, traceBytes, tracePath };
}

function runCli(args) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function presentedReporterEvents({ endpoint, surfaceId, displayId, localId }) {
  const common = {
    name: "PipelineReporter",
    cat: "cc,benchmark,disabled-by-default-devtools.timeline.frame",
    pid: 101,
    tid: 1,
    id2: { local: localId },
  };
  return [
    {
      ...common,
      ph: "b",
      ts: endpoint - 10,
      args: {
        frame_reporter: {
          state: "STATE_PRESENTED_ALL",
          surface_frame_trace_id: surfaceId,
          display_trace_id: displayId,
          layer_tree_host_id: 7,
          frame_source: 9,
        },
      },
    },
    { ...common, ph: "e", ts: endpoint },
  ];
}

test("prints a sanitized diagnostic summary without changing trace bytes", (t) => {
  const input = makeFixture(t);
  const beforeHash = sha256(readFileSync(input.tracePath));
  const result = runCli([input.manifestPath]);

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  const traceReport = report.traces[0];
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.status, "diagnostic-only");
  assert.equal(traceReport.fixture, "synthetic-fixture");
  assert.equal(traceReport.trace, basename(input.tracePath));
  assert.equal(traceReport.sha256, beforeHash);
  assert.equal(traceReport.counts.eventCount, 10);
  assert.equal(traceReport.counts.completedEventLatencySlices, 1);
  assert.equal(traceReport.counts.completedPipelineReporterSlices, 1);
  assert.deepEqual(traceReport.inputToPresentedFrameSamples, [
    {
      duration: 50,
      unit: "microseconds",
      status: "diagnostic-only",
      reasonCodes: [],
    },
  ]);
  assert.equal(traceReport.frameIntervals.status, "unavailable");
  assert.ok(
    traceReport.frameIntervals.reasonCodes.includes("NO_MEASUREMENT_SEGMENT"),
  );
  assert.equal(report.metadata.browser.product, "Synthetic Chromium");
  assert.equal(report.metadata.hardware.modelIdentifier, "test-machine");
  assert.equal(report.metadata.cache, "Synthetic cache state.");
  assert.equal(report.percentiles, undefined);
  assert.equal(report.fps, undefined);

  const serializedReport = JSON.stringify(report);
  assert.equal(serializedReport.includes(privateMarker), false);
  assert.equal(serializedReport.includes("databaseId"), false);
  assert.equal(
    serializedReport.includes("TRACE_PRIVATE_CAPTION_MARKER"),
    false,
  );
  assert.equal(serializedReport.includes("https://private.example"), false);
  assert.equal(
    readFileSync(input.tracePath).toString("utf8"),
    input.traceBytes.toString("utf8"),
  );
  assert.equal(sha256(readFileSync(input.tracePath)), beforeHash);
});

test("reports sanitized exact discrete candidates without promoting formal action samples", (t) => {
  const traceBytes = readFileSync(eventTimingFixturePath);
  const input = makeFixture(t, {
    traceText: traceBytes.toString("utf8"),
    traceName: "crosswalk.trace.json",
  });
  input.manifest.browser = {
    product: "Playwright Chromium",
    version: "153.0.8010.12",
  };
  input.manifest.status = "synthetic-method-pilot";
  writeFileSync(input.manifestPath, JSON.stringify(input.manifest));
  const result = runCli([input.manifestPath]);

  assert.equal(result.status, 0, result.stderr);
  const traceReport = JSON.parse(result.stdout).traces[0];
  assert.equal(traceReport.sha256, sha256(traceBytes));
  assert.deepEqual(traceReport.discreteEventTimingCrosswalk.candidates, [
    {
      eventType: "click",
      durationUs: 8,
      processingEndToPresentationUs: 3,
      status: "diagnostic-only",
    },
  ]);
  assert.deepEqual(traceReport.discreteEventTimingCrosswalk.methodScope, {
    observedBrowserVersion: "153.0.8010.12",
    pinnedSourceRevision: "971a7443b0c9b0a9b2860529b33331b76077ec62",
    evidenceClass: "synthetic-method-pilot",
    vendorPatchIdentity: "unverified",
    navigationDocumentIdentity: "not-inferred",
    originScope: "capture-case + renderer PID + frame",
  });
  assert.equal(
    traceReport.discreteEventTimingCrosswalk.formalActionStatus,
    "unavailable",
  );
  assert.deepEqual(
    traceReport.discreteEventTimingCrosswalk.formalActionSamples,
    [],
  );
  assert.ok(
    traceReport.discreteEventTimingCrosswalk.rejectionCounts.some(
      ({ code }) => code === "PAYLOAD_FREE_MODERN_MARKER",
    ),
  );
  assert.equal(result.stdout.includes("frame-A"), false);
  assert.equal(result.stdout.includes('"node_id"'), false);
  assert.equal(result.stdout.includes('"interaction_id"'), false);
  assert.equal(result.stdout.includes(privateMarker), false);
});

test("keeps Brave schema-probe crosswalks unavailable despite a forged Chromium top-level version", (t) => {
  const traceBytes = readFileSync(eventTimingFixturePath);
  const input = makeFixture(t, {
    traceText: traceBytes.toString("utf8"),
    traceName: "brave-probe.trace.json",
  });
  const knownManifest = {
    ...input.manifest,
    browser: { product: "Playwright Chromium", version: "153.0.8010.12" },
    status: "synthetic-method-pilot",
  };
  writeFileSync(input.manifestPath, JSON.stringify(knownManifest));
  const knownResult = runCli([input.manifestPath]);
  assert.equal(knownResult.status, 0, knownResult.stderr);
  const knownTrace = JSON.parse(knownResult.stdout).traces[0];

  const braveManifest = {
    ...knownManifest,
    browserIdentity: {
      bundle: {
        identifier: "com.brave.Browser",
        shortVersion: "155.1.97.56",
        bundleVersion: "155.1.97.56",
      },
      executableSha256: "a".repeat(64),
      runtime: {
        version: "153.0.8010.12",
        product: "Chrome/153.0.8010.12",
        revision: "@971a7443b0c9b0a9b2860529b33331b76077ec62",
        userAgent: "Mozilla/5.0 Chrome/153.0.8010.12 Safari/537.36",
      },
      chromiumSourceIdentity: "unverified",
    },
    qualification: "installed-brave-schema-probe",
    status: "installed-brave-schema-probe",
  };
  writeFileSync(input.manifestPath, JSON.stringify(braveManifest));
  const braveResult = runCli([input.manifestPath]);

  assert.equal(braveResult.status, 0, braveResult.stderr);
  const braveTrace = JSON.parse(braveResult.stdout).traces[0];
  assert.equal(braveTrace.discreteEventTimingCrosswalk.status, "unavailable");
  assert.deepEqual(braveTrace.discreteEventTimingCrosswalk.candidates, []);
  assert.equal(braveTrace.discreteEventTimingCrosswalk.methodScope, null);
  assert.equal(
    braveTrace.discreteEventTimingCrosswalk.formalActionStatus,
    "unavailable",
  );
  assert.deepEqual(
    braveTrace.discreteEventTimingCrosswalk.formalActionSamples,
    [],
  );
  assert.deepEqual(braveTrace.discreteEventTimingCrosswalk.gateReasonCodes, [
    "BROWSER_SOURCE_PROFILE_UNSUPPORTED",
  ]);
  for (const key of [
    "counts",
    "eventTimingInventory",
    "inputToPresentedFrameSamples",
    "frameIntervals",
    "diagnostics",
  ]) {
    assert.deepEqual(braveTrace[key], knownTrace[key]);
  }
});

test("reports isolated protocol-cell frame quantiles and rejects legacy EventTiming as next paint", (t) => {
  const traceEvents = [];
  const measurementSegments = [];
  const trials = [];
  const secondGroupTrials = [];
  for (let index = 0; index < 100; index += 1) {
    const session = Math.floor(index / 40) + 1;
    const trial = (index % 40) + 1;
    const base = index * 1000;
    const interval = index + 1;
    traceEvents.push(
      ...presentedReporterEvents({
        endpoint: base + 20,
        surfaceId: index * 2 + 1,
        displayId: index * 2 + 101,
        localId: `first-${index}`,
      }),
      ...presentedReporterEvents({
        endpoint: base + 20 + interval,
        surfaceId: index * 2 + 2,
        displayId: index * 2 + 102,
        localId: `second-${index}`,
      }),
    );
    measurementSegments.push({
      trace: "synthetic.trace.json",
      action: "fit-all",
      startUs: base,
      endUs: base + 500,
      rendererPid: 101,
      layerTreeHostId: 7,
      frameSource: 9,
      activeWindows: [
        { id: `active-${index}`, startUs: base + 1, endUs: base + 400 },
      ],
      protocolGroupIndex: 0,
      session,
      trial,
    });

    if (index < 99) {
      const secondBase = 200000 + index * 1000;
      const secondSession = Math.floor(index / 40) + 1;
      const secondTrial = (index % 40) + 1;
      traceEvents.push(
        ...presentedReporterEvents({
          endpoint: secondBase + 20,
          surfaceId: 1000 + index * 2 + 1,
          displayId: 2000 + index * 2 + 1,
          localId: `open-first-${index}`,
        }),
        ...presentedReporterEvents({
          endpoint: secondBase + 220 + index,
          surfaceId: 1000 + index * 2 + 2,
          displayId: 2000 + index * 2 + 2,
          localId: `open-second-${index}`,
        }),
      );
      if (index === 0) {
        traceEvents.push(
          ...presentedReporterEvents({
            endpoint: secondBase + 350,
            surfaceId: 5000,
            displayId: 6000,
            localId: "open-third-0",
          }),
        );
      }
      measurementSegments.push({
        trace: "synthetic.trace.json",
        action: "open",
        startUs: secondBase,
        endUs: secondBase + 500,
        rendererPid: 101,
        layerTreeHostId: 7,
        frameSource: 9,
        activeWindows: [
          {
            id: `open-active-${index}`,
            startUs: secondBase + 1,
            endUs: secondBase + 400,
          },
        ],
        protocolGroupIndex: 1,
        session: secondSession,
        trial: secondTrial,
      });
    }
  }
  const ambiguousBase = 200000 + 99 * 1000;
  traceEvents.push(
    ...presentedReporterEvents({
      endpoint: ambiguousBase + 20,
      surfaceId: 7001,
      displayId: 8001,
      localId: "open-ambiguous-first",
    }),
    ...presentedReporterEvents({
      endpoint: ambiguousBase + 21,
      surfaceId: 7001,
      displayId: 8001,
      localId: "open-ambiguous-second",
    }),
  );
  measurementSegments.push({
    trace: "synthetic.trace.json",
    action: "open",
    startUs: ambiguousBase,
    endUs: ambiguousBase + 500,
    rendererPid: 101,
    layerTreeHostId: 7,
    frameSource: 9,
    activeWindows: [
      {
        id: "open-ambiguous-active",
        startUs: ambiguousBase + 1,
        endUs: ambiguousBase + 400,
      },
    ],
    protocolGroupIndex: 1,
    session: 3,
    trial: 20,
  });
  for (let trial = 21; trial <= 40; trial += 1) {
    trials.push({
      session: 3,
      trial,
      status: "missing",
      reason: "NOT_CAPTURED",
    });
  }
  for (let trial = 21; trial <= 40; trial += 1) {
    secondGroupTrials.push({
      session: 3,
      trial,
      status: "missing",
      reason: "NOT_CAPTURED",
    });
  }
  traceEvents.push(
    ...JSON.parse(readFileSync(fixturePath, "utf8")).traceEvents,
  );
  traceEvents.push(
    {
      name: "EventTiming",
      cat: "devtools.timeline",
      ph: "b",
      ts: 5,
      pid: 101,
      tid: 1,
      args: { secret: privateMarker },
    },
    {
      name: "EventTiming",
      cat: "devtools.timeline",
      ph: "e",
      ts: 5,
      pid: 101,
      tid: 1,
      args: { secret: privateMarker },
    },
  );
  const input = makeFixture(t, {
    traceText: JSON.stringify({ traceEvents }),
  });
  input.manifest.measurementSegments = measurementSegments;
  input.manifest.protocolGroups = ["fit-all", "open"].map((action, index) => ({
    deviceKey: "mac",
    browserKey: "brave",
    workload: index === 0 ? "100-interactive" : "10000-chronological",
    action,
    plannedTrials: 120,
    sessions: [
      { session: 1, plannedTrials: 40 },
      { session: 2, plannedTrials: 40 },
      { session: 3, plannedTrials: 40 },
    ],
    trials: index === 0 ? trials : secondGroupTrials,
  }));
  writeFileSync(input.manifestPath, JSON.stringify(input.manifest), {
    flag: "w",
  });

  const result = runCli([input.manifestPath]);

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  const group = report.protocolGroups[0];
  const secondGroup = report.protocolGroups[1];
  assert.equal(group.deviceKey, "mac");
  assert.equal(group.browserKey, "brave");
  assert.equal(group.trialCounts.planned, 120);
  assert.equal(group.trialCounts.qualifiedFrameTrials, 100);
  assert.equal(group.trialCounts.missing, 20);
  assert.equal(group.frameIntervals.sampleCount, 100);
  assert.equal(group.frameIntervals.p50, 50);
  assert.equal(group.frameIntervals.p95, 95);
  assert.equal(group.frameIntervals.status, "observed-only");
  assert.deepEqual(group.frameIntervals.minimums, {
    intervals: 100,
    qualifiedTrials: 100,
  });
  assert.equal(group.sessions[0].frameIntervalSampleCount, 40);
  assert.equal(group.sessions[2].frameIntervalSampleCount, 20);
  assert.equal(group.nextPaint.status, "unavailable");
  assert.deepEqual(group.nextPaint.reasonCodes, ["NEXT_PAINT_METHOD_UNPROVEN"]);
  assert.equal(report.traces[0].inputToPresentedFrameSamples.length, 1);
  assert.equal(secondGroup.action, "open");
  assert.equal(secondGroup.trialCounts.qualifiedFrameTrials, 99);
  assert.equal(secondGroup.trialCounts.missing, 20);
  assert.equal(secondGroup.trialCounts.invalid, 1);
  assert.equal(secondGroup.trialCounts.planned, 120);
  assert.equal(
    secondGroup.trialCounts.qualifiedFrameTrials +
      secondGroup.trialCounts.missing +
      secondGroup.trialCounts.censored +
      secondGroup.trialCounts.invalid,
    120,
  );
  assert.equal("unqualifiedLinkedTrials" in secondGroup.trialCounts, false);
  assert.equal(secondGroup.trialReasonCounts.AMBIGUOUS_CORRELATION, 1);
  assert.equal(secondGroup.trialReasonCounts.NOT_CAPTURED, 20);
  assert.equal(secondGroup.frameIntervals.sampleCount, 100);
  assert.equal(secondGroup.frameIntervals.p50, null);
  assert.equal(secondGroup.frameIntervals.p95, null);
  assert.equal(secondGroup.frameIntervals.status, "unavailable");
  assert.ok(
    secondGroup.frameIntervals.reasonCodes.includes(
      "INSUFFICIENT_VALID_SAMPLES",
    ),
  );
  assert.equal(report.traces[0].eventTimingInventory.legacyBeginCount, 1);
  assert.equal(report.traces[0].eventTimingInventory.legacyEndCount, 1);
  assert.equal(
    report.traces[0].eventTimingInventory.latencyCategoryEventCount,
    0,
  );
  assert.equal(
    report.traces[0].eventTimingInventory.eventProcessingEventCount,
    0,
  );
  assert.equal(
    report.traces[0].eventTimingInventory.status,
    "fallback-unknown",
  );
  assert.deepEqual(report.traces[0].eventTimingInventory.reasonCodes, [
    "LEGACY_EVENT_TIMING_FALLBACK_UNKNOWN",
  ]);
  assert.equal(result.stdout.includes(privateMarker), false);
});

test("maps every unqualified linked trial into balanced fixed status and reason counts", (t) => {
  const scenarios = [
    {
      name: "reported data loss",
      traceEvents: [],
      dataLossOccurred: true,
      expectedStatus: "invalid",
      expectedStatusCount: 1,
      expectedReason: "TRACE_DATA_LOSS",
    },
    {
      name: "unknown data loss state",
      traceEvents: [],
      dataLossOccurred: undefined,
      expectedStatus: "invalid",
      expectedStatusCount: 1,
      expectedReason: "TRACE_DATA_LOSS",
    },
    {
      name: "no matched reporter",
      traceEvents: [],
      dataLossOccurred: false,
      expectedStatus: "missing",
      expectedStatusCount: 120,
      expectedReason: "UNSUPPORTED_INPUT",
    },
    {
      name: "malformed frame identity",
      traceEvents: presentedReporterEvents({
        endpoint: 20,
        surfaceId: 1.5,
        displayId: 11,
        localId: "malformed-frame",
      }),
      dataLossOccurred: false,
      expectedStatus: "invalid",
      expectedStatusCount: 1,
      expectedReason: "MALFORMED_TRACE",
    },
    {
      name: "ambiguous frame identity",
      traceEvents: [
        ...presentedReporterEvents({
          endpoint: 20,
          surfaceId: 1,
          displayId: 11,
          localId: "ambiguous-first",
        }),
        ...presentedReporterEvents({
          endpoint: 21,
          surfaceId: 1,
          displayId: 11,
          localId: "ambiguous-second",
        }),
      ],
      dataLossOccurred: false,
      expectedStatus: "invalid",
      expectedStatusCount: 1,
      expectedReason: "AMBIGUOUS_CORRELATION",
    },
  ];

  for (const scenario of scenarios) {
    const input = makeFixture(t, {
      traceText: JSON.stringify({ traceEvents: scenario.traceEvents }),
    });
    if (scenario.dataLossOccurred === undefined) {
      delete input.manifest.traces[0].dataLossOccurred;
    } else {
      input.manifest.traces[0].dataLossOccurred = scenario.dataLossOccurred;
    }
    input.manifest.protocolGroups = [
      {
        deviceKey: "mac",
        browserKey: "brave",
        workload: "100-interactive",
        action: "fit-all",
        plannedTrials: 120,
        sessions: [
          { session: 1, plannedTrials: 40 },
          { session: 2, plannedTrials: 40 },
          { session: 3, plannedTrials: 40 },
        ],
        trials: [],
      },
    ];
    input.manifest.measurementSegments = [
      {
        trace: "synthetic.trace.json",
        action: "fit-all",
        startUs: 0,
        endUs: 50,
        rendererPid: 101,
        layerTreeHostId: 7,
        frameSource: 9,
        activeWindows: [{ id: "linked-window", startUs: 0, endUs: 50 }],
        protocolGroupIndex: 0,
        session: 1,
        trial: 1,
      },
    ];
    writeFileSync(input.manifestPath, JSON.stringify(input.manifest), {
      flag: "w",
    });

    const result = runCli([input.manifestPath]);
    assert.equal(result.status, 0, `${scenario.name}: ${result.stderr}`);
    const group = JSON.parse(result.stdout).protocolGroups[0];
    assert.equal(
      group.trialCounts[scenario.expectedStatus],
      scenario.expectedStatusCount,
      scenario.name,
    );
    assert.equal(
      group.trialCounts.missing +
        group.trialCounts.censored +
        group.trialCounts.invalid +
        group.trialCounts.qualifiedFrameTrials,
      120,
      scenario.name,
    );
    assert.equal(
      "unqualifiedLinkedTrials" in group.trialCounts,
      false,
      scenario.name,
    );
    assert.equal(
      group.trialReasonCounts[scenario.expectedReason],
      1,
      scenario.name,
    );
    assert.equal(group.trialReasonCounts.NOT_CAPTURED, 119, scenario.name);
    assert.equal(
      Object.values(group.trialReasonCounts).reduce(
        (total, count) => total + count,
        0,
      ),
      120,
      scenario.name,
    );
    for (const session of group.sessions) {
      assert.equal(
        session.trialCounts.qualifiedFrameTrials +
          session.trialCounts.missing +
          session.trialCounts.censored +
          session.trialCounts.invalid,
        40,
        `${scenario.name}, session ${session.session}`,
      );
      assert.equal(
        Object.values(session.trialReasonCounts).reduce(
          (total, count) => total + count,
          0,
        ),
        40,
        `${scenario.name}, session ${session.session} reasons`,
      );
    }
  }
});

test("rejects unsafe segment action labels without leaking them into the report", (t) => {
  const actionLabels = [
    "https://private.example/secret",
    "pan\nTRACE_PRIVATE_CONTROL",
    "TRACE_PRIVATE_CAPTION",
  ];
  const traceText = JSON.stringify({
    traceEvents: [
      ...presentedReporterEvents({
        endpoint: 20,
        surfaceId: 101,
        displayId: 201,
        localId: "0x1",
      }),
      ...presentedReporterEvents({
        endpoint: 30,
        surfaceId: 102,
        displayId: 202,
        localId: "0x2",
      }),
    ],
  });
  const input = makeFixture(t, { traceText });
  input.manifest.measurementSegments = actionLabels.map((action) => ({
    trace: "synthetic.trace.json",
    action,
    startUs: 0,
    endUs: 40,
    rendererPid: 101,
    layerTreeHostId: 7,
    frameSource: 9,
    activeWindows: [{ id: "action-window", startUs: 0, endUs: 40 }],
  }));
  writeFileSync(input.manifestPath, JSON.stringify(input.manifest), {
    flag: "w",
  });

  const result = runCli([input.manifestPath]);

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  const traceReport = report.traces[0];
  assert.deepEqual(traceReport.frameIntervals.samples, []);
  assert.ok(
    traceReport.frameIntervals.reasonCodes.includes(
      "INVALID_MEASUREMENT_SEGMENT",
    ),
  );
  assert.ok(
    traceReport.diagnostics.some(
      ({ code }) => code === "INVALID_MEASUREMENT_SEGMENT",
    ),
  );
  for (const action of actionLabels) {
    assert.equal(result.stdout.includes(action), false);
  }
});

test("rejects extra protocol fields and duplicate trial references without echoing values", (t) => {
  const input = makeFixture(t);
  const group = {
    deviceKey: "mac",
    browserKey: "brave",
    workload: "100-interactive",
    action: "pan",
    plannedTrials: 120,
    sessions: [
      { session: 1, plannedTrials: 40 },
      { session: 2, plannedTrials: 40 },
      { session: 3, plannedTrials: 40 },
    ],
    trials: [],
  };

  input.manifest.protocolGroups = [{ ...group, untrustedLabel: privateMarker }];
  writeFileSync(input.manifestPath, JSON.stringify(input.manifest), {
    flag: "w",
  });
  const extraField = runCli([input.manifestPath]);
  assert.notEqual(extraField.status, 0);
  assert.match(
    extraField.stderr,
    /Invalid protocol group or linked measurement segment/,
  );
  assert.equal(extraField.stderr.includes(privateMarker), false);

  input.manifest.protocolGroups = [
    {
      ...group,
      trials: [
        { session: 1, trial: 1, status: "missing", reason: "NOT_CAPTURED" },
        { session: 1, trial: 1, status: "invalid", reason: "MALFORMED_TRACE" },
      ],
    },
  ];
  writeFileSync(input.manifestPath, JSON.stringify(input.manifest), {
    flag: "w",
  });
  const duplicateTrial = runCli([input.manifestPath]);
  assert.notEqual(duplicateTrial.status, 0);
  assert.match(
    duplicateTrial.stderr,
    /Invalid protocol group or linked measurement segment/,
  );
  assert.equal(duplicateTrial.stderr.includes(privateMarker), false);

  input.manifest.protocolGroups = [
    {
      ...group,
      trials: [
        { session: 1, trial: 1, status: "missing", reason: "NOT_CAPTURED" },
        { session: 2, trial: 1, status: "censored", reason: "TRACE_TRUNCATED" },
        { session: 3, trial: 1, status: "invalid", reason: "TRACE_DATA_LOSS" },
      ],
    },
  ];
  input.manifest.measurementSegments = [];
  writeFileSync(input.manifestPath, JSON.stringify(input.manifest), {
    flag: "w",
  });
  const countedStatuses = runCli([input.manifestPath]);
  assert.equal(countedStatuses.status, 0, countedStatuses.stderr);
  const trialCounts = JSON.parse(countedStatuses.stdout).protocolGroups[0]
    .trialCounts;
  assert.equal(trialCounts.planned, 120);
  assert.equal(trialCounts.missing, 118);
  assert.equal(trialCounts.censored, 1);
  assert.equal(trialCounts.invalid, 1);
  const reasonCounts = JSON.parse(countedStatuses.stdout).protocolGroups[0]
    .trialReasonCounts;
  assert.equal(reasonCounts.NOT_CAPTURED, 118);
  assert.equal(reasonCounts.TRACE_TRUNCATED, 1);
  assert.equal(reasonCounts.TRACE_DATA_LOSS, 1);
});

test("counts a captured frame trial with no adjacent frame without inventing an interval", (t) => {
  const input = makeFixture(t, {
    traceText: JSON.stringify({
      traceEvents: presentedReporterEvents({
        endpoint: 20,
        surfaceId: 1,
        displayId: 11,
        localId: "single-frame",
      }),
    }),
  });
  input.manifest.protocolGroups = [
    {
      deviceKey: "s25-ultra",
      browserKey: "chrome",
      workload: "100-interactive",
      action: "fit-all",
      plannedTrials: 120,
      sessions: [
        { session: 1, plannedTrials: 40 },
        { session: 2, plannedTrials: 40 },
        { session: 3, plannedTrials: 40 },
      ],
      trials: [],
    },
  ];
  input.manifest.measurementSegments = [
    {
      trace: "synthetic.trace.json",
      action: "fit-all",
      startUs: 0,
      endUs: 40,
      rendererPid: 101,
      layerTreeHostId: 7,
      frameSource: 9,
      activeWindows: [{ id: "single-window", startUs: 0, endUs: 40 }],
      protocolGroupIndex: 0,
      session: 1,
      trial: 1,
    },
  ];
  writeFileSync(input.manifestPath, JSON.stringify(input.manifest), {
    flag: "w",
  });

  const result = runCli([input.manifestPath]);

  assert.equal(result.status, 0, result.stderr);
  const group = JSON.parse(result.stdout).protocolGroups[0];
  assert.equal(group.trialCounts.qualifiedFrameTrials, 1);
  assert.equal(group.trialCounts.noAdjacentPresentedFrameTrials, 1);
  assert.equal(group.frameIntervals.sampleCount, 0);
  assert.equal(group.frameIntervals.p50, null);
  assert.equal(group.frameIntervals.p95, null);
  assert.ok(
    group.frameIntervals.reasonCodes.includes("NO_ADJACENT_PRESENTED_FRAME"),
  );
  assert.ok(
    group.frameIntervals.reasonCodes.includes("INSUFFICIENT_VALID_SAMPLES"),
  );
});

test("rejects repeated group-session-trial links before analysis", (t) => {
  const input = makeFixture(t);
  input.manifest.protocolGroups = [
    {
      deviceKey: "mac",
      browserKey: "brave",
      workload: "100-interactive",
      action: "pan",
      plannedTrials: 120,
      sessions: [
        { session: 1, plannedTrials: 40 },
        { session: 2, plannedTrials: 40 },
        { session: 3, plannedTrials: 40 },
      ],
      trials: [],
    },
  ];
  const segment = {
    trace: "synthetic.trace.json",
    action: "pan",
    startUs: 0,
    endUs: 10,
    rendererPid: 101,
    layerTreeHostId: 7,
    frameSource: 9,
    activeWindows: [{ id: "first-window", startUs: 0, endUs: 10 }],
    protocolGroupIndex: 0,
    session: 1,
    trial: 1,
  };
  input.manifest.measurementSegments = [
    segment,
    {
      ...segment,
      startUs: 20,
      endUs: 30,
      activeWindows: [{ id: "second-window", startUs: 20, endUs: 30 }],
    },
  ];
  writeFileSync(input.manifestPath, JSON.stringify(input.manifest), {
    flag: "w",
  });

  const result = runCli([input.manifestPath]);

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /Invalid protocol group or linked measurement segment/,
  );

  input.manifest.protocolGroups.push({
    ...input.manifest.protocolGroups[0],
    action: "scroll",
  });
  input.manifest.measurementSegments = [
    segment,
    {
      ...segment,
      action: "scroll",
      startUs: 5,
      endUs: 15,
      activeWindows: [{ id: "overlap-window", startUs: 5, endUs: 15 }],
      protocolGroupIndex: 1,
      trial: 2,
    },
  ];
  writeFileSync(input.manifestPath, JSON.stringify(input.manifest), {
    flag: "w",
  });
  const overlappingFrames = runCli([input.manifestPath]);
  assert.notEqual(overlappingFrames.status, 0);
  assert.match(
    overlappingFrames.stderr,
    /Invalid protocol group or linked measurement segment/,
  );
});

test("writes reports exclusively and preserves existing files and symlink targets", (t) => {
  const input = makeFixture(t);
  const outputPath = join(input.directory, "report.json");
  const first = runCli([input.manifestPath, "--out", outputPath]);

  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(readFileSync(outputPath, "utf8")).schemaVersion, 1);

  const existingContents = "keep existing output";
  writeFileSync(outputPath, existingContents, { flag: "w" });
  const second = runCli([input.manifestPath, "--out", outputPath]);
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /output.*(exist|exclusive)/i);
  assert.equal(readFileSync(outputPath, "utf8"), existingContents);

  const symlinkTarget = join(input.directory, "symlink-target.json");
  const symlinkOutput = join(input.directory, "symlink-report.json");
  writeFileSync(symlinkTarget, "keep symlink target", { flag: "wx" });
  symlinkSync(symlinkTarget, symlinkOutput);
  const third = runCli([input.manifestPath, "--out", symlinkOutput]);
  assert.notEqual(third.status, 0);
  assert.match(third.stderr, /output.*(exist|exclusive)/i);
  assert.equal(lstatSync(symlinkOutput).isSymbolicLink(), true);
  assert.equal(readFileSync(symlinkTarget, "utf8"), "keep symlink target");
});

test("rejects trace path traversal before reading a neighboring file", (t) => {
  const input = makeFixture(t);
  const outsideTrace = join(dirname(input.directory), "outside.trace.json");
  writeFileSync(outsideTrace, "{}", { flag: "wx" });
  t.after(() => rmSync(outsideTrace, { force: true }));
  input.manifest.traces[0].trace = `../${basename(outsideTrace)}`;
  writeFileSync(input.manifestPath, JSON.stringify(input.manifest), {
    flag: "w",
  });

  const result = runCli([input.manifestPath]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /trace path.*basename/i);
  assert.equal(result.stdout, "");
  assert.equal(readFileSync(outsideTrace, "utf8"), "{}");
});

test("invalid trace data produces no stdout or partial output file", (t) => {
  const input = makeFixture(t, { traceText: "{ not valid JSON" });
  const outputPath = join(input.directory, "partial-report.json");

  const result = runCli([input.manifestPath, "--out", outputPath]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /invalid trace JSON/i);
  assert.equal(result.stdout, "");
  assert.equal(existsSync(outputPath), false);
});

test("invalid manifests produce no partial report", (t) => {
  const input = makeFixture(t);
  input.manifest.traces = "not-an-array";
  writeFileSync(input.manifestPath, JSON.stringify(input.manifest), {
    flag: "w",
  });
  const outputPath = join(input.directory, "invalid-manifest-report.json");

  const result = runCli([input.manifestPath, "--out", outputPath]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /invalid manifest/i);
  assert.equal(result.stdout, "");
  assert.equal(existsSync(outputPath), false);
});

test("refuses an output path that names an existing raw input", (t) => {
  const input = makeFixture(t);
  const traceBefore = readFileSync(input.tracePath);

  const result = runCli([input.manifestPath, "--out", input.tracePath]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /output.*(exist|exclusive)/i);
  assert.equal(readFileSync(input.tracePath).equals(traceBefore), true);
});
