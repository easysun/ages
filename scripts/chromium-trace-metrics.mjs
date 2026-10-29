import {
  OBSERVATION_LIMITS,
  RETAINED_NODE_EVIDENCE_POLICY,
  RETAINED_NODE_RECORD_BYTE_LIMIT,
  TRUSTED_STIMULUS_EVIDENCE_CLASS,
  validateInputFrameProvenance,
  validateTrustedStimulusObservation,
} from "./browser-stimulus-observer.mjs";

const MALFORMED_ID = Symbol("malformed-trace-id");
const TRACE_ID_FIELDS = new Set([
  "trace_id",
  "event_latency_id",
  "surface_frame_trace_id",
  "display_trace_id",
]);
const EXACT_INTEGER_FIELDS = new Set([
  ...TRACE_ID_FIELDS,
  "id",
  "local",
  "global",
  "frame",
  "nodeId",
  "node_id",
  "interactionId",
  "interaction_id",
  "interactionOffset",
  "interaction_offset",
  "fallback_time",
  "fallback_time_us",
  "pointer_id",
  "key_code",
]);
const PRECISE_DECIMAL_FIELDS = new Set([
  "ts",
  "timeStamp",
  "processingStart",
  "processingEnd",
]);
const INTEGER_TOKEN = /^-?(?:0|[1-9][0-9]*)$/;
const MOUSE_UP_ID = /^0x[0-9a-f]+$/i;
const DECIMAL_TOKEN = Symbol("trace-decimal-token");
const PRECISE_NUMBER_TOKENS = new WeakMap();
const EVENT_NAMES = new Set([
  "EventLatency",
  "InputLatency::MouseUp",
  "PipelineReporter",
  "SubmitCompositorFrameToPresentationCompositorFrame",
  "SwapEndToPresentationCompositorFrame",
]);
const PRESENTED_STATE = "STATE_PRESENTED_ALL";
const TASK6_ACTIONS = new Set([
  "open",
  "fit-all",
  "pan",
  "zoom",
  "resize",
  "append",
  "scroll",
]);
const NO_UPDATE_STATE = "STATE_NO_UPDATE_DESIRED";
const LEGACY_TO_MODERN_EVENT_TYPES = new Map([
  ["click", "CLICK_EVENT"],
  ["pointerdown", "POINTER_DOWN_EVENT"],
  ["pointerup", "POINTER_UP_EVENT"],
  ["keydown", "KEY_DOWN_EVENT"],
  ["keyup", "KEY_UP_EVENT"],
]);
const MODERN_TO_LEGACY_EVENT_TYPES = new Map(
  [...LEGACY_TO_MODERN_EVENT_TYPES].map(([legacy, modern]) => [modern, legacy]),
);
const LEGACY_EVENT_DATA_FIELDS = new Set([
  "type",
  "frame",
  "nodeId",
  "cancelable",
  "interactionId",
  "interactionOffset",
  "timeStamp",
  "processingStart",
  "processingEnd",
  "duration",
  "commitFinishTime",
  "enqueuedToMainThreadTime",
]);
const MODERN_EVENT_TIMING_FIELDS = new Set([
  "type",
  "frame",
  "node_id",
  "cancelable",
  "interaction_id",
  "interaction_offset",
  "pointer_id",
  "key_code",
  "fallback_time_us",
]);
const MODERN_EVENT_ARGS_FIELDS = new Set([
  "event_timing",
  "fallback_reason",
  "fallback_time",
]);
const SIGNED_INT32_MIN = -(1n << 31n);
const SIGNED_INT32_MAX = (1n << 31n) - 1n;
const UNSIGNED_INT32_MAX = (1n << 32n) - 1n;
const RELATIVE_MICROSECOND_LIMIT = 1n << 40n;
const MAX_SAFE_MICROSECONDS = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_OBSERVED_API_ENTRIES = 512;
const CHROME155_INTERACTION_GROUP_REVISION =
  "5869fe313571d75152b77813cf0a4ee26a4e6df0";
const INTERACTION_GROUP_COUNTER_TYPES = Object.freeze([
  "click",
  "pointerdown",
  "pointerup",
  "keydown",
  "keypress",
  "keyup",
  "input",
]);
const INTERACTION_GROUP_NAVIGATION_TYPES = Object.freeze([
  "navigate",
  "popstate",
  "hashchange",
]);
const INTERACTION_GROUP_SCOPE_LABEL =
  "Chrome 155 source semantics conditional on declared capture and document binding";
const OBSERVER_SOURCE_HASH_LIFECYCLE = Object.freeze({
  originalVersionOne: Object.freeze({
    schemaVersion: 1,
    retainInputNodes: false,
    sha256: "96a969d576f7610b66217294480c444a36205cec69dba66e8dee0b9a820ce8ae",
  }),
  currentVersionOneRetentionDisabled: Object.freeze({
    schemaVersion: 1,
    retainInputNodes: false,
    sha256: "beb2868156bff1fa73389a6c83023aa878397cff9ac9e4df16599982051928a0",
  }),
  currentVersionTwoRetentionEnabled: Object.freeze({
    schemaVersion: 2,
    retainInputNodes: true,
    sha256: "beb2868156bff1fa73389a6c83023aa878397cff9ac9e4df16599982051928a0",
  }),
  cleanupVerifiedVersionOneRetentionDisabled: Object.freeze({
    schemaVersion: 1,
    retainInputNodes: false,
    sha256: "12c0ecc50a541835456367e4c57f8285feb119ad959aad8d0e222b75c06c33ab",
  }),
  cleanupVerifiedVersionTwoRetentionEnabled: Object.freeze({
    schemaVersion: 2,
    retainInputNodes: true,
    sha256: "12c0ecc50a541835456367e4c57f8285feb119ad959aad8d0e222b75c06c33ab",
  }),
  runLevelCleanupReceiptVersionOne: Object.freeze({
    schemaVersion: 1,
    retainInputNodes: false,
    sha256: "8ab4d0f155af00e6b16784873c3bc867b5423696e4d31572a2a3d3ba5af28f28",
  }),
  runLevelCleanupReceiptVersionTwo: Object.freeze({
    schemaVersion: 2,
    retainInputNodes: true,
    sha256: "8ab4d0f155af00e6b16784873c3bc867b5423696e4d31572a2a3d3ba5af28f28",
  }),
  postReviewVersionOneRetentionDisabled: Object.freeze({
    schemaVersion: 1,
    retainInputNodes: false,
    sha256: "1800489f4942aefe4ab642da9350af4177c39c06c44eb29b7ec2ee84a398996a",
  }),
  postReviewVersionTwoRetentionEnabled: Object.freeze({
    schemaVersion: 2,
    retainInputNodes: true,
    sha256: "1800489f4942aefe4ab642da9350af4177c39c06c44eb29b7ec2ee84a398996a",
  }),
  finalReviewedVersionThreeRetentionEnabled: Object.freeze({
    schemaVersion: 3,
    retainInputNodes: true,
    browserProfile: "brave15585",
    sha256: "1800489f4942aefe4ab642da9350af4177c39c06c44eb29b7ec2ee84a398996a",
  }),
});
const VERSION_ONE_OBSERVER_SOURCE_HASHES = new Set([
  OBSERVER_SOURCE_HASH_LIFECYCLE.originalVersionOne.sha256,
  OBSERVER_SOURCE_HASH_LIFECYCLE.currentVersionOneRetentionDisabled.sha256,
  OBSERVER_SOURCE_HASH_LIFECYCLE.cleanupVerifiedVersionOneRetentionDisabled
    .sha256,
  OBSERVER_SOURCE_HASH_LIFECYCLE.runLevelCleanupReceiptVersionOne.sha256,
  OBSERVER_SOURCE_HASH_LIFECYCLE.postReviewVersionOneRetentionDisabled.sha256,
]);
const VERSION_TWO_OBSERVER_SOURCE_HASHES = new Set([
  OBSERVER_SOURCE_HASH_LIFECYCLE.currentVersionTwoRetentionEnabled.sha256,
  OBSERVER_SOURCE_HASH_LIFECYCLE.cleanupVerifiedVersionTwoRetentionEnabled
    .sha256,
  OBSERVER_SOURCE_HASH_LIFECYCLE.runLevelCleanupReceiptVersionTwo.sha256,
  OBSERVER_SOURCE_HASH_LIFECYCLE.postReviewVersionTwoRetentionEnabled.sha256,
]);
const VERSION_THREE_OBSERVER_SOURCE_HASHES = new Set([
  OBSERVER_SOURCE_HASH_LIFECYCLE.finalReviewedVersionThreeRetentionEnabled
    .sha256,
]);
const V3_OBSERVATION_RECORD_BYTE_LIMIT = 256 * 1024 - 36 * 1024 - 80 * 1024;
const OBSERVER_SIDECAR_INPUT_METHOD =
  "Synthetic Playwright stimulus; DOM isTrusted means browser-dispatched only and does not establish human input or physical equivalence.";
const OBSERVER_SIDECAR_INTERPRETATION = {
  eventTiming:
    "PerformanceEventTiming is thresholded at 16 ms and browser-quantized; continuous input is excluded.",
  targets:
    "Target IDs are opaque per-document tokens; unknown, null, and removed targets remain uncertain.",
};
const OBSERVER_MANIFEST_INPUT_METHOD =
  "Synthetic Playwright stimuli against local fixtures; not human input or physical equivalence.";
// Event names mapped by the pinned Chromium EventTiming proto at 43a1951.
const KNOWN_CHROMIUM_EVENT_TIMING_TYPES = new Set([
  "auxclick",
  "beforeinput",
  "click",
  "compositionend",
  "compositionstart",
  "compositionupdate",
  "contextmenu",
  "dblclick",
  "dragend",
  "dragenter",
  "dragleave",
  "dragover",
  "dragstart",
  "drop",
  "gotpointercapture",
  "hashchange",
  "input",
  "keydown",
  "keypress",
  "keyup",
  "mousedown",
  "mouseenter",
  "mouseleave",
  "mouseout",
  "mouseover",
  "mouseup",
  "navigate",
  "pointercancel",
  "pointerdown",
  "pointerenter",
  "pointerleave",
  "pointerout",
  "pointerover",
  "pointerup",
  "popstate",
  "touchcancel",
  "touchend",
  "touchstart",
  "lostpointercapture",
]);
const OBSERVED_API_TO_LEGACY_TYPE = new Map([
  ["click", "click"],
  ["pointerdown", "pointerdown"],
  ["pointerup", "pointerup"],
  ["keydown", "keydown"],
  ["keyup", "keyup"],
]);
const OBSERVED_ACTION_LABELS = new Map([
  ["open-primary", { phase: "primary", action: "open" }],
  ["fit-all", { phase: "primary", action: "fit-all" }],
  ["append-confirm", { phase: "primary", action: "append" }],
  ["open-secondary", { phase: "secondary", action: "open" }],
]);
const CROSSWALK_METHOD_SCOPE = {
  observedBrowserVersion: "153.0.8010.12",
  pinnedSourceRevision: "971a7443b0c9b0a9b2860529b33331b76077ec62",
  evidenceClass: "synthetic-method-pilot",
  vendorPatchIdentity: "unverified",
  navigationDocumentIdentity: "not-inferred",
  originScope: "capture-case + renderer PID + frame",
};
const CROSSWALK_GATE_REASONS = [
  "ACTION_ATTRIBUTION_UNPROVEN",
  "INTERACTION_AGGREGATION_UNPROVEN",
  "BROWSER_SOURCE_COMPLETENESS_UNPROVEN",
  "MODALITY_EQUIVALENCE_UNPROVEN",
  "SYNTHETIC_METHOD_PILOT_ONLY",
  "VENDOR_PATCH_IDENTITY_UNVERIFIED",
  "NAVIGATION_DOCUMENT_IDENTITY_NOT_INFERRED",
];
const BRAVE15585_PROTOCOL_CATALOG_ID =
  "chromium-43a195105613ac83c21d3f14de279f4a045c7da0+v8-d89479ac5446a374c55a35be19b5a23437558d99";
const BRAVE155_METHOD_SCOPE = {
  observedBrowserVersion: "155.0.8059.40",
  pinnedSourceRevision: "cfaadc5a132d78e1828635aa8405a499f3e14864",
  publishedBraveCoreRevision: "b01cdf43be4b4d5559bf7e58229e666e24454f50",
  evidenceClass: "installed-brave-schema-probe",
  vendorPatchIdentity: "unverified",
  navigationDocumentIdentity: "not-inferred",
  originScope: "capture-case + renderer PID + frame",
};
const BRAVE15580_METHOD_SCOPE = {
  observedBrowserVersion: "155.0.8059.80",
  pinnedSourceRevision: "43a195105613ac83c21d3f14de279f4a045c7da0",
  observedBundleRevision: "7bfa200812971b7811541ae6e5b72620abebe3a7",
  evidenceClass: "installed-brave-schema-probe",
  vendorPatchIdentity: "unverified",
  navigationDocumentIdentity: "not-inferred",
  originScope: "capture-case + renderer PID + frame",
};
const BRAVE15585_METHOD_SCOPE = {
  observedBrowserVersion: "155.0.8059.85",
  pinnedSourceRevision: "0e66b94549a8bd85f03fbdf189b752d6e7b63c32",
  observedBundleRevision: "c7357bfd2a76c2467ba1ae62593a81ae92c05205",
  chromiumSourceIdentity: "unverified",
  protocolCatalogCompatibility: {
    protocolCatalogId: BRAVE15585_PROTOCOL_CATALOG_ID,
    comparedChromiumSourceRevision: "43a195105613ac83c21d3f14de279f4a045c7da0",
    basis: "consumed-upstream-files-byte-identical-at-both-pins",
    scope: "diagnostic-only",
  },
  evidenceClass: "installed-brave-schema-probe",
  vendorPatchIdentity: "unverified",
  navigationDocumentIdentity: "not-inferred",
  originScope: "capture-case + renderer PID + frame",
};
const ANDROID_BRAVE15585_METHOD_SCOPE = {
  observedBrowserVersion: "155.0.8059.85",
  platform: "Android",
  observedPackageIdentifier: "com.brave.browser",
  observedPackageVersion: "1.97.59",
  observedRuntimeRevision: "@c7357bfd2a76c2467ba1ae62593a81ae92c0520",
  chromiumSourceIdentity: "unverified",
  protocolCatalogCompatibility:
    BRAVE15585_METHOD_SCOPE.protocolCatalogCompatibility,
  evidenceClass: "installed-android-brave-schema-probe",
  vendorPatchIdentity: "unverified",
  navigationDocumentIdentity: "not-inferred",
  originScope: "capture-case + renderer PID + frame",
};
const BRAVE155_GATE_REASONS = [
  "ACTION_ATTRIBUTION_UNPROVEN",
  "INTERACTION_AGGREGATION_UNPROVEN",
  "BROWSER_SOURCE_COMPLETENESS_UNPROVEN",
  "MODALITY_EQUIVALENCE_UNPROVEN",
  "INSTALLED_BRAVE_SCHEMA_PROBE_ONLY",
  "VENDOR_PATCH_IDENTITY_UNVERIFIED",
  "NAVIGATION_DOCUMENT_IDENTITY_NOT_INFERRED",
];
const ANDROID_BRAVE155_GATE_REASONS = [
  "ACTION_ATTRIBUTION_UNPROVEN",
  "INTERACTION_AGGREGATION_UNPROVEN",
  "BROWSER_SOURCE_COMPLETENESS_UNPROVEN",
  "MODALITY_EQUIVALENCE_UNPROVEN",
  "INSTALLED_ANDROID_BRAVE_SCHEMA_PROBE_ONLY",
  "VENDOR_PATCH_IDENTITY_UNVERIFIED",
  "NAVIGATION_DOCUMENT_IDENTITY_NOT_INFERRED",
];

const BROWSER_SOURCE_PROFILE_UNSUPPORTED = "BROWSER_SOURCE_PROFILE_UNSUPPORTED";
const PLAYWRIGHT_CHROMIUM_PRODUCT = "Playwright Chromium";
const PLAYWRIGHT_RUNTIME_PRODUCT = `Chrome/${CROSSWALK_METHOD_SCOPE.observedBrowserVersion}`;
const BRAVE155_BROWSER_PRODUCT = "Runtime browser observation";
const ANDROID_BRAVE15585_BROWSER_PRODUCT =
  "Runtime Android browser observation";
const BRAVE155_RUNTIME_PRODUCT = "Chrome/155.0.8059.40";
const BRAVE155_USER_AGENT_PRODUCT_VERSION = "155.0.0.0";
const BRAVE155_BUNDLE_REVISION = "b01cdf43be4b4d5559bf7e58229e666e24454f50";
const BRAVE155_RUNTIME_REVISION = "@b01cdf43be4b4d5559bf7e58229e666e24454f5";
const BRAVE155_EXECUTABLE_SHA256 =
  "6099adb0e47d7c12922bb2dca02e2a044b71ae2895c0bbab1717f8660ffb99a7";
const BRAVE15580_RUNTIME_PRODUCT = "Chrome/155.0.8059.80";
const BRAVE15580_BUNDLE_REVISION = "7bfa200812971b7811541ae6e5b72620abebe3a7";
const BRAVE15580_RUNTIME_REVISION = "@7bfa200812971b7811541ae6e5b72620abebe3a";
const BRAVE15580_EXECUTABLE_SHA256 =
  "a17d7d68343726bb2a601ef237b90198bf1bb0133952dc3935435c8fed70d6f5";
const BRAVE15585_RUNTIME_PRODUCT = "Chrome/155.0.8059.85";
const BRAVE15585_BUNDLE_REVISION = "c7357bfd2a76c2467ba1ae62593a81ae92c05205";
const BRAVE15585_RUNTIME_REVISION = "@c7357bfd2a76c2467ba1ae62593a81ae92c0520";
const BRAVE15585_EXECUTABLE_SHA256 =
  "67539969b31e7579456d87ea62d9556f928f9c92af86bb3f43fe33b57d1cfad7";

export function nearestRank(values, percentile) {
  if (
    !Array.isArray(values) ||
    (percentile !== 0.5 && percentile !== 0.95) ||
    values.some((value) => !validTimestamp(value) || value < 0)
  ) {
    throw new TypeError(
      "Nearest-rank input must contain finite nonnegative values.",
    );
  }
  if (values.length === 0) return null;

  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.ceil(percentile * ordered.length) - 1];
}

export function parseTrace(text) {
  if (typeof text !== "string") {
    throw new TypeError("Trace input must be JSON text.");
  }

  const trace = JSON.parse(text, function reviver(key, value, context) {
    if (PRECISE_DECIMAL_FIELDS.has(key)) {
      if (typeof value === "number" && Number.isFinite(value)) {
        return {
          [DECIMAL_TOKEN]: {
            number: value,
            source: context?.source,
          },
        };
      }
      return { [MALFORMED_ID]: true };
    }

    if (EXACT_INTEGER_FIELDS.has(key)) {
      if (
        ["id", "local", "global", "frame"].includes(key) &&
        typeof value === "string" &&
        value.length > 0
      ) {
        return value;
      }
      if (
        typeof value === "number" &&
        typeof context?.source === "string" &&
        INTEGER_TOKEN.test(context.source)
      ) {
        return BigInt(context.source);
      }
      return { [MALFORMED_ID]: true };
    }

    if (value === null || typeof value !== "object") return value;
    const tokens = Object.create(null);
    for (const [childKey, childValue] of Object.entries(value)) {
      if (
        childValue !== null &&
        typeof childValue === "object" &&
        Object.hasOwn(childValue, DECIMAL_TOKEN)
      ) {
        tokens[childKey] = childValue[DECIMAL_TOKEN];
        value[childKey] = childValue[DECIMAL_TOKEN].number;
      }
    }
    if (Object.keys(tokens).length > 0)
      PRECISE_NUMBER_TOKENS.set(value, tokens);
    return value;
  });

  if (
    trace === null ||
    typeof trace !== "object" ||
    !Array.isArray(trace.traceEvents)
  ) {
    throw new TypeError("Trace JSON must contain a traceEvents array.");
  }

  return trace;
}

function isMalformedId(value) {
  return (
    value !== null && typeof value === "object" && value[MALFORMED_ID] === true
  );
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function diagnosticList(counts) {
  return [...counts]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([code, count]) => ({ code, count }));
}

function addDiagnostic(counts, code, count = 1) {
  counts.set(code, (counts.get(code) ?? 0) + count);
}

