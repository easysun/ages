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
const BRAVE155_METHOD_SCOPE = {
  observedBrowserVersion: "155.0.8059.40",
  pinnedSourceRevision: "cfaadc5a132d78e1828635aa8405a499f3e14864",
  publishedBraveCoreRevision: "b01cdf43be4b4d5559bf7e58229e666e24454f50",
  evidenceClass: "installed-brave-schema-probe",
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

const BROWSER_SOURCE_PROFILE_UNSUPPORTED = "BROWSER_SOURCE_PROFILE_UNSUPPORTED";
const PLAYWRIGHT_CHROMIUM_PRODUCT = "Playwright Chromium";
const PLAYWRIGHT_RUNTIME_PRODUCT = `Chrome/${CROSSWALK_METHOD_SCOPE.observedBrowserVersion}`;
const BRAVE155_BROWSER_PRODUCT = "Runtime browser observation";
const BRAVE155_RUNTIME_PRODUCT = "Chrome/155.0.8059.40";
const BRAVE155_USER_AGENT_PRODUCT_VERSION = "155.0.0.0";
const BRAVE155_BUNDLE_REVISION = "b01cdf43be4b4d5559bf7e58229e666e24454f50";
const BRAVE155_RUNTIME_REVISION = "@b01cdf43be4b4d5559bf7e58229e666e24454f5";
const BRAVE155_EXECUTABLE_SHA256 =
  "6099adb0e47d7c12922bb2dca02e2a044b71ae2895c0bbab1717f8660ffb99a7";

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
    }
  }

  return { spans, ...counts };
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
    profile === "brave155" &&
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
    profile === "brave155" &&
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

function selectEventTimingCrosswalkProfile(observations) {
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
  return null;
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
  const parsedLegacy = legacyPairs.spans
    .map((span) =>
      legacyCrosswalkEntry(span, captureCase, rejectionCounts, profile),
    )
    .filter((entry) => entry !== null);

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
    if (entry !== null && entry.legacyType !== null) {
      addToGroups(modernGroups, entry);
      addToGroups(modernIdentityGroups, entry, crosswalkBaseIdentityKey);
    }
  }

  const candidates = [];
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
      continue;
    }
    exactMatchedIdentityCount += 1;
    if (!modern.fallbackProven) {
      rejectEntry(rejectionCounts, "FALLBACK_UNPROVEN");
      continue;
    }

    const durationUs = legacy.endTimestampUs - legacy.beginTimestampUs;
    const processingEndToPresentationUs =
      legacy.endTimestampUs - legacy.processingEndUs;
    const safeDurationUs = toSafeMicroseconds(durationUs);
    const safeProcessingTailUs = toSafeMicroseconds(
      processingEndToPresentationUs,
    );
    if (
      durationUs < 0n ||
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
      continue;
    }
    addDiagnostic(
      rejectionCounts,
      "NO_EXACT_CROSSWALK_MATCH",
      unmatchedLegacy.length + unmatchedModern.length,
    );
  }

  candidates.sort((left, right) => left.beginIndex - right.beginIndex);
  return {
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
      ...(profile === "brave155"
        ? BRAVE155_METHOD_SCOPE
        : CROSSWALK_METHOD_SCOPE),
    },
    formalActionStatus: "unavailable",
    formalActionSamples: [],
    gateReasonCodes:
      profile === "brave155" ? BRAVE155_GATE_REASONS : CROSSWALK_GATE_REASONS,
  };
}

export function analyzeTrace(
  trace,
  traceRecord,
  segments = [],
  sourceObservations,
) {
  if (
    !isRecord(trace) ||
    !Array.isArray(trace.traceEvents) ||
    !isRecord(traceRecord)
  ) {
    throw new TypeError("Analyzer requires a parsed trace and trace record.");
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
  const profile = selectEventTimingCrosswalkProfile(sourceObservations);
  const eventTimingCrosswalk = profile
    ? discreteEventTimingCrosswalk(trace, traceRecord, profile)
    : unsupportedEventTimingCrosswalk();

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
    discreteEventTimingCrosswalk: eventTimingCrosswalk,
  };
}
