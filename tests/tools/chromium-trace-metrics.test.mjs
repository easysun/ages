import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  RETAINED_NODE_EVIDENCE_POLICY,
  RETAINED_NODE_RECORD_BYTE_LIMIT,
} from "../../scripts/browser-stimulus-observer.mjs";
import {
  analyzeTrace,
  nearestRank,
  parseTrace,
} from "../../scripts/chromium-trace-metrics.mjs";

const fixtures = new URL("../fixtures/chromium-traces/", import.meta.url);
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

function readFixture(name) {
  return readFileSync(new URL(name, fixtures), "utf8");
}

function analyzeFixture(name, traceRecord = {}) {
  const trace = parseTrace(readFixture(name));
  return analyzeKnownChromiumTrace(trace, {
    trace: name,
    dataLossOccurred: false,
    ...traceRecord,
  });
}

function diagnosticCodes(analysis) {
  return new Set(analysis.diagnostics.map(({ code }) => code));
}

const knownChromiumObservations = {
  browser: { product: "Playwright Chromium", version: "153.0.8010.12" },
  status: "synthetic-method-pilot",
};

function analyzeKnownChromiumTrace(trace, traceRecord, segments = []) {
  return analyzeTrace(trace, traceRecord, segments, knownChromiumObservations);
}

test("requires asserted Playwright Chromium observations before running the EventTiming crosswalk", () => {
  const trace = parseTrace(readFixture("event-timing-fallback.trace.json"));
  const record = {
    trace: "event-timing-fallback.trace.json",
    dataLossOccurred: false,
  };
  const accepted = analyzeTrace(
    trace,
    record,
    [],
    knownChromiumObservations,
  ).discreteEventTimingCrosswalk;
  assert.equal(accepted.status, "diagnostic-only");
  assert.equal(accepted.candidates.length, 1);
  assert.equal(accepted.methodScope.observedBrowserVersion, "153.0.8010.12");

  const braveIdentity = {
    bundle: {
      identifier: "com.brave.Browser",
      shortVersion: "155.1.97.56",
      bundleVersion: "155.1.97.56",
      scmRevision: "971a7443b0c9b0a9b2860529b33331b76077ec62",
    },
    executableSha256: "a".repeat(64),
    runtime: {
      version: "153.0.8010.12",
      product: "Chrome/153.0.8010.12",
      revision: "@971a7443b0c9b0a9b2860529b33331b76077ec62",
      userAgent:
        "Mozilla/5.0 AppleWebKit/537.36 Chrome/153.0.8010.12 Safari/537.36",
    },
    chromiumSourceIdentity: "unverified",
  };
  const unsupportedObservations = [
    undefined,
    null,
    {},
    { browser: { product: "Playwright Chromium" } },
    { browser: { product: "Synthetic Chromium", version: "153.0.8010.12" } },
    { browser: { product: "Playwright Chromium", version: "155.0.8059.40" } },
    {
      ...knownChromiumObservations,
      browserIdentity: { runtime: { version: "155.0.8059.40" } },
    },
    { ...knownChromiumObservations, browserIdentity: braveIdentity },
    {
      ...knownChromiumObservations,
      qualification: "installed-brave-schema-probe",
    },
    { ...knownChromiumObservations, status: "installed-brave-schema-probe" },
    {
      ...knownChromiumObservations,
      browserIdentity: { runtime: { revision: {} } },
    },
    {
      ...knownChromiumObservations,
      sourceRevision: "TRACE_PRIVATE_AGES_REVISION",
    },
    { ...knownChromiumObservations, profileName: "caller-selected-profile" },
  ];

  for (const observations of unsupportedObservations) {
    const crosswalk = analyzeTrace(
      trace,
      record,
      [],
      observations,
    ).discreteEventTimingCrosswalk;
    assert.equal(crosswalk.status, "unavailable");
    assert.deepEqual(crosswalk.candidates, []);
    assert.equal(crosswalk.methodScope, null);
    assert.equal(crosswalk.formalActionStatus, "unavailable");
    assert.deepEqual(crosswalk.formalActionSamples, []);
    assert.deepEqual(crosswalk.gateReasonCodes, [
      "BROWSER_SOURCE_PROFILE_UNSUPPORTED",
    ]);
  }
});

const knownBrave155Observations = {
  browser: {
    product: "Runtime browser observation",
    version: "155.0.8059.40",
  },
  browserIdentity: {
    bundle: {
      identifier: "com.brave.Browser",
      shortVersion: "155.1.97.56",
      bundleVersion: "197.56",
      scmRevision: "b01cdf43be4b4d5559bf7e58229e666e24454f50",
    },
    executableSha256:
      "6099adb0e47d7c12922bb2dca02e2a044b71ae2895c0bbab1717f8660ffb99a7",
    runtime: {
      version: "155.0.8059.40",
      product: "Chrome/155.0.8059.40",
      revision: "@b01cdf43be4b4d5559bf7e58229e666e24454f5",
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36",
    },
    chromiumSourceIdentity: "unverified",
  },
  qualification: "installed-brave-schema-probe",
  status: "installed-brave-schema-probe",
};

const knownBrave15580Observations = {
  browser: {
    product: "Runtime browser observation",
    version: "155.0.8059.80",
  },
  browserIdentity: {
    bundle: {
      identifier: "com.brave.Browser",
      shortVersion: "155.1.97.57",
      bundleVersion: "197.57",
      scmRevision: "7bfa200812971b7811541ae6e5b72620abebe3a7",
    },
    executableSha256:
      "a17d7d68343726bb2a601ef237b90198bf1bb0133952dc3935435c8fed70d6f5",
    runtime: {
      version: "155.0.8059.80",
      product: "Chrome/155.0.8059.80",
      revision: "@7bfa200812971b7811541ae6e5b72620abebe3a",
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36",
    },
    chromiumSourceIdentity: "unverified",
  },
  qualification: "installed-brave-schema-probe",
  status: "installed-brave-schema-probe",
};

const knownBrave15585Observations = {
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
  qualification: "installed-brave-schema-probe",
  status: "installed-brave-schema-probe",
};
const knownBrave15585VersionThreeObservations = {
  browser: structuredClone(knownBrave15585Observations.browser),
  browserIdentity: structuredClone(knownBrave15585Observations.browserIdentity),
  status: "diagnostic-only",
};

function withBrave155InteractionValues(trace) {
  const legacy = trace.traceEvents[0].args.data;
  const modern = trace.traceEvents[1].args.event_timing;
  legacy.interactionId = 17n;
  legacy.interactionOffset = 18n;
  modern.interaction_id = 17n;
  modern.interaction_offset = 18n;
  return trace;
}

function makeBrave155Trace() {
  return withBrave155InteractionValues(
    parseTrace(readFixture("event-timing-fallback.trace.json")),
  );
}

function makeBrave155TraceFromRaw(mutator) {
  const raw = JSON.parse(readFixture("event-timing-fallback.trace.json"));
  mutator(raw.traceEvents);
  return withBrave155InteractionValues(parseTrace(JSON.stringify(raw)));
}

function brave155Crosswalk(
  trace = makeBrave155Trace(),
  observations = knownBrave155Observations,
) {
  return analyzeTrace(
    trace,
    { trace: "brave155-synthetic.trace.json", dataLossOccurred: false },
    [],
    observations,
  ).discreteEventTimingCrosswalk;
}

function brave15580Crosswalk(
  trace = makeBrave155Trace(),
  observations = knownBrave15580Observations,
) {
  return analyzeTrace(
    trace,
    { trace: "brave15580-synthetic.trace.json", dataLossOccurred: false },
    [],
    observations,
  ).discreteEventTimingCrosswalk;
}

function brave15585Crosswalk(
  trace = makeBrave155Trace(),
  observations = knownBrave15585Observations,
) {
  return analyzeTrace(
    trace,
    { trace: "brave15585-synthetic.trace.json", dataLossOccurred: false },
    [],
    observations,
  ).discreteEventTimingCrosswalk;
}

function assertUnsupportedBrave155(crosswalk) {
  assert.equal(crosswalk.status, "unavailable");
  assert.deepEqual(crosswalk.candidates, []);
  assert.equal(crosswalk.methodScope, null);
  assert.equal(crosswalk.formalActionStatus, "unavailable");
  assert.deepEqual(crosswalk.formalActionSamples, []);
  assert.deepEqual(crosswalk.gateReasonCodes, [
    "BROWSER_SOURCE_PROFILE_UNSUPPORTED",
  ]);
  assert.doesNotMatch(JSON.stringify(crosswalk), /TRACE_PRIVATE_/);
}

function assertUnsupportedBrave15580(crosswalk) {
  assert.equal(crosswalk.status, "unavailable");
  assert.deepEqual(crosswalk.candidates, []);
  assert.equal(crosswalk.methodScope, null);
  assert.equal(crosswalk.formalActionStatus, "unavailable");
  assert.deepEqual(crosswalk.formalActionSamples, []);
  assert.deepEqual(crosswalk.gateReasonCodes, [
    "BROWSER_SOURCE_PROFILE_UNSUPPORTED",
  ]);
  assert.doesNotMatch(JSON.stringify(crosswalk), /TRACE_PRIVATE_/);
}

function assertUnsupportedBrave15585(crosswalk) {
  assert.equal(crosswalk.status, "unavailable");
  assert.deepEqual(crosswalk.candidates, []);
  assert.equal(crosswalk.methodScope, null);
  assert.equal(crosswalk.formalActionStatus, "unavailable");
  assert.deepEqual(crosswalk.formalActionSamples, []);
  assert.deepEqual(crosswalk.gateReasonCodes, [
    "BROWSER_SOURCE_PROFILE_UNSUPPORTED",
  ]);
  assert.doesNotMatch(JSON.stringify(crosswalk), /TRACE_PRIVATE_/);
}

const observedSourceHash =
  "96a969d576f7610b66217294480c444a36205cec69dba66e8dee0b9a820ce8ae";
const currentRetainedCollectorSourceHash =
  "beb2868156bff1fa73389a6c83023aa878397cff9ac9e4df16599982051928a0";
const cleanupVerifiedCollectorSourceHash =
  "12c0ecc50a541835456367e4c57f8285feb119ad959aad8d0e222b75c06c33ab";
const postReviewFrozenProducerSourceHash =
  "1800489f4942aefe4ab642da9350af4177c39c06c44eb29b7ec2ee84a398996a";