function validTimestamp(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function getAsyncTrack(event, diagnostics) {
  if (!isRecord(event)) {
    addDiagnostic(diagnostics, "INVALID_TRACE_EVENT");
    return null;
  }

  if (!EVENT_NAMES.has(event.name)) return null;

  if (
    !Number.isInteger(event.pid) ||
    !Number.isInteger(event.tid) ||
    typeof event.cat !== "string" ||
    event.cat.length === 0
  ) {
    addDiagnostic(diagnostics, "MISSING_ASYNC_SCOPE");
    return null;
  }

  if (isRecord(event.id2) && Object.hasOwn(event.id2, "local")) {
    if (
      Object.hasOwn(event.id2, "global") ||
      typeof event.id2.local !== "string" ||
      event.id2.local.length === 0
    ) {
      addDiagnostic(diagnostics, "UNSUPPORTED_ID_NAMESPACE");
      return null;
    }
    if (Object.hasOwn(event, "id")) {
      addDiagnostic(diagnostics, "UNSUPPORTED_MULTIPLE_ASYNC_IDS");
      return null;
    }

    const namespace = "id2.local";
    const identity = event.id2.local;
    return makeTrack(event, namespace, identity);
  }

  if (isRecord(event.id2) && Object.keys(event.id2).length > 0) {
    addDiagnostic(diagnostics, "UNSUPPORTED_ID_NAMESPACE");
    return null;
  }

  if (event.name === "InputLatency::MouseUp" && typeof event.id === "string") {
    if (!MOUSE_UP_ID.test(event.id)) {
      addDiagnostic(diagnostics, "MALFORMED_MOUSEUP_ASYNC_ID");
      return null;
    }

    return makeTrack(event, "input-mouseup-hex", event.id);
  }

  if (Object.hasOwn(event, "id")) {
    addDiagnostic(diagnostics, "UNSUPPORTED_TOP_LEVEL_ID");
    return null;
  }

  addDiagnostic(diagnostics, "MISSING_ASYNC_ID");
  return null;
}

function makeTrack(event, namespace, identity) {
  const scope = {
    pid: event.pid,
    tid: event.tid,
    category: event.cat,
    namespace,
    identity,
  };
  return {
    ...scope,
    key: JSON.stringify([
      scope.pid,
      scope.tid,
      scope.category,
      scope.namespace,
      scope.identity,
    ]),
    migrationKey: JSON.stringify([
      scope.category,
      scope.namespace,
      scope.identity,
    ]),
  };
}

function pairAsyncSlices(traceEvents, diagnostics) {
  const groups = new Map();
  const malformedReporterEvents = [];
  const reporterBegins = [];

  for (const [index, event] of traceEvents.entries()) {
    if (!isRecord(event)) {
      addDiagnostic(diagnostics, "INVALID_TRACE_EVENT");
      continue;
    }
    if (!EVENT_NAMES.has(event.name)) continue;
    if (event.ph !== "b" && event.ph !== "e") continue;

    if (!validTimestamp(event.ts)) {
      addDiagnostic(diagnostics, "MALFORMED_ASYNC_TIMESTAMP");
      if (event.name === "PipelineReporter") {
        const track = getAsyncTrack(event, diagnostics);
        if (track) {
          malformedReporterEvents.push({
            event,
            index,
            trackKey: track.key,
          });
        }
      }
      continue;
    }

    const track = getAsyncTrack(event, diagnostics);
    if (!track) continue;
    if (event.name === "PipelineReporter" && event.ph === "b") {
      reporterBegins.push({ event, index, trackKey: track.key });
    }

    const identity = {
      event,
      index,
      track,
      pairKey: JSON.stringify([track.key, event.name]),
    };
    const group = groups.get(identity.pairKey) ?? [];
    group.push(identity);
    groups.set(identity.pairKey, group);
  }

  const spans = [];
  const unmatchedBegins = [];
  const unmatchedEnds = [];

  for (const group of groups.values()) {
    group.sort((left, right) => {
      if (left.event.ts !== right.event.ts)
        return left.event.ts - right.event.ts;
      return left.index - right.index;
    });

    const pending = [];
    for (const item of group) {
      if (item.event.ph === "b") {
        if (pending.length > 0) {
          for (const span of pending) span.ambiguous = true;
          addDiagnostic(
            diagnostics,
            "AMBIGUOUS_ASYNC_SLICE",
            pending.length + 1,
          );
          item.ambiguous = true;
        }
        pending.push(item);
        continue;
      }

      if (pending.length === 0) {
        unmatchedEnds.push(item);
        addDiagnostic(diagnostics, "UNMATCHED_ASYNC_END");
        continue;
      }

      const begin = pending.pop();
      if (begin.ambiguous) continue;
      spans.push({
        name: begin.event.name,
        begin: begin.event,
        beginIndex: begin.index,
        end: item.event,
        endIndex: item.index,
        track: begin.track,
        trackKey: begin.track.key,
      });
    }

    for (const begin of pending) {
      unmatchedBegins.push(begin);
      addDiagnostic(diagnostics, "UNTERMINATED_ASYNC_SLICE");
    }
  }

  addCrossScopeDiagnostics(unmatchedBegins, unmatchedEnds, diagnostics);
  return { spans, malformedReporterEvents, reporterBegins };
}

function addCrossScopeDiagnostics(unmatchedBegins, unmatchedEnds, diagnostics) {
  const beginGroups = new Map();
  for (const begin of unmatchedBegins) {
    const group = beginGroups.get(begin.track.migrationKey) ?? [];
    group.push(begin);
    beginGroups.set(begin.track.migrationKey, group);
  }

  const reported = new Set();
  for (const end of unmatchedEnds) {
    for (const begin of beginGroups.get(end.track.migrationKey) ?? []) {
      if (
        begin.event.name !== end.event.name ||
        begin.event.ts > end.event.ts ||
        begin.track.key === end.track.key
      ) {
        continue;
      }

      const key = JSON.stringify([
        begin.track.migrationKey,
        begin.track.key,
        end.track.key,
      ]);
      if (reported.has(key)) continue;
      reported.add(key);
      addDiagnostic(diagnostics, "UNSUPPORTED_CROSS_SCOPE_ASYNC_PAIR");
    }
  }
}

function countSpansByName(spans) {
  const counts = new Map();
  for (const span of spans) {
    counts.set(span.name, (counts.get(span.name) ?? 0) + 1);
  }
  return Object.fromEntries(
    [...counts].sort(([left], [right]) => left.localeCompare(right)),
  );
}

function countReporterStates(spans) {
  const counts = new Map();
  for (const span of spans) {
    if (span.name !== "PipelineReporter") continue;
    const state = span.begin.args?.frame_reporter?.state;
    if (typeof state !== "string") continue;
    const safeState =
      state === PRESENTED_STATE || state === NO_UPDATE_STATE ? state : "OTHER";
    counts.set(safeState, (counts.get(safeState) ?? 0) + 1);
  }
  return Object.fromEntries(
    [...counts].sort(([left], [right]) => left.localeCompare(right)),
  );
}

function readTraceId(value, diagnostics, missingCode = "MISSING_TRACE_ID") {
  if (typeof value === "bigint") return value;
  if (isMalformedId(value)) {
    addDiagnostic(diagnostics, "MALFORMED_TRACE_ID");
    return null;
  }
  addDiagnostic(diagnostics, missingCode);
  return null;
}

function readFrameIdPair(args, diagnostics) {
  const surface = readTraceId(
    args?.surface_frame_trace_id,
    diagnostics,
    "MISSING_FRAME_ID",
  );
  const display = readTraceId(
    args?.display_trace_id,
    diagnostics,
    "MISSING_FRAME_ID",
  );
  if (surface === null || display === null) return null;
  return { surface, display };
}

function isContained(parent, child) {
  return (
    compareEventOrder(
      parent.begin,
      parent.beginIndex,
      child.begin,
      child.beginIndex,
    ) <= 0 &&
    compareEventOrder(child.end, child.endIndex, parent.end, parent.endIndex) <=
      0
  );
}

function compareEventOrder(leftEvent, leftIndex, rightEvent, rightIndex) {
  if (leftEvent.ts < rightEvent.ts) return -1;
  if (leftEvent.ts > rightEvent.ts) return 1;
  return leftIndex - rightIndex;
}

function isUniquelyOwnedBy(parent, child, spans, parentName) {
  const owners = spans.filter(
    (candidate) =>
      candidate.name === parentName &&
      candidate.trackKey === child.trackKey &&
      isContained(candidate, child),
  );
  return owners.length === 1 && owners[0] === parent;
}

function hasOwnedStages(eventLatency, spans, diagnostics) {
  const submitSpans = spans.filter(
    (span) =>
      span.name === "SubmitCompositorFrameToPresentationCompositorFrame" &&
      span.trackKey === eventLatency.trackKey &&
      isContained(eventLatency, span),
  );

  if (submitSpans.length !== 1) {
    addDiagnostic(diagnostics, "EVENT_LATENCY_STAGE_OWNERSHIP_MISMATCH");
    return false;
  }

  const submit = submitSpans[0];
  if (!isUniquelyOwnedBy(eventLatency, submit, spans, "EventLatency")) {
    addDiagnostic(diagnostics, "EVENT_LATENCY_STAGE_OWNERSHIP_MISMATCH");
    return false;
  }

  const swapSpans = spans.filter(
    (span) =>
      span.name === "SwapEndToPresentationCompositorFrame" &&
      span.trackKey === eventLatency.trackKey &&
      isContained(submit, span) &&
      isContained(eventLatency, span) &&
      span.end.ts === eventLatency.end.ts,
  );

  if (swapSpans.length !== 1) {
    addDiagnostic(diagnostics, "EVENT_LATENCY_STAGE_OWNERSHIP_MISMATCH");
    return false;
  }

  if (!isUniquelyOwnedBy(submit, swapSpans[0], spans, submit.name)) {
    addDiagnostic(diagnostics, "EVENT_LATENCY_STAGE_OWNERSHIP_MISMATCH");
    return false;
  }

  return true;
}

function findMatchedReporter(eventLatency, spans, diagnostics) {
  const latency = eventLatency.begin.args?.event_latency;
  const eventFrameIds = readFrameIdPair(latency, diagnostics);
  if (!eventFrameIds) return null;

  const presented = [];
  for (const span of spans) {
    if (span.name !== "PipelineReporter") continue;
    const reporter = span.begin.args?.frame_reporter;
    if (!isRecord(reporter)) continue;
    if (reporter.state !== PRESENTED_STATE) continue;

    const reporterFrameIds = readFrameIdPair(reporter, diagnostics);
    if (
      reporterFrameIds &&
      reporterFrameIds.surface === eventFrameIds.surface &&
      reporterFrameIds.display === eventFrameIds.display
    ) {
      presented.push(span);
    }
  }

  if (presented.length === 0) {
    addDiagnostic(diagnostics, "NO_EXACT_PRESENTED_REPORTER");
    return null;
  }
  if (presented.length !== 1) {
    addDiagnostic(diagnostics, "AMBIGUOUS_PRESENTED_REPORTER");
    return null;
  }

  const reporter = presented[0];
  if (reporter.end.ts !== eventLatency.end.ts) {
    addDiagnostic(diagnostics, "REPORTER_ENDPOINT_MISMATCH");
    return null;
  }

  return reporter;
}

function dataLossReason(traceRecord) {
  if (traceRecord?.dataLossOccurred === false) return null;
  if (traceRecord?.dataLossOccurred === true) return "TRACE_DATA_LOSS_OCCURRED";
  return "TRACE_DATA_LOSS_UNKNOWN";
}

function correlateMouseUps(spans, traceRecord, diagnostics) {
  const samples = [];
  const eventLatencies = spans.filter((span) => span.name === "EventLatency");
  const mouseUps = spans.filter(
    (span) => span.name === "InputLatency::MouseUp",
  );

  for (const mouseUp of mouseUps) {
    const traceId = readTraceId(
      mouseUp.begin.args?.chrome_latency_info?.trace_id,
      diagnostics,
    );
    if (traceId === null) continue;

    const matched = [];
    for (const eventLatency of eventLatencies) {
      const latency = eventLatency.begin.args?.event_latency;
      if (!isRecord(latency)) continue;
      const eventLatencyId = readTraceId(latency.event_latency_id, diagnostics);
      if (
        eventLatencyId === traceId &&
        latency.event_type === "MOUSE_RELEASED"
      ) {
        matched.push(eventLatency);
      }
    }

    if (matched.length === 0) {
      addDiagnostic(diagnostics, "NO_EXACT_EVENT_LATENCY_MATCH");
      continue;
    }
    if (matched.length !== 1) {
      addDiagnostic(diagnostics, "AMBIGUOUS_EVENT_LATENCY_MATCH");
      continue;
    }

    const eventLatency = matched[0];
    if (!hasOwnedStages(eventLatency, spans, diagnostics)) continue;
    if (!findMatchedReporter(eventLatency, spans, diagnostics)) continue;

    const durationUs = eventLatency.end.ts - mouseUp.begin.ts;
    if (!Number.isFinite(durationUs) || durationUs <= 0) {
      addDiagnostic(diagnostics, "NONPOSITIVE_INPUT_PRESENTATION_DURATION");
      continue;
    }

    const reason = dataLossReason(traceRecord);
    samples.push({
      durationUs,
      status: "diagnostic-only",
      reasonCodes: reason === null ? [] : [reason],
    });
  }

  return samples;
}

function validSegment(segment, traceName) {
  if (
    !isRecord(segment) ||
    !Array.isArray(segment.activeWindows) ||
    segment.activeWindows.length === 0
  ) {
    return false;
  }

  let previousEnd = -Infinity;
  const windowIds = new Set();
  for (const window of segment.activeWindows) {
    if (
      !isRecord(window) ||
      typeof window.id !== "string" ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(window.id) ||
      !validTimestamp(window.startUs) ||
      !validTimestamp(window.endUs) ||
      window.startUs < segment.startUs ||
      window.endUs > segment.endUs ||
      window.startUs >= window.endUs ||
      window.startUs < previousEnd ||
      windowIds.has(window.id)
    ) {
      return false;
    }
    windowIds.add(window.id);
    previousEnd = window.endUs;
  }

  const hasProtocolReference =
    Object.hasOwn(segment, "protocolGroupIndex") ||
    Object.hasOwn(segment, "session") ||
    Object.hasOwn(segment, "trial");
  const hasCompleteProtocolReference =
    Number.isInteger(segment.protocolGroupIndex) &&
    segment.protocolGroupIndex >= 0 &&
    Number.isInteger(segment.session) &&
    segment.session >= 1 &&
    segment.session <= 3 &&
    Number.isInteger(segment.trial) &&
    segment.trial >= 1 &&
    segment.trial <= 40;

  return (
    segment.trace === traceName &&
    TASK6_ACTIONS.has(segment.action) &&
    validTimestamp(segment.startUs) &&
    validTimestamp(segment.endUs) &&
    segment.startUs < segment.endUs &&
    Number.isInteger(segment.rendererPid) &&
    Number.isInteger(segment.layerTreeHostId) &&
    Number.isInteger(segment.frameSource) &&
    (!hasProtocolReference || hasCompleteProtocolReference)
  );
}

function frameIdentity(span, diagnostics) {
  const reporter = span.begin.args?.frame_reporter;
  if (!isRecord(reporter)) return null;

  const frameIds = readFrameIdPair(reporter, diagnostics);
  if (!frameIds) return null;
  if (
    !Number.isInteger(reporter.layer_tree_host_id) ||
    !Number.isInteger(reporter.frame_source)
  ) {
    addDiagnostic(diagnostics, "INCOMPLETE_FRAME_STREAM_IDENTITY");
    return null;
  }

  return {
    ...frameIds,
    layerTreeHostId: reporter.layer_tree_host_id,
    frameSource: reporter.frame_source,
  };
}

function reporterMatchesStream(reporter, segment) {
  return (
    isRecord(reporter) &&
    reporter.state === PRESENTED_STATE &&
    reporter.layer_tree_host_id === segment.layerTreeHostId &&
    reporter.frame_source === segment.frameSource
  );
}

function malformedReporterAffectsWindow(
  malformedEvent,
  reporterBegins,
  spans,
  segment,
  window,
) {
  const { event, index, trackKey } = malformedEvent;
  if (event.pid !== segment.rendererPid) return false;
  if (event.ph === "b") {
    return reporterMatchesStream(event.args?.frame_reporter, segment);
  }

  return reporterBegins.some((begin) => {
    if (begin.trackKey !== trackKey || begin.index >= index) return false;
    if (
      spans.some(
        (span) =>
          span.name === "PipelineReporter" &&
          span.beginIndex === begin.index &&
          span.endIndex < index,
      )
    ) {
      return false;
    }
    return (
      begin.event.pid === segment.rendererPid &&
      begin.event.ts >= window.startUs &&
      begin.event.ts < window.endUs &&
      reporterMatchesStream(begin.event.args?.frame_reporter, segment)
    );
  });
}

function frameIntervalsFor(
  traceRecord,
  segments,
  spans,
  malformedReporterEvents,
  reporterBegins,
  diagnostics,
) {
  const base = {
    samples: [],
    qualifiedProtocolTrials: [],
    unqualifiedProtocolTrials: [],
  };
  const traceName = traceRecord?.trace;
  const traceSegments = Array.isArray(segments)
    ? segments.filter(
        (segment) => isRecord(segment) && segment.trace === traceName,
      )
    : [];
  const lossReason = dataLossReason(traceRecord);
  if (lossReason !== null) {
    return {
      ...base,
      unqualifiedProtocolTrials: traceSegments
        .filter(
          (segment) =>
            validSegment(segment, traceName) &&
            Number.isInteger(segment.protocolGroupIndex),
        )
        .map((segment) => ({
          protocolGroupIndex: segment.protocolGroupIndex,
          session: segment.session,
          trial: segment.trial,
          status: "invalid",
          reason: "TRACE_DATA_LOSS",
        })),
      status: "unavailable",
      reasonCodes: [lossReason],
    };
  }

  if (traceSegments.length === 0) {
    return {
      ...base,
      status: "unavailable",
      reasonCodes: ["NO_MEASUREMENT_SEGMENT"],
    };
  }

  const reasonCodes = new Set();
  const entriesByFrameId = new Map();
  const incompleteIdentitySpans = [];
  for (const span of spans) {
    if (span.name !== "PipelineReporter") continue;
    const reporter = span.begin.args?.frame_reporter;
    if (!isRecord(reporter) || reporter.state !== PRESENTED_STATE) continue;
    const identity = frameIdentity(span, diagnostics);
    if (!identity) {
      incompleteIdentitySpans.push(span);
      continue;
    }
    if (
      !validTimestamp(span.begin.ts) ||
      !validTimestamp(span.end.ts) ||
      span.end.ts < span.begin.ts
    ) {
      addDiagnostic(diagnostics, "MALFORMED_FRAME_ENDPOINT");
      incompleteIdentitySpans.push(span);
      continue;
    }
    const identityKey = `${identity.surface.toString()}:${identity.display.toString()}`;
    const entry = { identityKey, identity, span };
    const entries = entriesByFrameId.get(identityKey) ?? [];
    entries.push(entry);
    entriesByFrameId.set(identityKey, entries);
  }

  const conflictingFrameIds = new Set();
  for (const [identityKey, entries] of entriesByFrameId) {
    const signatures = new Set(
      entries.map(({ identity, span }) =>
        JSON.stringify([
          span.begin.pid,
          span.end.ts,
          identity.layerTreeHostId,
          identity.frameSource,
          span.begin.args?.frame_reporter?.state,
        ]),
      ),
    );
    if (entries.length > 1) {
      addDiagnostic(
        diagnostics,
        "DUPLICATE_FRAME_IDENTITY",
        entries.length - 1,
      );
    }
    if (signatures.size > 1) conflictingFrameIds.add(identityKey);
  }

  const samples = [];
  const qualifiedProtocolTrials = [];
  const unqualifiedProtocolTrials = [];
  const seenProtocolTrials = new Set();
  const workItems = [];
  const workByContext = new Map();
  const contextsByFrameId = new Map();

  for (const [segmentIndex, segment] of traceSegments.entries()) {
    if (!validSegment(segment, traceName)) {
      addDiagnostic(diagnostics, "INVALID_MEASUREMENT_SEGMENT");
      reasonCodes.add("INVALID_MEASUREMENT_SEGMENT");
      continue;
    }
    let protocolTrial = null;
    if (Number.isInteger(segment.protocolGroupIndex)) {
      const trialKey = `${segment.protocolGroupIndex}:${segment.session}:${segment.trial}`;
      if (seenProtocolTrials.has(trialKey)) {
        addDiagnostic(diagnostics, "DUPLICATE_PROTOCOL_TRIAL_REFERENCE");
        reasonCodes.add("DUPLICATE_PROTOCOL_TRIAL_REFERENCE");
        continue;
      }
      seenProtocolTrials.add(trialKey);
      protocolTrial = {
        protocolGroupIndex: segment.protocolGroupIndex,
        session: segment.session,
        trial: segment.trial,
      };
    }

    const work = { segment, protocolTrial, windows: [], failureReason: null };
    for (const window of segment.activeWindows) {
      const contextKey = `${segmentIndex}:${window.id}`;
      const frames = new Map();
      for (const entries of entriesByFrameId.values()) {
        for (const { identityKey, identity, span } of entries) {
          if (
            span.begin.pid !== segment.rendererPid ||
            span.end.ts < window.startUs ||
            span.end.ts >= window.endUs ||
            identity.layerTreeHostId !== segment.layerTreeHostId ||
            identity.frameSource !== segment.frameSource
          ) {
            continue;
          }
          const frameContexts = contextsByFrameId.get(identityKey) ?? new Set();
          frameContexts.add(contextKey);
          contextsByFrameId.set(identityKey, frameContexts);
          if (conflictingFrameIds.has(identityKey)) {
            work.failureReason = "AMBIGUOUS_CORRELATION";
            reasonCodes.add("DUPLICATE_FRAME_IDENTITY");
            continue;
          }
          if (!frames.has(identityKey)) {
            frames.set(identityKey, {
              identityKey,
              surface: identity.surface,
              display: identity.display,
              endpoint: span.end.ts,
            });
          }
        }
      }

      if (
        incompleteIdentitySpans.some((span) => {
          if (
            span.begin.pid !== segment.rendererPid ||
            span.end.ts < window.startUs ||
            span.end.ts >= window.endUs
          ) {
            return false;
          }
          const reporter = span.begin.args?.frame_reporter;
          return (
            !isRecord(reporter) ||
            !Number.isInteger(reporter.layer_tree_host_id) ||
            !Number.isInteger(reporter.frame_source) ||
            (reporter.layer_tree_host_id === segment.layerTreeHostId &&
              reporter.frame_source === segment.frameSource)
          );
        }) ||
        malformedReporterEvents.some((event) =>
          malformedReporterAffectsWindow(
            event,
            reporterBegins,
            spans,
            segment,
            window,
          ),
        )
      ) {
        work.failureReason = "MALFORMED_TRACE";
        reasonCodes.add("INCOMPLETE_FRAME_IDENTITY");
      }

      const context = { key: contextKey, frames };
      work.windows.push(context);
      workByContext.set(contextKey, work);
    }
    workItems.push(work);
  }

  for (const contexts of contextsByFrameId.values()) {
    if (contexts.size < 2) continue;
    for (const contextKey of contexts) {
      const work = workByContext.get(contextKey);
      if (work) work.failureReason = "AMBIGUOUS_CORRELATION";
    }
    reasonCodes.add("DUPLICATE_FRAME_IDENTITY");
  }

  for (const work of workItems) {
    const { segment, protocolTrial } = work;
    const segmentFrames = work.windows.reduce(
      (total, window) => total + window.frames.size,
      0,
    );
    if (work.failureReason !== null) {
      if (protocolTrial) {
        unqualifiedProtocolTrials.push({
          ...protocolTrial,
          status: "invalid",
          reason: work.failureReason,
        });
      }
      continue;
    }
    if (segmentFrames === 0) {
      reasonCodes.add("NO_ADJACENT_PRESENTED_FRAME");
      if (protocolTrial) {
        unqualifiedProtocolTrials.push({
          ...protocolTrial,
          status: "missing",
          reason: "UNSUPPORTED_INPUT",
        });
      }
      continue;
    }

    if (protocolTrial) qualifiedProtocolTrials.push(protocolTrial);
    for (const window of work.windows) {
      const frames = [...window.frames.values()].sort(
        (left, right) => left.endpoint - right.endpoint,
      );
      for (let index = 1; index < frames.length; index += 1) {
        const previous = frames[index - 1];
        const current = frames[index];
        const intervalUs = current.endpoint - previous.endpoint;
        if (!Number.isFinite(intervalUs) || intervalUs <= 0) {
          addDiagnostic(diagnostics, "NONPOSITIVE_FRAME_INTERVAL");
          reasonCodes.add("NONPOSITIVE_FRAME_INTERVAL");
          continue;
        }
        const sample = {
          action: segment.action,
          rendererPid: segment.rendererPid,
          layerTreeHostId: segment.layerTreeHostId,
          frameSource: segment.frameSource,
          fromEndpointUs: previous.endpoint,
          toEndpointUs: current.endpoint,
          intervalUs,
        };
        if (protocolTrial) {
          sample.protocolGroupIndex = protocolTrial.protocolGroupIndex;
          sample.session = protocolTrial.session;
          sample.trial = protocolTrial.trial;
        }
        samples.push(sample);
      }
    }
    if (
      work.windows.every((window) => {
        const frames = window.frames.size;
        return frames < 2;
      })
    ) {
      reasonCodes.add("NO_ADJACENT_PRESENTED_FRAME");
    }
  }

  return {
    status: samples.length > 0 ? "diagnostic" : "unavailable",
    samples,
    qualifiedProtocolTrials,
    unqualifiedProtocolTrials,
    reasonCodes: [...reasonCodes].sort(),
  };
}

export function eventTimingInventory(trace) {
  const inventory = {
    legacyBeginCount: 0,
    legacyEndCount: 0,
    latencyCategoryEventCount: 0,
    eventProcessingEventCount: 0,
    status: "not-observed",
    reasonCodes: [],
  };

  for (const event of trace.traceEvents) {
    if (!isRecord(event)) continue;
    const categories =
      typeof event.cat === "string" ? event.cat.split(",") : [];
    if (categories.includes("latency")) {
      inventory.latencyCategoryEventCount += 1;
    }
    if (event.name === "EventProcessing") {
      inventory.eventProcessingEventCount += 1;
    }
    if (!categories.includes("devtools.timeline")) continue;
    if (event.name !== "EventTiming") continue;
    if (event.ph === "b") inventory.legacyBeginCount += 1;
    if (event.ph === "e") inventory.legacyEndCount += 1;
  }

  if (inventory.legacyBeginCount + inventory.legacyEndCount > 0) {
    inventory.status = "fallback-unknown";
    inventory.reasonCodes.push("LEGACY_EVENT_TIMING_FALLBACK_UNKNOWN");
  }
  return inventory;
}

function exactDecimalToken(record, key) {
  if (!isRecord(record)) return null;
  return PRECISE_NUMBER_TOKENS.get(record)?.[key] ?? null;
}

function parseDecimalRational(token) {
  if (typeof token !== "string") return null;
  const match = token.match(
    /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/,
  );
  if (!match) return null;

  const [, sign, whole, fraction = "", exponentText = "0"] = match;
  let exponent;
  try {
    exponent = BigInt(exponentText);
  } catch {
    return null;
  }
  const scale = BigInt(fraction.length) - exponent;
  if (scale > 4096n || scale < -4096n) return null;

  let numerator = BigInt(`${whole}${fraction}` || "0");
  if (sign === "-") numerator = -numerator;
  if (scale >= 0n) {
    return { numerator, denominator: 10n ** scale };
  }
  return { numerator: numerator * 10n ** -scale, denominator: 1n };
}

function nearestInteger(numerator, denominator) {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  const absoluteRemainder = remainder < 0n ? -remainder : remainder;
  const comparison = absoluteRemainder * 2n - denominator;
  if (comparison <= 0n) return quotient;
  return quotient + (numerator < 0n ? -1n : 1n);
}

function recoverRelativeMicroseconds(record, key, reject) {
  const token = exactDecimalToken(record, key);
  const number = record?.[key];
  if (
    token === null ||
    typeof token.source !== "string" ||
    typeof number !== "number" ||
    !Number.isFinite(number)
  ) {
    reject("MISSING_EXACT_RELATIVE_TIMESTAMP");
    return null;
  }

  const rational = parseDecimalRational(token.source);
  if (!rational) {
    reject("MALFORMED_RELATIVE_TIMESTAMP");
    return null;
  }

  const nearest = nearestInteger(
    rational.numerator * 1000n,
    rational.denominator,
  );
  const matches = new Set();
  for (const candidate of [nearest - 1n, nearest, nearest + 1n]) {
    const absolute = candidate < 0n ? -candidate : candidate;
    if (
      absolute <= RELATIVE_MICROSECOND_LIMIT &&
      Number(candidate) / 1000 === number
    ) {
      matches.add(candidate);
    }
  }
  if (matches.size === 0) {
    reject("NO_BINARY64_MICROSECOND_PREIMAGE");
    return null;
  }
  if (matches.size !== 1) {
    reject("AMBIGUOUS_BINARY64_MICROSECOND_PREIMAGE");
    return null;
  }
  return matches.values().next().value;
}

function absoluteTraceMicroseconds(event) {
  const token = exactDecimalToken(event, "ts");
  if (
    token === null ||
    typeof token.source !== "string" ||
    !INTEGER_TOKEN.test(token.source)
  ) {
    return null;
  }
  return BigInt(token.source);
}

function exactInteger(value) {
  if (isMalformedId(value)) return null;
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return BigInt(value);
  }
  return null;
}

