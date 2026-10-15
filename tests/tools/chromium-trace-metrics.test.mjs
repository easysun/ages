import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  analyzeTrace,
  nearestRank,
  parseTrace,
} from "../../scripts/chromium-trace-metrics.mjs";

const fixtures = new URL("../fixtures/chromium-traces/", import.meta.url);

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