function currentCollectorSourceHash() {
  const collectorSource = readFileSync(
    resolve(repoRoot, "scripts/capture-chromium-method-pilot.mjs"),
    "utf8",
  );
  const extrasDeclaration = collectorSource.match(
    /const extras = \[([\s\S]*?)\];/,
  );
  assert.ok(extrasDeclaration, "collector must declare explicit hash inputs");
  const extras = Array.from(
    extrasDeclaration[1].matchAll(/"([^"]+)"/g),
    ([, path]) => path,
  );
  const tracked = execFileSync("git", ["ls-files", "-z", "src", "migrations"], {
    cwd: repoRoot,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
  const sourceHash = createHash("sha256");
  for (const path of [...new Set([...tracked, ...extras])].sort()) {
    sourceHash.update(path);
    sourceHash.update("\0");
    sourceHash.update(readFileSync(resolve(repoRoot, path)));
  }
  return sourceHash.digest("hex");
}

test("pins current collector lifecycle hashes to explicit producer inputs", () => {
  const collectorSource = readFileSync(
    resolve(repoRoot, "scripts/capture-chromium-method-pilot.mjs"),
    "utf8",
  );
  const extrasDeclaration = collectorSource.match(
    /const extras = \[([\s\S]*?)\];/,
  );
  assert.ok(extrasDeclaration, "collector must declare explicit hash inputs");
  const extras = Array.from(
    extrasDeclaration[1].matchAll(/"([^"]+)"/g),
    ([, path]) => path,
  );
  assert.ok(extras.includes("scripts/retained-input-node-evidence.mjs"));
  assert.ok(extras.includes("scripts/lib/owned-cleanup-receipt.mjs"));
  assert.ok(!extras.includes("scripts/chromium-trace-metrics.mjs"));
  assert.ok(!extras.includes("scripts/analyze-chromium-traces.mjs"));

  const tracked = execFileSync("git", ["ls-files", "-z", "src", "migrations"], {
    cwd: repoRoot,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
  const producerInputs = [...new Set([...tracked, ...extras])].sort();
  assert.ok(
    producerInputs.includes("scripts/retained-input-node-evidence.mjs"),
  );
  assert.ok(!producerInputs.includes("scripts/chromium-trace-metrics.mjs"));
  assert.ok(!producerInputs.includes("scripts/analyze-chromium-traces.mjs"));

  const actualHash = currentCollectorSourceHash();
  assert.equal(actualHash, postReviewFrozenProducerSourceHash);
  assert.notEqual(actualHash, cleanupVerifiedCollectorSourceHash);
  const metricsSource = readFileSync(
    resolve(repoRoot, "scripts/chromium-trace-metrics.mjs"),
    "utf8",
  );
  const lifecycleHash = (entryName) => {
    const entry = metricsSource.match(
      new RegExp(`${entryName}: Object\\.freeze\\(\\{([\\s\\S]*?)\\n  \\}\\)`),
    );
    assert.ok(entry, `missing ${entryName} lifecycle entry`);
    const hash = entry[1].match(/sha256: "([a-f0-9]{64})"/);
    assert.ok(hash, `missing SHA-256 in ${entryName}`);
    return hash[1];
  };

  assert.equal(lifecycleHash("originalVersionOne"), observedSourceHash);
  assert.equal(
    lifecycleHash("currentVersionOneRetentionDisabled"),
    currentRetainedCollectorSourceHash,
  );
  assert.equal(
    lifecycleHash("currentVersionTwoRetentionEnabled"),
    currentRetainedCollectorSourceHash,
  );
  assert.equal(
    lifecycleHash("cleanupVerifiedVersionOneRetentionDisabled"),
    cleanupVerifiedCollectorSourceHash,
  );
  assert.equal(
    lifecycleHash("cleanupVerifiedVersionTwoRetentionEnabled"),
    cleanupVerifiedCollectorSourceHash,
  );
  assert.equal(
    lifecycleHash("runLevelCleanupReceiptVersionOne"),
    "8ab4d0f155af00e6b16784873c3bc867b5423696e4d31572a2a3d3ba5af28f28",
  );
  assert.equal(
    lifecycleHash("runLevelCleanupReceiptVersionTwo"),
    "8ab4d0f155af00e6b16784873c3bc867b5423696e4d31572a2a3d3ba5af28f28",
  );
  assert.equal(
    lifecycleHash("postReviewVersionOneRetentionDisabled"),
    actualHash,
  );
  assert.equal(
    lifecycleHash("postReviewVersionTwoRetentionEnabled"),
    actualHash,
  );
  assert.equal(
    lifecycleHash("finalReviewedVersionThreeRetentionEnabled"),
    actualHash,
  );
  assert.match(
    metricsSource.match(
      /finalReviewedVersionThreeRetentionEnabled: Object\.freeze\(\{([\s\S]*?)\n {2}\}\)/,
    )?.[1] ?? "",
    /browserProfile: "brave15585"/,
  );
  assert.notEqual(
    lifecycleHash("runLevelCleanupReceiptVersionOne"),
    lifecycleHash("originalVersionOne"),
  );
});

const observedDocumentId = "d-aaaaaaaaaaaaaaaaaaaaaaaa";
const observedTargetToken = "t-bbbbbbbbbbbbbbbbbbbbbbbb";
const observedFrameId = "frame-A";
const observedManifestEvidence = {
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
};

function observedApiEntry(overrides = {}) {
  return {
    kind: "event-timing",
    documentId: observedDocumentId,
    type: "click",
    startTime: 10,
    processingStart: 11,
    processingEnd: 15,
    duration: 20,
    interactionId: 17,
    targetToken: observedTargetToken,
    targetLabel: "open-primary",
    targetResolution: "registered-target",
    deliveryPhase: "immediate",
    ...overrides,
  };
}

function observedDomEntry(overrides = {}) {
  return {
    kind: "dom",
    documentId: observedDocumentId,
    type: "click",
    timeStamp: 10,
    isTrusted: true,
    targetToken: observedTargetToken,
    targetLabel: "open-primary",
    targetResolution: "registered-target",
    phase: "primary",
    ...overrides,
  };
}

function makeObserverEvidence({
  records = [observedApiEntry(), observedDomEntry()],
  observationOverrides = {},
  frameProvenanceOverrides = {},
  sidecarOverrides = {},
  declarationOverrides = {},
  caseObservationOverrides = {},
  caseRecordOverrides = {},
  traceRecordOverrides = {},
  sourceHashSha256 = observedSourceHash,
  traceDataLossOccurred = false,
} = {}) {
  const frameSnapshot = { frameId: observedFrameId, loaderId: "loader-A" };
  const observation = {
    schemaVersion: 1,
    status: "diagnostic",
    reasonCode: null,
    documentId: observedDocumentId,
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
    recordBytes: Buffer.byteLength(JSON.stringify(records), "utf8"),
    frameProvenance: {
      schemaVersion: 1,
      status: "stable",
      reasonCode: null,
      documentId: observedDocumentId,
      beforeArm: frameSnapshot,
      afterArm: frameSnapshot,
      afterDrain: frameSnapshot,
      ...frameProvenanceOverrides,
    },
    ...observationOverrides,
  };
  const sidecar = {
    schemaVersion: 1,
    evidenceClass: "synthetic-Playwright-stimulus-discovery",
    instrumented: true,
    qualification: "diagnostic-only",
    fixture: "synthetic-open",
    inputMethod:
      "Synthetic Playwright stimulus; DOM isTrusted means browser-dispatched only and does not establish human input or physical equivalence.",
    interpretation: {
      eventTiming:
        "PerformanceEventTiming is thresholded at 16 ms and browser-quantized; continuous input is excluded.",
      targets:
        "Target IDs are opaque per-document tokens; unknown, null, and removed targets remain uncertain.",
    },
    observation,
    ...sidecarOverrides,
  };
  const sidecarBytes = Buffer.from(`${JSON.stringify(sidecar, null, 2)}\n`);
  const caseObservationDeclaration = {
    fileName: "synthetic-open.stimulus.json",
    byteCount: sidecarBytes.byteLength,
    sha256: createHash("sha256").update(sidecarBytes).digest("hex"),
    evidenceClass: "synthetic-Playwright-stimulus-discovery",
    status: observation.status,
    reasonCode: observation.reasonCode,
    recordCount: observation.recordCount,
    apiStatus: observation.apiStatus,
    ...caseObservationOverrides,
  };
  const declaration = {
    ...structuredClone(observedManifestEvidence),
    ...declarationOverrides,
  };
  const caseRecord = {
    fixture: "synthetic-open",
    trace: "synthetic-open.trace.json",
    action: "open",
    actionStatus: "completed",
    dataLossOccurred: false,
    measurementStatus: "resolved",
    trustedStimulusObservation: caseObservationDeclaration,
    ...caseRecordOverrides,
  };
  return {
    declaration,
    sidecar,
    capture: { sourceHashSha256, caseRecord },
    traceRecord: {
      fixture: "synthetic-open",
      trace: "synthetic-open.trace.json",
      dataLossOccurred: traceDataLossOccurred,
      ...traceRecordOverrides,
    },
  };
}

function analyzeObservedTrace({
  trace = makeBrave155Trace(),
  evidence,
  traceRecord,
} = {}) {
  const observerEvidence = evidence ?? makeObserverEvidence();
  return analyzeTrace(
    trace,
    traceRecord ?? observerEvidence.traceRecord,
    [],
    knownBrave15580Observations,
    {
      declaration: observerEvidence.declaration,
      sidecar: observerEvidence.sidecar,
      capture: observerEvidence.capture,
    },
  ).observedDiscreteInputs;
}

function validRetainedNodeEvidence(overrides = {}) {
  const snapshot = {
    documentId: observedDocumentId,
    frameId: observedFrameId,
    loaderId: "loader-A",
  };
  return {
    status: "complete",
    reasonCode: null,
    mappings: [{ targetToken: observedTargetToken, backendNodeId: 311 }],
    executionContext: {
      uniqueId: "context-A",
      frameId: observedFrameId,
      isDefault: true,
    },
    documentId: observedDocumentId,
    snapshots: {
      beforeArm: { ...snapshot },
      afterArm: { ...snapshot },
      afterDrain: { ...snapshot },
      afterMapping: { ...snapshot },
      afterCleanup: { ...snapshot },
    },
    protocolCatalogId: RETAINED_NODE_EVIDENCE_POLICY.protocolCatalogId,
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

function makeVersionTwoObserverEvidence({
  records = [observedApiEntry(), observedDomEntry()],
  retainedOverrides = {},
  observationOverrides = {},
  sidecarOverrides = {},
  declarationOverrides = {},
  traceRecordOverrides = {},
  sourceHashSha256 = currentRetainedCollectorSourceHash,
  traceDataLossOccurred = false,
} = {}) {
  const base = makeObserverEvidence({
    records,
    observationOverrides,
    traceRecordOverrides,
    sourceHashSha256,
    traceDataLossOccurred,
  });
  const observation = {
    ...base.sidecar.observation,
    schemaVersion: 2,
    retainedNodeEvidence: validRetainedNodeEvidence(retainedOverrides),
  };
  const sidecar = {
    ...base.sidecar,
    schemaVersion: 2,
    observation,
    ...sidecarOverrides,
  };
  const declaration = {
    ...base.declaration,
    schemaVersion: 2,
    recordByteLimit: RETAINED_NODE_RECORD_BYTE_LIMIT,
    retainedNodeEvidence: {
      enabled: true,
      maxNodes: RETAINED_NODE_EVIDENCE_POLICY.maxNodes,
      mappingByteLimit: RETAINED_NODE_EVIDENCE_POLICY.mappingByteLimit,
      protocolCatalogId: RETAINED_NODE_EVIDENCE_POLICY.protocolCatalogId,
    },
    ...declarationOverrides,
  };
  const sidecarBytes = Buffer.from(`${JSON.stringify(sidecar)}\n`);
  const caseRecord = {
    ...base.capture.caseRecord,
    trustedStimulusObservation: {
      ...base.capture.caseRecord.trustedStimulusObservation,
      byteCount: sidecarBytes.byteLength,
      sha256: createHash("sha256").update(sidecarBytes).digest("hex"),
    },
  };
  return {
    declaration,
    sidecar,
    capture: { sourceHashSha256, caseRecord },
    traceRecord: base.traceRecord,
  };
}

function validSameDocumentLoadingWitness(overrides = {}) {
  const scope = {
    frameId: observedFrameId,
    loaderId: "loader-A",
    contextUniqueId: "context-A",
    targetId: "target-A",
    sessionId: "session-A",
  };
  return {
    status: "complete",
    reasonCode: null,
    protocolCatalogId: RETAINED_NODE_EVIDENCE_POLICY.protocolCatalogId,
    events: [
      {
        sequence: 0,
        phase: "primary-action",
        source: "page",
        method: "Page.frameStartedLoading",
        frameId: observedFrameId,
      },
      {
        sequence: 1,
        phase: "primary-action",
        source: "page",
        method: "Page.navigatedWithinDocument",
        frameId: observedFrameId,
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
      sourceRecordIndex: 1,
      documentId: observedDocumentId,
      targetToken: observedTargetToken,
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
        mappedBackendNodeId: 311,
        finalBackendNodeId: 311,
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

function makeVersionThreeObserverEvidence({
  records = [
    observedApiEntry({
      targetToken: null,
      targetLabel: null,
      targetResolution: "unknown",
    }),
    observedDomEntry(),
  ],
  retainedOverrides = {},
  witnessOverrides = {},
  observationOverrides = {},
  sidecarOverrides = {},
  declarationOverrides = {},
  traceRecordOverrides = {},
  sourceHashSha256 = postReviewFrozenProducerSourceHash,
  traceDataLossOccurred = false,
} = {}) {
  const base = makeObserverEvidence({
    records,
    observationOverrides,
    traceRecordOverrides,
    sourceHashSha256,
    traceDataLossOccurred,
  });
  const fixture = "100-interactive-open";
  const traceName = `${fixture}.trace.json`;
  const observation = {
    ...base.sidecar.observation,
    schemaVersion: 3,
    retainedNodeEvidence: validRetainedNodeEvidence(retainedOverrides),
    sameDocumentLoadingWitness:
      validSameDocumentLoadingWitness(witnessOverrides),
  };
  const sidecar = {
    ...base.sidecar,
    schemaVersion: 3,
    fixture,
    observation,
    ...sidecarOverrides,
  };
  const declaration = {
    ...base.declaration,
    schemaVersion: 3,
    recordByteLimit: 256 * 1024 - 36 * 1024 - 80 * 1024,
    retainedNodeEvidence: {
      enabled: true,
      maxNodes: RETAINED_NODE_EVIDENCE_POLICY.maxNodes,
      mappingByteLimit: RETAINED_NODE_EVIDENCE_POLICY.mappingByteLimit,
      protocolCatalogId: RETAINED_NODE_EVIDENCE_POLICY.protocolCatalogId,
    },
    ...declarationOverrides,
  };
  const sidecarBytes = Buffer.from(`${JSON.stringify(sidecar)}\n`);
  const caseRecord = {
    ...base.capture.caseRecord,
    fixture,
    trace: traceName,
    workload: "100-interactive",
    rowCount: 100,
    action: "open",
    measurementStatus: "unavailable",
    measurementReasonCode: "V3_DIAGNOSTIC_ONLY",
    trustedStimulusObservation: {
      ...base.capture.caseRecord.trustedStimulusObservation,
      fileName: `${fixture}.stimulus.json`,
      byteCount: sidecarBytes.byteLength,
      sha256: createHash("sha256").update(sidecarBytes).digest("hex"),
    },
  };
  return {
    declaration,
    sidecar,
    capture: { sourceHashSha256, caseRecord },
    traceRecord: { ...base.traceRecord, fixture, trace: traceName },
  };
}

function refreshVersionThreeEvidenceBytes(evidence) {
  evidence.sidecar.observation.recordBytes = Buffer.byteLength(
    JSON.stringify(evidence.sidecar.observation.records),
    "utf8",
  );
  const bytes = Buffer.from(`${JSON.stringify(evidence.sidecar)}\n`);
  Object.assign(evidence.capture.caseRecord.trustedStimulusObservation, {
    byteCount: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}

function makeVersionTwoTrace({
  trace = makeBrave155Trace(),
  frame = observedFrameId,
  processId = 101,
  metadataEvents = [],
  initialFrames,
} = {}) {
  const frames = initialFrames ?? [{ frame, processId }];
  trace.traceEvents.unshift({
    name: "TracingStartedInBrowser",
    cat: "disabled-by-default-devtools.timeline",
    ph: "I",
    pid: 1,
    tid: 1,
    ts: 0n,
    args: { data: { persistentIds: true, frames } },
  });
  trace.traceEvents.push(...metadataEvents);
  return trace;
}

function makeVersionThreeTrace({
  trace = makeBrave155Trace(),
  frame = observedFrameId,
  processId = 101,
  markerPid = processId,
  metadataEvents = [],
} = {}) {
  const versionTwoTrace = makeVersionTwoTrace({
    trace,
    frame,
    processId,
    metadataEvents,
  });
  versionTwoTrace.traceEvents.splice(1, 0, {
    name: "TimeStamp",
    cat: "blink.user_timing",
    ph: "I",
    pid: markerPid,
    tid: 1,
    ts: 1n,
    args: {
      data: { message: "pilot-100-interactive-open:segment-start" },
    },
  });
  return versionTwoTrace;
}

function analyzeVersionTwoTrace({
  evidence = makeVersionTwoObserverEvidence(),
  trace = makeVersionTwoTrace(),
  sourceObservations = knownBrave15580Observations,
} = {}) {
  return analyzeTrace(trace, evidence.traceRecord, [], sourceObservations, {
    declaration: evidence.declaration,
    sidecar: evidence.sidecar,
    capture: evidence.capture,
  }).observedDiscreteInputs;
}

function analyzeVersionThreeTrace({
  evidence = makeVersionThreeObserverEvidence(),
  trace = makeVersionThreeTrace(),
  segments = [],
  sourceObservations = knownBrave15585VersionThreeObservations,
} = {}) {
  return analyzeTrace(
    trace,
    evidence.traceRecord,
    segments,
    sourceObservations,
    {
      declaration: evidence.declaration,
      sidecar: evidence.sidecar,
      capture: evidence.capture,
    },
  ).observedDiscreteInputs;
}

function assertVersionTwoUnavailable(result) {
  assert.equal(result.status, "unavailable");
  assert.equal(result.counts.accepted, 0);
  assert.equal(result.counts.rejected, result.counts.apiEntries);
  assert.equal(result.formalActionStatus, "unavailable");
  assert.deepEqual(result.formalActionSamples, []);
}

function assertVersionThreeUnavailable(result, message) {
  assert.equal(result.status, "unavailable", message);
  assert.equal(result.counts.accepted, 0, message);
  assert.equal(result.counts.rejected, result.counts.apiEntries, message);
  assert.equal(result.formalActionStatus, "unavailable", message);
  assert.deepEqual(result.formalActionSamples, [], message);
}

test("v3 association requires singleton raw positive backend node equality and preserves API null", () => {
  const evidence = makeVersionThreeObserverEvidence();
  const result = analyzeVersionThreeTrace({ evidence });

  assert.deepEqual(result, {
    status: "diagnostic-only",
    counts: { apiEntries: 1, accepted: 1, rejected: 0 },
    entries: [
      {
        dispatchPhase: "primary",
        actionLabel: "open-primary",
        eventType: "click",
        durationUs: 8,
        processingEndToPresentationUs: 3,
        status: "diagnostic-only",
      },
    ],
    rejectionCounts: [],
    formalActionStatus: "unavailable",
    formalActionSamples: [],
  });
  assert.equal(
    evidence.sidecar.observation.records[0].targetToken,
    null,
    "the API's null target remains null while independent proof binds the DOM target",
  );

  for (const field of ["connected", "rootContainsTarget"]) {
    const detached = makeVersionThreeObserverEvidence();
    detached.sidecar.observation.sameDocumentLoadingWitness.retainedTargetProof.finalProof[
      field
    ] = false;
    assert.equal(
      analyzeVersionThreeTrace({ evidence: detached }).counts.accepted,
      1,
    );
  }

  const mismatchedMapping = makeVersionThreeObserverEvidence({
    retainedOverrides: {
      mappings: [{ targetToken: observedTargetToken, backendNodeId: 312 }],
    },
  });
  assertVersionThreeUnavailable(
    analyzeVersionThreeTrace({ evidence: mismatchedMapping }),
  );

  const rawNodeMismatch = makeVersionThreeObserverEvidence({
    retainedOverrides: {
      mappings: [{ targetToken: observedTargetToken, backendNodeId: 312 }],
    },
  });
  const rawNodeProof =
    rawNodeMismatch.sidecar.observation.sameDocumentLoadingWitness
      .retainedTargetProof.finalProof;
  rawNodeProof.mappedBackendNodeId = 312;
  rawNodeProof.finalBackendNodeId = 312;
  const rawNodeMismatchResult = analyzeVersionThreeTrace({
    evidence: rawNodeMismatch,
  });
  assertVersionThreeUnavailable(rawNodeMismatchResult);
  assert.deepEqual(rawNodeMismatchResult.rejectionCounts, [
    { code: "RETAINED_NODE_MAPPING_MISMATCH", count: 1 },
  ]);

  const nonNullApiTargetMismatch = makeVersionThreeObserverEvidence();
  nonNullApiTargetMismatch.sidecar.observation.records[0].targetToken =
    "t-cccccccccccccccccccccccc";
  refreshVersionThreeEvidenceBytes(nonNullApiTargetMismatch);
  const nonNullTargetResult = analyzeVersionThreeTrace({
    evidence: nonNullApiTargetMismatch,
  });
  assertVersionThreeUnavailable(nonNullTargetResult);
  assert.deepEqual(nonNullTargetResult.rejectionCounts, [
    { code: "TARGET_IDENTITY_MISMATCH", count: 1 },
  ]);

  const duplicateRawContender = makeVersionThreeTrace();
  duplicateRawContender.traceEvents.push({
    ...structuredClone(duplicateRawContender.traceEvents[2]),
    id: "0xduplicate",
  });
  const ambiguous = analyzeVersionThreeTrace({
    trace: duplicateRawContender,
  });
  assertVersionThreeUnavailable(ambiguous);
  assert.deepEqual(ambiguous.rejectionCounts, [
    { code: "TRACE_IDENTITY_AMBIGUOUS", count: 1 },
  ]);

  const crossFramePeer = makeVersionThreeTrace();
  const otherFrameCandidate = structuredClone(crossFramePeer.traceEvents[2]);
  otherFrameCandidate.id = "0xcrossframe";
  otherFrameCandidate.args.data.frame = "other-frame";
  crossFramePeer.traceEvents.push(otherFrameCandidate);
  const crossFrameAmbiguous = analyzeVersionThreeTrace({
    trace: crossFramePeer,
  });
  assertVersionThreeUnavailable(crossFrameAmbiguous);
  assert.deepEqual(crossFrameAmbiguous.rejectionCounts, [
    { code: "TRACE_IDENTITY_AMBIGUOUS", count: 1 },
  ]);

  const nonpositiveRawNode = makeVersionThreeTrace();
  nonpositiveRawNode.traceEvents[2].args.data.nodeId = 0;
  assertVersionThreeUnavailable(
    analyzeVersionThreeTrace({ trace: nonpositiveRawNode }),
  );

  const rawFrameMismatch = makeVersionThreeTrace();
  rawFrameMismatch.traceEvents[2].args.data.frame = "other-frame";
  assertVersionThreeUnavailable(
    analyzeVersionThreeTrace({ trace: rawFrameMismatch }),
  );

  const actionMismatch = makeVersionThreeObserverEvidence();
  actionMismatch.sidecar.observation.records[1].targetLabel = "fit-all";
  refreshVersionThreeEvidenceBytes(actionMismatch);
  const actionMismatchResult = analyzeVersionThreeTrace({
    evidence: actionMismatch,
  });
  assertVersionThreeUnavailable(actionMismatchResult);
  assert.deepEqual(actionMismatchResult.rejectionCounts, [
    { code: "UNSELECTED_ACTION_DISPATCH", count: 1 },
  ]);
});

test("v3 rejects each missing, false, or inconsistent retained-target proof field", () => {
  assert.equal(analyzeVersionThreeTrace().counts.accepted, 1);
  const scenarios = [
    ["source record index missing", (proof) => delete proof.sourceRecordIndex],
    ["source record index mismatch", (proof) => (proof.sourceRecordIndex = 0)],
    ["document binding missing", (proof) => delete proof.documentId],
    [
      "document binding mismatch",
      (proof) => (proof.documentId = "d-cccccccccccccccccccccccc"),
    ],
    ["target token missing", (proof) => delete proof.targetToken],
    [
      "target token binding mismatch",
      (proof) => (proof.targetToken = "t-cccccccccccccccccccccccc"),
    ],
    ["mapping index missing", (proof) => delete proof.mappingIndex],
    ["mapping index mismatch", (proof) => (proof.mappingIndex = 1)],
    ["source capture missing", (proof) => delete proof.sourceCapture],
    ["baseline scope missing", (proof) => delete proof.baselineScope],
    ...[
      ["frameId", "other-frame"],
      ["loaderId", "other-loader"],
      ["contextUniqueId", "other-context"],
      ["targetId", "other-target"],
      ["sessionId", "other-session"],
    ].flatMap(([field, value]) => [
      [
        `baseline ${field} missing`,
        (proof) => delete proof.baselineScope[field],
      ],
      [
        `baseline ${field} mismatch`,
        (proof) => (proof.baselineScope[field] = value),
      ],
    ]),
    ["final proof missing", (proof) => delete proof.finalProof],
    [
      "final proof stage mismatch",
      (proof) => (proof.finalProof.stage = "after-release"),
    ],
    [
      "mapped backend node missing",
      (proof) => delete proof.finalProof.mappedBackendNodeId,
    ],
    [
      "mapped backend node mismatch",
      (proof) => (proof.finalProof.mappedBackendNodeId = 312),
    ],
    [
      "final backend node missing",
      (proof) => delete proof.finalProof.finalBackendNodeId,
    ],
    [
      "final backend node mismatch",
      (proof) => (proof.finalProof.finalBackendNodeId = 312),
    ],
    ["final CDP scope missing", (proof) => delete proof.finalProof.cdpScope],
    ...[
      ["frameId", "other-frame"],
      ["loaderId", "other-loader"],
      ["contextUniqueId", "other-context"],
      ["targetId", "other-target"],
      ["sessionId", "other-session"],
    ].flatMap(([field, value]) => [
      [
        `final CDP ${field} missing`,
        (proof) => delete proof.finalProof.cdpScope[field],
      ],
      [
        `final CDP ${field} mismatch`,
        (proof) => (proof.finalProof.cdpScope[field] = value),
      ],
    ]),
    ["extra proof field", (proof) => (proof.unreviewed = true)],
    ...[
      "targetIsNode",
      "ownerDocumentMatches",
      "rootContainsTarget",
      "connected",
      "composedPathStartsAtTarget",
    ].flatMap((field) => [
      [`${field} missing`, (proof) => delete proof.sourceCapture[field]],
      [`${field} false`, (proof) => (proof.sourceCapture[field] = false)],
    ]),
    ...[
      "savedDocumentSame",
      "savedRootSame",
      "savedTargetSame",
      "targetOwnerDocumentMatches",
    ].flatMap((field) => [
      [`${field} missing`, (proof) => delete proof.finalProof[field]],
      [`${field} false`, (proof) => (proof.finalProof[field] = false)],
    ]),
    ...["rootContainsTarget", "connected"].map((field) => [
      `${field} missing in final proof`,
      (proof) => delete proof.finalProof[field],
    ]),
  ];

  for (const [name, mutateProof] of scenarios) {
    const evidence = makeVersionThreeObserverEvidence();
    mutateProof(
      evidence.sidecar.observation.sameDocumentLoadingWitness
        .retainedTargetProof,
    );
    assertVersionThreeUnavailable(analyzeVersionThreeTrace({ evidence }), name);
  }
});

test("v3 rejects identity and trace-order mismatches", () => {
  assert.equal(analyzeVersionThreeTrace().counts.accepted, 1);
  assert.throws(
    () => analyzeVersionThreeTrace({ segments: [{}] }),
    /version-three analysis cannot include action measurement segments/i,
  );

  const unknownHash = makeVersionThreeObserverEvidence({
    sourceHashSha256: "0".repeat(64),
  });
  const unknownHashResult = analyzeVersionThreeTrace({ evidence: unknownHash });
  assertVersionThreeUnavailable(unknownHashResult);
  assert.deepEqual(unknownHashResult.rejectionCounts, [
    { code: "COLLECTOR_SOURCE_HASH_MISMATCH", count: 1 },
  ]);

  const eightyProfile = analyzeTrace(
    makeVersionThreeTrace(),
    makeVersionThreeObserverEvidence().traceRecord,
    [],
    knownBrave15580Observations,
    {
      declaration: makeVersionThreeObserverEvidence().declaration,
      sidecar: makeVersionThreeObserverEvidence().sidecar,
      capture: makeVersionThreeObserverEvidence().capture,
    },
  ).observedDiscreteInputs;
  assertVersionThreeUnavailable(eightyProfile);

  const qualifiedProfile = analyzeVersionThreeTrace({
    sourceObservations: knownBrave15585Observations,
  });
  assertVersionThreeUnavailable(qualifiedProfile);
  assert.deepEqual(qualifiedProfile.rejectionCounts, [
    { code: "BROWSER_SOURCE_PROFILE_UNSUPPORTED", count: 1 },
  ]);

  const markerPidMismatch = analyzeVersionThreeTrace({
    trace: makeVersionThreeTrace({ markerPid: 202 }),
  });
  assertVersionThreeUnavailable(markerPidMismatch);

  const rendererPidMismatchTrace = makeVersionThreeTrace({
    processId: 202,
    markerPid: 202,
  });
  const rendererPidMismatch = analyzeVersionThreeTrace({
    trace: rendererPidMismatchTrace,
  });
  assertVersionThreeUnavailable(rendererPidMismatch);

  const candidateBeforeMarker = makeVersionThreeTrace();
  const marker = candidateBeforeMarker.traceEvents.splice(1, 1)[0];
  candidateBeforeMarker.traceEvents.push(marker);
  assertVersionThreeUnavailable(
    analyzeVersionThreeTrace({ trace: candidateBeforeMarker }),
  );

  const missingMarker = makeVersionThreeTrace();
  missingMarker.traceEvents.splice(1, 1);
  assertVersionThreeUnavailable(
    analyzeVersionThreeTrace({ trace: missingMarker }),
  );

  const duplicateMarker = makeVersionThreeTrace();
  duplicateMarker.traceEvents.splice(
    2,
    0,
    structuredClone(duplicateMarker.traceEvents[1]),
  );
  assertVersionThreeUnavailable(
    analyzeVersionThreeTrace({ trace: duplicateMarker }),
  );

  const malformedMarker = makeVersionThreeTrace();
  malformedMarker.traceEvents[1].cat = "devtools.timeline";
  assertVersionThreeUnavailable(
    analyzeVersionThreeTrace({ trace: malformedMarker }),
  );

  const malformedMarkerPhase = makeVersionThreeTrace();
  malformedMarkerPhase.traceEvents[1].ph = "X";
  assertVersionThreeUnavailable(
    analyzeVersionThreeTrace({ trace: malformedMarkerPhase }),
  );

  const epochChangesAfterMarker = makeVersionThreeTrace();
  epochChangesAfterMarker.traceEvents.push({
    name: "FrameCommittedInBrowser",
    ph: "I",
    args: { data: { frame: observedFrameId } },
  });
  const epochInvalidated = analyzeVersionThreeTrace({
    trace: epochChangesAfterMarker,
  });
  assertVersionThreeUnavailable(epochInvalidated);
  assert.deepEqual(epochInvalidated.rejectionCounts, [
    { code: "TRACE_FRAME_EPOCH_INVALIDATED", count: 1 },
  ]);
});

test("v1 and v2 historical and current fingerprints stay profile-bound", () => {
  const v1Hashes = [
    observedSourceHash,
    currentRetainedCollectorSourceHash,
    cleanupVerifiedCollectorSourceHash,
    "8ab4d0f155af00e6b16784873c3bc867b5423696e4d31572a2a3d3ba5af28f28",
    postReviewFrozenProducerSourceHash,
  ];
  for (const sourceHashSha256 of v1Hashes) {
    const evidence = makeObserverEvidence({ sourceHashSha256 });
    const supported = analyzeObservedTrace({ evidence });
    assert.equal(supported.counts.accepted, 1, sourceHashSha256);
    const unsupported = analyzeTrace(
      makeBrave155Trace(),
      evidence.traceRecord,
      [],
      knownBrave15585Observations,
      {
        declaration: evidence.declaration,
        sidecar: evidence.sidecar,
        capture: evidence.capture,
      },
    ).observedDiscreteInputs;
    assertVersionTwoUnavailable(unsupported);
    assert.deepEqual(unsupported.rejectionCounts, [
      { code: "BROWSER_SOURCE_PROFILE_UNSUPPORTED", count: 1 },
    ]);
  }

  const v2Hashes = [
    currentRetainedCollectorSourceHash,
    cleanupVerifiedCollectorSourceHash,
    "8ab4d0f155af00e6b16784873c3bc867b5423696e4d31572a2a3d3ba5af28f28",
    postReviewFrozenProducerSourceHash,
  ];
  for (const sourceHashSha256 of v2Hashes) {
    const evidence = makeVersionTwoObserverEvidence({ sourceHashSha256 });
    assert.equal(analyzeVersionTwoTrace({ evidence }).counts.accepted, 1);
    assert.equal(
      analyzeVersionTwoTrace({
        evidence,
        sourceObservations: knownBrave15585Observations,
      }).counts.accepted,
      1,
    );
  }

  const v3UnknownHash = makeVersionThreeObserverEvidence({
    sourceHashSha256:
      "8ab4d0f155af00e6b16784873c3bc867b5423696e4d31572a2a3d3ba5af28f28",
  });
  assertVersionThreeUnavailable(
    analyzeVersionThreeTrace({ evidence: v3UnknownHash }),
  );
});

test("accepts the complete installed Brave 155 tuple as a separate diagnostic profile", () => {
  const crosswalk = brave155Crosswalk();
  assert.equal(crosswalk.status, "diagnostic-only");
  assert.deepEqual(crosswalk.candidates, [
    {
      eventType: "click",
      durationUs: 8,
      processingEndToPresentationUs: 3,
      status: "diagnostic-only",
    },
  ]);
  assert.deepEqual(crosswalk.methodScope, {
    observedBrowserVersion: "155.0.8059.40",
    pinnedSourceRevision: "cfaadc5a132d78e1828635aa8405a499f3e14864",
    publishedBraveCoreRevision: "b01cdf43be4b4d5559bf7e58229e666e24454f50",
    evidenceClass: "installed-brave-schema-probe",
    vendorPatchIdentity: "unverified",
    navigationDocumentIdentity: "not-inferred",
    originScope: "capture-case + renderer PID + frame",
  });
  assert.ok(
    crosswalk.gateReasonCodes.includes("INSTALLED_BRAVE_SCHEMA_PROBE_ONLY"),
  );
  assert.ok(!crosswalk.gateReasonCodes.includes("SYNTHETIC_METHOD_PILOT_ONLY"));
  for (const reason of [
    "ACTION_ATTRIBUTION_UNPROVEN",
    "INTERACTION_AGGREGATION_UNPROVEN",
    "BROWSER_SOURCE_COMPLETENESS_UNPROVEN",
    "MODALITY_EQUIVALENCE_UNPROVEN",
    "VENDOR_PATCH_IDENTITY_UNVERIFIED",
    "NAVIGATION_DOCUMENT_IDENTITY_NOT_INFERRED",
  ]) {
    assert.ok(crosswalk.gateReasonCodes.includes(reason), reason);
  }
  assert.equal(crosswalk.formalActionStatus, "unavailable");
  assert.deepEqual(crosswalk.formalActionSamples, []);
});

test("accepts only the exact Brave 155.0.8059.80 published-source projection", () => {
  const crosswalk = brave15580Crosswalk();
  assert.equal(crosswalk.status, "diagnostic-only");
  assert.deepEqual(crosswalk.candidates, [
    {
      eventType: "click",
      durationUs: 8,
      processingEndToPresentationUs: 3,
      status: "diagnostic-only",
    },
  ]);
  assert.equal("publishedBraveCoreRevision" in crosswalk.methodScope, false);
  assert.deepEqual(crosswalk.methodScope, {
    observedBrowserVersion: "155.0.8059.80",
    pinnedSourceRevision: "43a195105613ac83c21d3f14de279f4a045c7da0",
    observedBundleRevision: "7bfa200812971b7811541ae6e5b72620abebe3a7",
    evidenceClass: "installed-brave-schema-probe",
    vendorPatchIdentity: "unverified",
    navigationDocumentIdentity: "not-inferred",
    originScope: "capture-case + renderer PID + frame",
  });
  assert.ok(
    crosswalk.gateReasonCodes.includes("INSTALLED_BRAVE_SCHEMA_PROBE_ONLY"),
  );
  assert.ok(
    crosswalk.gateReasonCodes.includes("VENDOR_PATCH_IDENTITY_UNVERIFIED"),
  );
  assert.equal(crosswalk.formalActionStatus, "unavailable");
  assert.deepEqual(crosswalk.formalActionSamples, []);

  const changedIdentityPaths = [
    ["browser", "product"],
    ["browser", "version"],
    ["browserIdentity", "bundle", "identifier"],
    ["browserIdentity", "bundle", "shortVersion"],
    ["browserIdentity", "bundle", "bundleVersion"],
    ["browserIdentity", "bundle", "scmRevision"],
    ["browserIdentity", "executableSha256"],
    ["browserIdentity", "runtime", "version"],
    ["browserIdentity", "runtime", "product"],
    ["browserIdentity", "runtime", "revision"],
    ["browserIdentity", "runtime", "userAgent"],
    ["browserIdentity", "chromiumSourceIdentity"],
    ["qualification"],
    ["status"],
  ];

  for (const path of changedIdentityPaths) {
    const observations = structuredClone(knownBrave15580Observations);
    let parent = observations;
    for (const key of path.slice(0, -1)) parent = parent[key];
    parent[path.at(-1)] = `TRACE_PRIVATE_${path.join("_")}`;
    assertUnsupportedBrave15580(brave15580Crosswalk(undefined, observations));
  }

  const extraFieldMutations = [
    (observations) => {
      observations.extra = "TRACE_PRIVATE_ROOT";
    },
    (observations) => {
      observations.browser.extra = "TRACE_PRIVATE_BROWSER";
    },
    (observations) => {
      observations.browserIdentity.extra = "TRACE_PRIVATE_IDENTITY";
    },
    (observations) => {
      observations.browserIdentity.bundle.extra = "TRACE_PRIVATE_BUNDLE";
    },
    (observations) => {
      observations.browserIdentity.runtime.extra = "TRACE_PRIVATE_RUNTIME";
    },
  ];
  for (const mutate of extraFieldMutations) {
    const observations = structuredClone(knownBrave15580Observations);
    mutate(observations);
    assertUnsupportedBrave15580(brave15580Crosswalk(undefined, observations));
  }
});

test("accepts only the exact Brave 155.0.8059.85 tuple with diagnostic source compatibility provenance", () => {
  const crosswalk = brave15585Crosswalk();
  assert.equal(crosswalk.status, "diagnostic-only");
  assert.deepEqual(crosswalk.candidates, [
    {
      eventType: "click",
      durationUs: 8,
      processingEndToPresentationUs: 3,
      status: "diagnostic-only",
    },
  ]);
  assert.deepEqual(crosswalk.methodScope, {
    observedBrowserVersion: "155.0.8059.85",
    pinnedSourceRevision: "0e66b94549a8bd85f03fbdf189b752d6e7b63c32",
    observedBundleRevision: "c7357bfd2a76c2467ba1ae62593a81ae92c05205",
    chromiumSourceIdentity: "unverified",
    protocolCatalogCompatibility: {
      protocolCatalogId: RETAINED_NODE_EVIDENCE_POLICY.protocolCatalogId,
      comparedChromiumSourceRevision:
        "43a195105613ac83c21d3f14de279f4a045c7da0",
      basis: "consumed-upstream-files-byte-identical-at-both-pins",
      scope: "diagnostic-only",
    },
    evidenceClass: "installed-brave-schema-probe",
    vendorPatchIdentity: "unverified",
    navigationDocumentIdentity: "not-inferred",
    originScope: "capture-case + renderer PID + frame",
  });
  assert.ok(
    crosswalk.gateReasonCodes.includes("INSTALLED_BRAVE_SCHEMA_PROBE_ONLY"),
  );
  for (const reason of [
    "ACTION_ATTRIBUTION_UNPROVEN",
    "INTERACTION_AGGREGATION_UNPROVEN",
    "BROWSER_SOURCE_COMPLETENESS_UNPROVEN",
    "MODALITY_EQUIVALENCE_UNPROVEN",
    "VENDOR_PATCH_IDENTITY_UNVERIFIED",
    "NAVIGATION_DOCUMENT_IDENTITY_NOT_INFERRED",
  ]) {
    assert.ok(crosswalk.gateReasonCodes.includes(reason), reason);
  }
  assert.equal(crosswalk.formalActionStatus, "unavailable");
  assert.deepEqual(crosswalk.formalActionSamples, []);

  const requiredPaths = [
    ["browser"],
    ["browser", "product"],
    ["browser", "version"],
    ["qualification"],
    ["status"],
    ["browserIdentity"],
    ["browserIdentity", "bundle"],
    ["browserIdentity", "bundle", "identifier"],
    ["browserIdentity", "bundle", "shortVersion"],
    ["browserIdentity", "bundle", "bundleVersion"],
    ["browserIdentity", "bundle", "scmRevision"],
    ["browserIdentity", "executableSha256"],
    ["browserIdentity", "runtime"],
    ["browserIdentity", "runtime", "version"],
    ["browserIdentity", "runtime", "product"],
    ["browserIdentity", "runtime", "revision"],
    ["browserIdentity", "runtime", "userAgent"],
    ["browserIdentity", "chromiumSourceIdentity"],
  ];
  for (const path of requiredPaths) {
    const missing = structuredClone(knownBrave15585Observations);
    let parent = missing;
    for (const key of path.slice(0, -1)) parent = parent[key];
    delete parent[path.at(-1)];
    assertUnsupportedBrave15585(brave15585Crosswalk(undefined, missing));

    const changed = structuredClone(knownBrave15585Observations);
    parent = changed;
    for (const key of path.slice(0, -1)) parent = parent[key];
    parent[path.at(-1)] = `TRACE_PRIVATE_${path.join("_")}`;
    assertUnsupportedBrave15585(brave15585Crosswalk(undefined, changed));
  }

  const extraFieldMutations = [
    (observations) => {
      observations.extra = "TRACE_PRIVATE_ROOT";
    },
    (observations) => {
      observations.browser.extra = "TRACE_PRIVATE_BROWSER";
    },
    (observations) => {
      observations.browserIdentity.extra = "TRACE_PRIVATE_IDENTITY";
    },
    (observations) => {
      observations.browserIdentity.bundle.extra = "TRACE_PRIVATE_BUNDLE";
    },
    (observations) => {
      observations.browserIdentity.runtime.extra = "TRACE_PRIVATE_RUNTIME";
    },
  ];
  for (const mutate of extraFieldMutations) {
    const observations = structuredClone(knownBrave15585Observations);
    mutate(observations);
    assertUnsupportedBrave15585(brave15585Crosswalk(undefined, observations));
  }
});

test("accepts the preserved .80 retained-node protocol catalog for exact Brave .85 as a diagnostic compatibility input", () => {
  const evidence = makeVersionTwoObserverEvidence();
  const analysis = analyzeTrace(
    makeVersionTwoTrace(),
    evidence.traceRecord,
    [],
    knownBrave15585Observations,
    {
      declaration: evidence.declaration,
      sidecar: evidence.sidecar,
      capture: evidence.capture,
    },
  );
  assert.equal(analysis.observedDiscreteInputs.status, "diagnostic-only");
  assert.equal(analysis.observedDiscreteInputs.counts.accepted, 1);
  assert.equal(
    analysis.observedDiscreteInputs.formalActionStatus,
    "unavailable",
  );
  assert.deepEqual(analysis.observedDiscreteInputs.formalActionSamples, []);
  assert.deepEqual(
    analysis.discreteEventTimingCrosswalk.methodScope
      .protocolCatalogCompatibility,
    {
      protocolCatalogId: RETAINED_NODE_EVIDENCE_POLICY.protocolCatalogId,
      comparedChromiumSourceRevision:
        "43a195105613ac83c21d3f14de279f4a045c7da0",
      basis: "consumed-upstream-files-byte-identical-at-both-pins",
      scope: "diagnostic-only",
    },
  );

  const mismatchedCatalog = makeVersionTwoObserverEvidence();
  const unsupported85Catalog =
    "chromium-0e66b94549a8bd85f03fbdf189b752d6e7b63c32+v8-712e1808de2d7416f1276d0deb1ee4ac978132b8";
  mismatchedCatalog.declaration.retainedNodeEvidence.protocolCatalogId =
    unsupported85Catalog;
  mismatchedCatalog.sidecar.observation.retainedNodeEvidence.protocolCatalogId =
    unsupported85Catalog;
  const rejected = analyzeVersionTwoTrace({
    evidence: mismatchedCatalog,
    sourceObservations: knownBrave15585Observations,
  });
  assertVersionTwoUnavailable(rejected);
  assert.deepEqual(rejected.rejectionCounts, [
    { code: "OBSERVER_EVIDENCE_INVALID", count: 1 },
  ]);
});

test("keeps version-one observed association limited to Brave 155.0.8059.80", () => {
  const versionOneEvidence = makeObserverEvidence();
  const versionOneObserver = {
    declaration: versionOneEvidence.declaration,
    sidecar: versionOneEvidence.sidecar,
    capture: versionOneEvidence.capture,
  };
  const versionOne80 = analyzeTrace(
    makeBrave155Trace(),
    versionOneEvidence.traceRecord,
    [],
    knownBrave15580Observations,
    versionOneObserver,
  ).observedDiscreteInputs;
  assert.equal(versionOne80.status, "diagnostic-only");
  assert.equal(versionOne80.counts.accepted, 1);
  assert.equal(versionOne80.formalActionStatus, "unavailable");
  assert.deepEqual(versionOne80.formalActionSamples, []);

  const versionOne85 = analyzeTrace(
    makeBrave155Trace(),
    versionOneEvidence.traceRecord,
    [],
    knownBrave15585Observations,
    versionOneObserver,
  ).observedDiscreteInputs;
  assert.equal(versionOne85.status, "unavailable");
  assert.deepEqual(versionOne85.counts, {
    apiEntries: 1,
    accepted: 0,
    rejected: 1,
  });
  assert.deepEqual(versionOne85.rejectionCounts, [
    { code: "BROWSER_SOURCE_PROFILE_UNSUPPORTED", count: 1 },
  ]);
  assert.equal(versionOne85.formalActionStatus, "unavailable");
  assert.deepEqual(versionOne85.formalActionSamples, []);

  const versionTwo85 = analyzeVersionTwoTrace({
    evidence: makeVersionTwoObserverEvidence(),
    sourceObservations: knownBrave15585Observations,
  });
  assert.equal(versionTwo85.status, "diagnostic-only");
  assert.equal(versionTwo85.counts.accepted, 1);
  assert.equal(versionTwo85.formalActionStatus, "unavailable");
  assert.deepEqual(versionTwo85.formalActionSamples, []);
});

test("requires every asserted Brave 155 observation and rejects independent tuple mutations", () => {
  const requiredPaths = [
    ["browser"],
    ["browser", "product"],
    ["browser", "version"],
    ["qualification"],
    ["status"],
    ["browserIdentity"],
    ["browserIdentity", "bundle"],
    ["browserIdentity", "bundle", "identifier"],
    ["browserIdentity", "bundle", "shortVersion"],
    ["browserIdentity", "bundle", "bundleVersion"],
    ["browserIdentity", "bundle", "scmRevision"],
    ["browserIdentity", "executableSha256"],
    ["browserIdentity", "runtime"],
    ["browserIdentity", "runtime", "version"],
    ["browserIdentity", "runtime", "product"],
    ["browserIdentity", "runtime", "revision"],
    ["browserIdentity", "runtime", "userAgent"],
    ["browserIdentity", "chromiumSourceIdentity"],
  ];

  for (const path of requiredPaths) {
    const missing = structuredClone(knownBrave155Observations);
    let parent = missing;
    for (const key of path.slice(0, -1)) parent = parent[key];
    delete parent[path.at(-1)];
    assertUnsupportedBrave155(brave155Crosswalk(undefined, missing));

    const changed = structuredClone(knownBrave155Observations);
    parent = changed;
    for (const key of path.slice(0, -1)) parent = parent[key];
    parent[path.at(-1)] = `TRACE_PRIVATE_${path.join("_")}`;
    assertUnsupportedBrave155(brave155Crosswalk(undefined, changed));
  }

  const invalidObservations = [
    (observations) => {
      observations.browser.version = "153.0.8010.12";
      observations.browserIdentity.runtime.version = "153.0.8010.12";
    },
    (observations) => {
      observations.browserIdentity.runtime.product = "Chrome/155.0.8059.41";
    },
    (observations) => {
      observations.browserIdentity.runtime.revision = {};
    },
    (observations) => {
      observations.browserIdentity.runtime.userAgent =
        "Mozilla/5.0 Chrome/155.0.8059.40 Safari/537.36";
    },
    (observations) => {
      observations.browserIdentity.runtime.userAgent =
        "Mozilla/5.0 Chrome/155.0.0.0 Safari/537.36 Chrome/155.0.0.1";
    },
    (observations) => {
      observations.browserIdentity.runtime.userAgent =
        "Mozilla/5.0 Chrome/155.0.0.0trailing Safari/537.36";
    },
    (observations) => {
      observations.browserIdentity.runtime.userAgent =
        "Mozilla/5.0 Safari/537.36";
    },
    (observations) => {
      observations.profileName = "TRACE_PRIVATE_PROFILE";
    },
    (observations) => {
      observations.browser.engine = "TRACE_PRIVATE_ENGINE";
    },
    (observations) => {
      observations.browserIdentity.profileName = "TRACE_PRIVATE_PROFILE";
    },
    (observations) => {
      observations.browserIdentity.bundle.extra = "TRACE_PRIVATE_BUNDLE";
    },
    (observations) => {
      observations.browserIdentity.runtime.extra = "TRACE_PRIVATE_RUNTIME";
    },
    (observations) => {
      observations.sourceRevision = "TRACE_PRIVATE_SOURCE_REVISION";
    },
  ];
  for (const mutate of invalidObservations) {
    const observations = structuredClone(knownBrave155Observations);
    mutate(observations);
    assertUnsupportedBrave155(brave155Crosswalk(undefined, observations));
  }
});

test("keeps non-Chrome user-agent text private while requiring every Chrome token to match Brave 155", () => {
  const observations = structuredClone(knownBrave155Observations);
  observations.browserIdentity.runtime.userAgent += " TRACE_PRIVATE_USER_AGENT";
  const crosswalk = brave155Crosswalk(undefined, observations);
  assert.equal(crosswalk.status, "diagnostic-only");
  assert.equal(crosswalk.candidates.length, 1);
  assert.doesNotMatch(JSON.stringify(crosswalk), /TRACE_PRIVATE_USER_AGENT/);
});

test("bounds each legacy and modern Brave 155 interaction identity to signed int32", () => {
  const fields = [
    {
      label: "legacy interactionId",
      owner: "legacy",
      key: "interactionId",
      peerOwner: "modern",
      peerKey: "interaction_id",
    },
    {
      label: "legacy interactionOffset",
      owner: "legacy",
      key: "interactionOffset",
      peerOwner: "modern",
      peerKey: "interaction_offset",
    },
    {
      label: "modern interaction_id",
      owner: "modern",
      key: "interaction_id",
      peerOwner: "legacy",
      peerKey: "interactionId",
    },
    {
      label: "modern interaction_offset",
      owner: "modern",
      key: "interaction_offset",
      peerOwner: "legacy",
      peerKey: "interactionOffset",
    },
  ];
  const boundaries = [
    ["zero", 0n, true],
    ["signed maximum", 2147483647n, true],
    ["negative one", -1n, false],
    ["signed maximum plus one", 2147483648n, false],
  ];

  for (const field of fields) {
    for (const [label, value, supported] of boundaries) {
      const trace = makeBrave155Trace();
      const legacy = trace.traceEvents[0].args.data;
      const modern = trace.traceEvents[1].args.event_timing;
      const target = field.owner === "legacy" ? legacy : modern;
      target[field.key] = value;
      if (supported) {
        const peer = field.peerOwner === "legacy" ? legacy : modern;
        peer[field.peerKey] = value;
      }

      const crosswalk = brave155Crosswalk(trace);
      if (supported) {
        assert.equal(
          crosswalk.status,
          "diagnostic-only",
          `${field.label}: ${label}`,
        );
        assert.equal(
          crosswalk.candidates.length,
          1,
          `${field.label}: ${label}`,
        );
      } else {
        assert.deepEqual(crosswalk.candidates, [], `${field.label}: ${label}`);
        assert.ok(
          crosswalk.rejectionCounts.some(
            ({ code, count }) =>
              code === "BRAVE_SIGNED_IDENTITY_OVERFLOW_UNVERIFIED" &&
              count === 1,
          ),
          `${field.label}: ${label}`,
        );
      }
    }
  }
});

test("preserves existing missing and malformed interaction reasons in the Brave 155 profile", () => {
  const fields = [
    [
      "legacy",
      "interactionId",
      "MISSING_LEGACY_EVENT_FIELD",
      "MALFORMED_LEGACY_INTERACTION",
    ],
    [
      "legacy",
      "interactionOffset",
      "MISSING_LEGACY_EVENT_FIELD",
      "MALFORMED_LEGACY_INTERACTION",
    ],
    [
      "modern",
      "interaction_id",
      "MISSING_MODERN_EVENT_TIMING_FIELD",
      "MALFORMED_MODERN_INTERACTION",
    ],
    [
      "modern",
      "interaction_offset",
      "MISSING_MODERN_EVENT_TIMING_FIELD",
      "MALFORMED_MODERN_INTERACTION",
    ],
  ];
  for (const [owner, key, missingReason, malformedReason] of fields) {
    const missingTrace = makeBrave155Trace();
    const missingRecord =
      owner === "legacy"
        ? missingTrace.traceEvents[0].args.data
        : missingTrace.traceEvents[1].args.event_timing;
    delete missingRecord[key];
    const missingCrosswalk = brave155Crosswalk(missingTrace);
    assert.ok(
      missingCrosswalk.rejectionCounts.some(
        ({ code }) => code === missingReason,
      ),
      `${owner}.${key}`,
    );
    assert.equal(
      missingCrosswalk.methodScope.evidenceClass,
      "installed-brave-schema-probe",
    );

    const malformedTrace = makeBrave155Trace();
    const malformedRecord =
      owner === "legacy"
        ? malformedTrace.traceEvents[0].args.data
        : malformedTrace.traceEvents[1].args.event_timing;
    malformedRecord[key] = "17";
    const malformedCrosswalk = brave155Crosswalk(malformedTrace);
    assert.ok(
      malformedCrosswalk.rejectionCounts.some(
        ({ code }) => code === malformedReason,
      ),
      `${owner}.${key}`,
    );
    assert.equal(
      malformedCrosswalk.methodScope.evidenceClass,
      "installed-brave-schema-probe",
    );
  }
});

test("keeps Brave 155 slice pairing, identity, endpoint, marker, and fallback gates", () => {
  const invalidCases = [
    {
      name: "wrong EventTiming phase",
      expectedReason: "UNSUPPORTED_SLICE_PHASE",
      mutate(trace) {
        trace.traceEvents[3].ph = "X";
      },
    },
    {
      name: "wrong legacy typed category",
      expectedReason: "UNEXPECTED_TYPED_SLICE_CATEGORY",
      mutate(trace) {
        trace.traceEvents[0].cat = "latency";
      },
    },
    {
      name: "wrong modern typed category",
      expectedReason: "UNEXPECTED_TYPED_SLICE_CATEGORY",
      mutate(trace) {
        trace.traceEvents[1].cat = "devtools.timeline";
      },
    },
    {
      name: "mismatched typed begin and end ID",
      expectedReason: "UNMATCHED_TYPED_SLICE_END",
      mutate(trace) {
        trace.traceEvents[2].id2.local = "0x42";
      },
    },
    {
      name: "different renderer process",
      expectedReason: "NO_EXACT_CROSSWALK_MATCH",
      mutate(trace) {
        trace.traceEvents[1].pid = 102;
        trace.traceEvents[2].pid = 102;
      },
    },
    {
      name: "different thread",
      expectedReason: "NO_EXACT_CROSSWALK_MATCH",
      mutate(trace) {
        trace.traceEvents[1].tid = 8;
        trace.traceEvents[2].tid = 8;
      },
    },
    {
      name: "different frame",
      expectedReason: "NO_EXACT_CROSSWALK_MATCH",
      mutate(trace) {
        trace.traceEvents[1].args.event_timing.frame = "frame-B";
      },
    },
    {
      name: "different DOM node",
      expectedReason: "NO_EXACT_CROSSWALK_MATCH",
      mutate(trace) {
        trace.traceEvents[1].args.event_timing.node_id = 312n;
      },
    },
    {
      name: "different cancelable state",
      expectedReason: "NO_EXACT_CROSSWALK_MATCH",
      mutate(trace) {
        trace.traceEvents[1].args.event_timing.cancelable = false;
      },
    },
    {
      name: "different DOM event type",
      expectedReason: "NO_EXACT_CROSSWALK_MATCH",
      mutate(trace) {
        trace.traceEvents[1].args.event_timing.type = "KEY_DOWN_EVENT";
      },
    },
    {
      name: "ambiguous duplicate legacy identity",
      expectedReason: "AMBIGUOUS_CROSSWALK_IDENTITY",
      makeTrace() {
        const trace = makeBrave155TraceFromRaw((events) => {
          const duplicateBegin = structuredClone(events[0]);
          const duplicateEnd = structuredClone(events[3]);
          duplicateBegin.id = "0x4";
          duplicateEnd.id = "0x4";
          events.push(duplicateBegin, duplicateEnd);
        });
        trace.traceEvents[6].args.data.interactionId = 17n;
        trace.traceEvents[6].args.data.interactionOffset = 18n;
        return trace;
      },
    },
    {
      name: "different processing endpoint",
      expectedReason: "PROCESSING_ENDPOINT_MISMATCH",
      makeTrace() {
        return makeBrave155TraceFromRaw((events) => {
          events[2].ts = 10006;
        });
      },
    },
    {
      name: "unproven fallback reason",
      expectedReason: "FALLBACK_UNPROVEN",
      mutate(trace) {
        trace.traceEvents[1].args.fallback_reason = "unknown";
      },
    },
    {
      name: "nonzero fallback time",
      expectedReason: "FALLBACK_UNPROVEN",
      mutate(trace) {
        trace.traceEvents[1].args.fallback_time = 1n;
      },
    },
    {
      name: "fallback time in modern payload",
      expectedReason: "FALLBACK_UNPROVEN",
      mutate(trace) {
        trace.traceEvents[1].args.event_timing.fallback_time_us = 1000n;
      },
    },
  ];

  for (const invalidCase of invalidCases) {
    const trace = invalidCase.makeTrace
      ? invalidCase.makeTrace()
      : makeBrave155Trace();
    if (invalidCase.mutate) invalidCase.mutate(trace);
    const crosswalk = brave155Crosswalk(trace);
    assert.deepEqual(crosswalk.candidates, [], invalidCase.name);
    assert.equal(
      crosswalk.methodScope.evidenceClass,
      "installed-brave-schema-probe",
      invalidCase.name,
    );
    assert.ok(
      crosswalk.rejectionCounts.some(
        ({ code }) => code === invalidCase.expectedReason,
      ),
      invalidCase.name,
    );
  }

  const payloadFreeMarker = brave155Crosswalk();
  assert.equal(payloadFreeMarker.candidates.length, 1);
  assert.equal(payloadFreeMarker.counts.modernMarkerCount, 1);
  assert.ok(
    payloadFreeMarker.rejectionCounts.some(
      ({ code }) => code === "PAYLOAD_FREE_MODERN_MARKER",
    ),
  );

  const payloadMarkerTrace = makeBrave155Trace();
  payloadMarkerTrace.traceEvents[5].args = {
    event_timing: structuredClone(
      payloadMarkerTrace.traceEvents[1].args.event_timing,
    ),
  };
  const payloadMarker = brave155Crosswalk(payloadMarkerTrace);
  assert.equal(payloadMarker.candidates.length, 1);
  assert.equal(payloadMarker.counts.modernMarkerCount, 1);
  assert.ok(
    payloadMarker.rejectionCounts.some(
      ({ code }) => code === "MODERN_MARKER_NOT_SLICE",
    ),
  );
});

function crosswalkWithRuntimeUserAgent(userAgent) {
  const trace = parseTrace(readFixture("event-timing-fallback.trace.json"));
  return analyzeTrace(
    trace,
    { trace: "event-timing-fallback.trace.json", dataLossOccurred: false },
    [],
    {
      ...knownChromiumObservations,
      browserIdentity: { runtime: { userAgent } },
    },
  ).discreteEventTimingCrosswalk;
}

function assertUnsupportedUserAgent(userAgent) {
  const crosswalk = crosswalkWithRuntimeUserAgent(userAgent);
  assert.equal(crosswalk.status, "unavailable");
  assert.deepEqual(crosswalk.candidates, []);
  assert.equal(crosswalk.methodScope, null);
  assert.deepEqual(crosswalk.formalActionSamples, []);
  assert.deepEqual(crosswalk.gateReasonCodes, [
    "BROWSER_SOURCE_PROFILE_UNSUPPORTED",
  ]);
  assert.doesNotMatch(JSON.stringify(crosswalk), /TRACE_PRIVATE_USER_AGENT/);
}

test("accepts the complete pinned Chrome product token in an asserted user agent", () => {
  const crosswalk = crosswalkWithRuntimeUserAgent(
    "Mozilla/5.0 AppleWebKit/537.36 Chrome/153.0.8010.12 Safari/537.36",
  );
  assert.equal(crosswalk.status, "diagnostic-only");
  assert.equal(crosswalk.candidates.length, 1);
});

test("rejects a Chrome product token with a longer version sharing the pinned prefix", () => {
  assertUnsupportedUserAgent("Mozilla/5.0 Chrome/153.0.8010.123 Safari/537.36");
});

test("rejects the pinned version embedded after a conflicting Chrome product token", () => {
  assertUnsupportedUserAgent(
    "Mozilla/5.0 Chrome/155.0.8059.40 comment=Chrome/153.0.8010.12 TRACE_PRIVATE_USER_AGENT",
  );
});

test("rejects conflicting complete Chrome product tokens", () => {
  assertUnsupportedUserAgent(
    "Mozilla/5.0 Chrome/153.0.8010.12 Safari/537.36 Chrome/155.0.8059.40",
  );
});

test("unsupported browser observations do not leak into crosswalk reasons or alter frame diagnostics", () => {
  const trace = parseTrace(readFixture("exact-ids.trace.json"));
  const record = { trace: "exact-ids.trace.json", dataLossOccurred: false };
  const known = analyzeTrace(trace, record, [], knownChromiumObservations);
  const unsupported = analyzeTrace(trace, record, [], {
    browser: {
      product: "TRACE_PRIVATE_BROWSER_PRODUCT",
      version: "TRACE_PRIVATE_BROWSER_VERSION",
    },
    status: "TRACE_PRIVATE_PROBE_STATUS",
  });

  for (const key of [
    "counts",
    "diagnostics",
    "inputToPresentedFrameSamples",
    "frameIntervals",
  ]) {
    assert.deepEqual(unsupported[key], known[key]);
  }
  const crosswalk = unsupported.discreteEventTimingCrosswalk;
  assert.deepEqual(crosswalk.candidates, []);
  assert.deepEqual(crosswalk.formalActionSamples, []);
  assert.equal(crosswalk.methodScope, null);
  assert.deepEqual(crosswalk.gateReasonCodes, [
    "BROWSER_SOURCE_PROFILE_UNSUPPORTED",
  ]);
  assert.doesNotMatch(JSON.stringify(crosswalk), /TRACE_PRIVATE_/);
});

test("uses one-based nearest-rank percentiles and rejects invalid inputs", () => {
  assert.equal(nearestRank([4], 0.5), 4);
  assert.equal(nearestRank([4], 0.95), 4);
  assert.equal(
    nearestRank(
      Array.from({ length: 100 }, (_, i) => i + 1),
      0.5,
    ),
    50,
  );
  assert.equal(
    nearestRank(
      Array.from({ length: 100 }, (_, i) => i + 1),
      0.95,
    ),
    95,
  );
  assert.equal(
    nearestRank(
      Array.from({ length: 120 }, (_, i) => i + 1),
      0.5,
    ),
    60,
  );
  assert.equal(
    nearestRank(
      Array.from({ length: 120 }, (_, i) => i + 1),
      0.95,
    ),
    114,
  );
  assert.equal(nearestRank([2, 1, 2, 1], 0.5), 1);
  assert.equal(nearestRank([], 0.5), null);
  assert.throws(() => nearestRank([1, Number.NaN], 0.5), TypeError);
  assert.throws(() => nearestRank([-1], 0.5), TypeError);
  assert.throws(() => nearestRank([1], 0.9), TypeError);
});

test("inverts the original EventTiming decimal token and proves only exact discrete entries", () => {
  const analysis = analyzeKnownChromiumTrace(
    parseTrace(readFixture("event-timing-fallback.trace.json")),
    { trace: "event-timing-fallback.trace.json", dataLossOccurred: false },
  );

  assert.deepEqual(analysis.discreteEventTimingCrosswalk.candidates, [
    {
      eventType: "click",
      durationUs: 8,
      processingEndToPresentationUs: 3,
      status: "diagnostic-only",
    },
  ]);
  assert.equal(
    analysis.discreteEventTimingCrosswalk.counts.legacyCompleteEntries,
    1,
  );
  assert.equal(
    analysis.discreteEventTimingCrosswalk.counts.modernCompleteEntries,
    1,
  );
  assert.deepEqual(
    analysis.discreteEventTimingCrosswalk.formalActionSamples,
    [],
  );
  assert.deepEqual(analysis.discreteEventTimingCrosswalk.methodScope, {
    observedBrowserVersion: "153.0.8010.12",
    pinnedSourceRevision: "971a7443b0c9b0a9b2860529b33331b76077ec62",
    evidenceClass: "synthetic-method-pilot",
    vendorPatchIdentity: "unverified",
    navigationDocumentIdentity: "not-inferred",
    originScope: "capture-case + renderer PID + frame",
  });
  assert.ok(
    analysis.discreteEventTimingCrosswalk.gateReasonCodes.includes(
      "ACTION_ATTRIBUTION_UNPROVEN",
    ),
  );
  assert.ok(
    analysis.discreteEventTimingCrosswalk.gateReasonCodes.includes(
      "NAVIGATION_DOCUMENT_IDENTITY_NOT_INFERRED",
    ),
  );
  assert.ok(
    analysis.discreteEventTimingCrosswalk.gateReasonCodes.includes(
      "VENDOR_PATCH_IDENTITY_UNVERIFIED",
    ),
  );
  assert.ok(
    analysis.discreteEventTimingCrosswalk.gateReasonCodes.includes(
      "SYNTHETIC_METHOD_PILOT_ONLY",
    ),
  );
});

test("rejects ambiguous crosswalk identities instead of joining nearby entries", () => {
  const trace = JSON.parse(readFixture("event-timing-fallback.trace.json"));
  const duplicate = structuredClone(trace.traceEvents[0]);
  const duplicateEnd = structuredClone(trace.traceEvents[3]);
  duplicate.id = "0x4";
  duplicateEnd.id = "0x4";
  trace.traceEvents.push(duplicate, duplicateEnd);

  const crosswalk = analyzeKnownChromiumTrace(
    parseTrace(JSON.stringify(trace)),
    {
      trace: "event-timing-fallback.trace.json",
      dataLossOccurred: false,
    },
  ).discreteEventTimingCrosswalk;

  assert.deepEqual(crosswalk.candidates, []);
  assert.ok(
    crosswalk.rejectionCounts.some(
      ({ code }) => code === "AMBIGUOUS_CROSSWALK_IDENTITY",
    ),
  );
});

test("distinguishes repeated EventTiming identities by exact processing endpoints", () => {
  const trace = JSON.parse(readFixture("event-timing-fallback.trace.json"));
  const legacyBegin = structuredClone(trace.traceEvents[0]);
  const legacyEnd = structuredClone(trace.traceEvents[3]);
  const modernBegin = structuredClone(trace.traceEvents[1]);
  const modernEnd = structuredClone(trace.traceEvents[2]);
  legacyBegin.ts = 11000;
  legacyBegin.args.data.timeStamp = 2;
  legacyBegin.args.data.processingStart = 2.001;
  legacyBegin.args.data.processingEnd = 2.005;
  legacyEnd.ts = 11009;
  modernBegin.ts = 11001;
  modernEnd.ts = 11005;
  trace.traceEvents.push(legacyBegin, modernBegin, modernEnd, legacyEnd);

  const crosswalk = analyzeKnownChromiumTrace(
    parseTrace(JSON.stringify(trace)),
    {
      trace: "event-timing-fallback.trace.json",
      dataLossOccurred: false,
    },
  ).discreteEventTimingCrosswalk;

  assert.deepEqual(
    crosswalk.candidates.map(({ durationUs }) => durationUs),
    [8, 9],
  );
  assert.equal(
    crosswalk.rejectionCounts.some(
      ({ code }) => code === "AMBIGUOUS_CROSSWALK_IDENTITY",
    ),
    false,
  );
});

test("requires EventTiming frame values to use the observed string encoding", () => {
  const legacyNumericFrame = JSON.parse(
    readFixture("event-timing-fallback.trace.json"),
  );
  legacyNumericFrame.traceEvents[0].args.data.frame = 123;
  const legacyCrosswalk = analyzeKnownChromiumTrace(
    parseTrace(JSON.stringify(legacyNumericFrame)),
    {
      trace: "event-timing-fallback.trace.json",
      dataLossOccurred: false,
    },
  ).discreteEventTimingCrosswalk;
  assert.deepEqual(legacyCrosswalk.candidates, []);
  assert.ok(
    legacyCrosswalk.rejectionCounts.some(
      ({ code }) => code === "MALFORMED_LEGACY_FRAME",
    ),
  );

  const modernNumericFrame = JSON.parse(
    readFixture("event-timing-fallback.trace.json"),
  );
  modernNumericFrame.traceEvents[1].args.event_timing.frame = 123;
  const modernCrosswalk = analyzeKnownChromiumTrace(
    parseTrace(JSON.stringify(modernNumericFrame)),
    {
      trace: "event-timing-fallback.trace.json",
      dataLossOccurred: false,
    },
  ).discreteEventTimingCrosswalk;
  assert.deepEqual(modernCrosswalk.candidates, []);
  assert.ok(
    modernCrosswalk.rejectionCounts.some(
      ({ code }) => code === "MALFORMED_MODERN_FRAME",
    ),
  );
});

test("requires the observed category for each typed EventTiming source", () => {
  const trace = JSON.parse(readFixture("event-timing-fallback.trace.json"));
  for (const event of trace.traceEvents) {
    if (event.name === "EventTiming") event.cat = "latency";
    if (event.name === "EventProcessing") event.cat = "devtools.timeline";
  }

  const crosswalk = analyzeKnownChromiumTrace(
    parseTrace(JSON.stringify(trace)),
    {
      trace: "event-timing-fallback.trace.json",
      dataLossOccurred: false,
    },
  ).discreteEventTimingCrosswalk;

  assert.deepEqual(crosswalk.candidates, []);
  assert.ok(
    crosswalk.rejectionCounts.some(
      ({ code }) => code === "UNEXPECTED_TYPED_SLICE_CATEGORY",
    ),
  );
});

test("requires a consistent origin per capture, renderer, and frame scope", () => {
  const trace = JSON.parse(readFixture("event-timing-fallback.trace.json"));
  const legacyBegin = structuredClone(trace.traceEvents[0]);
  const legacyEnd = structuredClone(trace.traceEvents[3]);
  const modernBegin = structuredClone(trace.traceEvents[1]);
  const modernEnd = structuredClone(trace.traceEvents[2]);
  legacyBegin.id = "0x4";
  legacyEnd.id = "0x4";
  legacyBegin.ts = 11000;
  legacyBegin.args.data.timeStamp = 1;
  legacyBegin.args.data.processingStart = 1.001;
  legacyBegin.args.data.processingEnd = 1.005;
  legacyEnd.ts = 11008;
  legacyBegin.args.data.interactionId = 2;
  legacyBegin.args.data.interactionOffset = 3;
  modernBegin.id2.local = "0x4";
  modernEnd.id2.local = "0x4";
  modernBegin.ts = 11001;
  modernEnd.ts = 11005;
  modernBegin.args.event_timing.interaction_id = 2;
  modernBegin.args.event_timing.interaction_offset = 3;
  trace.traceEvents.push(legacyBegin, modernBegin, modernEnd, legacyEnd);

  const crosswalk = analyzeKnownChromiumTrace(
    parseTrace(JSON.stringify(trace)),
    {
      trace: "event-timing-fallback.trace.json",
      dataLossOccurred: false,
    },
  ).discreteEventTimingCrosswalk;

  assert.deepEqual(crosswalk.candidates, []);
  assert.ok(
    crosswalk.rejectionCounts.some(
      ({ code }) => code === "INCONSISTENT_DOCUMENT_ORIGIN",
    ),
  );
});

test("keeps independent renderer scopes separate when origins differ", () => {
  const trace = JSON.parse(readFixture("event-timing-fallback.trace.json"));
  const legacyBegin = structuredClone(trace.traceEvents[0]);
  const legacyEnd = structuredClone(trace.traceEvents[3]);
  const modernBegin = structuredClone(trace.traceEvents[1]);
  const modernEnd = structuredClone(trace.traceEvents[2]);
  for (const event of [legacyBegin, legacyEnd, modernBegin, modernEnd]) {
    event.pid = 202;
  }
  legacyBegin.id = "0x4";
  legacyEnd.id = "0x4";
  legacyBegin.ts = 11000;
  legacyBegin.args.data.timeStamp = 1;
  legacyBegin.args.data.processingStart = 1.001;
  legacyBegin.args.data.processingEnd = 1.005;
  legacyEnd.ts = 11008;
  legacyBegin.args.data.interactionId = 2;
  legacyBegin.args.data.interactionOffset = 3;
  modernBegin.id2.local = "0x4";
  modernEnd.id2.local = "0x4";
  modernBegin.ts = 11001;
  modernEnd.ts = 11005;
  modernBegin.args.event_timing.interaction_id = 2;
  modernBegin.args.event_timing.interaction_offset = 3;
  trace.traceEvents.push(legacyBegin, modernBegin, modernEnd, legacyEnd);

  const crosswalk = analyzeKnownChromiumTrace(
    parseTrace(JSON.stringify(trace)),
    {
      trace: "event-timing-fallback.trace.json",
      dataLossOccurred: false,
    },
  ).discreteEventTimingCrosswalk;

  assert.equal(crosswalk.candidates.length, 2);
});

test("keeps independent frame scopes separate when origins differ", () => {
  const trace = JSON.parse(readFixture("event-timing-fallback.trace.json"));
  const legacyBegin = structuredClone(trace.traceEvents[0]);
  const legacyEnd = structuredClone(trace.traceEvents[3]);
  const modernBegin = structuredClone(trace.traceEvents[1]);
  const modernEnd = structuredClone(trace.traceEvents[2]);
  legacyBegin.id = "0x4";
  legacyEnd.id = "0x4";
  legacyBegin.ts = 11000;
  legacyBegin.args.data.frame = "frame-B";
  legacyBegin.args.data.timeStamp = 1;
  legacyBegin.args.data.processingStart = 1.001;
  legacyBegin.args.data.processingEnd = 1.005;
  legacyEnd.ts = 11008;
  legacyBegin.args.data.interactionId = 2;
  legacyBegin.args.data.interactionOffset = 3;
  modernBegin.id2.local = "0x4";
  modernEnd.id2.local = "0x4";
  modernBegin.ts = 11001;
  modernEnd.ts = 11005;
  modernBegin.args.event_timing.frame = "frame-B";
  modernBegin.args.event_timing.interaction_id = 2;
  modernBegin.args.event_timing.interaction_offset = 3;
  trace.traceEvents.push(legacyBegin, modernBegin, modernEnd, legacyEnd);

  const crosswalk = analyzeKnownChromiumTrace(
    parseTrace(JSON.stringify(trace)),
    {
      trace: "event-timing-fallback.trace.json",
      dataLossOccurred: false,
    },
  ).discreteEventTimingCrosswalk;

  assert.equal(crosswalk.candidates.length, 2);
});

test("rejects a decimal timestamp with no exact binary64 microsecond preimage", () => {
  const text = readFixture("event-timing-fallback.trace.json").replace(
    '"timeStamp": 1.0000000000000001',
    '"timeStamp": 1.0000000000000002',
  );
  const crosswalk = analyzeKnownChromiumTrace(parseTrace(text), {
    trace: "event-timing-fallback.trace.json",
    dataLossOccurred: false,
  }).discreteEventTimingCrosswalk;

  assert.deepEqual(crosswalk.candidates, []);
  assert.ok(
    crosswalk.rejectionCounts.some(
      ({ code }) => code === "NO_BINARY64_MICROSECOND_PREIMAGE",
    ),
  );
});

test("requires explicit fallback-free evidence for the modern slice", () => {
  const missingFallback = readFixture(
    "event-timing-fallback.trace.json",
  ).replace('"fallback_reason": "None",\n', "");
  const crosswalk = analyzeKnownChromiumTrace(parseTrace(missingFallback), {
    trace: "event-timing-fallback.trace.json",
    dataLossOccurred: false,
  }).discreteEventTimingCrosswalk;

  assert.deepEqual(crosswalk.candidates, []);
  assert.ok(
    crosswalk.rejectionCounts.some(({ code }) => code === "FALLBACK_UNPROVEN"),
  );

  const fallbackTimeUsPresent = readFixture(
    "event-timing-fallback.trace.json",
  ).replace('"pointer_id": 1', '"pointer_id": 1, "fallback_time_us": 0');
  const contradicted = analyzeKnownChromiumTrace(
    parseTrace(fallbackTimeUsPresent),
    {
      trace: "event-timing-fallback.trace.json",
      dataLossOccurred: false,
    },
  ).discreteEventTimingCrosswalk;
  assert.deepEqual(contradicted.candidates, []);
  assert.ok(
    contradicted.rejectionCounts.some(
      ({ code }) => code === "FALLBACK_UNPROVEN",
    ),
  );

  const nonzeroFallbackTime = readFixture(
    "event-timing-fallback.trace.json",
  ).replace('"fallback_time": 0', '"fallback_time": 1');
  const fallbackTimeCrosswalk = analyzeKnownChromiumTrace(
    parseTrace(nonzeroFallbackTime),
    {
      trace: "event-timing-fallback.trace.json",
      dataLossOccurred: false,
    },
  ).discreteEventTimingCrosswalk;
  assert.deepEqual(fallbackTimeCrosswalk.candidates, []);
  assert.ok(
    fallbackTimeCrosswalk.rejectionCounts.some(
      ({ code }) => code === "FALLBACK_UNPROVEN",
    ),
  );
});

test("associates one observed click through trusted DOM dispatch and the exact raw trace index", () => {
  const evidence = makeObserverEvidence({
    records: [
      observedApiEntry({ deliveryPhase: "secondary" }),
      observedDomEntry({ phase: "primary" }),
    ],
  });
  const analysis = analyzeTrace(
    makeBrave155Trace(),
    evidence.traceRecord,
    [],
    knownBrave15580Observations,
    {
      declaration: evidence.declaration,
      sidecar: evidence.sidecar,
      capture: evidence.capture,
    },
  );

  assert.deepEqual(analysis.observedDiscreteInputs, {
    status: "diagnostic-only",
    counts: { apiEntries: 1, accepted: 1, rejected: 0 },
    entries: [
      {
        dispatchPhase: "primary",
        actionLabel: "open-primary",
        eventType: "click",
        durationUs: 8,
        processingEndToPresentationUs: 3,
        status: "diagnostic-only",
      },
    ],
    rejectionCounts: [],
    formalActionStatus: "unavailable",
    formalActionSamples: [],
  });
  assert.doesNotMatch(
    JSON.stringify(analysis.observedDiscreteInputs),
    /d-aaaaaaaa|t-bbbbbbbb|frame-A|loader-A|targetToken|timeStamp|startTime|interactionId|event-timing/,
  );

  const withoutEvidence = analyzeTrace(
    makeBrave155Trace(),
    evidence.traceRecord,
    [],
    knownBrave15580Observations,
  );
  assert.equal(Object.hasOwn(withoutEvidence, "observedDiscreteInputs"), false);
  assert.deepEqual(withoutEvidence.discreteEventTimingCrosswalk.candidates, [
    {
      eventType: "click",
      durationUs: 8,
      processingEndToPresentationUs: 3,
      status: "diagnostic-only",
    },
  ]);
});

test("selects the crosswalk candidate by the associated raw begin index", () => {
  const raw = JSON.parse(readFixture("event-timing-fallback.trace.json"));
  const secondEvents = structuredClone(raw.traceEvents.slice(0, 4));
  secondEvents[0].ts = 20000;
  secondEvents[0].id = "0x3";
  secondEvents[0].args.data.interactionId = 18;
  secondEvents[0].args.data.interactionOffset = 19;
  secondEvents[0].args.data.timeStamp = 11;
  secondEvents[0].args.data.processingStart = 11.001;
  secondEvents[0].args.data.processingEnd = 11.003;
  secondEvents[1].ts = 20001;
  secondEvents[1].id2.local = "0x4";
  secondEvents[1].args.event_timing.interaction_id = 18;
  secondEvents[1].args.event_timing.interaction_offset = 19;
  secondEvents[2].ts = 20003;
  secondEvents[2].id2.local = "0x4";
  secondEvents[3].ts = 20008;
  secondEvents[3].id = "0x3";
  raw.traceEvents.push(...secondEvents);
  const trace = withBrave155InteractionValues(parseTrace(JSON.stringify(raw)));
  trace.traceEvents[6].args.data.interactionId = 18n;
  trace.traceEvents[6].args.data.interactionOffset = 19n;
  const evidence = makeObserverEvidence({
    records: [observedApiEntry({ interactionId: 18 }), observedDomEntry()],
  });
  const analysis = analyzeTrace(
    trace,
    evidence.traceRecord,
    [],
    knownBrave15580Observations,
    {
      declaration: evidence.declaration,
      sidecar: evidence.sidecar,
      capture: evidence.capture,
    },
  );

  assert.deepEqual(analysis.discreteEventTimingCrosswalk.candidates, [
    {
      eventType: "click",
      durationUs: 8,
      processingEndToPresentationUs: 3,
      status: "diagnostic-only",
    },
    {
      eventType: "click",
      durationUs: 8,
      processingEndToPresentationUs: 5,
      status: "diagnostic-only",
    },
  ]);
  assert.equal(analysis.observedDiscreteInputs.counts.accepted, 1);
  assert.deepEqual(analysis.observedDiscreteInputs.entries, [
    {
      dispatchPhase: "primary",
      actionLabel: "open-primary",
      eventType: "click",
      durationUs: 8,
      processingEndToPresentationUs: 5,
      status: "diagnostic-only",
    },
  ]);
});

test("counts duplicate API identities before rejecting a target miss", () => {
  const evidence = makeObserverEvidence({
    records: [
      observedApiEntry(),
      observedApiEntry({ targetToken: "t-cccccccccccccccccccccccc" }),
      observedDomEntry(),
    ],
  });
  const result = analyzeObservedTrace({ evidence });

  assert.deepEqual(result.counts, { apiEntries: 2, accepted: 0, rejected: 2 });
  assert.deepEqual(result.entries, []);
  assert.deepEqual(result.rejectionCounts, [
    { code: "API_IDENTITY_AMBIGUOUS", count: 2 },
  ]);
  assert.equal(result.formalActionStatus, "unavailable");
  assert.deepEqual(result.formalActionSamples, []);
});

test("counts duplicate raw EventTiming begins before endpoint and fallback filtering", () => {
  const trace = makeBrave155Trace();
  trace.traceEvents.push({
    ...structuredClone(trace.traceEvents[0]),
    pid: 999,
    tid: 99,
    id: "0xduplicate",
  });
  const result = analyzeObservedTrace({
    evidence: makeObserverEvidence(),
    trace,
  });

  assert.deepEqual(result.counts, { apiEntries: 1, accepted: 0, rejected: 1 });
  assert.deepEqual(result.rejectionCounts, [
    { code: "TRACE_IDENTITY_AMBIGUOUS", count: 1 },
  ]);
});

test("rejects an unclassifiable raw begin instead of allowing it to create a singleton", () => {
  const trace = makeBrave155Trace();
  trace.traceEvents.push({
    name: "EventTiming",
    cat: "devtools.timeline",
    ph: "b",
    pid: 999,
    tid: 99,
    ts: 10001n,
    id: "0xmalformed",
    args: { data: { type: "click" } },
  });
  const result = analyzeObservedTrace({
    evidence: makeObserverEvidence(),
    trace,
  });

  assert.deepEqual(result.counts, { apiEntries: 1, accepted: 0, rejected: 1 });
  assert.deepEqual(result.rejectionCounts, [
    { code: "TRACE_CONTENDER_UNCLASSIFIABLE", count: 1 },
  ]);
});

test("rejects an unknown EventTiming type but excludes pinned known legacy types", () => {
  const unknownTypeTrace = makeBrave155Trace();
  unknownTypeTrace.traceEvents.push({
    name: "EventTiming",
    cat: "devtools.timeline",
    ph: "b",
    pid: 999,
    tid: 99,
    ts: 10001n,
    id: "0xunknown",
    args: {
      data: {
        type: "mysterypointergesture",
        frame: observedFrameId,
        interactionId: 17n,
      },
    },
  });
  const unknownResult = analyzeObservedTrace({
    evidence: makeObserverEvidence(),
    trace: unknownTypeTrace,
  });
  assert.deepEqual(unknownResult.counts, {
    apiEntries: 1,
    accepted: 0,
    rejected: 1,
  });
  assert.deepEqual(unknownResult.rejectionCounts, [
    { code: "TRACE_CONTENDER_UNCLASSIFIABLE", count: 1 },
  ]);

  const knownExcludedTrace = makeBrave155Trace();
  knownExcludedTrace.traceEvents.push({
    name: "EventTiming",
    cat: "devtools.timeline",
    ph: "b",
    pid: 999,
    tid: 99,
    ts: 10001n,
    id: "0xknown-excluded",
    args: { data: { type: "gotpointercapture" } },
  });
  const knownExcludedResult = analyzeObservedTrace({
    evidence: makeObserverEvidence(),
    trace: knownExcludedTrace,
  });
  assert.deepEqual(knownExcludedResult.counts, {
    apiEntries: 1,
    accepted: 1,
    rejected: 0,
  });
});

test("rejects nonpositive and overflow API interaction IDs", () => {
  const evidence = makeObserverEvidence({
    records: [
      observedApiEntry({ interactionId: 0 }),
      observedApiEntry({ interactionId: 2147483648 }),
      observedDomEntry(),
    ],
  });
  const result = analyzeObservedTrace({ evidence });

  assert.deepEqual(result.counts, { apiEntries: 2, accepted: 0, rejected: 2 });
  assert.deepEqual(result.rejectionCounts, [
    { code: "API_INTERACTION_ID_INVALID", count: 2 },
  ]);
});

test("rejects stale frame provenance and exact DOM target misses", () => {
  const staleProvenance = makeObserverEvidence({
    frameProvenanceOverrides: {
      status: "unknown",
      reasonCode: "PROVENANCE_DOCUMENT_ID_MISMATCH",
    },
  });
  const staleResult = analyzeObservedTrace({ evidence: staleProvenance });
  assert.deepEqual(staleResult.counts, {
    apiEntries: 1,
    accepted: 0,
    rejected: 1,
  });
  assert.deepEqual(staleResult.rejectionCounts, [
    { code: "FRAME_PROVENANCE_UNSTABLE", count: 1 },
  ]);

  const targetMiss = makeObserverEvidence({
    records: [
      observedApiEntry({ targetToken: "t-cccccccccccccccccccccccc" }),
      observedDomEntry(),
    ],
  });
  const targetResult = analyzeObservedTrace({ evidence: targetMiss });
  assert.deepEqual(targetResult.counts, {
    apiEntries: 1,
    accepted: 0,
    rejected: 1,
  });
  assert.deepEqual(targetResult.rejectionCounts, [
    { code: "DOM_COUNTERPART_UNAVAILABLE", count: 1 },
  ]);
});

test("requires collector hash, completed action, loss-free trace, and an allowed measurement state", () => {
  const invalidCases = [
    {
      name: "capture failure reason",
      evidence: makeObserverEvidence({
        caseRecordOverrides: { actionReasonCode: "TRACE_CAPTURE_FAILED" },
      }),
      code: "COLLECTOR_LIFECYCLE_INVALID",
    },
    {
      name: "missing original source hash",
      evidence: makeObserverEvidence({ sourceHashSha256: null }),
      code: "COLLECTOR_SOURCE_HASH_MISMATCH",
    },
    {
      name: "changed original source hash",
      evidence: makeObserverEvidence({ sourceHashSha256: "0".repeat(64) }),
      code: "COLLECTOR_SOURCE_HASH_MISMATCH",
    },
    {
      name: "unknown measurement state",
      evidence: makeObserverEvidence({
        caseRecordOverrides: { measurementStatus: "unknown" },
      }),
      code: "COLLECTOR_LIFECYCLE_INVALID",
    },
    {
      name: "resolved measurement with a reason",
      evidence: makeObserverEvidence({
        caseRecordOverrides: {
          measurementStatus: "resolved",
          measurementReasonCode: "FRAME_STREAM_MISSING",
        },
      }),
      code: "COLLECTOR_LIFECYCLE_INVALID",
    },
    {
      name: "unavailable measurement with another reason",
      evidence: makeObserverEvidence({
        caseRecordOverrides: {
          measurementStatus: "unavailable",
          measurementReasonCode: "TRACE_CAPTURE_FAILED",
        },
      }),
      code: "COLLECTOR_LIFECYCLE_INVALID",
    },
    {
      name: "case trace loss",
      evidence: makeObserverEvidence({
        caseRecordOverrides: { dataLossOccurred: true },
      }),
      code: "TRACE_DATA_LOSS_OR_LINK_MISMATCH",
    },
    {
      name: "linked trace loss",
      evidence: makeObserverEvidence({ traceDataLossOccurred: true }),
      code: "TRACE_DATA_LOSS_OR_LINK_MISMATCH",
    },
    {
      name: "case trace mismatch",
      evidence: makeObserverEvidence({
        caseRecordOverrides: { trace: "other.trace.json" },
      }),
      code: "TRACE_DATA_LOSS_OR_LINK_MISMATCH",
    },
  ];

  for (const invalidCase of invalidCases) {
    const result = analyzeObservedTrace({ evidence: invalidCase.evidence });
    assert.deepEqual(
      result.counts,
      { apiEntries: 1, accepted: 0, rejected: 1 },
      invalidCase.name,
    );
    assert.deepEqual(
      result.rejectionCounts,
      [{ code: invalidCase.code, count: 1 }],
      invalidCase.name,
    );
  }

  for (const caseRecordOverrides of [
    { measurementStatus: "resolved" },
    {
      measurementStatus: "unavailable",
      measurementReasonCode: "FRAME_STREAM_MISSING",
    },
  ]) {
    const evidence = makeObserverEvidence({ caseRecordOverrides });
    assert.equal(analyzeObservedTrace({ evidence }).counts.accepted, 1);
  }
});

test("validates the original manifest declaration separately from the case summary", () => {
  const invalidManifestEvidence = [
    makeObserverEvidence({
      declarationOverrides: { unexpected: "private-value" },
    }),
    makeObserverEvidence({
      declarationOverrides: { inputMethod: "other synthetic method" },
    }),
    makeObserverEvidence({
      declarationOverrides: {
        performanceEventTiming: {
          ...observedManifestEvidence.performanceEventTiming,
          durationThresholdMs: 8,
        },
      },
    }),
    makeObserverEvidence({ declarationOverrides: { recordLimit: 513 } }),
    makeObserverEvidence({ declarationOverrides: { recordByteLimit: 1 } }),
    makeObserverEvidence({
      declarationOverrides: {
        nextPaint: { status: "resolved", reasonCode: null },
      },
    }),
    makeObserverEvidence({
      caseObservationOverrides: { fileName: "other-case.stimulus.json" },
    }),
  ];
  for (const evidence of invalidManifestEvidence) {
    const result = analyzeObservedTrace({ evidence });
    assert.deepEqual(result.counts, {
      apiEntries: 1,
      accepted: 0,
      rejected: 1,
    });
    assert.deepEqual(result.rejectionCounts, [
      { code: "OBSERVER_EVIDENCE_INVALID", count: 1 },
    ]);
  }

  const evidence = makeObserverEvidence();
  const caseSummaryAsManifestDeclaration = analyzeTrace(
    makeBrave155Trace(),
    evidence.traceRecord,
    [],
    knownBrave15580Observations,
    {
      declaration: evidence.capture.caseRecord.trustedStimulusObservation,
      sidecar: evidence.sidecar,
      capture: evidence.capture,
    },
  );
  assert.equal(
    caseSummaryAsManifestDeclaration.observedDiscreteInputs.counts.accepted,
    0,
  );
  assert.deepEqual(
    caseSummaryAsManifestDeclaration.observedDiscreteInputs.rejectionCounts,
    [{ code: "OBSERVER_EVIDENCE_INVALID", count: 1 }],
  );

  const changedSidecar = makeObserverEvidence({
    sidecarOverrides: { unexpected: "private-value" },
  });
  const sidecarResult = analyzeObservedTrace({ evidence: changedSidecar });
  assert.deepEqual(sidecarResult.counts, {
    apiEntries: 1,
    accepted: 0,
    rejected: 1,
  });
  assert.deepEqual(sidecarResult.rejectionCounts, [
    { code: "OBSERVER_EVIDENCE_INVALID", count: 1 },
  ]);

  const malformedApi = makeObserverEvidence({
    records: [
      (() => {
        const api = observedApiEntry();
        delete api.interactionId;
        return api;
      })(),
      observedDomEntry(),
    ],
  });
  const malformedApiResult = analyzeObservedTrace({ evidence: malformedApi });
  assert.deepEqual(malformedApiResult.counts, {
    apiEntries: 1,
    accepted: 0,
    rejected: 1,
  });
  assert.deepEqual(malformedApiResult.rejectionCounts, [
    { code: "OBSERVER_EVIDENCE_INVALID", count: 1 },
  ]);
});

test("requires the original trace fixture to match the case and sidecar fixtures", () => {
  const missingFixture = makeObserverEvidence();
  delete missingFixture.traceRecord.fixture;
  const mismatchedFixture = makeObserverEvidence({
    traceRecordOverrides: { fixture: "another-case" },
  });

  for (const evidence of [missingFixture, mismatchedFixture]) {
    const result = analyzeObservedTrace({ evidence });
    assert.deepEqual(result.counts, {
      apiEntries: 1,
      accepted: 0,
      rejected: 1,
    });
    assert.deepEqual(result.rejectionCounts, [
      { code: "TRACE_DATA_LOSS_OR_LINK_MISMATCH", count: 1 },
    ]);
  }
});

test("does not let pointer release, key, resize, or delivery phase select an action", () => {
  const evidence = makeObserverEvidence({
    records: [
      observedApiEntry({ type: "pointerup", interactionId: 17 }),
      observedDomEntry({ type: "pointerup", phase: "primary" }),
      observedApiEntry({ type: "keydown", interactionId: 18 }),
      observedDomEntry({ type: "keydown", phase: "primary" }),
      observedDomEntry({ type: "resize", targetLabel: "window" }),
    ],
  });
  const result = analyzeObservedTrace({ evidence });

  assert.deepEqual(result.counts, { apiEntries: 2, accepted: 0, rejected: 2 });
  assert.deepEqual(result.entries, []);
  assert.equal(result.formalActionStatus, "unavailable");
});

test("rejects mismatched identity fields and typed track namespaces", () => {
  const frameMismatch = readFixture("event-timing-fallback.trace.json").replace(
    '"frame": "frame-A",\n          "node_id"',
    '"frame": "frame-B",\n          "node_id"',
  );
  const frameCrosswalk = analyzeKnownChromiumTrace(parseTrace(frameMismatch), {
    trace: "event-timing-fallback.trace.json",
    dataLossOccurred: false,
  }).discreteEventTimingCrosswalk;
  assert.deepEqual(frameCrosswalk.candidates, []);
  assert.ok(
    frameCrosswalk.rejectionCounts.some(
      ({ code }) => code === "NO_EXACT_CROSSWALK_MATCH",
    ),
  );

  const trace = JSON.parse(readFixture("event-timing-fallback.trace.json"));
  delete trace.traceEvents[3].id;
  trace.traceEvents[3].id2 = { local: "0x1" };
  const trackCrosswalk = analyzeKnownChromiumTrace(
    parseTrace(JSON.stringify(trace)),
    {
      trace: "event-timing-fallback.trace.json",
      dataLossOccurred: false,
    },
  ).discreteEventTimingCrosswalk;
  assert.deepEqual(trackCrosswalk.candidates, []);
  assert.ok(
    trackCrosswalk.rejectionCounts.some(
      ({ code }) => code === "UNTERMINATED_TYPED_SLICE",
    ),
  );
  assert.ok(
    trackCrosswalk.rejectionCounts.some(
      ({ code }) => code === "UNMATCHED_TYPED_SLICE_END",
    ),
  );
});

test("supports id2.global tracks and optional key_code without using them as join keys", () => {
  const trace = JSON.parse(readFixture("event-timing-fallback.trace.json"));
  const legacyBegin = structuredClone(trace.traceEvents[0]);
  const legacyEnd = structuredClone(trace.traceEvents[3]);
  const modernBegin = structuredClone(trace.traceEvents[1]);
  const modernEnd = structuredClone(trace.traceEvents[2]);
  legacyBegin.id = "0x9";
  legacyEnd.id = "0x9";
  legacyBegin.ts = 11000;
  legacyBegin.args.data.type = "keydown";
  legacyBegin.args.data.frame = "frame-B";
  legacyBegin.args.data.nodeId = 317;
  legacyBegin.args.data.interactionId = -3;
  legacyBegin.args.data.interactionOffset = -4;
  legacyBegin.args.data.timeStamp = 2;
  legacyBegin.args.data.processingStart = 2.001;
  legacyBegin.args.data.processingEnd = 2.005;
  legacyEnd.ts = 11008;
  delete modernBegin.id2.local;
  delete modernEnd.id2.local;
  modernBegin.id2.global = "0x9";
  modernEnd.id2.global = "0x9";
  modernBegin.ts = 11001;
  modernEnd.ts = 11005;
  modernBegin.args.event_timing.type = "KEY_DOWN_EVENT";
  modernBegin.args.event_timing.frame = "frame-B";
  modernBegin.args.event_timing.node_id = 317;
  modernBegin.args.event_timing.interaction_id = 4294967293;
  modernBegin.args.event_timing.interaction_offset = 4294967292;
  delete modernBegin.args.event_timing.pointer_id;
  modernBegin.args.event_timing.key_code = 16;
  trace.traceEvents.push(legacyBegin, modernBegin, modernEnd, legacyEnd);

  const crosswalk = analyzeKnownChromiumTrace(
    parseTrace(JSON.stringify(trace)),
    {
      trace: "event-timing-fallback.trace.json",
      dataLossOccurred: false,
    },
  ).discreteEventTimingCrosswalk;

  assert.deepEqual(
    crosswalk.candidates.map(({ eventType }) => eventType),
    ["click", "keydown"],
  );
});

test("rejects unknown fields and modern interaction values outside uint32", () => {
  const unknownField = readFileSync(
    new URL("event-timing-fallback.trace.json", fixtures),
    "utf8",
  ).replace('"pointer_id": 1', '"pointer_id": 1, "joinKey": "private"');
  const unknownCrosswalk = analyzeKnownChromiumTrace(parseTrace(unknownField), {
    trace: "event-timing-fallback.trace.json",
    dataLossOccurred: false,
  }).discreteEventTimingCrosswalk;
  assert.deepEqual(unknownCrosswalk.candidates, []);
  assert.ok(
    unknownCrosswalk.rejectionCounts.some(
      ({ code }) => code === "UNKNOWN_MODERN_EVENT_TIMING_FIELD",
    ),
  );

  const outOfRange = readFixture("event-timing-fallback.trace.json").replace(
    '"interaction_id": 4294967295',
    '"interaction_id": 4294967296',
  );
  const rangeCrosswalk = analyzeKnownChromiumTrace(parseTrace(outOfRange), {
    trace: "event-timing-fallback.trace.json",
    dataLossOccurred: false,
  }).discreteEventTimingCrosswalk;
  assert.deepEqual(rangeCrosswalk.candidates, []);
  assert.ok(
    rangeCrosswalk.rejectionCounts.some(
      ({ code }) => code === "MODERN_INTERACTION_OUT_OF_RANGE",
    ),
  );
});

test("rejects processing endpoint mismatch and out-of-range legacy interaction IDs", () => {
  const endpointMismatch = readFixture(
    "event-timing-fallback.trace.json",
  ).replace('"ts": 10005', '"ts": 10004');
  const endpointCrosswalk = analyzeKnownChromiumTrace(
    parseTrace(endpointMismatch),
    {
      trace: "event-timing-fallback.trace.json",
      dataLossOccurred: false,
    },
  ).discreteEventTimingCrosswalk;
  assert.deepEqual(endpointCrosswalk.candidates, []);
  assert.ok(
    endpointCrosswalk.rejectionCounts.some(
      ({ code }) => code === "PROCESSING_ENDPOINT_MISMATCH",
    ),
  );

  const invalidLegacyId = readFixture(
    "event-timing-fallback.trace.json",
  ).replace('"interactionId": -1', '"interactionId": -2147483649');
  const identityCrosswalk = analyzeKnownChromiumTrace(
    parseTrace(invalidLegacyId),
    {
      trace: "event-timing-fallback.trace.json",
      dataLossOccurred: false,
    },
  ).discreteEventTimingCrosswalk;
  assert.deepEqual(identityCrosswalk.candidates, []);
  assert.ok(
    identityCrosswalk.rejectionCounts.some(
      ({ code }) => code === "LEGACY_INTERACTION_OUT_OF_RANGE",
    ),
  );
});

test("rejects processing spans outside their legacy event lifetime", () => {
  const outsideInput = readFixture("event-timing-fallback.trace.json")
    .replace(
      '"processingStart": 1.00099999999999999',
      '"processingStart": 0.999',
    )
    .replace('"ts": 10001', '"ts": 9999');
  const crosswalk = analyzeKnownChromiumTrace(parseTrace(outsideInput), {
    trace: "event-timing-fallback.trace.json",
    dataLossOccurred: false,
  }).discreteEventTimingCrosswalk;

  assert.deepEqual(crosswalk.candidates, []);
  assert.ok(
    crosswalk.rejectionCounts.some(
      ({ code }) => code === "INVALID_LEGACY_PROCESSING_INTERVAL",
    ),
  );
});

test("does not promote an incidental discrete event into a continuous action sample", () => {
  const analysis = analyzeKnownChromiumTrace(
    parseTrace(readFixture("continuous-input.trace.json")),
    {
      trace: "continuous-input.trace.json",
      dataLossOccurred: false,
      action: "pan",
      stimulusType: "pointermove",
    },
  );
  const crosswalk = analysis.discreteEventTimingCrosswalk;

  assert.equal(crosswalk.candidates.length, 1);
  assert.deepEqual(crosswalk.formalActionSamples, []);
  assert.equal(crosswalk.formalActionStatus, "unavailable");
  assert.ok(
    crosswalk.rejectionCounts.some(
      ({ code }) => code === "UNSUPPORTED_CONTINUOUS_EVENT_TYPE",
    ),
  );
});

function frameReporterEvents({
  pid,
  tid = 1,
  layerTreeHostId,
  frameSource,
  surfaceId,
  displayId,
  endpoint,
  localId = "0x1",
}) {
  const common = {
    name: "PipelineReporter",
    cat: "cc,benchmark,disabled-by-default-devtools.timeline.frame",
    pid,
    tid,
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
          layer_tree_host_id: layerTreeHostId,
          frame_source: frameSource,
        },
      },
    },
    { ...common, ph: "e", ts: endpoint },
  ];
}

test("preserves signed int64 trace IDs without rounding fractional timings", () => {
  const trace = parseTrace(readFixture("exact-ids.trace.json"));
  const eventLatency = trace.traceEvents.find(
    ({ args }) => args?.event_latency?.event_type === "MOUSE_RELEASED",
  );

  assert.equal(
    eventLatency.args.event_latency.event_latency_id,
    9223372036854775807n,
  );
  assert.equal(
    eventLatency.args.event_latency.surface_frame_trace_id,
    -9223372036854775808n,
  );
  assert.equal(
    eventLatency.args.event_latency.display_trace_id,
    -9223372036854775807n,
  );
  assert.equal(eventLatency.args.event_latency.vsync_interval_ms, 16.666);
});

test("emits a diagnostic sample only for exact nested stages and owned reporter endpoint", () => {
  const analysis = analyzeFixture("exact-ids.trace.json");

  assert.equal(analysis.counts.eventCount, 10);
  assert.equal(analysis.counts.completedEventLatencySlices, 1);
  assert.equal(analysis.counts.completedPipelineReporterSlices, 1);
  assert.deepEqual(analysis.counts.reporterStates, {
    STATE_PRESENTED_ALL: 1,
  });
  assert.deepEqual(analysis.inputToPresentedFrameSamples, [
    {
      durationUs: 50,
      status: "diagnostic-only",
      reasonCodes: [],
    },
  ]);
  assert.equal(analysis.frameIntervals.status, "unavailable");
  assert.deepEqual(analysis.frameIntervals.samples, []);
  assert.ok(
    analysis.frameIntervals.reasonCodes.includes("NO_MEASUREMENT_SEGMENT"),
  );
});

test("does not correlate adjacent int64 values that collapse to the same Number", () => {
  const text = readFixture("exact-ids.trace.json").replace(
    '"event_latency_id": 9223372036854775807',
    '"event_latency_id": 9223372036854775806',
  );
  const analysis = analyzeKnownChromiumTrace(parseTrace(text), {
    trace: "exact-ids.trace.json",
    dataLossOccurred: false,
  });

  assert.deepEqual(analysis.inputToPresentedFrameSamples, []);
  assert.ok(diagnosticCodes(analysis).has("NO_EXACT_EVENT_LATENCY_MATCH"));
});

test("does not borrow same-time stages from another track or a sibling reporter", () => {
  const analysis = analyzeFixture("partial-presentation.trace.json");

  assert.deepEqual(analysis.inputToPresentedFrameSamples, []);
  assert.ok(
    diagnosticCodes(analysis).has("EVENT_LATENCY_STAGE_OWNERSHIP_MISMATCH"),
  );
  assert.equal(analysis.counts.completedPipelineReporterSlices, 2);
  assert.deepEqual(analysis.counts.reporterStates, {
    STATE_NO_UPDATE_DESIRED: 1,
    STATE_PRESENTED_ALL: 1,
  });
});

test("a reporter with a different close endpoint cannot complete the chain", () => {
  const text = readFixture("exact-ids.trace.json").replace(
    '"ts": 10050,\n      "id2": { "local": "0x1" }',
    '"ts": 10051,\n      "id2": { "local": "0x1" }',
  );
  const analysis = analyzeKnownChromiumTrace(parseTrace(text), {
    trace: "exact-ids.trace.json",
    dataLossOccurred: false,
  });

  assert.deepEqual(analysis.inputToPresentedFrameSamples, []);
  assert.ok(diagnosticCodes(analysis).has("REPORTER_ENDPOINT_MISMATCH"));
});

test("requires a unique containing parent occurrence for each nested stage", () => {
  const trace = parseTrace(readFixture("exact-ids.trace.json"));
  trace.traceEvents = trace.traceEvents.filter(
    ({ name }) =>
      name !== "SubmitCompositorFrameToPresentationCompositorFrame" &&
      name !== "SwapEndToPresentationCompositorFrame",
  );
  trace.traceEvents.push(
    {
      name: "EventLatency",
      cat: "cc,benchmark,input,input.scrolling",
      ph: "b",
      pid: 22,
      tid: 2,
      ts: 10050,
      id2: { local: "0xa" },
      args: {
        event_latency: { event_type: "MOUSE_MOVED", event_latency_id: 1n },
      },
    },
    {
      name: "SubmitCompositorFrameToPresentationCompositorFrame",
      cat: "cc,benchmark,input,input.scrolling",
      ph: "b",
      pid: 22,
      tid: 2,
      ts: 10050,
      id2: { local: "0xa" },
    },
    {
      name: "SwapEndToPresentationCompositorFrame",
      cat: "cc,benchmark,input,input.scrolling",
      ph: "b",
      pid: 22,
      tid: 2,
      ts: 10050,
      id2: { local: "0xa" },
    },
    {
      name: "SwapEndToPresentationCompositorFrame",
      cat: "cc,benchmark,input,input.scrolling",
      ph: "e",
      pid: 22,
      tid: 2,
      ts: 10050,
      id2: { local: "0xa" },
    },
    {
      name: "SubmitCompositorFrameToPresentationCompositorFrame",
      cat: "cc,benchmark,input,input.scrolling",
      ph: "e",
      pid: 22,
      tid: 2,
      ts: 10050,
      id2: { local: "0xa" },
    },
    {
      name: "EventLatency",
      cat: "cc,benchmark,input,input.scrolling",
      ph: "e",
      pid: 22,
      tid: 2,
      ts: 10060,
      id2: { local: "0xa" },
    },
  );

  const analysis = analyzeKnownChromiumTrace(trace, {
    trace: "exact-ids.trace.json",
    dataLossOccurred: false,
  });

  assert.deepEqual(analysis.inputToPresentedFrameSamples, []);
  assert.ok(
    diagnosticCodes(analysis).has("EVENT_LATENCY_STAGE_OWNERSHIP_MISMATCH"),
  );
});

test("rejects same-track stages ordered after the EventLatency close", () => {
  const trace = parseTrace(readFixture("exact-ids.trace.json"));
  const stageNames = new Set([
    "SubmitCompositorFrameToPresentationCompositorFrame",
    "SwapEndToPresentationCompositorFrame",
  ]);
  const stages = trace.traceEvents.filter(({ name }) => stageNames.has(name));
  trace.traceEvents = trace.traceEvents.filter(
    ({ name }) => !stageNames.has(name),
  );
  const postCloseStages = [
    stages.find(
      ({ name, ph }) =>
        name === "SubmitCompositorFrameToPresentationCompositorFrame" &&
        ph === "b",
    ),
    stages.find(
      ({ name, ph }) =>
        name === "SwapEndToPresentationCompositorFrame" && ph === "b",
    ),
    stages.find(
      ({ name, ph }) =>
        name === "SwapEndToPresentationCompositorFrame" && ph === "e",
    ),
    stages.find(
      ({ name, ph }) =>
        name === "SubmitCompositorFrameToPresentationCompositorFrame" &&
        ph === "e",
    ),
  ].map((event) => ({ ...event, ts: 10050 }));
  trace.traceEvents.push(...postCloseStages);

  const analysis = analyzeKnownChromiumTrace(trace, {
    trace: "exact-ids.trace.json",
    dataLossOccurred: false,
  });

  assert.deepEqual(analysis.inputToPresentedFrameSamples, []);
  assert.ok(
    diagnosticCodes(analysis).has("EVENT_LATENCY_STAGE_OWNERSHIP_MISMATCH"),
  );
});

test("accepts zero-duration stages ordered inside an equal-time parent boundary", () => {
  const trace = parseTrace(readFixture("exact-ids.trace.json"));
  const stageNames = new Set([
    "SubmitCompositorFrameToPresentationCompositorFrame",
    "SwapEndToPresentationCompositorFrame",
  ]);
  trace.traceEvents = trace.traceEvents.filter(
    ({ name }) => !stageNames.has(name),
  );
  const parentEndIndex = trace.traceEvents.findIndex(
    ({ name, ph }) => name === "EventLatency" && ph === "e",
  );
  trace.traceEvents.splice(
    parentEndIndex,
    0,
    {
      name: "SubmitCompositorFrameToPresentationCompositorFrame",
      cat: "cc,benchmark,input,input.scrolling",
      ph: "b",
      pid: 22,
      tid: 2,
      ts: 10050,
      id2: { local: "0xa" },
    },
    {
      name: "SwapEndToPresentationCompositorFrame",
      cat: "cc,benchmark,input,input.scrolling",
      ph: "b",
      pid: 22,
      tid: 2,
      ts: 10050,
      id2: { local: "0xa" },
    },
    {
      name: "SwapEndToPresentationCompositorFrame",
      cat: "cc,benchmark,input,input.scrolling",
      ph: "e",
      pid: 22,
      tid: 2,
      ts: 10050,
      id2: { local: "0xa" },
    },
    {
      name: "SubmitCompositorFrameToPresentationCompositorFrame",
      cat: "cc,benchmark,input,input.scrolling",
      ph: "e",
      pid: 22,
      tid: 2,
      ts: 10050,
      id2: { local: "0xa" },
    },
  );

  const analysis = analyzeKnownChromiumTrace(trace, {
    trace: "exact-ids.trace.json",
    dataLossOccurred: false,
  });

  assert.deepEqual(analysis.inputToPresentedFrameSamples, [
    { durationUs: 50, status: "diagnostic-only", reasonCodes: [] },
  ]);
});

test("requires both exact frame IDs from the matched presented reporter", () => {
  const trace = parseTrace(readFixture("exact-ids.trace.json"));
  const reporterBegin = trace.traceEvents.find(
    ({ name, ph }) => name === "PipelineReporter" && ph === "b",
  );
  reporterBegin.args.frame_reporter.display_trace_id -= 1n;

  const analysis = analyzeKnownChromiumTrace(trace, {
    trace: "exact-ids.trace.json",
    dataLossOccurred: false,
  });

  assert.deepEqual(analysis.inputToPresentedFrameSamples, []);
  assert.ok(diagnosticCodes(analysis).has("NO_EXACT_PRESENTED_REPORTER"));
});

test("rejects duplicate presented reporters with the same exact frame IDs", () => {
  const trace = parseTrace(readFixture("exact-ids.trace.json"));
  const reporterBegin = trace.traceEvents.find(
    ({ name, ph }) => name === "PipelineReporter" && ph === "b",
  );
  const reporterEnd = trace.traceEvents.find(
    ({ name, ph }) => name === "PipelineReporter" && ph === "e",
  );
  trace.traceEvents.push(
    {
      ...reporterBegin,
      id2: { local: "0x2" },
      args: { frame_reporter: { ...reporterBegin.args.frame_reporter } },
    },
    { ...reporterEnd, id2: { local: "0x2" } },
  );

  const analysis = analyzeKnownChromiumTrace(trace, {
    trace: "exact-ids.trace.json",
    dataLossOccurred: false,
  });

  assert.deepEqual(analysis.inputToPresentedFrameSamples, []);
  assert.ok(diagnosticCodes(analysis).has("AMBIGUOUS_PRESENTED_REPORTER"));
});

test("does not substitute a nearby frame swap or animation frame marker", () => {
  const trace = parseTrace(readFixture("exact-ids.trace.json"));
  const reporterBegin = trace.traceEvents.find(
    ({ name, ph }) => name === "PipelineReporter" && ph === "b",
  );
  reporterBegin.args.frame_reporter.state = "STATE_NO_UPDATE_DESIRED";

  const analysis = analyzeKnownChromiumTrace(trace, {
    trace: "exact-ids.trace.json",
    dataLossOccurred: false,
  });

  assert.deepEqual(analysis.inputToPresentedFrameSamples, []);
  assert.ok(diagnosticCodes(analysis).has("NO_EXACT_PRESENTED_REPORTER"));
});

test("lossy or unknown trace status keeps an exact sample diagnostic-only", () => {
  for (const dataLossOccurred of [true, undefined]) {
    const analysis = analyzeFixture("exact-ids.trace.json", {
      dataLossOccurred,
    });

    assert.equal(analysis.inputToPresentedFrameSamples.length, 1);
    assert.equal(
      analysis.inputToPresentedFrameSamples[0].status,
      "diagnostic-only",
    );
    assert.deepEqual(analysis.inputToPresentedFrameSamples[0].reasonCodes, [
      dataLossOccurred === true
        ? "TRACE_DATA_LOSS_OCCURRED"
        : "TRACE_DATA_LOSS_UNKNOWN",
    ]);
    assert.equal(analysis.frameIntervals.status, "unavailable");
  }
});

test("reuses local IDs sequentially but rejects other namespaces and cross-scope ends", () => {
  const analysis = analyzeFixture("reused-local-ids.trace.json");
  const codes = diagnosticCodes(analysis);
  const crossScope = analysis.diagnostics.find(
    ({ code }) => code === "UNSUPPORTED_CROSS_SCOPE_ASYNC_PAIR",
  );

  assert.equal(analysis.counts.completedAsyncSlicesByName.EventLatency, 4);
  assert.ok(codes.has("UNSUPPORTED_ID_NAMESPACE"));
  assert.ok(codes.has("UNSUPPORTED_TOP_LEVEL_ID"));
  assert.ok(codes.has("UNSUPPORTED_MULTIPLE_ASYNC_IDS"));
  assert.ok(codes.has("UNSUPPORTED_CROSS_SCOPE_ASYNC_PAIR"));
  assert.ok(codes.has("AMBIGUOUS_ASYNC_SLICE"));
  assert.ok(codes.has("UNTERMINATED_ASYNC_SLICE"));
  assert.ok(codes.has("UNMATCHED_ASYNC_END"));
  assert.equal(crossScope.count, 2);
});

test("rejects malformed numeric identity tokens without rounding them", () => {
  const text = readFixture("exact-ids.trace.json").replace(
    '"event_latency_id": 9223372036854775807',
    '"event_latency_id": 9.223372036854776e18',
  );
  const analysis = analyzeKnownChromiumTrace(parseTrace(text), {
    trace: "exact-ids.trace.json",
    dataLossOccurred: false,
  });

  assert.deepEqual(analysis.inputToPresentedFrameSamples, []);
  assert.ok(diagnosticCodes(analysis).has("MALFORMED_TRACE_ID"));
});

test("diagnoses non-object trace entries without pairing them", () => {
  const analysis = analyzeKnownChromiumTrace(
    parseTrace(JSON.stringify({ traceEvents: [null, "malformed-event"] })),
    { trace: "invalid-events.trace.json", dataLossOccurred: false },
  );

  assert.equal(analysis.counts.eventCount, 2);
  assert.deepEqual(analysis.diagnostics, [
    { code: "INVALID_TRACE_EVENT", count: 2 },
  ]);
  assert.deepEqual(analysis.inputToPresentedFrameSamples, []);
});

test("keeps frame intervals inside declared action segments and streams", () => {
  const events = [
    ...frameReporterEvents({
      pid: 101,
      layerTreeHostId: 7,
      frameSource: 9,
      surfaceId: 101,
      displayId: 201,
      endpoint: 20,
    }),
    ...frameReporterEvents({
      pid: 202,
      layerTreeHostId: 8,
      frameSource: 10,
      surfaceId: 102,
      displayId: 202,
      endpoint: 30,
    }),
    ...frameReporterEvents({
      pid: 101,
      layerTreeHostId: 7,
      frameSource: 9,
      surfaceId: 103,
      displayId: 203,
      endpoint: 40,
    }),
    ...frameReporterEvents({
      pid: 202,
      layerTreeHostId: 8,
      frameSource: 10,
      surfaceId: 104,
      displayId: 204,
      endpoint: 50,
    }),
    ...frameReporterEvents({
      pid: 101,
      layerTreeHostId: 7,
      frameSource: 9,
      surfaceId: 105,
      displayId: 205,
      endpoint: 100,
    }),
    ...frameReporterEvents({
      pid: 101,
      layerTreeHostId: 7,
      frameSource: 9,
      surfaceId: 106,
      displayId: 206,
      endpoint: 110,
    }),
  ];
  const trace = parseTrace(JSON.stringify({ traceEvents: events }));
  const traceRecord = { trace: "frames.trace.json", dataLossOccurred: false };
  const segments = [
    {
      trace: "frames.trace.json",
      action: "scroll",
      startUs: 0,
      endUs: 60,
      rendererPid: 101,
      layerTreeHostId: 7,
      frameSource: 9,
      activeWindows: [{ id: "scroll-one", startUs: 0, endUs: 60 }],
    },
    {
      trace: "frames.trace.json",
      action: "scroll",
      startUs: 0,
      endUs: 60,
      rendererPid: 202,
      layerTreeHostId: 8,
      frameSource: 10,
      activeWindows: [{ id: "scroll-two", startUs: 0, endUs: 60 }],
    },
    {
      trace: "frames.trace.json",
      action: "zoom",
      startUs: 90,
      endUs: 120,
      rendererPid: 101,
      layerTreeHostId: 7,
      frameSource: 9,
      activeWindows: [{ id: "zoom-one", startUs: 90, endUs: 120 }],
    },
  ];
  const analysis = analyzeKnownChromiumTrace(trace, traceRecord, segments);

  assert.deepEqual(analysis.frameIntervals.samples, [
    {
      action: "scroll",
      rendererPid: 101,
      layerTreeHostId: 7,
      frameSource: 9,
      fromEndpointUs: 20,
      toEndpointUs: 40,
      intervalUs: 20,
    },
    {
      action: "scroll",
      rendererPid: 202,
      layerTreeHostId: 8,
      frameSource: 10,
      fromEndpointUs: 30,
      toEndpointUs: 50,
      intervalUs: 20,
    },
    {
      action: "zoom",
      rendererPid: 101,
      layerTreeHostId: 7,
      frameSource: 9,
      fromEndpointUs: 100,
      toEndpointUs: 110,
      intervalUs: 10,
    },
  ]);
  assert.equal(analysis.frameIntervals.status, "diagnostic");
});

test("does not bridge idle gaps between active windows in one action segment", () => {
  const events = [20, 30, 40, 50].flatMap((endpoint, index) =>
    frameReporterEvents({
      pid: 101,
      layerTreeHostId: 7,
      frameSource: 9,
      surfaceId: index + 1,
      displayId: index + 101,
      endpoint,
    }),
  );
  const analysis = analyzeKnownChromiumTrace(
    parseTrace(JSON.stringify({ traceEvents: events })),
    { trace: "frames.trace.json", dataLossOccurred: false },
    [
      {
        trace: "frames.trace.json",
        action: "pan",
        startUs: 0,
        endUs: 60,
        rendererPid: 101,
        layerTreeHostId: 7,
        frameSource: 9,
        activeWindows: [
          { id: "window-one", startUs: 0, endUs: 35 },
          { id: "window-two", startUs: 35, endUs: 60 },
        ],
      },
    ],
  );

  assert.deepEqual(
    analysis.frameIntervals.samples.map(({ fromEndpointUs, toEndpointUs }) => [
      fromEndpointUs,
      toEndpointUs,
    ]),
    [
      [20, 30],
      [40, 50],
    ],
  );
});

test("deduplicates fully identical presented-frame records once", () => {
  const duplicateFrame = frameReporterEvents({
    pid: 101,
    layerTreeHostId: 7,
    frameSource: 9,
    surfaceId: 1,
    displayId: 11,
    endpoint: 20,
    localId: "0x1",
  });
  const trace = parseTrace(
    JSON.stringify({
      traceEvents: [
        ...duplicateFrame,
        ...frameReporterEvents({
          pid: 101,
          layerTreeHostId: 7,
          frameSource: 9,
          surfaceId: 1,
          displayId: 11,
          endpoint: 20,
          localId: "0x2",
        }),
        ...frameReporterEvents({
          pid: 101,
          layerTreeHostId: 7,
          frameSource: 9,
          surfaceId: 2,
          displayId: 12,
          endpoint: 30,
          localId: "0x3",
        }),
      ],
    }),
  );
  const analysis = analyzeKnownChromiumTrace(
    trace,
    { trace: "frames.trace.json", dataLossOccurred: false },
    [
      {
        trace: "frames.trace.json",
        action: "pan",
        startUs: 0,
        endUs: 40,
        rendererPid: 101,
        layerTreeHostId: 7,
        frameSource: 9,
        activeWindows: [{ id: "pan-one", startUs: 0, endUs: 40 }],
        protocolGroupIndex: 0,
        session: 1,
        trial: 1,
      },
    ],
  );

  assert.equal(analysis.frameIntervals.samples.length, 1);
  assert.equal(analysis.frameIntervals.samples[0].intervalUs, 10);
  assert.deepEqual(analysis.frameIntervals.qualifiedProtocolTrials, [
    { protocolGroupIndex: 0, session: 1, trial: 1 },
  ]);
});

test("rejects all linked trials that reuse an exact frame identity across windows", () => {
  const events = [
    ...frameReporterEvents({
      pid: 101,
      layerTreeHostId: 7,
      frameSource: 9,
      surfaceId: 1,
      displayId: 11,
      endpoint: 20,
      localId: "0x1",
    }),
    ...frameReporterEvents({
      pid: 101,
      layerTreeHostId: 7,
      frameSource: 9,
      surfaceId: 1,
      displayId: 11,
      endpoint: 40,
      localId: "0x2",
    }),
  ];
  const analysis = analyzeKnownChromiumTrace(
    parseTrace(JSON.stringify({ traceEvents: events })),
    { trace: "frames.trace.json", dataLossOccurred: false },
    [1, 2].map((trial) => ({
      trace: "frames.trace.json",
      action: "pan",
      startUs: (trial - 1) * 30,
      endUs: trial * 30,
      rendererPid: 101,
      layerTreeHostId: 7,
      frameSource: 9,
      activeWindows: [
        {
          id: `window-${trial}`,
          startUs: (trial - 1) * 30,
          endUs: trial * 30,
        },
      ],
      protocolGroupIndex: 0,
      session: 1,
      trial,
    })),
  );

  assert.deepEqual(analysis.frameIntervals.samples, []);
  assert.deepEqual(analysis.frameIntervals.qualifiedProtocolTrials, []);
  assert.deepEqual(analysis.frameIntervals.unqualifiedProtocolTrials, [
    {
      protocolGroupIndex: 0,
      session: 1,
      trial: 1,
      status: "invalid",
      reason: "AMBIGUOUS_CORRELATION",
    },
    {
      protocolGroupIndex: 0,
      session: 1,
      trial: 2,
      status: "invalid",
      reason: "AMBIGUOUS_CORRELATION",
    },
  ]);
});

test("rejects frame identity reuse across conflicting compositor streams", () => {
  const events = [
    ...frameReporterEvents({
      pid: 101,
      layerTreeHostId: 7,
      frameSource: 9,
      surfaceId: 1,
      displayId: 11,
      endpoint: 20,
      localId: "0x1",
    }),
    ...frameReporterEvents({
      pid: 101,
      layerTreeHostId: 8,
      frameSource: 10,
      surfaceId: 1,
      displayId: 11,
      endpoint: 20,
      localId: "0x2",
    }),
  ];
  const analysis = analyzeKnownChromiumTrace(
    parseTrace(JSON.stringify({ traceEvents: events })),
    { trace: "frames.trace.json", dataLossOccurred: false },
    [
      { trial: 1, layerTreeHostId: 7, frameSource: 9 },
      { trial: 2, layerTreeHostId: 8, frameSource: 10 },
    ].map(({ trial, layerTreeHostId, frameSource }) => ({
      trace: "frames.trace.json",
      action: "pan",
      startUs: 0,
      endUs: 40,
      rendererPid: 101,
      layerTreeHostId,
      frameSource,
      activeWindows: [{ id: `stream-${trial}`, startUs: 0, endUs: 40 }],
      protocolGroupIndex: 0,
      session: 1,
      trial,
    })),
  );

  assert.deepEqual(analysis.frameIntervals.samples, []);
  assert.deepEqual(analysis.frameIntervals.qualifiedProtocolTrials, []);
  assert.deepEqual(analysis.frameIntervals.unqualifiedProtocolTrials, [
    {
      protocolGroupIndex: 0,
      session: 1,
      trial: 1,
      status: "invalid",
      reason: "AMBIGUOUS_CORRELATION",
    },
    {
      protocolGroupIndex: 0,
      session: 1,
      trial: 2,
      status: "invalid",
      reason: "AMBIGUOUS_CORRELATION",
    },
  ]);
});

test("rejects an ambiguous middle frame instead of bridging its neighbors", () => {
  const events = [
    ...frameReporterEvents({
      pid: 101,
      layerTreeHostId: 7,
      frameSource: 9,
      surfaceId: 1,
      displayId: 11,
      endpoint: 10,
      localId: "0x1",
    }),
    ...frameReporterEvents({
      pid: 101,
      layerTreeHostId: 7,
      frameSource: 9,
      surfaceId: 2,
      displayId: 12,
      endpoint: 20,
      localId: "0x2",
    }),
    ...frameReporterEvents({
      pid: 101,
      layerTreeHostId: 7,
      frameSource: 9,
      surfaceId: 2,
      displayId: 12,
      endpoint: 21,
      localId: "0x3",
    }),
    ...frameReporterEvents({
      pid: 101,
      layerTreeHostId: 7,
      frameSource: 9,
      surfaceId: 3,
      displayId: 13,
      endpoint: 30,
      localId: "0x4",
    }),
  ];
  const analysis = analyzeKnownChromiumTrace(
    parseTrace(JSON.stringify({ traceEvents: events })),
    { trace: "frames.trace.json", dataLossOccurred: false },
    [
      {
        trace: "frames.trace.json",
        action: "pan",
        startUs: 0,
        endUs: 40,
        rendererPid: 101,
        layerTreeHostId: 7,
        frameSource: 9,
        activeWindows: [{ id: "pan-one", startUs: 0, endUs: 40 }],
        protocolGroupIndex: 0,
        session: 1,
        trial: 1,
      },
    ],
  );

  assert.deepEqual(analysis.frameIntervals.samples, []);
  assert.deepEqual(analysis.frameIntervals.qualifiedProtocolTrials, []);
  assert.deepEqual(analysis.frameIntervals.unqualifiedProtocolTrials, [
    {
      protocolGroupIndex: 0,
      session: 1,
      trial: 1,
      status: "invalid",
      reason: "AMBIGUOUS_CORRELATION",
    },
  ]);
});

test("does not bridge a presented-frame reporter with a malformed endpoint", () => {
  const malformedReporter = frameReporterEvents({
    pid: 101,
    layerTreeHostId: 7,
    frameSource: 9,
    surfaceId: 2,
    displayId: 12,
    endpoint: 30,
    localId: "0x2",
  });
  malformedReporter[1].ts = null;
  const events = [
    ...frameReporterEvents({
      pid: 101,
      layerTreeHostId: 7,
      frameSource: 9,
      surfaceId: 1,
      displayId: 11,
      endpoint: 10,
      localId: "0x1",
    }),
    ...malformedReporter,
    ...frameReporterEvents({
      pid: 101,
      layerTreeHostId: 7,
      frameSource: 9,
      surfaceId: 3,
      displayId: 13,
      endpoint: 40,
      localId: "0x3",
    }),
  ];
  const analysis = analyzeKnownChromiumTrace(
    parseTrace(JSON.stringify({ traceEvents: events })),
    { trace: "frames.trace.json", dataLossOccurred: false },
    [
      {
        trace: "frames.trace.json",
        action: "pan",
        startUs: 0,
        endUs: 50,
        rendererPid: 101,
        layerTreeHostId: 7,
        frameSource: 9,
        activeWindows: [{ id: "pan-one", startUs: 0, endUs: 50 }],
        protocolGroupIndex: 0,
        session: 1,
        trial: 1,
      },
    ],
  );

  assert.deepEqual(analysis.frameIntervals.samples, []);
  assert.deepEqual(analysis.frameIntervals.qualifiedProtocolTrials, []);
  assert.deepEqual(analysis.frameIntervals.unqualifiedProtocolTrials, [
    {
      protocolGroupIndex: 0,
      session: 1,
      trial: 1,
      status: "invalid",
      reason: "MALFORMED_TRACE",
    },
  ]);
});

test("uses both exact frame IDs when identifying a presented frame", () => {
  const events = [
    ...frameReporterEvents({
      pid: 101,
      layerTreeHostId: 7,
      frameSource: 9,
      surfaceId: 99,
      displayId: 100,
      endpoint: 20,
    }),
    ...frameReporterEvents({
      pid: 101,
      layerTreeHostId: 7,
      frameSource: 9,
      surfaceId: 99,
      displayId: 101,
      endpoint: 30,
    }),
  ];
  const analysis = analyzeKnownChromiumTrace(
    parseTrace(JSON.stringify({ traceEvents: events })),
    { trace: "frames.trace.json", dataLossOccurred: false },
    [
      {
        trace: "frames.trace.json",
        action: "pan",
        startUs: 0,
        endUs: 40,
        rendererPid: 101,
        layerTreeHostId: 7,
        frameSource: 9,
        activeWindows: [{ id: "pan-one", startUs: 0, endUs: 40 }],
      },
    ],
  );

  assert.deepEqual(analysis.frameIntervals.samples, [
    {
      action: "pan",
      rendererPid: 101,
      layerTreeHostId: 7,
      frameSource: 9,
      fromEndpointUs: 20,
      toEndpointUs: 30,
      intervalUs: 10,
    },
  ]);
});

test("rejects noncanonical segment action labels without echoing them", () => {
  const events = [
    ...frameReporterEvents({
      pid: 101,
      layerTreeHostId: 7,
      frameSource: 9,
      surfaceId: 101,
      displayId: 201,
      endpoint: 20,
    }),
    ...frameReporterEvents({
      pid: 101,
      layerTreeHostId: 7,
      frameSource: 9,
      surfaceId: 102,
      displayId: 202,
      endpoint: 30,
    }),
  ];
  const trace = parseTrace(JSON.stringify({ traceEvents: events }));
  const actionLabels = [
    "https://private.example/secret",
    "pan\nTRACE_PRIVATE_CONTROL",
    "TRACE_PRIVATE_CAPTION",
  ];

  for (const action of actionLabels) {
    const analysis = analyzeKnownChromiumTrace(
      trace,
      { trace: "frames.trace.json", dataLossOccurred: false },
      [
        {
          trace: "frames.trace.json",
          action,
          startUs: 0,
          endUs: 40,
          rendererPid: 101,
          layerTreeHostId: 7,
          frameSource: 9,
          activeWindows: [{ id: "pan-one", startUs: 0, endUs: 40 }],
        },
      ],
    );

    assert.deepEqual(analysis.frameIntervals.samples, []);
    assert.ok(
      analysis.frameIntervals.reasonCodes.includes(
        "INVALID_MEASUREMENT_SEGMENT",
      ),
    );
    assert.equal(JSON.stringify(analysis).includes(action), false);
  }
});

test("does not form intervals when the presented stream identity is incomplete", () => {
  const events = [
    ...frameReporterEvents({
      pid: 101,
      layerTreeHostId: 7,
      frameSource: 9,
      surfaceId: 101,
      displayId: 201,
      endpoint: 20,
    }),
    ...frameReporterEvents({
      pid: 101,
      layerTreeHostId: 7,
      frameSource: 9,
      surfaceId: 102,
      displayId: 202,
      endpoint: 30,
    }),
  ];
  delete events[0].args.frame_reporter.frame_source;
  const analysis = analyzeKnownChromiumTrace(
    parseTrace(JSON.stringify({ traceEvents: events })),
    { trace: "frames.trace.json", dataLossOccurred: false },
    [
      {
        trace: "frames.trace.json",
        action: "pan",
        startUs: 0,
        endUs: 40,
        rendererPid: 101,
        layerTreeHostId: 7,
        frameSource: 9,
        activeWindows: [{ id: "pan-one", startUs: 0, endUs: 40 }],
      },
    ],
  );

  assert.deepEqual(analysis.frameIntervals.samples, []);
  assert.ok(
    analysis.frameIntervals.reasonCodes.includes("INCOMPLETE_FRAME_IDENTITY"),
  );
  assert.ok(diagnosticCodes(analysis).has("INCOMPLETE_FRAME_STREAM_IDENTITY"));
});

test("reports no interval series for absent segments or lossy traces", () => {
  const events = [
    ...frameReporterEvents({
      pid: 101,
      layerTreeHostId: 7,
      frameSource: 9,
      surfaceId: 1,
      displayId: 11,
      endpoint: 20,
    }),
    ...frameReporterEvents({
      pid: 101,
      layerTreeHostId: 7,
      frameSource: 9,
      surfaceId: 2,
      displayId: 12,
      endpoint: 30,
    }),
  ];
  const trace = parseTrace(JSON.stringify({ traceEvents: events }));
  const segment = {
    trace: "frames.trace.json",
    action: "pan",
    startUs: 0,
    endUs: 40,
    rendererPid: 101,
    layerTreeHostId: 7,
    frameSource: 9,
    activeWindows: [{ id: "pan-one", startUs: 0, endUs: 40 }],
  };

  const noSegments = analyzeKnownChromiumTrace(trace, {
    trace: "frames.trace.json",
    dataLossOccurred: false,
  });
  const lossy = analyzeKnownChromiumTrace(
    trace,
    { trace: "frames.trace.json", dataLossOccurred: true },
    [segment],
  );

  assert.equal(noSegments.frameIntervals.status, "unavailable");
  assert.deepEqual(noSegments.frameIntervals.samples, []);
  assert.ok(
    noSegments.frameIntervals.reasonCodes.includes("NO_MEASUREMENT_SEGMENT"),
  );
  assert.deepEqual(lossy.frameIntervals.samples, []);
  assert.ok(
    lossy.frameIntervals.reasonCodes.includes("TRACE_DATA_LOSS_OCCURRED"),
  );
});

test("associates version-two API entries through an exact DOM and retained-node mapping", () => {
  for (const apiTarget of [
    { targetToken: observedTargetToken },
    { targetToken: null, targetLabel: null, targetResolution: "unknown" },
  ]) {
    const evidence = makeVersionTwoObserverEvidence({
      records: [observedApiEntry(apiTarget), observedDomEntry()],
    });
    const result = analyzeVersionTwoTrace({ evidence });

    assert.deepEqual(result, {
      status: "diagnostic-only",
      counts: { apiEntries: 1, accepted: 1, rejected: 0 },
      entries: [
        {
          dispatchPhase: "primary",
          actionLabel: "open-primary",
          eventType: "click",
          durationUs: 8,
          processingEndToPresentationUs: 3,
          status: "diagnostic-only",
        },
      ],
      rejectionCounts: [],
      formalActionStatus: "unavailable",
      formalActionSamples: [],
    });
    assert.equal(
      evidence.sidecar.observation.records[0].targetToken,
      apiTarget.targetToken,
    );
    assert.doesNotMatch(
      JSON.stringify(result),
      /d-aaaaaaaa|t-bbbbbbbb|frame-A|loader-A|context-A|nodeId|backendNodeId|processId|startTime|timeStamp/,
    );
  }
});

test("requires exact version-two DOM identity and exact retained backend-node equality", () => {
  const scenarios = [
    {
      name: "DOM timestamp mismatch",
      records: [observedApiEntry(), observedDomEntry({ timeStamp: 10.001 })],
      code: "DOM_COUNTERPART_UNAVAILABLE",
    },
    {
      name: "DOM type mismatch",
      records: [observedApiEntry(), observedDomEntry({ type: "pointerdown" })],
      code: "DOM_COUNTERPART_UNAVAILABLE",
    },
    {
      name: "multiple exact DOM counterparts",
      records: [
        observedApiEntry(),
        observedDomEntry(),
        observedDomEntry({ targetToken: "t-cccccccccccccccccccccccc" }),
      ],
      code: "DOM_COUNTERPART_AMBIGUOUS",
    },
    {
      name: "non-null API target differs from the actual DOM target",
      records: [
        observedApiEntry({ targetToken: "t-cccccccccccccccccccccccc" }),
        observedDomEntry(),
      ],
      code: "TARGET_IDENTITY_MISMATCH",
    },
    {
      name: "retained backend node differs from the legacy node",
      records: [observedApiEntry(), observedDomEntry()],
      retainedOverrides: {
        mappings: [{ targetToken: observedTargetToken, backendNodeId: 312 }],
      },
      code: "RETAINED_NODE_MAPPING_MISMATCH",
    },
    {
      name: "duplicate retained mappings are invalid",
      records: [observedApiEntry(), observedDomEntry()],
      retainedOverrides: {
        mappings: [
          { targetToken: observedTargetToken, backendNodeId: 311 },
          { targetToken: observedTargetToken, backendNodeId: 312 },
        ],
      },
      code: "OBSERVER_EVIDENCE_INVALID",
    },
  ];

  for (const scenario of scenarios) {
    const evidence = makeVersionTwoObserverEvidence({
      records: scenario.records,
      retainedOverrides: scenario.retainedOverrides,
    });
    const result = analyzeVersionTwoTrace({ evidence });
    assertVersionTwoUnavailable(result);
    assert.deepEqual(
      result.rejectionCounts,
      [{ code: scenario.code, count: 1 }],
      scenario.name,
    );
  }

  const wrongDocument = makeVersionTwoObserverEvidence({
    records: [
      observedApiEntry(),
      observedDomEntry({ documentId: "d-cccccccccccccccccccccccc" }),
    ],
  });
  const wrongDocumentResult = analyzeVersionTwoTrace({
    evidence: wrongDocument,
  });
  assertVersionTwoUnavailable(wrongDocumentResult);
  assert.deepEqual(wrongDocumentResult.rejectionCounts, [
    { code: "OBSERVER_EVIDENCE_INVALID", count: 1 },
  ]);
});

test("counts version-two duplicate and malformed contenders before target or action filtering", () => {
  const duplicateApi = makeVersionTwoObserverEvidence({
    records: [
      observedApiEntry(),
      observedApiEntry({ targetToken: "t-cccccccccccccccccccccccc" }),
      observedDomEntry(),
    ],
  });
  const duplicateApiResult = analyzeVersionTwoTrace({ evidence: duplicateApi });
  assertVersionTwoUnavailable(duplicateApiResult);
  assert.deepEqual(duplicateApiResult.rejectionCounts, [
    { code: "API_IDENTITY_AMBIGUOUS", count: 2 },
  ]);

  const duplicateLegacyTrace = makeVersionTwoTrace();
  duplicateLegacyTrace.traceEvents.push({
    ...structuredClone(duplicateLegacyTrace.traceEvents[1]),
    pid: 999,
    tid: 99,
    id: "0xduplicate",
  });
  const duplicateLegacyResult = analyzeVersionTwoTrace({
    trace: duplicateLegacyTrace,
  });
  assertVersionTwoUnavailable(duplicateLegacyResult);
  assert.deepEqual(duplicateLegacyResult.rejectionCounts, [
    { code: "TRACE_IDENTITY_AMBIGUOUS", count: 1 },
  ]);

  const malformedTrace = makeVersionTwoTrace();
  malformedTrace.traceEvents.push({
    name: "EventTiming",
    cat: "devtools.timeline",
    ph: "b",
    pid: 999,
    tid: 99,
    ts: 10001n,
    id: "0xmalformed",
    args: { data: { type: "click" } },
  });
  const malformedResult = analyzeVersionTwoTrace({ trace: malformedTrace });
  assertVersionTwoUnavailable(malformedResult);
  assert.deepEqual(malformedResult.rejectionCounts, [
    { code: "TRACE_CONTENDER_UNCLASSIFIABLE", count: 1 },
  ]);
});

test("requires one initial root-frame renderer PID epoch without later target metadata", () => {
  const duplicateInitialTrace = makeVersionTwoTrace();
  duplicateInitialTrace.traceEvents.splice(
    1,
    0,
    structuredClone(duplicateInitialTrace.traceEvents[0]),
  );
  const initialAfterCandidateTrace = makeVersionTwoTrace();
  const initial = initialAfterCandidateTrace.traceEvents.shift();
  initialAfterCandidateTrace.traceEvents.push(initial);
  const scenarios = [
    {
      name: "missing initial association",
      trace: makeBrave155Trace(),
      code: "TRACE_FRAME_ASSOCIATION_INVALID",
    },
    {
      name: "duplicate initial associations",
      trace: duplicateInitialTrace,
      code: "TRACE_FRAME_ASSOCIATION_INVALID",
    },
    {
      name: "selected frame is not the root-frame association",
      trace: makeVersionTwoTrace({ frame: "other-frame" }),
      code: "TRACE_FRAME_ASSOCIATION_INVALID",
    },
    {
      name: "selected frame entry has a parent",
      trace: makeVersionTwoTrace({
        initialFrames: [
          {
            frame: observedFrameId,
            parent: "parent-frame",
            processId: 101,
          },
        ],
      }),
      code: "TRACE_FRAME_ASSOCIATION_INVALID",
    },
    {
      name: "root-frame process ID is missing",
      trace: makeVersionTwoTrace({
        initialFrames: [{ frame: observedFrameId }],
      }),
      code: "TRACE_FRAME_ASSOCIATION_INVALID",
    },
    {
      name: "initial metadata follows the candidate",
      trace: initialAfterCandidateTrace,
      code: "TRACE_FRAME_ASSOCIATION_INVALID",
    },
    {
      name: "subsequent root ProcessReady invalidates the epoch",
      trace: makeVersionTwoTrace({
        metadataEvents: [
          {
            name: "ProcessReadyInBrowser",
            args: { data: { frame: observedFrameId, processId: 102 } },
          },
        ],
      }),
      code: "TRACE_FRAME_EPOCH_INVALIDATED",
    },
    {
      name: "subsequent root FrameCommitted invalidates the epoch",
      trace: makeVersionTwoTrace({
        metadataEvents: [
          {
            name: "FrameCommittedInBrowser",
            args: { data: { frame: observedFrameId, processId: 101 } },
          },
        ],
      }),
      code: "TRACE_FRAME_EPOCH_INVALIDATED",
    },
    {
      name: "subsequent root FrameDeleted invalidates the epoch",
      trace: makeVersionTwoTrace({
        metadataEvents: [
          {
            name: "FrameDeletedInBrowser",
            args: { data: { frame: observedFrameId } },
          },
        ],
      }),
      code: "TRACE_FRAME_EPOCH_INVALIDATED",
    },
    {
      name: "ambiguous follow-up metadata fails closed",
      trace: makeVersionTwoTrace({
        metadataEvents: [{ name: "FrameDeletedInBrowser", args: { data: {} } }],
      }),
      code: "TRACE_METADATA_INVALID",
    },
    {
      name: "legacy renderer PID differs from the initial epoch",
      trace: makeVersionTwoTrace({ processId: 102 }),
      code: "TRACE_PID_EPOCH_MISMATCH",
    },
    {
      name: "duplicate root frame entries conflict",
      trace: makeVersionTwoTrace({
        initialFrames: [
          { frame: observedFrameId, processId: 101 },
          { frame: observedFrameId, processId: 102 },
        ],
      }),
      code: "TRACE_FRAME_ASSOCIATION_INVALID",
    },
    {
      name: "parent-bearing selected-frame duplicate conflicts with root entry",
      trace: makeVersionTwoTrace({
        initialFrames: [
          { frame: observedFrameId, processId: 101 },
          {
            frame: observedFrameId,
            parent: "parent-frame",
            processId: 102,
          },
        ],
      }),
      code: "TRACE_FRAME_ASSOCIATION_INVALID",
    },
  ];

  for (const scenario of scenarios) {
    const result = analyzeVersionTwoTrace({ trace: scenario.trace });
    assertVersionTwoUnavailable(result);
    assert.deepEqual(
      result.rejectionCounts,
      [{ code: scenario.code, count: 1 }],
      scenario.name,
    );
  }

  const contextMismatch = makeVersionTwoObserverEvidence({
    retainedOverrides: {
      executionContext: {
        uniqueId: "context-B",
        frameId: "other-frame",
        isDefault: true,
      },
    },
  });
  const contextResult = analyzeVersionTwoTrace({ evidence: contextMismatch });
  assertVersionTwoUnavailable(contextResult);
  assert.deepEqual(contextResult.rejectionCounts, [
    { code: "OBSERVER_EVIDENCE_INVALID", count: 1 },
  ]);

  const frameMismatchTrace = makeVersionTwoTrace();
  frameMismatchTrace.traceEvents[1].args.data.frame = "other-frame";
  const frameResult = analyzeVersionTwoTrace({ trace: frameMismatchTrace });
  assertVersionTwoUnavailable(frameResult);
  assert.deepEqual(frameResult.rejectionCounts, [
    { code: "TRACE_FRAME_MISMATCH", count: 1 },
  ]);
});

test("keeps unsupported modalities, trace loss, and incomplete retained cleanup unavailable", () => {
  const unsupported = makeVersionTwoObserverEvidence({
    records: [
      observedApiEntry({ type: "keydown", interactionId: 17 }),
      observedDomEntry({ type: "keydown", phase: "primary" }),
    ],
  });
  const unsupportedResult = analyzeVersionTwoTrace({ evidence: unsupported });
  assertVersionTwoUnavailable(unsupportedResult);

  const traceLoss = makeVersionTwoObserverEvidence({
    traceDataLossOccurred: true,
  });
  const traceLossResult = analyzeVersionTwoTrace({ evidence: traceLoss });
  assertVersionTwoUnavailable(traceLossResult);
  assert.deepEqual(traceLossResult.rejectionCounts, [
    { code: "TRACE_DATA_LOSS_OR_LINK_MISMATCH", count: 1 },
  ]);

  const conflictingCleanup = makeVersionTwoObserverEvidence({
    retainedOverrides: {
      cleanup: {
        windowListenersRemoved: true,
        strongReferencesCleared: true,
        objectGroupReleased: true,
        cdpListenersRemoved: false,
      },
    },
  });
  const conflictingCleanupResult = analyzeVersionTwoTrace({
    evidence: conflictingCleanup,
  });
  assertVersionTwoUnavailable(conflictingCleanupResult);
  assert.deepEqual(conflictingCleanupResult.rejectionCounts, [
    { code: "OBSERVER_EVIDENCE_INVALID", count: 1 },
  ]);

  const unavailableCleanup = makeVersionTwoObserverEvidence({
    retainedOverrides: {
      status: "unavailable",
      reasonCode: "RETAINED_NODE_CLEANUP_FAILED",
      mappings: [],
      lifecycle: {
        coverage: "incomplete",
        lossReasonCode: null,
        overflow: false,
      },
      cleanup: {
        windowListenersRemoved: true,
        strongReferencesCleared: false,
        objectGroupReleased: true,
        cdpListenersRemoved: true,
      },
    },
  });
  const unavailableCleanupResult = analyzeVersionTwoTrace({
    evidence: unavailableCleanup,
  });
  assertVersionTwoUnavailable(unavailableCleanupResult);
  assert.deepEqual(unavailableCleanupResult.rejectionCounts, [
    { code: "RETAINED_NODE_CLEANUP_FAILED", count: 1 },
  ]);
});

test("version-one observer association remains tied to its original schema and hash", () => {
  const evidence = makeObserverEvidence();
  const result = analyzeObservedTrace({ evidence });
  assert.equal(result.status, "diagnostic-only");
  assert.equal(result.counts.accepted, 1);

  const currentVersionOne = makeObserverEvidence({
    sourceHashSha256: currentRetainedCollectorSourceHash,
  });
  assert.equal(
    analyzeObservedTrace({ evidence: currentVersionOne }).counts.accepted,
    1,
  );

  const cleanupVerifiedVersionOne = makeObserverEvidence({
    sourceHashSha256: cleanupVerifiedCollectorSourceHash,
  });
  const cleanupVerifiedResult = analyzeObservedTrace({
    evidence: cleanupVerifiedVersionOne,
  });
  assert.equal(cleanupVerifiedResult.status, "diagnostic-only");
  assert.equal(cleanupVerifiedResult.counts.accepted, 1);
  assert.equal(cleanupVerifiedResult.formalActionStatus, "unavailable");
  assert.deepEqual(cleanupVerifiedResult.formalActionSamples, []);

  const versionTwoLabelOnVersionOneSchema = makeObserverEvidence({
    declarationOverrides: { schemaVersion: 2 },
  });
  const rejected = analyzeObservedTrace({
    evidence: versionTwoLabelOnVersionOneSchema,
  });
  assertVersionTwoUnavailable(rejected);
});

test("version-two observer accepts only registered retention-enabled collector hashes", () => {
  const cleanupVerifiedVersionTwo = makeVersionTwoObserverEvidence({
    sourceHashSha256: cleanupVerifiedCollectorSourceHash,
  });
  const cleanupVerifiedResult = analyzeVersionTwoTrace({
    evidence: cleanupVerifiedVersionTwo,
  });
  assert.equal(cleanupVerifiedResult.status, "diagnostic-only");
  assert.equal(cleanupVerifiedResult.counts.accepted, 1);
  assert.equal(cleanupVerifiedResult.formalActionStatus, "unavailable");
  assert.deepEqual(cleanupVerifiedResult.formalActionSamples, []);

  const beebe32VersionTwo = makeVersionTwoObserverEvidence({
    sourceHashSha256: currentRetainedCollectorSourceHash,
  });
  assert.equal(
    analyzeVersionTwoTrace({ evidence: beebe32VersionTwo }).counts.accepted,
    1,
  );

  const unknownVersionTwo = makeVersionTwoObserverEvidence({
    sourceHashSha256: "0".repeat(64),
  });
  const unknownResult = analyzeVersionTwoTrace({ evidence: unknownVersionTwo });
  assertVersionTwoUnavailable(unknownResult);
  assert.deepEqual(unknownResult.rejectionCounts, [
    { code: "COLLECTOR_SOURCE_HASH_MISMATCH", count: 1 },
  ]);
});

test("run-level cleanup receipt producer hash is accepted only with matching observer schema", () => {
  const sourceHashSha256 = currentCollectorSourceHash();
  const versionOne = makeObserverEvidence({ sourceHashSha256 });
  const versionOneResult = analyzeObservedTrace({ evidence: versionOne });
  assert.equal(versionOneResult.counts.accepted, 1);

  const versionTwo = makeVersionTwoObserverEvidence({ sourceHashSha256 });
  const versionTwoResult = analyzeVersionTwoTrace({ evidence: versionTwo });
  assert.equal(versionTwoResult.counts.accepted, 1);

  const crossedVersionOne = makeObserverEvidence({
    sourceHashSha256,
    declarationOverrides: { schemaVersion: 2 },
  });
  assertVersionTwoUnavailable(
    analyzeObservedTrace({ evidence: crossedVersionOne }),
  );

  const crossedVersionTwo = makeVersionTwoObserverEvidence({
    sourceHashSha256,
    declarationOverrides: { schemaVersion: 1 },
  });
  assertVersionTwoUnavailable(
    analyzeVersionTwoTrace({ evidence: crossedVersionTwo }),
  );
});

test("keeps a secondary open dispatch explicitly separate from the primary action", () => {
  const evidence = makeVersionTwoObserverEvidence({
    records: [
      observedApiEntry({
        targetLabel: "open-secondary",
        deliveryPhase: "secondary",
      }),
      observedDomEntry({ targetLabel: "open-secondary", phase: "secondary" }),
    ],
  });
  const result = analyzeVersionTwoTrace({ evidence });

  assert.equal(result.status, "diagnostic-only");
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].actionLabel, "open-secondary");
  assert.equal(result.entries[0].dispatchPhase, "secondary");
  assert.equal(result.formalActionStatus, "unavailable");
  assert.deepEqual(result.formalActionSamples, []);
});