function identityValue(value) {
  if (typeof value === "string" && value.length > 0) {
    return JSON.stringify(["string", value]);
  }
  const integer = exactInteger(value);
  if (integer !== null && integer >= 0n) {
    return JSON.stringify(["integer", integer.toString()]);
  }
  return null;
}

function frameIdentityValue(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  return JSON.stringify(["string", value]);
}

function typedTrack(event) {
  if (
    !Number.isSafeInteger(event?.pid) ||
    !Number.isSafeInteger(event?.tid) ||
    typeof event?.cat !== "string" ||
    event.cat.length === 0
  ) {
    return null;
  }

  const hasTopLevelId = Object.hasOwn(event, "id");
  const hasId2 = Object.hasOwn(event, "id2");
  if (hasTopLevelId === hasId2) return null;

  let namespace;
  let value;
  if (hasTopLevelId) {
    namespace = "id";
    value = event.id;
  } else {
    if (!isRecord(event.id2)) return null;
    const keys = Object.keys(event.id2);
    if (keys.length !== 1 || !["local", "global"].includes(keys[0])) {
      return null;
    }
    namespace = `id2.${keys[0]}`;
    value = event.id2[keys[0]];
  }

  const encodedValue = identityValue(value);
  if (encodedValue === null) return null;
  return JSON.stringify([
    event.pid,
    event.tid,
    event.cat,
    namespace,
    encodedValue,
  ]);
}

function pairTypedSlices(traceEvents, name, expectedCategory, rejections) {
  const groups = new Map();
  const counts = { beginCount: 0, endCount: 0, markerCount: 0 };
  const incompleteBegins = [];

  for (const [index, event] of traceEvents.entries()) {
    if (!isRecord(event) || event.name !== name) continue;
    if (event.cat !== expectedCategory) {
      rejectEntry(rejections, "UNEXPECTED_TYPED_SLICE_CATEGORY");
      continue;
    }
    if (event.ph === "n") {
      if (name === "EventProcessing") {
        counts.markerCount += 1;
        addDiagnostic(
          rejections,
          isRecord(event.args?.event_timing)
            ? "MODERN_MARKER_NOT_SLICE"
            : "PAYLOAD_FREE_MODERN_MARKER",
        );
      }
      continue;
    }
    if (event.ph !== "b" && event.ph !== "e") {
      addDiagnostic(rejections, "UNSUPPORTED_SLICE_PHASE");
      continue;
    }
    if (event.ph === "b") counts.beginCount += 1;
    else counts.endCount += 1;

    const timestampUs = absoluteTraceMicroseconds(event);
    if (timestampUs === null) {
      addDiagnostic(rejections, "MALFORMED_ABSOLUTE_TIMESTAMP");
      continue;
    }
    const trackKey = typedTrack(event);
    if (trackKey === null) {
      addDiagnostic(rejections, "MISSING_TYPED_TRACK_IDENTITY");
      continue;
    }
    const key = JSON.stringify([name, trackKey]);
    const group = groups.get(key) ?? [];
    group.push({ event, index, trackKey, timestampUs });
    groups.set(key, group);
  }

  const spans = [];
  for (const group of groups.values()) {
    group.sort((left, right) => {
      if (left.timestampUs < right.timestampUs) return -1;
      if (left.timestampUs > right.timestampUs) return 1;
      return left.index - right.index;
    });
    const pending = [];
    for (const item of group) {
      if (item.event.ph === "b") {
        pending.push(item);
        continue;
      }
      const begin = pending.pop();
      if (!begin) {
        addDiagnostic(rejections, "UNMATCHED_TYPED_SLICE_END");
        continue;
      }
      if (item.timestampUs < begin.timestampUs) {
        addDiagnostic(rejections, "NEGATIVE_TYPED_SLICE");
        continue;
      }
      spans.push({
        name,
        begin: begin.event,
        beginIndex: begin.index,
        beginTimestampUs: begin.timestampUs,
        end: item.event,
        endIndex: item.index,
        endTimestampUs: item.timestampUs,
        trackKey: begin.trackKey,
      });
    }
    if (pending.length > 0) {
      addDiagnostic(rejections, "UNTERMINATED_TYPED_SLICE", pending.length);
      incompleteBegins.push(...pending);
    }
  }

  return { spans, incompleteBegins, ...counts };
}

function rejectEntry(rejections, code) {
  addDiagnostic(rejections, code);
}

function hasOnlyFields(record, allowedFields) {
  return Object.keys(record).every((key) => allowedFields.has(key));
}

function hasRequiredFields(record, requiredFields) {
  return requiredFields.every((key) => Object.hasOwn(record, key));
}

function normalizeLegacyInteraction(value, rejections) {
  const integer = exactInteger(value);
  if (integer === null) {
    rejectEntry(rejections, "MALFORMED_LEGACY_INTERACTION");
    return null;
  }
  if (integer < SIGNED_INT32_MIN || integer > SIGNED_INT32_MAX) {
    rejectEntry(rejections, "LEGACY_INTERACTION_OUT_OF_RANGE");
    return null;
  }
  return integer < 0n ? integer + (1n << 32n) : integer;
}

function readModernInteraction(value, rejections) {
  const integer = exactInteger(value);
  if (integer === null) {
    rejectEntry(rejections, "MALFORMED_MODERN_INTERACTION");
    return null;
  }
  if (integer < 0n || integer > UNSIGNED_INT32_MAX) {
    rejectEntry(rejections, "MODERN_INTERACTION_OUT_OF_RANGE");
    return null;
  }
  return integer;
}

function withinBrave155SignedInteractionBounds(values, rejections) {
  let withinBounds = true;
  for (const value of values) {
    const integer = exactInteger(value);
    if (integer !== null && (integer < 0n || integer > SIGNED_INT32_MAX)) {
      rejectEntry(rejections, "BRAVE_SIGNED_IDENTITY_OVERFLOW_UNVERIFIED");
      withinBounds = false;
    }
  }
  return withinBounds;
}

function readNodeId(value, rejections, source) {
  const integer = exactInteger(value);
  if (integer === null || integer < 0n) {
    rejectEntry(rejections, `MALFORMED_${source}_NODE_ID`);
    return null;
  }
  return integer;
}

function isContinuousEventType(type) {
  return [
    "pointermove",
    "wheel",
    "mousemove",
    "touchmove",
    "pointerrawupdate",
    "POINTER_MOVE_EVENT",
    "MOUSE_MOVE_EVENT",
    "MOUSE_WHEEL_EVENT",
    "TOUCH_MOVE_EVENT",
    "POINTER_RAW_UPDATE_EVENT",
  ].includes(type);
}

function legacyCrosswalkEntry(span, captureCase, rejections, profile) {
  const data = span.begin.args?.data;
  if (
    !isRecord(data) ||
    !isRecord(span.begin.args) ||
    !hasOnlyFields(span.begin.args, new Set(["data"]))
  ) {
    rejectEntry(rejections, "MALFORMED_LEGACY_EVENT_DATA");
    return null;
  }
  if (!hasOnlyFields(data, LEGACY_EVENT_DATA_FIELDS)) {
    rejectEntry(rejections, "UNKNOWN_LEGACY_EVENT_FIELD");
    return null;
  }
  const required = [
    "type",
    "frame",
    "nodeId",
    "cancelable",
    "interactionId",
    "interactionOffset",
    "timeStamp",
    "processingStart",
    "processingEnd",
  ];
  if (!hasRequiredFields(data, required)) {
    rejectEntry(rejections, "MISSING_LEGACY_EVENT_FIELD");
    return null;
  }
  if (
    (profile === "brave155" ||
      profile === "brave15580" ||
      profile === "brave15585" ||
      profile === "android-brave15585") &&
    !withinBrave155SignedInteractionBounds(
      [data.interactionId, data.interactionOffset],
      rejections,
    )
  ) {
    return null;
  }

  const frameKey = frameIdentityValue(data.frame);
  const nodeId = readNodeId(data.nodeId, rejections, "LEGACY");
  const interactionId = normalizeLegacyInteraction(
    data.interactionId,
    rejections,
  );
  const interactionOffset = normalizeLegacyInteraction(
    data.interactionOffset,
    rejections,
  );
  if (frameKey === null) rejectEntry(rejections, "MALFORMED_LEGACY_FRAME");
  if (typeof data.type !== "string" || data.type.length === 0) {
    rejectEntry(rejections, "MALFORMED_LEGACY_EVENT_TYPE");
  }
  if (typeof data.cancelable !== "boolean") {
    rejectEntry(rejections, "MALFORMED_LEGACY_CANCELABLE");
  }
  if (
    frameKey === null ||
    nodeId === null ||
    interactionId === null ||
    interactionOffset === null ||
    typeof data.type !== "string" ||
    data.type.length === 0 ||
    typeof data.cancelable !== "boolean"
  ) {
    return null;
  }

  const rejectRelative = (code) => rejectEntry(rejections, code);
  const timeStampUs = recoverRelativeMicroseconds(
    data,
    "timeStamp",
    rejectRelative,
  );
  const processingStartUs = recoverRelativeMicroseconds(
    data,
    "processingStart",
    rejectRelative,
  );
  const processingEndUs = recoverRelativeMicroseconds(
    data,
    "processingEnd",
    rejectRelative,
  );
  if (
    timeStampUs === null ||
    processingStartUs === null ||
    processingEndUs === null
  ) {
    return null;
  }
  if (captureCase === null) {
    rejectEntry(rejections, "CAPTURE_SCOPE_UNAVAILABLE");
    return null;
  }

  const originUs = span.beginTimestampUs - timeStampUs;
  const absoluteProcessingStartUs = originUs + processingStartUs;
  const absoluteProcessingEndUs = originUs + processingEndUs;
  if (
    absoluteProcessingStartUs < span.beginTimestampUs ||
    absoluteProcessingEndUs < absoluteProcessingStartUs ||
    absoluteProcessingEndUs > span.endTimestampUs
  ) {
    rejectEntry(rejections, "INVALID_LEGACY_PROCESSING_INTERVAL");
    return null;
  }
  const modernType = LEGACY_TO_MODERN_EVENT_TYPES.get(data.type) ?? null;
  if (modernType === null) {
    rejectEntry(
      rejections,
      isContinuousEventType(data.type)
        ? "UNSUPPORTED_CONTINUOUS_EVENT_TYPE"
        : "UNSUPPORTED_DISCRETE_EVENT_TYPE",
    );
  }
  return {
    captureCase,
    pid: span.begin.pid,
    tid: span.begin.tid,
    legacyType: data.type,
    modernType,
    frame: data.frame,
    frameKey,
    nodeId,
    cancelable: data.cancelable,
    interactionId,
    interactionOffset,
    originUs,
    processingStartUs: absoluteProcessingStartUs,
    processingEndUs: absoluteProcessingEndUs,
    beginTimestampUs: span.beginTimestampUs,
    endTimestampUs: span.endTimestampUs,
    beginIndex: span.beginIndex,
  };
}

function modernCrosswalkEntry(span, rejections, profile) {
  const args = span.begin.args;
  const timing = args?.event_timing;
  if (!isRecord(args) || !isRecord(timing)) {
    rejectEntry(rejections, "MISSING_MODERN_EVENT_TIMING_PAYLOAD");
    return null;
  }
  if (!hasOnlyFields(args, MODERN_EVENT_ARGS_FIELDS)) {
    rejectEntry(rejections, "UNKNOWN_MODERN_EVENT_FIELD");
    return null;
  }
  if (!hasOnlyFields(timing, MODERN_EVENT_TIMING_FIELDS)) {
    rejectEntry(rejections, "UNKNOWN_MODERN_EVENT_TIMING_FIELD");
    return null;
  }
  const required = [
    "type",
    "frame",
    "node_id",
    "cancelable",
    "interaction_id",
    "interaction_offset",
  ];
  if (!hasRequiredFields(timing, required)) {
    rejectEntry(rejections, "MISSING_MODERN_EVENT_TIMING_FIELD");
    return null;
  }
  if (
    (profile === "brave155" ||
      profile === "brave15580" ||
      profile === "brave15585" ||
      profile === "android-brave15585") &&
    !withinBrave155SignedInteractionBounds(
      [timing.interaction_id, timing.interaction_offset],
      rejections,
    )
  ) {
    return null;
  }

  const frameKey = frameIdentityValue(timing.frame);
  const nodeId = readNodeId(timing.node_id, rejections, "MODERN");
  const interactionId = readModernInteraction(
    timing.interaction_id,
    rejections,
  );
  const interactionOffset = readModernInteraction(
    timing.interaction_offset,
    rejections,
  );
  if (frameKey === null) rejectEntry(rejections, "MALFORMED_MODERN_FRAME");
  if (typeof timing.type !== "string" || timing.type.length === 0) {
    rejectEntry(rejections, "MALFORMED_MODERN_EVENT_TYPE");
  }
  if (typeof timing.cancelable !== "boolean") {
    rejectEntry(rejections, "MALFORMED_MODERN_CANCELABLE");
  }
  for (const optionalKey of ["pointer_id", "key_code"]) {
    if (
      Object.hasOwn(timing, optionalKey) &&
      exactInteger(timing[optionalKey]) === null
    ) {
      rejectEntry(rejections, "MALFORMED_MODERN_OPTIONAL_IDENTITY");
    }
  }
  if (
    frameKey === null ||
    nodeId === null ||
    interactionId === null ||
    interactionOffset === null ||
    typeof timing.type !== "string" ||
    timing.type.length === 0 ||
    typeof timing.cancelable !== "boolean" ||
    ["pointer_id", "key_code"].some(
      (key) => Object.hasOwn(timing, key) && exactInteger(timing[key]) === null,
    )
  ) {
    return null;
  }

  const legacyType = MODERN_TO_LEGACY_EVENT_TYPES.get(timing.type) ?? null;
  if (legacyType === null) {
    rejectEntry(
      rejections,
      isContinuousEventType(timing.type)
        ? "UNSUPPORTED_CONTINUOUS_EVENT_TYPE"
        : "UNSUPPORTED_DISCRETE_EVENT_TYPE",
    );
  }
  const fallbackTime = Object.hasOwn(args, "fallback_time")
    ? exactInteger(args.fallback_time)
    : null;
  const fallbackTimeUs = Object.hasOwn(timing, "fallback_time_us")
    ? exactInteger(timing.fallback_time_us)
    : null;
  const fallbackProven =
    args.fallback_reason === "None" &&
    fallbackTime === 0n &&
    !Object.hasOwn(timing, "fallback_time_us");

  return {
    pid: span.begin.pid,
    tid: span.begin.tid,
    legacyType,
    modernType: timing.type,
    frame: timing.frame,
    frameKey,
    nodeId,
    cancelable: timing.cancelable,
    interactionId,
    interactionOffset,
    processingStartUs: span.beginTimestampUs,
    processingEndUs: span.endTimestampUs,
    fallbackReason: args.fallback_reason,
    fallbackTime,
    fallbackTimeUs,
    hasFallbackTime: Object.hasOwn(args, "fallback_time"),
    hasFallbackTimeUs: Object.hasOwn(timing, "fallback_time_us"),
    fallbackProven,
  };
}

function crosswalkBaseIdentityKey(entry) {
  return JSON.stringify([
    entry.pid,
    entry.tid,
    entry.modernType,
    entry.frameKey,
    entry.nodeId.toString(),
    entry.cancelable,
    entry.interactionId.toString(),
    entry.interactionOffset.toString(),
  ]);
}

function crosswalkIdentityKey(entry) {
  return JSON.stringify([
    crosswalkBaseIdentityKey(entry),
    entry.processingStartUs.toString(),
    entry.processingEndUs.toString(),
  ]);
}

function addToGroups(groups, entry, keyForEntry = crosswalkIdentityKey) {
  const key = keyForEntry(entry);
  const entries = groups.get(key) ?? [];
  entries.push(entry);
  groups.set(key, entries);
}

function toSafeMicroseconds(value) {
  if (value > MAX_SAFE_MICROSECONDS || value < -MAX_SAFE_MICROSECONDS) {
    return null;
  }
  return Number(value);
}

function hasPinnedChromeProductTokens(userAgent, expectedVersion) {
  const versions = [...userAgent.matchAll(/(?:^|\s)Chrome\/([^\s]*)/g)].map(
    ([, version]) => version,
  );
  return (
    versions.length > 0 &&
    versions.every((version) => version === expectedVersion)
  );
}

function supportsPlaywrightChromiumProfile(observations) {
  if (
    !isRecord(observations) ||
    Object.keys(observations).some(
      (key) =>
        !["browser", "browserIdentity", "qualification", "status"].includes(
          key,
        ),
    ) ||
    !isRecord(observations.browser) ||
    Object.keys(observations.browser).some(
      (key) => !["product", "version"].includes(key),
    ) ||
    observations.browser.product !== PLAYWRIGHT_CHROMIUM_PRODUCT ||
    observations.browser.version !==
      CROSSWALK_METHOD_SCOPE.observedBrowserVersion ||
    (observations.status !== undefined &&
      observations.status !== "synthetic-method-pilot") ||
    (observations.qualification !== undefined &&
      observations.qualification !== "synthetic-method-pilot")
  ) {
    return false;
  }

  const identity = observations.browserIdentity;
  if (identity === undefined) return true;
  if (!isRecord(identity)) return false;
  if (
    Object.keys(identity).some(
      (key) => !["runtime", "chromiumSourceIdentity"].includes(key),
    )
  ) {
    return false;
  }
  if (
    identity.chromiumSourceIdentity !== undefined &&
    identity.chromiumSourceIdentity !== "unverified"
  ) {
    return false;
  }

  const runtime = identity.runtime;
  if (runtime === undefined) return true;
  if (!isRecord(runtime)) return false;
  if (
    Object.keys(runtime).some(
      (key) => !["version", "product", "revision", "userAgent"].includes(key),
    ) ||
    (runtime.version !== undefined &&
      runtime.version !== CROSSWALK_METHOD_SCOPE.observedBrowserVersion) ||
    (runtime.product !== undefined &&
      runtime.product !== PLAYWRIGHT_RUNTIME_PRODUCT) ||
    (runtime.revision !== undefined &&
      (typeof runtime.revision !== "string" ||
        runtime.revision.replace(/^@/, "") !==
          CROSSWALK_METHOD_SCOPE.pinnedSourceRevision)) ||
    (runtime.userAgent !== undefined &&
      (typeof runtime.userAgent !== "string" ||
        !hasPinnedChromeProductTokens(
          runtime.userAgent,
          CROSSWALK_METHOD_SCOPE.observedBrowserVersion,
        ) ||
        /brave/i.test(runtime.userAgent)))
  ) {
    return false;
  }

  return true;
}

function supportsBrave155Profile(observations) {
  if (
    !isRecord(observations) ||
    !hasOnlyFields(
      observations,
      new Set(["browser", "browserIdentity", "qualification", "status"]),
    ) ||
    !isRecord(observations.browser) ||
    !hasOnlyFields(observations.browser, new Set(["product", "version"])) ||
    observations.browser.product !== BRAVE155_BROWSER_PRODUCT ||
    observations.browser.version !==
      BRAVE155_METHOD_SCOPE.observedBrowserVersion ||
    observations.qualification !== "installed-brave-schema-probe" ||
    observations.status !== "installed-brave-schema-probe"
  ) {
    return false;
  }

  const identity = observations.browserIdentity;
  if (
    !isRecord(identity) ||
    !hasOnlyFields(
      identity,
      new Set([
        "bundle",
        "executableSha256",
        "runtime",
        "chromiumSourceIdentity",
      ]),
    ) ||
    identity.chromiumSourceIdentity !== "unverified" ||
    identity.executableSha256 !== BRAVE155_EXECUTABLE_SHA256
  ) {
    return false;
  }

  const bundle = identity.bundle;
  if (
    !isRecord(bundle) ||
    !hasOnlyFields(
      bundle,
      new Set(["identifier", "shortVersion", "bundleVersion", "scmRevision"]),
    ) ||
    bundle.identifier !== "com.brave.Browser" ||
    bundle.shortVersion !== "155.1.97.56" ||
    bundle.bundleVersion !== "197.56" ||
    bundle.scmRevision !== BRAVE155_BUNDLE_REVISION
  ) {
    return false;
  }

  const runtime = identity.runtime;
  return (
    isRecord(runtime) &&
    hasOnlyFields(
      runtime,
      new Set(["version", "product", "revision", "userAgent"]),
    ) &&
    runtime.version === BRAVE155_METHOD_SCOPE.observedBrowserVersion &&
    runtime.product === BRAVE155_RUNTIME_PRODUCT &&
    runtime.revision === BRAVE155_RUNTIME_REVISION &&
    typeof runtime.userAgent === "string" &&
    hasPinnedChromeProductTokens(
      runtime.userAgent,
      BRAVE155_USER_AGENT_PRODUCT_VERSION,
    )
  );
}

function supportsBrave15580Profile(observations) {
  if (
    !isRecord(observations) ||
    !hasOnlyFields(
      observations,
      new Set(["browser", "browserIdentity", "qualification", "status"]),
    ) ||
    !isRecord(observations.browser) ||
    !hasOnlyFields(observations.browser, new Set(["product", "version"])) ||
    observations.browser.product !== BRAVE155_BROWSER_PRODUCT ||
    observations.browser.version !==
      BRAVE15580_METHOD_SCOPE.observedBrowserVersion ||
    observations.qualification !== "installed-brave-schema-probe" ||
    observations.status !== "installed-brave-schema-probe"
  ) {
    return false;
  }

  const identity = observations.browserIdentity;
  if (
    !isRecord(identity) ||
    !hasOnlyFields(
      identity,
      new Set([
        "bundle",
        "executableSha256",
        "runtime",
        "chromiumSourceIdentity",
      ]),
    ) ||
    identity.chromiumSourceIdentity !== "unverified" ||
    identity.executableSha256 !== BRAVE15580_EXECUTABLE_SHA256
  ) {
    return false;
  }

  const bundle = identity.bundle;
  if (
    !isRecord(bundle) ||
    !hasOnlyFields(
      bundle,
      new Set(["identifier", "shortVersion", "bundleVersion", "scmRevision"]),
    ) ||
    bundle.identifier !== "com.brave.Browser" ||
    bundle.shortVersion !== "155.1.97.57" ||
    bundle.bundleVersion !== "197.57" ||
    bundle.scmRevision !== BRAVE15580_BUNDLE_REVISION
  ) {
    return false;
  }

  const runtime = identity.runtime;
  return (
    isRecord(runtime) &&
    hasOnlyFields(
      runtime,
      new Set(["version", "product", "revision", "userAgent"]),
    ) &&
    runtime.version === BRAVE15580_METHOD_SCOPE.observedBrowserVersion &&
    runtime.product === BRAVE15580_RUNTIME_PRODUCT &&
    runtime.revision === BRAVE15580_RUNTIME_REVISION &&
    typeof runtime.userAgent === "string" &&
    hasPinnedChromeProductTokens(
      runtime.userAgent,
      BRAVE155_USER_AGENT_PRODUCT_VERSION,
    )
  );
}

function supportsBrave15585Identity(observations) {
  if (
    !isRecord(observations) ||
    !isRecord(observations.browser) ||
    !hasOnlyFields(observations.browser, new Set(["product", "version"])) ||
    observations.browser.product !== BRAVE155_BROWSER_PRODUCT ||
    observations.browser.version !==
      BRAVE15585_METHOD_SCOPE.observedBrowserVersion
  ) {
    return false;
  }

  const identity = observations.browserIdentity;
  if (
    !isRecord(identity) ||
    !hasOnlyFields(
      identity,
      new Set([
        "bundle",
        "executableSha256",
        "runtime",
        "chromiumSourceIdentity",
      ]),
    ) ||
    identity.chromiumSourceIdentity !== "unverified" ||
    identity.executableSha256 !== BRAVE15585_EXECUTABLE_SHA256
  ) {
    return false;
  }

  const bundle = identity.bundle;
  if (
    !isRecord(bundle) ||
    !hasOnlyFields(
      bundle,
      new Set(["identifier", "shortVersion", "bundleVersion", "scmRevision"]),
    ) ||
    bundle.identifier !== "com.brave.Browser" ||
    bundle.shortVersion !== "155.1.97.59" ||
    bundle.bundleVersion !== "197.59" ||
    bundle.scmRevision !== BRAVE15585_BUNDLE_REVISION
  ) {
    return false;
  }

  const runtime = identity.runtime;
  return (
    isRecord(runtime) &&
    hasOnlyFields(
      runtime,
      new Set(["version", "product", "revision", "userAgent"]),
    ) &&
    runtime.version === BRAVE15585_METHOD_SCOPE.observedBrowserVersion &&
    runtime.product === BRAVE15585_RUNTIME_PRODUCT &&
    runtime.revision === BRAVE15585_RUNTIME_REVISION &&
    typeof runtime.userAgent === "string" &&
    hasPinnedChromeProductTokens(
      runtime.userAgent,
      BRAVE155_USER_AGENT_PRODUCT_VERSION,
    )
  );
}

function supportsBrave15585Profile(observations) {
  return (
    isRecord(observations) &&
    hasOnlyFields(
      observations,
      new Set(["browser", "browserIdentity", "qualification", "status"]),
    ) &&
    observations.qualification === "installed-brave-schema-probe" &&
    observations.status === "installed-brave-schema-probe" &&
    supportsBrave15585Identity(observations)
  );
}

function supportsAndroidBrave15585Profile(observations) {
  if (
    !hasExactFields(observations, [
      "browser",
      "browserIdentity",
      "qualification",
      "status",
    ]) ||
    observations.qualification !== "installed-android-brave-schema-probe" ||
    observations.status !== "installed-android-brave-schema-probe" ||
    !hasExactFields(observations.browser, ["product", "version"]) ||
    observations.browser.product !== ANDROID_BRAVE15585_BROWSER_PRODUCT ||
    observations.browser.version !== "155.0.8059.85"
  ) {
    return false;
  }

  const identity = observations.browserIdentity;
  if (
    !hasExactFields(identity, [
      "platform",
      "package",
      "runtime",
      "chromiumSourceIdentity",
    ]) ||
    identity.chromiumSourceIdentity !== "unverified" ||
    !hasExactFields(identity.platform, ["os", "version", "apiLevel"]) ||
    identity.platform.os !== "Android" ||
    identity.platform.version !== "16" ||
    identity.platform.apiLevel !== 36 ||
    !hasExactFields(identity.package, [
      "identifier",
      "versionName",
      "versionCode",
      "minSdk",
      "targetSdk",
      "artifacts",
    ]) ||
    identity.package.identifier !== "com.brave.browser" ||
    identity.package.versionName !== "1.97.59" ||
    identity.package.versionCode !== 429705904 ||
    identity.package.minSdk !== 32 ||
    identity.package.targetSdk !== 37 ||
    !hasExactFields(identity.package.artifacts, [
      "base.apk",
      "split_chrome.apk",
      "split_config.zh.apk",
      "split_on_demand.apk",
    ]) ||
    identity.package.artifacts["base.apk"] !==
      "b5cf4775da7b98b49061d95723d586e6fb88043131db1d940912b214b26a8c33" ||
    identity.package.artifacts["split_chrome.apk"] !==
      "055ae12ddb53aac8c7b6d9064d725111f6ab3e7a390f0b04ce01245697fb39d8" ||
    identity.package.artifacts["split_config.zh.apk"] !==
      "d151e31a957eadb09d11b85d117d8574f334de045cf1e52d7b61c26e407b6f68" ||
    identity.package.artifacts["split_on_demand.apk"] !==
      "4c4d15e114b1e5689f6d48734aa4de960c53b8918d0698b2f632534fcd1cc893" ||
    !hasExactFields(identity.runtime, [
      "version",
      "product",
      "revision",
      "userAgent",
    ]) ||
    identity.runtime.version !== "155.0.8059.85" ||
    identity.runtime.product !== "Chrome/155.0.8059.85" ||
    identity.runtime.revision !== "@c7357bfd2a76c2467ba1ae62593a81ae92c0520" ||
    identity.runtime.userAgent !==
      "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Mobile Safari/537.36"
  ) {
    return false;
  }

  return true;
}

function supportsBrave15585VersionThreeProfile(observations) {
  return (
    isRecord(observations) &&
    hasOnlyFields(
      observations,
      new Set(["browser", "browserIdentity", "status"]),
    ) &&
    !Object.hasOwn(observations, "qualification") &&
    observations.status === "diagnostic-only" &&
    supportsBrave15585Identity(observations)
  );
}

function selectEventTimingCrosswalkProfile(
  observations,
  allowVersionThreeDiagnostic = false,
) {
  if (!isRecord(observations) || !isRecord(observations.browser)) return null;
  if (
    observations.browser.product === PLAYWRIGHT_CHROMIUM_PRODUCT &&
    observations.browser.version ===
      CROSSWALK_METHOD_SCOPE.observedBrowserVersion
  ) {
    return supportsPlaywrightChromiumProfile(observations)
      ? "chromium153"
      : null;
  }
  if (
    observations.browser.product === BRAVE155_BROWSER_PRODUCT &&
    observations.browser.version ===
      BRAVE155_METHOD_SCOPE.observedBrowserVersion
  ) {
    return supportsBrave155Profile(observations) ? "brave155" : null;
  }
  if (
    observations.browser.product === BRAVE155_BROWSER_PRODUCT &&
    observations.browser.version ===
      BRAVE15580_METHOD_SCOPE.observedBrowserVersion
  ) {
    return supportsBrave15580Profile(observations) ? "brave15580" : null;
  }
  if (
    observations.browser.product === BRAVE155_BROWSER_PRODUCT &&
    observations.browser.version ===
      BRAVE15585_METHOD_SCOPE.observedBrowserVersion
  ) {
    if (allowVersionThreeDiagnostic) {
      return supportsBrave15585VersionThreeProfile(observations)
        ? "brave15585"
        : null;
    }
    return supportsBrave15585Profile(observations) ? "brave15585" : null;
  }
  if (
    observations.browser.product === ANDROID_BRAVE15585_BROWSER_PRODUCT &&
    observations.browser.version === "155.0.8059.85"
  ) {
    return allowVersionThreeDiagnostic
      ? null
      : supportsAndroidBrave15585Profile(observations)
        ? "android-brave15585"
        : null;
  }
  return null;
}

function hasExactFields(value, fields) {
  return (
    isRecord(value) &&
    hasOnlyFields(value, new Set(fields)) &&
    hasRequiredFields(value, fields)
  );
}

function observedApiEntryCount(sidecar) {
  const records = sidecar?.observation?.records;
  if (!Array.isArray(records)) return 0;
  return Math.min(
    MAX_OBSERVED_API_ENTRIES,
    records.filter((record) => !isRecord(record) || record.kind !== "dom")
      .length,
  );
}

function rejectedObservedDiscreteInputs(apiEntries, code) {
  const boundedApiEntries = Math.min(
    MAX_OBSERVED_API_ENTRIES,
    Math.max(0, apiEntries),
  );
  return {
    status: "unavailable",
    counts: {
      apiEntries: boundedApiEntries,
      accepted: 0,
      rejected: boundedApiEntries,
    },
    entries: [],
    rejectionCounts:
      boundedApiEntries > 0 ? [{ code, count: boundedApiEntries }] : [],
    formalActionStatus: "unavailable",
    formalActionSamples: [],
  };
}

function validateObservedDiscreteEvidence(
  traceRecord,
  sourceProfile,
  observerEvidence,
) {
  const apiEntries = observedApiEntryCount(observerEvidence?.sidecar);
  const fail = (code) => ({ apiEntries, code });
  if (
    !hasExactFields(observerEvidence, ["declaration", "sidecar", "capture"]) ||
    !hasExactFields(observerEvidence.capture, [
      "sourceHashSha256",
      "caseRecord",
    ])
  ) {
    return fail("OBSERVER_EVIDENCE_INVALID");
  }

  const { declaration, sidecar, capture } = observerEvidence;
  const { caseRecord } = capture;
  if (!VERSION_ONE_OBSERVER_SOURCE_HASHES.has(capture.sourceHashSha256)) {
    return fail("COLLECTOR_SOURCE_HASH_MISMATCH");
  }
  if (
    !isRecord(caseRecord) ||
    typeof caseRecord.fixture !== "string" ||
    caseRecord.fixture.length === 0 ||
    caseRecord.actionStatus !== "completed" ||
    Object.hasOwn(caseRecord, "actionReasonCode") ||
    ![
      caseRecord.measurementStatus === "resolved" &&
        !Object.hasOwn(caseRecord, "measurementReasonCode"),
      caseRecord.measurementStatus === "unavailable" &&
        caseRecord.measurementReasonCode === "FRAME_STREAM_MISSING",
    ].some(Boolean)
  ) {
    return fail("COLLECTOR_LIFECYCLE_INVALID");
  }
  if (
    caseRecord.dataLossOccurred !== false ||
    traceRecord?.dataLossOccurred !== false ||
    traceRecord?.fixture !== caseRecord.fixture ||
    typeof caseRecord.trace !== "string" ||
    caseRecord.trace.length === 0 ||
    caseRecord.trace !== traceRecord?.trace
  ) {
    return fail("TRACE_DATA_LOSS_OR_LINK_MISMATCH");
  }
  if (sourceProfile !== "brave15580") {
    return fail("BROWSER_SOURCE_PROFILE_UNSUPPORTED");
  }

  const manifestDeclarationFields = [
    "evidenceClass",
    "instrumented",
    "qualification",
    "inputMethod",
    "performanceEventTiming",
    "recordLimit",
    "recordByteLimit",
    "sidecarByteLimit",
    "nextPaint",
  ];
  const performanceEventTimingFields = [
    "status",
    "durationThresholdMs",
    "buffered",
    "quantized",
    "continuousInputExcluded",
  ];
  const caseDeclarationFields = [
    "fileName",
    "byteCount",
    "sha256",
    "evidenceClass",
    "status",
    "reasonCode",
    "recordCount",
    "apiStatus",
  ];
  const sidecarFields = [
    "schemaVersion",
    "evidenceClass",
    "instrumented",
    "qualification",
    "fixture",
    "inputMethod",
    "interpretation",
    "observation",
  ];
  const caseDeclaration = caseRecord.trustedStimulusObservation;
  if (
    !hasExactFields(declaration, manifestDeclarationFields) ||
    declaration.evidenceClass !== TRUSTED_STIMULUS_EVIDENCE_CLASS ||
    declaration.instrumented !== true ||
    declaration.qualification !== "diagnostic-only" ||
    declaration.inputMethod !== OBSERVER_MANIFEST_INPUT_METHOD ||
    !hasExactFields(
      declaration.performanceEventTiming,
      performanceEventTimingFields,
    ) ||
    declaration.performanceEventTiming.status !== "thresholded" ||
    declaration.performanceEventTiming.durationThresholdMs !== 16 ||
    declaration.performanceEventTiming.buffered !== false ||
    declaration.performanceEventTiming.quantized !== true ||
    declaration.performanceEventTiming.continuousInputExcluded !== true ||
    declaration.recordLimit !== OBSERVATION_LIMITS.records ||
    declaration.recordByteLimit !== OBSERVATION_LIMITS.recordBytes ||
    declaration.sidecarByteLimit !== OBSERVATION_LIMITS.sidecarBytes ||
    !hasExactFields(declaration.nextPaint, ["status", "reasonCode"]) ||
    declaration.nextPaint.status !== "unproven" ||
    declaration.nextPaint.reasonCode !== "NEXT_PAINT_METHOD_UNPROVEN" ||
    !hasExactFields(caseDeclaration, caseDeclarationFields) ||
    !hasExactFields(sidecar, sidecarFields) ||
    sidecar.schemaVersion !== 1 ||
    sidecar.evidenceClass !== TRUSTED_STIMULUS_EVIDENCE_CLASS ||
    sidecar.instrumented !== true ||
    sidecar.qualification !== "diagnostic-only" ||
    sidecar.fixture !== caseRecord.fixture ||
    sidecar.inputMethod !== OBSERVER_SIDECAR_INPUT_METHOD ||
    !hasExactFields(sidecar.interpretation, ["eventTiming", "targets"]) ||
    sidecar.interpretation.eventTiming !==
      OBSERVER_SIDECAR_INTERPRETATION.eventTiming ||
    sidecar.interpretation.targets !==
      OBSERVER_SIDECAR_INTERPRETATION.targets ||
    caseDeclaration.fileName !== `${caseRecord.fixture}.stimulus.json` ||
    !Number.isSafeInteger(caseDeclaration.byteCount) ||
    caseDeclaration.byteCount < 1 ||
    caseDeclaration.byteCount > OBSERVATION_LIMITS.sidecarBytes ||
    typeof caseDeclaration.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(caseDeclaration.sha256) ||
    caseDeclaration.evidenceClass !== TRUSTED_STIMULUS_EVIDENCE_CLASS
  ) {
    return fail("OBSERVER_EVIDENCE_INVALID");
  }

  const observerPayloadFields = [
    "schemaVersion",
    "status",
    "reasonCode",
    "documentId",
    "apiStatus",
    "apiMetadata",
    "records",
    "recordCount",
    "recordBytes",
    "frameProvenance",
  ];
  if (!hasExactFields(sidecar.observation, observerPayloadFields)) {
    return fail("OBSERVER_EVIDENCE_INVALID");
  }

  let observation;
  let frameProvenance;
  try {
    const { frameProvenance: rawFrameProvenance, ...payload } =
      sidecar.observation;
    observation = validateTrustedStimulusObservation(
      payload,
      payload.documentId,
    );
    frameProvenance = validateInputFrameProvenance(
      rawFrameProvenance,
      observation.documentId,
    );
  } catch {
    return fail("OBSERVER_EVIDENCE_INVALID");
  }

  if (
    caseDeclaration.status !== observation.status ||
    caseDeclaration.reasonCode !== observation.reasonCode ||
    caseDeclaration.recordCount !== observation.recordCount ||
    caseDeclaration.apiStatus !== observation.apiStatus ||
    declaration.performanceEventTiming.status !== observation.apiStatus
  ) {
    return fail("OBSERVER_EVIDENCE_INVALID");
  }
  if (
    frameProvenance.status !== "stable" ||
    frameProvenance.reasonCode !== null ||
    frameProvenance.documentId !== observation.documentId
  ) {
    return fail("FRAME_PROVENANCE_UNSTABLE");
  }
  if (
    observation.status !== "diagnostic" ||
    observation.reasonCode !== null ||
    observation.apiStatus !== "thresholded"
  ) {
    return fail("OBSERVER_NOT_DIAGNOSTIC");
  }

  return {
    apiEntries: observation.records.filter(
      (record) => record.kind === "event-timing",
    ).length,
    apiRecords: observation.records.filter(
      (record) => record.kind === "event-timing",
    ),
    domRecords: observation.records.filter((record) => record.kind === "dom"),
    documentId: observation.documentId,
    frameId: frameProvenance.afterDrain.frameId,
    caseRecord,
  };
}

function validateObservedDiscreteEvidenceVersionTwo(
  traceRecord,
  sourceProfile,
  observerEvidence,
) {
  const apiEntries = observedApiEntryCount(observerEvidence?.sidecar);
  const fail = (code) => ({ apiEntries, code });
  if (
    !hasExactFields(observerEvidence, ["declaration", "sidecar", "capture"]) ||
    !hasExactFields(observerEvidence.capture, [
      "sourceHashSha256",
      "caseRecord",
    ])
  ) {
    return fail("OBSERVER_EVIDENCE_INVALID");
  }

  const { declaration, sidecar, capture } = observerEvidence;
  const { caseRecord } = capture;
  if (!VERSION_TWO_OBSERVER_SOURCE_HASHES.has(capture.sourceHashSha256)) {
    return fail("COLLECTOR_SOURCE_HASH_MISMATCH");
  }
  if (
    !isRecord(caseRecord) ||
    typeof caseRecord.fixture !== "string" ||
    caseRecord.fixture.length === 0 ||
    caseRecord.actionStatus !== "completed" ||
    Object.hasOwn(caseRecord, "actionReasonCode") ||
    ![
      caseRecord.measurementStatus === "resolved" &&
        !Object.hasOwn(caseRecord, "measurementReasonCode"),
      caseRecord.measurementStatus === "unavailable" &&
        caseRecord.measurementReasonCode === "FRAME_STREAM_MISSING",
    ].some(Boolean)
  ) {
    return fail("COLLECTOR_LIFECYCLE_INVALID");
  }
  if (
    caseRecord.dataLossOccurred !== false ||
    traceRecord?.dataLossOccurred !== false ||
    traceRecord?.fixture !== caseRecord.fixture ||
    typeof caseRecord.trace !== "string" ||
    caseRecord.trace.length === 0 ||
    caseRecord.trace !== traceRecord?.trace
  ) {
    return fail("TRACE_DATA_LOSS_OR_LINK_MISMATCH");
  }
  if (sourceProfile !== "brave15580" && sourceProfile !== "brave15585") {
    return fail("BROWSER_SOURCE_PROFILE_UNSUPPORTED");
  }

  const manifestDeclarationFields = [
    "schemaVersion",
    "evidenceClass",
    "instrumented",
    "qualification",
    "inputMethod",
    "performanceEventTiming",
    "recordLimit",
    "recordByteLimit",
    "sidecarByteLimit",
    "retainedNodeEvidence",
    "nextPaint",
  ];
  const caseDeclarationFields = [
    "fileName",
    "byteCount",
    "sha256",
    "evidenceClass",
    "status",
    "reasonCode",
    "recordCount",
    "apiStatus",
  ];
  const sidecarFields = [
    "schemaVersion",
    "evidenceClass",
    "instrumented",
    "qualification",
    "fixture",
    "inputMethod",
    "interpretation",
    "observation",
  ];
  const observerPayloadFields = [
    "schemaVersion",
    "status",
    "reasonCode",
    "documentId",
    "apiStatus",
    "apiMetadata",
    "records",
    "recordCount",
    "recordBytes",
    "frameProvenance",
    "retainedNodeEvidence",
  ];
  const caseDeclaration = caseRecord.trustedStimulusObservation;
  const retainedDeclaration = declaration.retainedNodeEvidence;
  const expectedProtocolCatalogId =
    sourceProfile === "brave15585"
      ? BRAVE15585_PROTOCOL_CATALOG_ID
      : RETAINED_NODE_EVIDENCE_POLICY.protocolCatalogId;
  if (
    !hasExactFields(declaration, manifestDeclarationFields) ||
    declaration.schemaVersion !== 2 ||
    declaration.evidenceClass !== TRUSTED_STIMULUS_EVIDENCE_CLASS ||
    declaration.instrumented !== true ||
    declaration.qualification !== "diagnostic-only" ||
    declaration.inputMethod !== OBSERVER_MANIFEST_INPUT_METHOD ||
    !hasExactFields(declaration.performanceEventTiming, [
      "status",
      "durationThresholdMs",
      "buffered",
      "quantized",
      "continuousInputExcluded",
    ]) ||
    declaration.performanceEventTiming.status !== "thresholded" ||
    declaration.performanceEventTiming.durationThresholdMs !== 16 ||
    declaration.performanceEventTiming.buffered !== false ||
    declaration.performanceEventTiming.quantized !== true ||
    declaration.performanceEventTiming.continuousInputExcluded !== true ||
    declaration.recordLimit !== OBSERVATION_LIMITS.records ||
    declaration.recordByteLimit !== RETAINED_NODE_RECORD_BYTE_LIMIT ||
    declaration.sidecarByteLimit !== OBSERVATION_LIMITS.sidecarBytes ||
    !hasExactFields(retainedDeclaration, [
      "enabled",
      "maxNodes",
      "mappingByteLimit",
      "protocolCatalogId",
    ]) ||
    retainedDeclaration.enabled !== RETAINED_NODE_EVIDENCE_POLICY.enabled ||
    retainedDeclaration.maxNodes !== RETAINED_NODE_EVIDENCE_POLICY.maxNodes ||
    retainedDeclaration.mappingByteLimit !==
      RETAINED_NODE_EVIDENCE_POLICY.mappingByteLimit ||
    retainedDeclaration.protocolCatalogId !== expectedProtocolCatalogId ||
    !hasExactFields(declaration.nextPaint, ["status", "reasonCode"]) ||
    declaration.nextPaint.status !== "unproven" ||
    declaration.nextPaint.reasonCode !== "NEXT_PAINT_METHOD_UNPROVEN" ||
    !hasExactFields(caseDeclaration, caseDeclarationFields) ||
    !hasExactFields(sidecar, sidecarFields) ||
    sidecar.schemaVersion !== 2 ||
    sidecar.evidenceClass !== TRUSTED_STIMULUS_EVIDENCE_CLASS ||
    sidecar.instrumented !== true ||
    sidecar.qualification !== "diagnostic-only" ||
    sidecar.fixture !== caseRecord.fixture ||
    sidecar.inputMethod !== OBSERVER_SIDECAR_INPUT_METHOD ||
    !hasExactFields(sidecar.interpretation, ["eventTiming", "targets"]) ||
    sidecar.interpretation.eventTiming !==
      OBSERVER_SIDECAR_INTERPRETATION.eventTiming ||
    sidecar.interpretation.targets !==
      OBSERVER_SIDECAR_INTERPRETATION.targets ||
    caseDeclaration.fileName !== `${caseRecord.fixture}.stimulus.json` ||
    !Number.isSafeInteger(caseDeclaration.byteCount) ||
    caseDeclaration.byteCount < 1 ||
    caseDeclaration.byteCount > OBSERVATION_LIMITS.sidecarBytes ||
    typeof caseDeclaration.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(caseDeclaration.sha256) ||
    caseDeclaration.evidenceClass !== TRUSTED_STIMULUS_EVIDENCE_CLASS ||
    !hasExactFields(sidecar.observation, observerPayloadFields)
  ) {
    return fail("OBSERVER_EVIDENCE_INVALID");
  }

  let observation;
  let frameProvenance;
  try {
    const { frameProvenance: rawFrameProvenance, ...payload } =
      sidecar.observation;
    observation = validateTrustedStimulusObservation(
      payload,
      payload.documentId,
    );
    frameProvenance = validateInputFrameProvenance(
      rawFrameProvenance,
      observation.documentId,
    );
  } catch {
    return fail("OBSERVER_EVIDENCE_INVALID");
  }

  const retainedNodeEvidence = observation.retainedNodeEvidence;
  if (
    caseDeclaration.status !== observation.status ||
    caseDeclaration.reasonCode !== observation.reasonCode ||
    caseDeclaration.recordCount !== observation.recordCount ||
    caseDeclaration.apiStatus !== observation.apiStatus ||
    declaration.performanceEventTiming.status !== observation.apiStatus
  ) {
    return fail("OBSERVER_EVIDENCE_INVALID");
  }
  if (
    frameProvenance.status !== "stable" ||
    frameProvenance.reasonCode !== null ||
    frameProvenance.documentId !== observation.documentId
  ) {
    return fail("FRAME_PROVENANCE_UNSTABLE");
  }
  if (
    observation.status !== "diagnostic" ||
    observation.reasonCode !== null ||
    observation.apiStatus !== "thresholded"
  ) {
    return fail("OBSERVER_NOT_DIAGNOSTIC");
  }
  if (retainedNodeEvidence.status !== "complete") {
    return fail(
      retainedNodeEvidence.reasonCode ?? "RETAINED_NODE_EVIDENCE_UNAVAILABLE",
    );
  }
  if (
    retainedNodeEvidence.documentId !== observation.documentId ||
    retainedNodeEvidence.executionContext?.frameId !==
      frameProvenance.afterDrain.frameId ||
    retainedNodeEvidence.snapshots.afterDrain?.frameId !==
      frameProvenance.afterDrain.frameId
  ) {
    return fail("RETAINED_NODE_EVIDENCE_INVALID");
  }

  const apiRecords = observation.records.filter(
    (record) => record.kind === "event-timing",
  );
  return {
    apiEntries: apiRecords.length,
    apiRecords,
    domRecords: observation.records.filter((record) => record.kind === "dom"),
    documentId: observation.documentId,
    frameId: frameProvenance.afterDrain.frameId,
    retainedNodeEvidence,
    caseRecord,
  };
}

function validateObservedDiscreteEvidenceVersionThree(
  traceRecord,
  sourceProfile,
  observerEvidence,
) {
  const apiEntries = observedApiEntryCount(observerEvidence?.sidecar);
  const fail = (code) => ({ apiEntries, code });
  if (
    !hasExactFields(observerEvidence, ["declaration", "sidecar", "capture"]) ||
    !hasExactFields(observerEvidence.capture, [
      "sourceHashSha256",
      "caseRecord",
    ])
  ) {
    return fail("OBSERVER_EVIDENCE_INVALID");
  }

  const { declaration, sidecar, capture } = observerEvidence;
  const { caseRecord } = capture;
  if (!VERSION_THREE_OBSERVER_SOURCE_HASHES.has(capture.sourceHashSha256)) {
    return fail("COLLECTOR_SOURCE_HASH_MISMATCH");
  }
  if (
    !isRecord(caseRecord) ||
    caseRecord.fixture !== "100-interactive-open" ||
    caseRecord.trace !== `${caseRecord.fixture}.trace.json` ||
    caseRecord.workload !== "100-interactive" ||
    caseRecord.rowCount !== 100 ||
    caseRecord.action !== "open" ||
    caseRecord.actionStatus !== "completed" ||
    Object.hasOwn(caseRecord, "actionReasonCode") ||
    caseRecord.measurementStatus !== "unavailable" ||
    caseRecord.measurementReasonCode !== "V3_DIAGNOSTIC_ONLY"
  ) {
    return fail("COLLECTOR_LIFECYCLE_INVALID");
  }
  if (
    caseRecord.dataLossOccurred !== false ||
    traceRecord?.dataLossOccurred !== false ||
    traceRecord?.fixture !== caseRecord.fixture ||
    typeof caseRecord.trace !== "string" ||
    caseRecord.trace.length === 0 ||
    caseRecord.trace !== traceRecord?.trace
  ) {
    return fail("TRACE_DATA_LOSS_OR_LINK_MISMATCH");
  }
  if (sourceProfile !== "brave15585") {
    return fail("BROWSER_SOURCE_PROFILE_UNSUPPORTED");
  }

  const manifestDeclarationFields = [
    "schemaVersion",
    "evidenceClass",
    "instrumented",
    "qualification",
    "inputMethod",
    "performanceEventTiming",
    "recordLimit",
    "recordByteLimit",
    "sidecarByteLimit",
    "retainedNodeEvidence",
    "nextPaint",
  ];
  const caseDeclarationFields = [
    "fileName",
    "byteCount",
    "sha256",
    "evidenceClass",
    "status",
    "reasonCode",
    "recordCount",
    "apiStatus",
  ];
  const sidecarFields = [
    "schemaVersion",
    "evidenceClass",
    "instrumented",
    "qualification",
    "fixture",
    "inputMethod",
    "interpretation",
    "observation",
  ];
  const observerPayloadFields = [
    "schemaVersion",
    "status",
    "reasonCode",
    "documentId",
    "apiStatus",
    "apiMetadata",
    "records",
    "recordCount",
    "recordBytes",
    "frameProvenance",
    "retainedNodeEvidence",
    "sameDocumentLoadingWitness",
  ];
  const caseDeclaration = caseRecord.trustedStimulusObservation;
  const retainedDeclaration = declaration.retainedNodeEvidence;
  if (
    !hasExactFields(declaration, manifestDeclarationFields) ||
    declaration.schemaVersion !== 3 ||
    declaration.evidenceClass !== TRUSTED_STIMULUS_EVIDENCE_CLASS ||
    declaration.instrumented !== true ||
    declaration.qualification !== "diagnostic-only" ||
    declaration.inputMethod !== OBSERVER_MANIFEST_INPUT_METHOD ||
    !hasExactFields(declaration.performanceEventTiming, [
      "status",
      "durationThresholdMs",
      "buffered",
      "quantized",
      "continuousInputExcluded",
    ]) ||
    declaration.performanceEventTiming.status !== "thresholded" ||
    declaration.performanceEventTiming.durationThresholdMs !== 16 ||
    declaration.performanceEventTiming.buffered !== false ||
    declaration.performanceEventTiming.quantized !== true ||
    declaration.performanceEventTiming.continuousInputExcluded !== true ||
    declaration.recordLimit !== OBSERVATION_LIMITS.records ||
    declaration.recordByteLimit !== V3_OBSERVATION_RECORD_BYTE_LIMIT ||
    declaration.sidecarByteLimit !== OBSERVATION_LIMITS.sidecarBytes ||
    !hasExactFields(retainedDeclaration, [
      "enabled",
      "maxNodes",
      "mappingByteLimit",
      "protocolCatalogId",
    ]) ||
    retainedDeclaration.enabled !== RETAINED_NODE_EVIDENCE_POLICY.enabled ||
    retainedDeclaration.maxNodes !== RETAINED_NODE_EVIDENCE_POLICY.maxNodes ||
    retainedDeclaration.mappingByteLimit !==
      RETAINED_NODE_EVIDENCE_POLICY.mappingByteLimit ||
    retainedDeclaration.protocolCatalogId !== BRAVE15585_PROTOCOL_CATALOG_ID ||
    !hasExactFields(declaration.nextPaint, ["status", "reasonCode"]) ||
    declaration.nextPaint.status !== "unproven" ||
    declaration.nextPaint.reasonCode !== "NEXT_PAINT_METHOD_UNPROVEN" ||
    !hasExactFields(caseDeclaration, caseDeclarationFields) ||
    !hasExactFields(sidecar, sidecarFields) ||
    sidecar.schemaVersion !== 3 ||
    sidecar.evidenceClass !== TRUSTED_STIMULUS_EVIDENCE_CLASS ||
    sidecar.instrumented !== true ||
    sidecar.qualification !== "diagnostic-only" ||
    sidecar.fixture !== caseRecord.fixture ||
    sidecar.inputMethod !== OBSERVER_SIDECAR_INPUT_METHOD ||
    !hasExactFields(sidecar.interpretation, ["eventTiming", "targets"]) ||
    sidecar.interpretation.eventTiming !==
      OBSERVER_SIDECAR_INTERPRETATION.eventTiming ||
    sidecar.interpretation.targets !==
      OBSERVER_SIDECAR_INTERPRETATION.targets ||
    caseDeclaration.fileName !== `${caseRecord.fixture}.stimulus.json` ||
    !Number.isSafeInteger(caseDeclaration.byteCount) ||
    caseDeclaration.byteCount < 1 ||
    caseDeclaration.byteCount > OBSERVATION_LIMITS.sidecarBytes ||
    typeof caseDeclaration.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(caseDeclaration.sha256) ||
    caseDeclaration.evidenceClass !== TRUSTED_STIMULUS_EVIDENCE_CLASS ||
    !hasExactFields(sidecar.observation, observerPayloadFields)
  ) {
    return fail("OBSERVER_EVIDENCE_INVALID");
  }

  let observation;
  let frameProvenance;
  try {
    const { frameProvenance: rawFrameProvenance, ...payload } =
      sidecar.observation;
    observation = validateTrustedStimulusObservation(
      payload,
      payload.documentId,
    );
    frameProvenance = validateInputFrameProvenance(
      rawFrameProvenance,
      observation.documentId,
    );
  } catch {
    return fail("OBSERVER_EVIDENCE_INVALID");
  }

  const retainedNodeEvidence = observation.retainedNodeEvidence;
  const witness = observation.sameDocumentLoadingWitness;
  if (
    caseDeclaration.status !== observation.status ||
    caseDeclaration.reasonCode !== observation.reasonCode ||
    caseDeclaration.recordCount !== observation.recordCount ||
    caseDeclaration.apiStatus !== observation.apiStatus ||
    declaration.performanceEventTiming.status !== observation.apiStatus
  ) {
    return fail("OBSERVER_EVIDENCE_INVALID");
  }
  if (
    frameProvenance.status !== "stable" ||
    frameProvenance.reasonCode !== null ||
    frameProvenance.documentId !== observation.documentId
  ) {
    return fail("FRAME_PROVENANCE_UNSTABLE");
  }
  if (
    observation.schemaVersion !== 3 ||
    observation.status !== "diagnostic" ||
    observation.reasonCode !== null ||
    observation.apiStatus !== "thresholded"
  ) {
    return fail("OBSERVER_NOT_DIAGNOSTIC");
  }
  if (retainedNodeEvidence.status !== "complete") {
    return fail(
      retainedNodeEvidence.reasonCode ?? "RETAINED_NODE_EVIDENCE_UNAVAILABLE",
    );
  }
  if (
    retainedNodeEvidence.documentId !== observation.documentId ||
    retainedNodeEvidence.executionContext?.isDefault !== true ||
    retainedNodeEvidence.executionContext?.frameId !==
      frameProvenance.afterDrain.frameId ||
    retainedNodeEvidence.snapshots.afterDrain?.frameId !==
      frameProvenance.afterDrain.frameId ||
    retainedNodeEvidence.snapshots.afterDrain?.loaderId !==
      frameProvenance.afterDrain.loaderId
  ) {
    return fail("RETAINED_NODE_EVIDENCE_INVALID");
  }
  if (
    witness.status !== "complete" ||
    witness.reasonCode !== null ||
    witness.firstInvalidation !== null ||
    witness.droppedCount !== 0 ||
    witness.overflow !== false ||
    witness.orderingBasis !== "cdp-receipt" ||
    witness.sourceOrder !== "unknown" ||
    Object.values(witness.collectorCleanup).some((value) => value !== true)
  ) {
    return fail(witness.reasonCode ?? "RETAINED_NODE_EVIDENCE_UNAVAILABLE");
  }
  const loadingEvents = witness.events.filter(
    (event) => event.method === "Page.frameStartedLoading",
  );
  const historyEvents = witness.events.filter(
    (event) => event.method === "Page.navigatedWithinDocument",
  );
  const rootSnapshot = retainedNodeEvidence.snapshots.beforeArm;
  if (
    witness.protocolCatalogId !== BRAVE15585_PROTOCOL_CATALOG_ID ||
    witness.loadingCount !== 1 ||
    witness.historyApiCount !== 1 ||
    loadingEvents.length !== 1 ||
    historyEvents.length !== 1 ||
    loadingEvents[0].phase !== "primary-action" ||
    !["primary-action", "route-ready"].includes(historyEvents[0].phase) ||
    loadingEvents[0].sequence >= historyEvents[0].sequence ||
    loadingEvents[0].frameId !== historyEvents[0].frameId ||
    loadingEvents[0].frameId !== rootSnapshot.frameId ||
    historyEvents[0].navigationType !== "historyApi"
  ) {
    return fail("RETAINED_NODE_TRACE_ASSOCIATION_INVALID");
  }
  if (
    witness.events.some(
      (event) =>
        !(
          event.method === "Page.frameStartedLoading" ||
          event.method === "Page.navigatedWithinDocument" ||
          (event.method === "Runtime.executionContextCreated" &&
            event.phase === "baseline" &&
            event.source === "page" &&
            event.frameId === rootSnapshot.frameId &&
            event.contextUniqueId ===
              retainedNodeEvidence.executionContext.uniqueId &&
            event.isDefault === true)
        ) ||
        (Object.hasOwn(event, "frameId") &&
          event.frameId !== rootSnapshot.frameId),
    )
  ) {
    return fail("RETAINED_NODE_TRACE_ASSOCIATION_INVALID");
  }

  const apiRecords = observation.records.filter(
    (record) => record.kind === "event-timing",
  );
  const primaryClickRecords = observation.records
    .map((record, index) => ({ record, index }))
    .filter(
      ({ record }) =>
        record.kind === "dom" &&
        record.type === "click" &&
        record.phase === "primary" &&
        record.isTrusted === true,
    );
  const proof = witness.retainedTargetProof;
  if (apiRecords.length !== 1) {
    return fail("API_IDENTITY_AMBIGUOUS");
  }
  const apiRecord = apiRecords[0];
  const interactionId = Number.isSafeInteger(apiRecord.interactionId)
    ? BigInt(apiRecord.interactionId)
    : null;
  if (
    apiRecord.type !== "click" ||
    interactionId === null ||
    interactionId <= 0n ||
    interactionId > SIGNED_INT32_MAX
  ) {
    return fail("API_INTERACTION_ID_INVALID");
  }
  if (!proof || primaryClickRecords.length !== 1) {
    return fail("RETAINED_TARGET_PROOF_INVALID");
  }
  const { record: domRecord, index: domRecordIndex } = primaryClickRecords[0];
  if (
    proof.sourceRecordIndex !== domRecordIndex ||
    proof.documentId !== observation.documentId ||
    proof.documentId !== domRecord.documentId ||
    proof.targetToken === null ||
    proof.targetToken !== domRecord.targetToken ||
    domRecord.timeStamp !== apiRecord.startTime ||
    domRecord.type !== apiRecord.type ||
    !domRecord.isTrusted ||
    !Object.values(proof.sourceCapture).every((value) => value === true)
  ) {
    return fail("RETAINED_TARGET_PROOF_INVALID");
  }
  if (
    apiRecord.targetToken !== null &&
    apiRecord.targetToken !== proof.targetToken
  ) {
    return fail("TARGET_IDENTITY_MISMATCH");
  }

  const selectedAction = OBSERVED_ACTION_LABELS.get(domRecord.targetLabel);
  if (
    selectedAction === undefined ||
    selectedAction.action !== "open" ||
    apiRecord.type !== "click" ||
    domRecord.phase !== selectedAction.phase ||
    (domRecord.targetResolution !== "registered-target" &&
      domRecord.targetResolution !== "registered-ancestor") ||
    caseRecord.action !== selectedAction.action
  ) {
    return fail("UNSELECTED_ACTION_DISPATCH");
  }

  const mapping = retainedNodeEvidence.mappings[proof.mappingIndex];
  const finalProof = proof.finalProof;
  const baselineScope = proof.baselineScope;
  const finalScope = finalProof?.cdpScope;
  const sameScope =
    isRecord(baselineScope) &&
    isRecord(finalScope) &&
    ["frameId", "loaderId", "contextUniqueId", "targetId", "sessionId"].every(
      (key) => baselineScope[key] === finalScope[key],
    );
  if (
    !mapping ||
    mapping.targetToken !== proof.targetToken ||
    !Number.isSafeInteger(mapping.backendNodeId) ||
    mapping.backendNodeId <= 0 ||
    !finalProof ||
    finalProof.stage !== "post-trace-before-release" ||
    ![
      finalProof.savedDocumentSame,
      finalProof.savedRootSame,
      finalProof.savedTargetSame,
      finalProof.targetOwnerDocumentMatches,
    ].every((value) => value === true) ||
    finalProof.mappedBackendNodeId !== mapping.backendNodeId ||
    finalProof.finalBackendNodeId !== mapping.backendNodeId ||
    !sameScope ||
    baselineScope.frameId !==
      retainedNodeEvidence.snapshots.beforeArm.frameId ||
    baselineScope.loaderId !==
      retainedNodeEvidence.snapshots.beforeArm.loaderId ||
    baselineScope.contextUniqueId !==
      retainedNodeEvidence.executionContext.uniqueId ||
    baselineScope.frameId !== retainedNodeEvidence.executionContext.frameId ||
    baselineScope.frameId !== frameProvenance.afterDrain.frameId ||
    baselineScope.loaderId !== frameProvenance.afterDrain.loaderId
  ) {
    return fail("RETAINED_TARGET_PROOF_INVALID");
  }

  return {
    apiEntries: apiRecords.length,
    apiRecords,
    domRecord,
    documentId: observation.documentId,
    frameId: frameProvenance.afterDrain.frameId,
    retainedNodeEvidence,
    witness,
    caseRecord,
    proof,
    mapping,
  };
}

function observedDiscreteIdentityKey(frameId, legacyType, interactionId) {
  return JSON.stringify([frameId, legacyType, interactionId.toString()]);
}

function rawObservedLegacyBegins(trace) {
  const identities = new Map();
  let unclassifiable = false;
  for (const [beginIndex, event] of trace.traceEvents.entries()) {
    if (!isRecord(event) || event.name !== "EventTiming" || event.ph !== "b") {
      continue;
    }
    const data = event.args?.data;
    if (!isRecord(data) || typeof data.type !== "string") {
      unclassifiable = true;
      continue;
    }
    if (!LEGACY_TO_MODERN_EVENT_TYPES.has(data.type)) {
      if (!KNOWN_CHROMIUM_EVENT_TIMING_TYPES.has(data.type)) {
        unclassifiable = true;
      }
      continue;
    }
    const frameId = data.frame;
    const interactionId = exactInteger(data.interactionId);
    if (
      typeof frameId !== "string" ||
      frameId.length === 0 ||
      interactionId === null
    ) {
      unclassifiable = true;
      continue;
    }
    if (interactionId <= 0n || interactionId > SIGNED_INT32_MAX) continue;

    const key = observedDiscreteIdentityKey(frameId, data.type, interactionId);
    const entries = identities.get(key) ?? [];
    entries.push(beginIndex);
    identities.set(key, entries);
  }
  return { identities, unclassifiable };
}

function rawObservedLegacyBeginsVersionTwo(trace) {
  const identities = new Map();
  const byTypeAndInteraction = new Map();
  let unclassifiable = false;
  for (const [beginIndex, event] of trace.traceEvents.entries()) {
    if (!isRecord(event) || event.name !== "EventTiming" || event.ph !== "b") {
      continue;
    }
    const data = event.args?.data;
    if (!isRecord(data) || typeof data.type !== "string") {
      unclassifiable = true;
      continue;
    }
    if (!LEGACY_TO_MODERN_EVENT_TYPES.has(data.type)) {
      if (!KNOWN_CHROMIUM_EVENT_TIMING_TYPES.has(data.type)) {
        unclassifiable = true;
      }
      continue;
    }

    const frameId = data.frame;
    const interactionId = exactInteger(data.interactionId);
    const nodeId = exactInteger(data.nodeId);
    if (
      typeof frameId !== "string" ||
      frameId.length === 0 ||
      interactionId === null ||
      !Number.isSafeInteger(event.pid) ||
      event.pid <= 0 ||
      nodeId === null ||
      nodeId <= 0n ||
      nodeId > SIGNED_INT32_MAX
    ) {
      unclassifiable = true;
      continue;
    }
    if (interactionId <= 0n || interactionId > SIGNED_INT32_MAX) continue;

    const candidate = {
      beginIndex,
      frameId,
      interactionId,
      legacyType: data.type,
      nodeId: Number(nodeId),
      pid: event.pid,
    };
    const key = observedDiscreteIdentityKey(frameId, data.type, interactionId);
    const entries = identities.get(key) ?? [];
    entries.push(candidate);
    identities.set(key, entries);

    const typeAndInteractionKey = JSON.stringify([
      data.type,
      interactionId.toString(),
    ]);
    const peers = byTypeAndInteraction.get(typeAndInteractionKey) ?? [];
    peers.push(candidate);
    byTypeAndInteraction.set(typeAndInteractionKey, peers);
  }
  return { identities, byTypeAndInteraction, unclassifiable };
}

const TRACE_EPOCH_METADATA_NAMES = new Set([
  "ProcessReady",
  "ProcessReadyInBrowser",
  "FrameCommitted",
  "FrameCommittedInBrowser",
  "FrameDeleted",
  "FrameDeletedInBrowser",
]);

function observedTraceRendererEpoch(trace, frameId) {
  const initialEvents = trace.traceEvents
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event?.name === "TracingStartedInBrowser");
  if (initialEvents.length !== 1) {
    return { code: "TRACE_FRAME_ASSOCIATION_INVALID" };
  }

  const { event: initialEvent, index: initialIndex } = initialEvents[0];
  const frames = initialEvent?.args?.data?.frames;
  if (initialEvent.ph !== "I" || !Array.isArray(frames)) {
    return { code: "TRACE_FRAME_ASSOCIATION_INVALID" };
  }
  const selectedFrames = frames.filter(
    (frame) => isRecord(frame) && frame.frame === frameId,
  );
  if (selectedFrames.length !== 1) {
    return { code: "TRACE_FRAME_ASSOCIATION_INVALID" };
  }
  const selectedFrame = selectedFrames[0];
  if (Object.hasOwn(selectedFrame, "parent")) {
    return { code: "TRACE_FRAME_ASSOCIATION_INVALID" };
  }
  const rendererPid = selectedFrame.processId;
  if (!Number.isSafeInteger(rendererPid) || rendererPid <= 0) {
    return { code: "TRACE_FRAME_ASSOCIATION_INVALID" };
  }

  for (
    let index = initialIndex + 1;
    index < trace.traceEvents.length;
    index += 1
  ) {
    const event = trace.traceEvents[index];
    if (!isRecord(event) || !TRACE_EPOCH_METADATA_NAMES.has(event.name)) {
      continue;
    }
    const data = event.args?.data;
    if (
      !isRecord(data) ||
      typeof data.frame !== "string" ||
      data.frame.length === 0
    ) {
      return { code: "TRACE_METADATA_INVALID" };
    }
    if (data.frame === frameId) {
      return { code: "TRACE_FRAME_EPOCH_INVALIDATED" };
    }
  }

  return { initialIndex, rendererPid };
}

function associateObservedDiscreteInputsVersionOne(
  trace,
  traceRecord,
  sourceProfile,
  observerEvidence,
  candidateByBeginIndex,
) {
  const apiEntryCount = observedApiEntryCount(observerEvidence?.sidecar);
  const validated = validateObservedDiscreteEvidence(
    traceRecord,
    sourceProfile,
    observerEvidence,
  );
  if (validated.code) {
    return rejectedObservedDiscreteInputs(validated.apiEntries, validated.code);
  }

  const apiIdentities = new Map();
  const apiKeys = new Map();
  for (const [index, record] of validated.apiRecords.entries()) {
    const legacyType = OBSERVED_API_TO_LEGACY_TYPE.get(record.type);
    const interactionId = Number.isSafeInteger(record.interactionId)
      ? BigInt(record.interactionId)
      : null;
    if (
      legacyType === undefined ||
      interactionId === null ||
      interactionId <= 0n ||
      interactionId > SIGNED_INT32_MAX
    ) {
      apiKeys.set(index, null);
      continue;
    }
    const key = observedDiscreteIdentityKey(
      validated.frameId,
      legacyType,
      interactionId,
    );
    apiKeys.set(index, key);
    const entries = apiIdentities.get(key) ?? [];
    entries.push(index);
    apiIdentities.set(key, entries);
  }

  const { identities: legacyIdentities, unclassifiable } =
    rawObservedLegacyBegins(trace);
  const rejectionCounts = new Map();
  const acceptedEntries = [];
  const reject = (code) => addDiagnostic(rejectionCounts, code);

  for (const [apiIndex, apiRecord] of validated.apiRecords.entries()) {
    const key = apiKeys.get(apiIndex);
    if (key === null) {
      reject("API_INTERACTION_ID_INVALID");
      continue;
    }
    if ((apiIdentities.get(key) ?? []).length !== 1) {
      reject("API_IDENTITY_AMBIGUOUS");
      continue;
    }
    if (unclassifiable) {
      reject("TRACE_CONTENDER_UNCLASSIFIABLE");
      continue;
    }
    const beginIndexes = legacyIdentities.get(key) ?? [];
    if (beginIndexes.length > 1) {
      reject("TRACE_IDENTITY_AMBIGUOUS");
      continue;
    }
    if (beginIndexes.length === 0) {
      reject("TRACE_IDENTITY_NOT_FOUND");
      continue;
    }

    if (
      typeof apiRecord.targetToken !== "string" ||
      apiRecord.targetToken.length === 0
    ) {
      reject("TARGET_IDENTITY_MISMATCH");
      continue;
    }
    const domMatches = validated.domRecords.filter(
      (record) =>
        record.documentId === validated.documentId &&
        record.type === apiRecord.type &&
        record.timeStamp === apiRecord.startTime &&
        record.targetToken === apiRecord.targetToken,
    );
    if (domMatches.length === 0) {
      reject("DOM_COUNTERPART_UNAVAILABLE");
      continue;
    }
    if (domMatches.length !== 1) {
      reject("DOM_COUNTERPART_AMBIGUOUS");
      continue;
    }
    const domRecord = domMatches[0];
    if (!domRecord.isTrusted) {
      reject("DOM_COUNTERPART_UNTRUSTED");
      continue;
    }
    if (
      apiRecord.targetResolution !== "registered-target" &&
      apiRecord.targetResolution !== "registered-ancestor"
    ) {
      reject("TARGET_IDENTITY_MISMATCH");
      continue;
    }
    if (
      domRecord.targetResolution !== "registered-target" &&
      domRecord.targetResolution !== "registered-ancestor"
    ) {
      reject("TARGET_IDENTITY_MISMATCH");
      continue;
    }
    if (apiRecord.targetLabel !== domRecord.targetLabel) {
      reject("TARGET_IDENTITY_MISMATCH");
      continue;
    }
    const selectedAction = OBSERVED_ACTION_LABELS.get(domRecord.targetLabel);
    if (
      apiRecord.type !== "click" ||
      selectedAction === undefined ||
      domRecord.phase !== selectedAction.phase
    ) {
      reject("UNSELECTED_ACTION_DISPATCH");
      continue;
    }
    if (validated.caseRecord.action !== selectedAction.action) {
      reject("ACTION_CASE_MISMATCH");
      continue;
    }

    const candidate = candidateByBeginIndex.get(beginIndexes[0]);
    if (!candidate || candidate.eventType !== apiRecord.type) {
      reject("CROSSWALK_CANDIDATE_UNAVAILABLE");
      continue;
    }
    acceptedEntries.push({
      dispatchPhase: domRecord.phase,
      actionLabel: domRecord.targetLabel,
      eventType: candidate.eventType,
      durationUs: candidate.durationUs,
      processingEndToPresentationUs: candidate.processingEndToPresentationUs,
      status: "diagnostic-only",
    });
  }

  const accepted = acceptedEntries.length;
  const rejected = apiEntryCount - accepted;
  return {
    status: accepted > 0 ? "diagnostic-only" : "unavailable",
    counts: { apiEntries: apiEntryCount, accepted, rejected },
    entries: acceptedEntries,
    rejectionCounts: diagnosticList(rejectionCounts),
    formalActionStatus: "unavailable",
    formalActionSamples: [],
  };
}

function associateObservedDiscreteInputsVersionTwo(
  trace,
  traceRecord,
  sourceProfile,
  observerEvidence,
  candidateByBeginIndex,
) {
  const validated = validateObservedDiscreteEvidenceVersionTwo(
    traceRecord,
    sourceProfile,
    observerEvidence,
  );
  if (validated.code) {
    return rejectedObservedDiscreteInputs(validated.apiEntries, validated.code);
  }

  const apiIdentities = new Map();
  const apiKeys = new Map();
  const apiTypeAndInteractionKeys = new Map();
  for (const [index, record] of validated.apiRecords.entries()) {
    const legacyType = OBSERVED_API_TO_LEGACY_TYPE.get(record.type);
    const interactionId = Number.isSafeInteger(record.interactionId)
      ? BigInt(record.interactionId)
      : null;
    if (
      legacyType === undefined ||
      interactionId === null ||
      interactionId <= 0n ||
      interactionId > SIGNED_INT32_MAX
    ) {
      apiKeys.set(index, null);
      apiTypeAndInteractionKeys.set(index, null);
      continue;
    }
    const key = observedDiscreteIdentityKey(
      validated.frameId,
      legacyType,
      interactionId,
    );
    apiKeys.set(index, key);
    apiTypeAndInteractionKeys.set(
      index,
      JSON.stringify([legacyType, interactionId.toString()]),
    );
    const entries = apiIdentities.get(key) ?? [];
    entries.push(index);
    apiIdentities.set(key, entries);
  }

  const {
    identities: legacyIdentities,
    byTypeAndInteraction,
    unclassifiable,
  } = rawObservedLegacyBeginsVersionTwo(trace);
  const traceEpoch = observedTraceRendererEpoch(trace, validated.frameId);
  const rejectionCounts = new Map();
  const acceptedEntries = [];
  const reject = (code) => addDiagnostic(rejectionCounts, code);

  for (const [apiIndex, apiRecord] of validated.apiRecords.entries()) {
    const key = apiKeys.get(apiIndex);
    if (key === null) {
      reject("API_INTERACTION_ID_INVALID");
      continue;
    }
    if ((apiIdentities.get(key) ?? []).length !== 1) {
      reject("API_IDENTITY_AMBIGUOUS");
      continue;
    }
    if (unclassifiable) {
      reject("TRACE_CONTENDER_UNCLASSIFIABLE");
      continue;
    }

    const legacyCandidates = legacyIdentities.get(key) ?? [];
    if (legacyCandidates.length > 1) {
      reject("TRACE_IDENTITY_AMBIGUOUS");
      continue;
    }
    if (legacyCandidates.length === 0) {
      const peers =
        byTypeAndInteraction.get(apiTypeAndInteractionKeys.get(apiIndex)) ?? [];
      reject(
        peers.length > 0 ? "TRACE_FRAME_MISMATCH" : "TRACE_IDENTITY_NOT_FOUND",
      );
      continue;
    }
    if (traceEpoch.code) {
      reject(traceEpoch.code);
      continue;
    }

    const legacy = legacyCandidates[0];
    if (legacy.beginIndex <= traceEpoch.initialIndex) {
      reject("TRACE_FRAME_ASSOCIATION_INVALID");
      continue;
    }
    if (legacy.pid !== traceEpoch.rendererPid) {
      reject("TRACE_PID_EPOCH_MISMATCH");
      continue;
    }

    const domMatches = validated.domRecords.filter(
      (record) =>
        record.documentId === validated.documentId &&
        record.type === apiRecord.type &&
        record.timeStamp === apiRecord.startTime,
    );
    if (domMatches.length === 0) {
      reject("DOM_COUNTERPART_UNAVAILABLE");
      continue;
    }
    if (domMatches.length !== 1) {
      reject("DOM_COUNTERPART_AMBIGUOUS");
      continue;
    }
    const domRecord = domMatches[0];
    if (!domRecord.isTrusted) {
      reject("DOM_COUNTERPART_UNTRUSTED");
      continue;
    }
    if (
      typeof domRecord.targetToken !== "string" ||
      domRecord.targetToken.length === 0 ||
      (apiRecord.targetToken !== null &&
        apiRecord.targetToken !== domRecord.targetToken)
    ) {
      reject("TARGET_IDENTITY_MISMATCH");
      continue;
    }
    if (
      domRecord.targetResolution !== "registered-target" &&
      domRecord.targetResolution !== "registered-ancestor"
    ) {
      reject("TARGET_IDENTITY_MISMATCH");
      continue;
    }

    const selectedAction = OBSERVED_ACTION_LABELS.get(domRecord.targetLabel);
    if (
      apiRecord.type !== "click" ||
      selectedAction === undefined ||
      domRecord.phase !== selectedAction.phase
    ) {
      reject("UNSELECTED_ACTION_DISPATCH");
      continue;
    }
    if (validated.caseRecord.action !== selectedAction.action) {
      reject("ACTION_CASE_MISMATCH");
      continue;
    }

    const mapping = validated.retainedNodeEvidence.mappings.filter(
      (candidate) => candidate.targetToken === domRecord.targetToken,
    );
    if (mapping.length !== 1) {
      reject("RETAINED_NODE_MAPPING_UNAVAILABLE");
      continue;
    }
    if (mapping[0].backendNodeId !== legacy.nodeId) {
      reject("RETAINED_NODE_MAPPING_MISMATCH");
      continue;
    }

    const candidate = candidateByBeginIndex.get(legacy.beginIndex);
    if (!candidate || candidate.eventType !== apiRecord.type) {
      reject("CROSSWALK_CANDIDATE_UNAVAILABLE");
      continue;
    }
    acceptedEntries.push({
      dispatchPhase: domRecord.phase,
      actionLabel: domRecord.targetLabel,
      eventType: candidate.eventType,
      durationUs: candidate.durationUs,
      processingEndToPresentationUs: candidate.processingEndToPresentationUs,
      status: "diagnostic-only",
    });
  }

  const accepted = acceptedEntries.length;
  const apiEntryCount = validated.apiEntries;
  return {
    status: accepted > 0 ? "diagnostic-only" : "unavailable",
    counts: {
      apiEntries: apiEntryCount,
      accepted,
      rejected: apiEntryCount - accepted,
    },
    entries: acceptedEntries,
    rejectionCounts: diagnosticList(rejectionCounts),
    formalActionStatus: "unavailable",
    formalActionSamples: [],
  };
}

function associateObservedDiscreteInputsVersionThree(
  trace,
  traceRecord,
  sourceProfile,
  observerEvidence,
  candidateByBeginIndex,
) {
  const validated = validateObservedDiscreteEvidenceVersionThree(
    traceRecord,
    sourceProfile,
    observerEvidence,
  );
  if (validated.code) {
    return rejectedObservedDiscreteInputs(validated.apiEntries, validated.code);
  }

  const apiRecord = validated.apiRecords[0];
  const legacyType = OBSERVED_API_TO_LEGACY_TYPE.get(apiRecord.type);
  const interactionId = BigInt(apiRecord.interactionId);
  const apiKey = observedDiscreteIdentityKey(
    validated.frameId,
    legacyType,
    interactionId,
  );
  const typeAndInteractionKey = JSON.stringify([
    legacyType,
    interactionId.toString(),
  ]);
  const {
    identities: legacyIdentities,
    byTypeAndInteraction,
    unclassifiable,
  } = rawObservedLegacyBeginsVersionTwo(trace);
  if (unclassifiable) {
    return rejectedObservedDiscreteInputs(1, "TRACE_CONTENDER_UNCLASSIFIABLE");
  }

  const traceEpoch = observedTraceRendererEpoch(trace, validated.frameId);
  if (traceEpoch.code) {
    return rejectedObservedDiscreteInputs(1, traceEpoch.code);
  }

  const markerCandidates = trace.traceEvents
    .map((event, index) => ({ event, index }))
    .filter(
      ({ event }) =>
        event?.name === "TimeStamp" &&
        event?.args?.data?.message ===
          "pilot-100-interactive-open:segment-start",
    );
  if (markerCandidates.length !== 1) {
    return rejectedObservedDiscreteInputs(
      1,
      markerCandidates.length === 0
        ? "TRACE_MARKER_MISSING"
        : "TRACE_MARKER_AMBIGUOUS",
    );
  }
  const { event: marker, index: markerIndex } = markerCandidates[0];
  if (
    !isRecord(marker) ||
    typeof marker.cat !== "string" ||
    !marker.cat.split(",").includes("blink.user_timing") ||
    (marker.ph !== "I" && marker.ph !== "R") ||
    !Number.isSafeInteger(marker.pid) ||
    marker.pid <= 0 ||
    markerIndex <= traceEpoch.initialIndex
  ) {
    return rejectedObservedDiscreteInputs(1, "TRACE_MARKER_INVALID");
  }
  if (marker.pid !== traceEpoch.rendererPid) {
    return rejectedObservedDiscreteInputs(1, "TRACE_PID_EPOCH_MISMATCH");
  }

  const peers = byTypeAndInteraction.get(typeAndInteractionKey) ?? [];
  if (peers.length > 1) {
    return rejectedObservedDiscreteInputs(1, "TRACE_IDENTITY_AMBIGUOUS");
  }
  const legacyCandidates = legacyIdentities.get(apiKey) ?? [];
  if (legacyCandidates.length > 1) {
    return rejectedObservedDiscreteInputs(1, "TRACE_IDENTITY_AMBIGUOUS");
  }
  if (legacyCandidates.length === 0) {
    return rejectedObservedDiscreteInputs(
      1,
      peers.length > 0 ? "TRACE_FRAME_MISMATCH" : "TRACE_IDENTITY_NOT_FOUND",
    );
  }
  if (peers.length !== 1) {
    return rejectedObservedDiscreteInputs(1, "TRACE_IDENTITY_AMBIGUOUS");
  }

  const legacy = legacyCandidates[0];
  if (
    legacy.beginIndex <= traceEpoch.initialIndex ||
    legacy.beginIndex <= markerIndex
  ) {
    return rejectedObservedDiscreteInputs(1, "TRACE_ORDER_INVALID");
  }
  if (legacy.pid !== traceEpoch.rendererPid) {
    return rejectedObservedDiscreteInputs(1, "TRACE_PID_EPOCH_MISMATCH");
  }
  if (legacy.nodeId !== validated.mapping.backendNodeId) {
    return rejectedObservedDiscreteInputs(1, "RETAINED_NODE_MAPPING_MISMATCH");
  }

  const candidate = candidateByBeginIndex.get(legacy.beginIndex);
  if (!candidate || candidate.eventType !== apiRecord.type) {
    return rejectedObservedDiscreteInputs(1, "CROSSWALK_CANDIDATE_UNAVAILABLE");
  }
  return {
    status: "diagnostic-only",
    counts: { apiEntries: 1, accepted: 1, rejected: 0 },
    entries: [
      {
        dispatchPhase: validated.domRecord.phase,
        actionLabel: validated.domRecord.targetLabel,
        eventType: candidate.eventType,
        durationUs: candidate.durationUs,
        processingEndToPresentationUs: candidate.processingEndToPresentationUs,
        status: "diagnostic-only",
      },
    ],
    rejectionCounts: [],
    formalActionStatus: "unavailable",
    formalActionSamples: [],
  };
}

function observerEvidenceSchemaVersion(observerEvidence) {
  const declaration = observerEvidence?.declaration;
  const sidecar = observerEvidence?.sidecar;
  if (
    isRecord(declaration) &&
    !Object.hasOwn(declaration, "schemaVersion") &&
    isRecord(sidecar) &&
    sidecar.schemaVersion === 1 &&
    sidecar.observation?.schemaVersion === 1
  ) {
    return 1;
  }
  if (
    isRecord(declaration) &&
    declaration.schemaVersion === 2 &&
    isRecord(sidecar) &&
    sidecar.schemaVersion === 2 &&
    sidecar.observation?.schemaVersion === 2
  ) {
    return 2;
  }
  if (
    isRecord(declaration) &&
    declaration.schemaVersion === 3 &&
    isRecord(sidecar) &&
    sidecar.schemaVersion === 3 &&
    sidecar.observation?.schemaVersion === 3
  ) {
    return 3;
  }
  return null;
}

function associateObservedDiscreteInputs(
  trace,
  traceRecord,
  sourceProfile,
  observerEvidence,
  candidateByBeginIndex,
) {
  const apiEntries = observedApiEntryCount(observerEvidence?.sidecar);
  const schemaVersion = observerEvidenceSchemaVersion(observerEvidence);
  if (schemaVersion === 1) {
    return associateObservedDiscreteInputsVersionOne(
      trace,
      traceRecord,
      sourceProfile,
      observerEvidence,
      candidateByBeginIndex,
    );
  }
  if (schemaVersion === 2) {
    return associateObservedDiscreteInputsVersionTwo(
      trace,
      traceRecord,
      sourceProfile,
      observerEvidence,
      candidateByBeginIndex,
    );
  }
  if (schemaVersion === 3) {
    return associateObservedDiscreteInputsVersionThree(
      trace,
      traceRecord,
      sourceProfile,
      observerEvidence,
      candidateByBeginIndex,
    );
  }
  return rejectedObservedDiscreteInputs(
    apiEntries,
    "OBSERVER_EVIDENCE_INVALID",
  );
}

function unsupportedEventTimingCrosswalk() {
  return {
    status: "unavailable",
    counts: {
      legacyBeginCount: 0,
      legacyEndCount: 0,
      legacyCompleteEntries: 0,
      modernBeginCount: 0,
      modernEndCount: 0,
      modernMarkerCount: 0,
      modernCompleteEntries: 0,
      exactIdentityGroupCount: 0,
      exactMatchedIdentityCount: 0,
      candidateCount: 0,
    },
    candidates: [],
    rejectionCounts: [{ code: BROWSER_SOURCE_PROFILE_UNSUPPORTED, count: 1 }],
    methodScope: null,
    formalActionStatus: "unavailable",
    formalActionSamples: [],
    gateReasonCodes: [BROWSER_SOURCE_PROFILE_UNSUPPORTED],
  };
}

function interactionEndpointClass(legacy, modern) {
  if (
    modern.fallbackReason === "None" &&
    modern.hasFallbackTime &&
    modern.fallbackTime === 0n &&
    !modern.hasFallbackTimeUs
  ) {
    return "presentation";
  }
  if (
    modern.fallbackReason === "DoesNotNeedNextPaint" &&
    modern.hasFallbackTime &&
    modern.hasFallbackTimeUs &&
    modern.fallbackTime !== null &&
    modern.fallbackTime > 0n &&
    modern.fallbackTimeUs !== null &&
    modern.fallbackTimeUs > 0n &&
    modern.fallbackTime === legacy.endTimestampUs &&
    legacy.originUs + modern.fallbackTimeUs === legacy.endTimestampUs
  ) {
    return "recognized-fallback";
  }
  return "unknown";
}

function sourceRoundedDurationMilliseconds(durationUs) {
  if (!Number.isSafeInteger(durationUs) || durationUs < 0) return null;
  const rounded = Math.round(Number(durationUs) / 1000 / 8) * 8;
  return Number.isSafeInteger(rounded) ? rounded : null;
}

function discreteEventTimingCrosswalk(trace, traceRecord, profile) {
  const rejectionCounts = new Map();
  const legacyPairs = pairTypedSlices(
    trace.traceEvents,
    "EventTiming",
    "devtools.timeline",
    rejectionCounts,
  );
  const modernPairs = pairTypedSlices(
    trace.traceEvents,
    "EventProcessing",
    "latency",
    rejectionCounts,
  );
  const captureCase =
    typeof traceRecord?.trace === "string" && traceRecord.trace.length > 0
      ? traceRecord.trace
      : null;
  const parsedLegacy = [];
  const rejectedEntries = [];
  const parsedBeginIndexes = new Set();
  const rejectedBeginIndexes = new Set();
  for (const span of legacyPairs.spans) {
    const entry = legacyCrosswalkEntry(
      span,
      captureCase,
      rejectionCounts,
      profile,
    );
    if (entry !== null) {
      parsedLegacy.push(entry);
      parsedBeginIndexes.add(span.beginIndex);
      continue;
    }
    const partial = partialInteractionEntry(
      { event: span.begin, index: span.beginIndex, name: "EventTiming" },
      traceRecord,
    );
    if (partial !== null) {
      rejectedEntries.push(partial);
      rejectedBeginIndexes.add(span.beginIndex);
    }
  }

  const originsByScope = new Map();
  for (const entry of parsedLegacy) {
    const scope = JSON.stringify([
      entry.captureCase,
      entry.pid,
      entry.frameKey,
    ]);
    const origins = originsByScope.get(scope) ?? new Set();
    origins.add(entry.originUs.toString());
    originsByScope.set(scope, origins);
  }

  const inconsistentScopes = new Set(
    [...originsByScope]
      .filter(([, origins]) => origins.size !== 1)
      .map(([scope]) => scope),
  );
  const legacyGroups = new Map();
  const legacyIdentityGroups = new Map();
  for (const entry of parsedLegacy) {
    const scope = JSON.stringify([
      entry.captureCase,
      entry.pid,
      entry.frameKey,
    ]);
    if (inconsistentScopes.has(scope)) {
      rejectEntry(rejectionCounts, "INCONSISTENT_DOCUMENT_ORIGIN");
      continue;
    }
    if (entry.modernType !== null) {
      addToGroups(legacyGroups, entry);
      addToGroups(legacyIdentityGroups, entry, crosswalkBaseIdentityKey);
    }
  }

  const modernGroups = new Map();
  const modernIdentityGroups = new Map();
  for (const span of modernPairs.spans) {
    const entry = modernCrosswalkEntry(span, rejectionCounts, profile);
    if (entry === null) {
      const partial = partialInteractionEntry(
        { event: span.begin, index: span.beginIndex, name: "EventProcessing" },
        traceRecord,
      );
      if (partial !== null) {
        rejectedEntries.push(partial);
        rejectedBeginIndexes.add(span.beginIndex);
      }
      continue;
    }
    parsedBeginIndexes.add(span.beginIndex);
    if (entry.legacyType !== null) {
      entry.captureCase = captureCase;
      addToGroups(modernGroups, entry);
      addToGroups(modernIdentityGroups, entry, crosswalkBaseIdentityKey);
    }
  }

  const incompleteBeginIndexes = new Set([
    ...legacyPairs.incompleteBegins.map(({ index }) => index),
    ...modernPairs.incompleteBegins.map(({ index }) => index),
  ]);
  for (const [index, event] of trace.traceEvents.entries()) {
    if (
      !isRecord(event) ||
      (event.name !== "EventTiming" && event.name !== "EventProcessing") ||
      event.ph === "e" ||
      event.ph === "n" ||
      parsedBeginIndexes.has(index) ||
      incompleteBeginIndexes.has(index) ||
      rejectedBeginIndexes.has(index)
    ) {
      continue;
    }
    const partial = partialInteractionEntry(
      {
        event,
        index,
        name: event.name,
      },
      traceRecord,
    );
    if (partial !== null) {
      rejectedEntries.push(partial);
      rejectedBeginIndexes.add(index);
    }
  }

  const candidates = [];
  const exactPairs = [];
  const ambiguousEntries = [];
  const unmatchedEntries = [];
  const pairedLegacyEntries = new Set();
  const pairedModernEntries = new Set();
  let exactIdentityGroupCount = 0;
  let exactMatchedIdentityCount = 0;
  const exactKeys = new Set([...legacyGroups.keys(), ...modernGroups.keys()]);
  for (const key of [...exactKeys].sort()) {
    const legacyEntries = legacyGroups.get(key) ?? [];
    const modernEntries = modernGroups.get(key) ?? [];
    if (legacyEntries.length === 0 || modernEntries.length === 0) {
      continue;
    }
    exactIdentityGroupCount += 1;
    if (legacyEntries.length !== 1 || modernEntries.length !== 1) {
      addDiagnostic(
        rejectionCounts,
        "AMBIGUOUS_CROSSWALK_IDENTITY",
        legacyEntries.length + modernEntries.length,
      );
      for (const entry of legacyEntries) pairedLegacyEntries.add(entry);
      for (const entry of modernEntries) pairedModernEntries.add(entry);
      ambiguousEntries.push(...legacyEntries, ...modernEntries);
      continue;
    }

    const legacy = legacyEntries[0];
    const modern = modernEntries[0];
    pairedLegacyEntries.add(legacy);
    pairedModernEntries.add(modern);
    if (
      legacy.processingStartUs !== modern.processingStartUs ||
      legacy.processingEndUs !== modern.processingEndUs
    ) {
      rejectEntry(rejectionCounts, "PROCESSING_ENDPOINT_MISMATCH");
      unmatchedEntries.push(legacy, modern);
      continue;
    }
    exactMatchedIdentityCount += 1;
    const rawTraceSpan = legacy.endTimestampUs - legacy.beginTimestampUs;
    const rawTraceSpanUs = toSafeMicroseconds(rawTraceSpan);
    const endpointClass = interactionEndpointClass(legacy, modern);
    const durationUs =
      endpointClass === "unknown" || rawTraceSpan < 0n ? null : rawTraceSpanUs;
    exactPairs.push({
      beginIndex: legacy.beginIndex,
      legacy,
      modern,
      rawTraceSpanUs,
      durationUs,
      endpointClass,
      sourceRoundedDurationMs:
        durationUs === null
          ? null
          : sourceRoundedDurationMilliseconds(durationUs),
    });
    if (!modern.fallbackProven) {
      rejectEntry(rejectionCounts, "FALLBACK_UNPROVEN");
      continue;
    }

    const processingEndToPresentationUs =
      legacy.endTimestampUs - legacy.processingEndUs;
    const safeDurationUs = toSafeMicroseconds(rawTraceSpan);
    const safeProcessingTailUs = toSafeMicroseconds(
      processingEndToPresentationUs,
    );
    if (
      rawTraceSpan < 0n ||
      processingEndToPresentationUs < 0n ||
      safeDurationUs === null ||
      safeProcessingTailUs === null
    ) {
      rejectEntry(rejectionCounts, "INVALID_PRESENTATION_ENDPOINT");
      continue;
    }
    candidates.push({
      beginIndex: legacy.beginIndex,
      eventType: legacy.legacyType,
      durationUs: safeDurationUs,
      processingEndToPresentationUs: safeProcessingTailUs,
      status: "diagnostic-only",
    });
  }

  const identityKeys = new Set([
    ...legacyIdentityGroups.keys(),
    ...modernIdentityGroups.keys(),
  ]);
  for (const key of [...identityKeys].sort()) {
    const unmatchedLegacy = (legacyIdentityGroups.get(key) ?? []).filter(
      (entry) => !pairedLegacyEntries.has(entry),
    );
    const unmatchedModern = (modernIdentityGroups.get(key) ?? []).filter(
      (entry) => !pairedModernEntries.has(entry),
    );
    if (unmatchedLegacy.length === 0 && unmatchedModern.length === 0) continue;
    if (
      unmatchedLegacy.length === 1 &&
      unmatchedModern.length === 1 &&
      (unmatchedLegacy[0].processingStartUs !==
        unmatchedModern[0].processingStartUs ||
        unmatchedLegacy[0].processingEndUs !==
          unmatchedModern[0].processingEndUs)
    ) {
      rejectEntry(rejectionCounts, "PROCESSING_ENDPOINT_MISMATCH");
      unmatchedEntries.push(...unmatchedLegacy, ...unmatchedModern);
      continue;
    }
    unmatchedEntries.push(...unmatchedLegacy, ...unmatchedModern);
    addDiagnostic(
      rejectionCounts,
      "NO_EXACT_CROSSWALK_MATCH",
      unmatchedLegacy.length + unmatchedModern.length,
    );
  }

  candidates.sort((left, right) => left.beginIndex - right.beginIndex);
  const candidateByBeginIndex = new Map(
    candidates.map((candidate) => [candidate.beginIndex, candidate]),
  );
  return {
    result: {
      status: candidates.length > 0 ? "diagnostic-only" : "unavailable",
      counts: {
        legacyBeginCount: legacyPairs.beginCount,
        legacyEndCount: legacyPairs.endCount,
        legacyCompleteEntries: legacyPairs.spans.length,
        modernBeginCount: modernPairs.beginCount,
        modernEndCount: modernPairs.endCount,
        modernMarkerCount: modernPairs.markerCount,
        modernCompleteEntries: modernPairs.spans.length,
        exactIdentityGroupCount,
        exactMatchedIdentityCount,
        candidateCount: candidates.length,
      },
      candidates: candidates.map(
        ({ eventType, durationUs, processingEndToPresentationUs, status }) => ({
          eventType,
          durationUs,
          processingEndToPresentationUs,
          status,
        }),
      ),
      rejectionCounts: diagnosticList(rejectionCounts),
      methodScope: {
        ...(profile === "android-brave15585"
          ? ANDROID_BRAVE15585_METHOD_SCOPE
          : profile === "brave15585"
            ? BRAVE15585_METHOD_SCOPE
            : profile === "brave15580"
              ? BRAVE15580_METHOD_SCOPE
              : profile === "brave155"
                ? BRAVE155_METHOD_SCOPE
                : CROSSWALK_METHOD_SCOPE),
      },
      formalActionStatus: "unavailable",
      formalActionSamples: [],
      gateReasonCodes:
        profile === "brave155" ||
        profile === "brave15580" ||
        profile === "brave15585"
          ? BRAVE155_GATE_REASONS
          : profile === "android-brave15585"
            ? ANDROID_BRAVE155_GATE_REASONS
            : CROSSWALK_GATE_REASONS,
    },
    candidateByBeginIndex,
    exactPairs,
    ambiguousEntries,
    unmatchedEntries,
    rejectedEntries,
    incompleteBegins: [
      ...legacyPairs.incompleteBegins.map((item) => ({
        event: item.event,
        index: item.index,
        name: "EventTiming",
      })),
      ...modernPairs.incompleteBegins.map((item) => ({
        event: item.event,
        index: item.index,
        name: "EventProcessing",
      })),
    ],
  };
}

function supportsChrome155InteractionGroupSource(observations) {
  return (
    hasExactFields(observations, ["browser", "status", "sourceRevision"]) &&
    hasExactFields(observations.browser, ["product", "version"]) &&
    observations.browser.product === "Google Chrome" &&
    observations.browser.version === "155.0.8059.84" &&
    observations.status === "bounded-click-calibration" &&
    observations.sourceRevision === CHROME155_INTERACTION_GROUP_REVISION
  );
}

function safeCalibrationLabel(value, maximumLength = 128) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength &&
    !Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint < 32 || codePoint === 127);
    })
  );
}

function validInteractionGroupBinding(binding) {
  if (
    !hasExactFields(binding, [
      "documentId",
      "frame",
      "rendererPid",
      "targetNodeId",
      "traceSha256",
      "sourceRevision",
    ]) ||
    !safeCalibrationLabel(binding.documentId) ||
    !safeCalibrationLabel(binding.frame) ||
    !Number.isSafeInteger(binding.rendererPid) ||
    binding.rendererPid <= 0 ||
    typeof binding.targetNodeId !== "string" ||
    !/^[1-9][0-9]*$/.test(binding.targetNodeId) ||
    binding.targetNodeId.length > 128 ||
    typeof binding.traceSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(binding.traceSha256) ||
    binding.sourceRevision !== CHROME155_INTERACTION_GROUP_REVISION
  ) {
    return null;
  }
  return {
    documentId: binding.documentId,
    frame: binding.frame,
    rendererPid: binding.rendererPid,
    targetNodeId: BigInt(binding.targetNodeId),
    traceSha256: binding.traceSha256,
    sourceRevision: binding.sourceRevision,
  };
}

function binary64MillisecondsToMicroseconds(value) {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value, false);
  const bits = view.getBigUint64(0, false);
  const exponentBits = Number((bits >> 52n) & 0x7ffn);
  const fractionBits = bits & ((1n << 52n) - 1n);
  const coefficient =
    exponentBits === 0 ? fractionBits : (1n << 52n) + fractionBits;
  const exponent = exponentBits === 0 ? -1074 : exponentBits - 1023 - 52;
  let numerator = coefficient * 1000n;
  let denominator = 1n;
  if (exponent >= 0) numerator <<= BigInt(exponent);
  else denominator <<= BigInt(-exponent);
  if (bits >> 63n !== 0n) numerator = -numerator;
  return { numerator, denominator };
}

function shiftedRational(value, microseconds) {
  return {
    numerator: value.numerator + BigInt(microseconds) * value.denominator,
    denominator: value.denominator,
  };
}

function compareIntegerToRational(integer, rational) {
  const difference =
    BigInt(integer) * rational.denominator - rational.numerator;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

function classifyInteractionWindow(processingStartUs, before, after) {
  if (typeof processingStartUs !== "bigint") return "uncertain";
  const beforeUs = binary64MillisecondsToMicroseconds(before.observedAt);
  const afterUs = binary64MillisecondsToMicroseconds(after.observedAt);
  const expandedBefore = shiftedRational(beforeUs, -11000);
  const contractedBefore = shiftedRational(beforeUs, 11000);
  const contractedAfter = shiftedRational(afterUs, -11000);
  const expandedAfter = shiftedRational(afterUs, 11000);
  if (
    compareIntegerToRational(processingStartUs, expandedBefore) < 0 ||
    compareIntegerToRational(processingStartUs, expandedAfter) > 0
  ) {
    return "outside";
  }
  if (
    compareIntegerToRational(processingStartUs, contractedBefore) > 0 &&
    compareIntegerToRational(processingStartUs, contractedAfter) < 0
  ) {
    return "inside";
  }
  return "uncertain";
}

function validCalibrationSnapshot(sidecar, binding, traceRecord) {
  const fail = (code, details = {}) => ({
    valid: false,
    reasonCodes: [code],
    ...details,
  });
  if (
    !hasExactFields(sidecar, [
      "schemaVersion",
      "evidenceClass",
      "documentId",
      "diagnosticOnly",
      "formalStatus",
      "status",
      "reasons",
      "before",
      "after",
      "clickDelta",
      "clicks",
      "overflow",
    ]) ||
    sidecar.schemaVersion !== 1 ||
    sidecar.evidenceClass !== "same-document-click-count-calibration" ||
    sidecar.diagnosticOnly !== true ||
    sidecar.formalStatus !== "unavailable" ||
    !Array.isArray(sidecar.reasons) ||
    !Array.isArray(sidecar.clicks) ||
    !hasExactFields(sidecar.before, ["timeOrigin", "observedAt", "counters"]) ||
    !hasExactFields(sidecar.after, ["timeOrigin", "observedAt", "counters"])
  ) {
    return fail("CALIBRATION_SNAPSHOT_INVALID");
  }
  if (sidecar.documentId !== binding.documentId) {
    return fail("CALIBRATION_DOCUMENT_MISMATCH");
  }
  if (traceRecord?.dataLossOccurred !== false) {
    return fail("TRACE_DATA_LOSS");
  }

  const isSafeCounter = (value) => Number.isSafeInteger(value) && value >= 0;
  const isSafeClock = (value) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0;
  const readCounters = (snapshot) => {
    if (!isRecord(snapshot.counters)) return null;
    const keys = Object.keys(snapshot.counters);
    if (keys.length > 64) return null;
    for (const key of keys) {
      if (
        !/^[a-z][a-z0-9_-]{0,31}$/.test(key) ||
        !isSafeCounter(snapshot.counters[key])
      ) {
        return null;
      }
    }
    return snapshot.counters;
  };
  const beforeCounters = readCounters(sidecar.before);
  const afterCounters = readCounters(sidecar.after);
  if (
    !isSafeClock(sidecar.before.timeOrigin) ||
    !isSafeClock(sidecar.after.timeOrigin) ||
    !isSafeClock(sidecar.before.observedAt) ||
    !isSafeClock(sidecar.after.observedAt) ||
    beforeCounters === null ||
    afterCounters === null
  ) {
    return fail("CALIBRATION_SNAPSHOT_INVALID");
  }
  const beforeKeys = Object.keys(beforeCounters).sort();
  const afterKeys = Object.keys(afterCounters).sort();
  if (
    beforeKeys.length !== afterKeys.length ||
    beforeKeys.some((key, index) => key !== afterKeys[index]) ||
    beforeKeys.some((key) => afterCounters[key] < beforeCounters[key]) ||
    sidecar.before.timeOrigin !== sidecar.after.timeOrigin ||
    sidecar.after.observedAt < sidecar.before.observedAt
  ) {
    return fail("CALIBRATION_SNAPSHOT_INVALID");
  }

  const navigationCount = INTERACTION_GROUP_NAVIGATION_TYPES.filter((type) =>
    Object.hasOwn(beforeCounters, type),
  ).length;
  if (navigationCount !== 0 && navigationCount !== 3) {
    return fail("CALIBRATION_COUNTER_KEYS_MALFORMED");
  }
  const counterDeltas = Object.fromEntries(
    beforeKeys.map((key) => [key, afterCounters[key] - beforeCounters[key]]),
  );
  const clicks = sidecar.clicks;
  const clickRowsValid =
    clicks.length === 1 &&
    hasExactFields(clicks[0], [
      "type",
      "isTrusted",
      "targetMatched",
      "timeStamp",
      "observedAt",
    ]) &&
    clicks[0].type === "click" &&
    clicks[0].isTrusted === true &&
    clicks[0].targetMatched === true &&
    isSafeClock(clicks[0].timeStamp) &&
    isSafeClock(clicks[0].observedAt) &&
    clicks[0].observedAt >= sidecar.before.observedAt &&
    clicks[0].observedAt <= sidecar.after.observedAt;
  if (
    sidecar.status !== "collected" ||
    sidecar.reasons.length !== 0 ||
    sidecar.overflow !== false ||
    !clickRowsValid ||
    !Object.hasOwn(counterDeltas, "click") ||
    counterDeltas.click !== clicks.length ||
    sidecar.clickDelta !== counterDeltas.click
  ) {
    return fail("CALIBRATION_DECLARATION_MISMATCH", {
      counterDeltas,
      navigationEnabled: navigationCount === 3,
      snapshotsUsable: true,
      before: sidecar.before,
      after: sidecar.after,
    });
  }
  return {
    valid: true,
    reasonCodes: [],
    counterDeltas,
    navigationEnabled: navigationCount === 3,
    snapshotsUsable: true,
    before: sidecar.before,
    after: sidecar.after,
  };
}

function partialInteractionEntry(item, traceRecord) {
  const event = item.event;
  if (!isRecord(event) || !Number.isSafeInteger(event.pid)) return null;
  if (item.name === "EventTiming") {
    const data = event.args?.data;
    if (!isRecord(data)) return null;
    const rejections = new Map();
    const frameKey = frameIdentityValue(data.frame);
    const interactionId = normalizeLegacyInteraction(
      data.interactionId,
      rejections,
    );
    const timestampUs = absoluteTraceMicroseconds(event);
    const timeStampUs = recoverRelativeMicroseconds(
      data,
      "timeStamp",
      () => {},
    );
    const processingStartUs = recoverRelativeMicroseconds(
      data,
      "processingStart",
      () => {},
    );
    const originUs =
      timestampUs !== null && timeStampUs !== null
        ? timestampUs - timeStampUs
        : null;
    return {
      pid: event.pid,
      frame: data.frame,
      frameKey,
      interactionId,
      nodeId: exactInteger(data.nodeId),
      legacyType: data.type,
      processingStartUs:
        originUs !== null && processingStartUs !== null
          ? originUs + processingStartUs
          : null,
      beginIndex: item.index,
      captureCase: traceRecord.trace,
    };
  }
  const timing = event.args?.event_timing;
  if (!isRecord(timing)) return null;
  const rejections = new Map();
  const interactionId = readModernInteraction(
    timing.interaction_id,
    rejections,
  );
  return {
    pid: event.pid,
    frame: timing.frame,
    frameKey: frameIdentityValue(timing.frame),
    interactionId,
    nodeId: exactInteger(timing.node_id),
    legacyType: MODERN_TO_LEGACY_EVENT_TYPES.get(timing.type) ?? null,
    processingStartUs: absoluteTraceMicroseconds(event),
    beginIndex: item.index,
    captureCase: traceRecord.trace,
  };
}

function interactionGroupKey(entry, binding, traceName) {
  if (
    entry?.captureCase !== traceName ||
    entry?.pid !== binding.rendererPid ||
    entry?.frame !== binding.frame ||
    entry?.interactionId === null ||
    entry?.interactionId === undefined ||
    entry.interactionId <= 0n
  ) {
    return null;
  }
  return JSON.stringify([
    traceName,
    binding.documentId,
    binding.rendererPid,
    binding.frame,
    entry.interactionId.toString(),
  ]);
}

function makeInteractionMaximum(members) {
  if (
    members.length === 0 ||
    members.some(
      (member) =>
        member.rawTraceSpanUs === null ||
        member.durationUs === null ||
        member.sourceRoundedDurationMs === null,
    )
  ) {
    return null;
  }
  let rawDurationUs = -1;
  let sourceRoundedDurationMs = -1;
  for (const member of members) {
    rawDurationUs = Math.max(rawDurationUs, member.durationUs);
    sourceRoundedDurationMs = Math.max(
      sourceRoundedDurationMs,
      member.sourceRoundedDurationMs,
    );
  }
  const rawMembers = members
    .filter((member) => member.durationUs === rawDurationUs)
    .map((member) => member.member);
  const roundedMembers = members
    .filter(
      (member) => member.sourceRoundedDurationMs === sourceRoundedDurationMs,
    )
    .map((member) => member.member);
  return {
    rawDurationUs,
    rawMembers,
    sourceRoundedDurationMs,
    roundedMembers,
    presentationClaimEligible: members
      .filter((member) => roundedMembers.includes(member.member))
      .every((member) => member.endpointClass === "presentation"),
  };
}

function countClosureForInteractionGroup({
  groupPairs,
  selected,
  calibration,
  pairDetails,
  binding,
  traceRecord,
}) {
  const reasonCodes = new Set(calibration.reasonCodes);
  const countRows = INTERACTION_GROUP_COUNTER_TYPES.map((eventType) => {
    const C = calibration.counterDeltas?.[eventType] ?? null;
    const R = groupPairs.filter(
      (pair) =>
        pair.legacy.legacyType === eventType &&
        calibration.valid &&
        classifyInteractionWindow(
          pair.legacy.processingStartUs,
          calibration.before,
          calibration.after,
        ) === "inside",
    ).length;
    const closes = C !== null && C === R;
    return {
      eventType,
      C,
      R,
      N: closes ? R : null,
      D: closes ? 0 : null,
    };
  });

  let hasOpenCondition = false;
  if (!selected) {
    reasonCodes.add("CLICK_GROUP_CANDIDATE_NOT_UNIQUE");
  }
  const relatedRows = [
    ...pairDetails.unmatchedEntries.map((entry) => ({
      entry,
      reason: "UNMATCHED_RELEVANT_ENTRY",
    })),
    ...pairDetails.ambiguousEntries.map((entry) => ({
      entry,
      reason: "AMBIGUOUS_RELEVANT_ENTRY",
    })),
    ...pairDetails.rejectedEntries.map((entry) => ({
      entry,
      reason: "MALFORMED_RELEVANT_ENTRY",
    })),
    ...pairDetails.incompleteBegins
      .map((item) => partialInteractionEntry(item, traceRecord))
      .filter((entry) => entry !== null)
      .map((entry) => ({ entry, reason: "INCOMPLETE_RELEVANT_ENTRY" })),
  ];
  const hasWindow =
    calibration.snapshotsUsable === true &&
    calibration.before !== undefined &&
    calibration.after !== undefined;
  if (!hasWindow && groupPairs.length > 0) {
    reasonCodes.add("CALIBRATION_WINDOW_UNAVAILABLE");
  }
  for (const pair of groupPairs) {
    if (hasWindow) {
      const position = classifyInteractionWindow(
        pair.legacy.processingStartUs,
        calibration.before,
        calibration.after,
      );
      if (position === "outside") {
        reasonCodes.add("INTERACTION_MEMBER_OUTSIDE_WINDOW");
        hasOpenCondition = true;
      } else if (position === "uncertain") {
        reasonCodes.add("INTERACTION_MEMBER_BOUNDARY_UNCERTAIN");
        hasOpenCondition = true;
      }
    }
    if (pair.endpointClass === "unknown") {
      reasonCodes.add("UNKNOWN_ENDPOINT");
      hasOpenCondition = true;
    }
    if (
      pair.rawTraceSpanUs === null ||
      pair.durationUs === null ||
      pair.sourceRoundedDurationMs === null
    ) {
      reasonCodes.add("MEMBER_DURATION_INVALID");
      hasOpenCondition = true;
    }
  }
  for (const { entry, reason } of relatedRows) {
    if (
      interactionGroupKey(entry, binding, traceRecord.trace) !==
      interactionGroupKey(groupPairs[0]?.legacy, binding, traceRecord.trace)
    ) {
      continue;
    }
    const position = hasWindow
      ? classifyInteractionWindow(
          entry.processingStartUs,
          calibration.before,
          calibration.after,
        )
      : null;
    reasonCodes.add(
      position === "outside"
        ? "INTERACTION_MEMBER_OUTSIDE_WINDOW"
        : position === "uncertain"
          ? "INTERACTION_MEMBER_BOUNDARY_UNCERTAIN"
          : reason,
    );
    hasOpenCondition = true;
  }
  if (calibration.navigationEnabled) {
    reasonCodes.add("NAVIGATION_MAPPING_UNAVAILABLE");
    hasOpenCondition = true;
  }
  if (
    INTERACTION_GROUP_COUNTER_TYPES.some(
      (eventType) => !Object.hasOwn(calibration.counterDeltas ?? {}, eventType),
    )
  ) {
    reasonCodes.add("REQUIRED_COUNTER_MISSING");
  }
  if (countRows.some(({ C, R }) => C === null || C !== R)) {
    reasonCodes.add("COUNT_CLOSURE_MISMATCH");
    hasOpenCondition = true;
  }

  const closureUnavailable =
    !calibration.valid ||
    !selected ||
    traceRecord.dataLossOccurred !== false ||
    reasonCodes.has("REQUIRED_COUNTER_MISSING");
  const status = closureUnavailable
    ? "unavailable"
    : hasOpenCondition
      ? "open"
      : "closed";
  return {
    status,
    byType: countRows,
    unsupportedApiTypes: [...INTERACTION_GROUP_NAVIGATION_TYPES],
    reasonCodes: [...reasonCodes].sort(),
  };
}

function analyzeChrome155InteractionGroups(
  trace,
  traceRecord,
  interactionGroupCalibration,
) {
  if (!hasExactFields(interactionGroupCalibration, ["sidecar", "binding"])) {
    return [];
  }
  const binding = validInteractionGroupBinding(
    interactionGroupCalibration.binding,
  );
  if (binding === null || typeof traceRecord.trace !== "string") return [];

  const calibration = validCalibrationSnapshot(
    interactionGroupCalibration.sidecar,
    binding,
    traceRecord,
  );
  const pairDetails = discreteEventTimingCrosswalk(
    trace,
    traceRecord,
    "chrome155-interaction-group",
  );
  const scopedPairs = pairDetails.exactPairs.filter(
    (pair) =>
      pair.legacy.pid === binding.rendererPid &&
      pair.legacy.frame === binding.frame &&
      pair.legacy.interactionId > 0n,
  );
  const groups = new Map();
  for (const pair of scopedPairs) {
    const key = interactionGroupKey(pair.legacy, binding, traceRecord.trace);
    if (key === null) continue;
    const group = groups.get(key) ?? {
      key,
      pairs: [],
      earliestIndex: Infinity,
    };
    group.pairs.push(pair);
    group.earliestIndex = Math.min(group.earliestIndex, pair.beginIndex);
    groups.set(key, group);
  }
  const orderedGroups = [...groups.values()].sort(
    (left, right) => left.earliestIndex - right.earliestIndex,
  );

  const clickContenders = [
    ...scopedPairs.filter(
      (pair) =>
        pair.legacy.legacyType === "click" &&
        pair.legacy.nodeId === binding.targetNodeId &&
        classifyInteractionWindow(
          pair.legacy.processingStartUs,
          calibration.before ?? { observedAt: 0 },
          calibration.after ?? { observedAt: 0 },
        ) !== "outside",
    ),
    ...[
      ...pairDetails.unmatchedEntries,
      ...pairDetails.ambiguousEntries,
      ...pairDetails.rejectedEntries,
      ...pairDetails.incompleteBegins
        .map((item) => partialInteractionEntry(item, traceRecord))
        .filter((entry) => entry !== null),
    ].filter(
      (entry) =>
        entry.pid === binding.rendererPid &&
        entry.frame === binding.frame &&
        entry.nodeId === binding.targetNodeId &&
        entry.legacyType === "click" &&
        classifyInteractionWindow(
          entry.processingStartUs,
          calibration.before ?? { observedAt: 0 },
          calibration.after ?? { observedAt: 0 },
        ) !== "outside",
    ),
  ];
  const selected = calibration.valid && clickContenders.length === 1;
  const selectedKey = selected
    ? interactionGroupKey(
        clickContenders[0].legacy ?? clickContenders[0],
        binding,
        traceRecord.trace,
      )
    : null;

  return orderedGroups.map((group, index) => {
    const orderedPairs = [...group.pairs].sort(
      (left, right) => left.beginIndex - right.beginIndex,
    );
    const members = orderedPairs.map((pair, memberIndex) => ({
      member: `member-${memberIndex + 1}`,
      eventType: pair.legacy.legacyType,
      rawTraceSpanUs: pair.rawTraceSpanUs,
      durationUs: pair.durationUs,
      endpointClass: pair.endpointClass,
      sourceRoundedDurationMs: pair.sourceRoundedDurationMs,
    }));
    const groupSelected = selected && selectedKey === group.key;
    const countClosure = groupSelected
      ? countClosureForInteractionGroup({
          groupPairs: orderedPairs,
          selected: true,
          calibration,
          pairDetails,
          binding,
          traceRecord,
        })
      : {
          status: "unavailable",
          byType: [],
          unsupportedApiTypes: [...INTERACTION_GROUP_NAVIGATION_TYPES],
          reasonCodes: [
            ...new Set([
              ...calibration.reasonCodes,
              "CALIBRATION_NOT_BOUND_TO_GROUP",
            ]),
          ].sort(),
        };
    const reasonCodes = new Set(countClosure.reasonCodes);
    const observedMaximum = makeInteractionMaximum(members);
    const status =
      groupSelected &&
      countClosure.status === "closed" &&
      observedMaximum !== null
        ? "bounded-calibration-verified"
        : "diagnostic-only";
    return {
      group: `group-${index + 1}`,
      status,
      formalStatus: "unavailable",
      scope: INTERACTION_GROUP_SCOPE_LABEL,
      members,
      observedMaximum,
      countClosure: {
        status: countClosure.status,
        byType: countClosure.byType,
        unsupportedApiTypes: countClosure.unsupportedApiTypes,
      },
      reasonCodes: [...reasonCodes].sort(),
    };
  });
}

export function analyzeTrace(
  trace,
  traceRecord,
  segments = [],
  sourceObservations,
  observerEvidence = undefined,
  interactionGroupCalibration = undefined,
) {
  if (
    !isRecord(trace) ||
    !Array.isArray(trace.traceEvents) ||
    !isRecord(traceRecord)
  ) {
    throw new TypeError("Analyzer requires a parsed trace and trace record.");
  }

  const versionThreeEvidence =
    observerEvidenceSchemaVersion(observerEvidence) === 3;
  if (versionThreeEvidence && Array.isArray(segments) && segments.length > 0) {
    throw new TypeError(
      "Version-three analysis cannot include action measurement segments.",
    );
  }

  const diagnosticCounts = new Map();
  const { spans, malformedReporterEvents, reporterBegins } = pairAsyncSlices(
    trace.traceEvents,
    diagnosticCounts,
  );
  const completedAsyncSlicesByName = countSpansByName(spans);
  const reporterStates = countReporterStates(spans);
  const inputToPresentedFrameSamples = correlateMouseUps(
    spans,
    traceRecord,
    diagnosticCounts,
  );
  const frameIntervals = frameIntervalsFor(
    traceRecord,
    segments,
    spans,
    malformedReporterEvents,
    reporterBegins,
    diagnosticCounts,
  );
  const profile = selectEventTimingCrosswalkProfile(
    sourceObservations,
    versionThreeEvidence,
  );
  const crosswalk = profile
    ? discreteEventTimingCrosswalk(trace, traceRecord, profile)
    : {
        result: unsupportedEventTimingCrosswalk(),
        candidateByBeginIndex: new Map(),
      };
  const observedDiscreteInputs =
    observerEvidence === undefined
      ? undefined
      : associateObservedDiscreteInputs(
          trace,
          traceRecord,
          profile,
          observerEvidence,
          crosswalk.candidateByBeginIndex,
        );
  const interactionGroups = supportsChrome155InteractionGroupSource(
    sourceObservations,
  )
    ? analyzeChrome155InteractionGroups(
        trace,
        traceRecord,
        interactionGroupCalibration,
      )
    : undefined;

  return {
    counts: {
      eventCount: trace.traceEvents.length,
      completedAsyncSlicesByName,
      completedEventLatencySlices: completedAsyncSlicesByName.EventLatency ?? 0,
      completedPipelineReporterSlices:
        completedAsyncSlicesByName.PipelineReporter ?? 0,
      reporterStates,
    },
    diagnostics: diagnosticList(diagnosticCounts),
    inputToPresentedFrameSamples,
    frameIntervals,
    discreteEventTimingCrosswalk: crosswalk.result,
    ...(observerEvidence === undefined ? {} : { observedDiscreteInputs }),
    ...(interactionGroups === undefined ? {} : { interactionGroups }),
  };
}
