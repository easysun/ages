const MALFORMED_ID = Symbol("malformed-trace-id");
const TRACE_ID_FIELDS = new Set([
  "trace_id",
  "event_latency_id",
  "surface_frame_trace_id",
  "display_trace_id",
]);
const INTEGER_TOKEN = /^-?(?:0|[1-9][0-9]*)$/;
const MOUSE_UP_ID = /^0x[0-9a-f]+$/i;
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

export function parseTrace(text) {
  if (typeof text !== "string") {
    throw new TypeError("Trace input must be JSON text.");
  }

  const trace = JSON.parse(text, function reviver(key, value, context) {
    if (!TRACE_ID_FIELDS.has(key)) return value;

    if (
      typeof value === "number" &&
      typeof context?.source === "string" &&
      INTEGER_TOKEN.test(context.source)
    ) {
      return BigInt(context.source);
    }

    return { [MALFORMED_ID]: true };
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

  for (const [index, event] of traceEvents.entries()) {
    if (!isRecord(event)) {
      addDiagnostic(diagnostics, "INVALID_TRACE_EVENT");
      continue;
    }
    if (!EVENT_NAMES.has(event.name)) continue;
    if (event.ph !== "b" && event.ph !== "e") continue;

    if (!validTimestamp(event.ts)) {
      addDiagnostic(diagnostics, "MALFORMED_ASYNC_TIMESTAMP");
      continue;
    }

    const track = getAsyncTrack(event, diagnostics);
    if (!track) continue;

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
  return spans;
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
  return (
    isRecord(segment) &&
    segment.trace === traceName &&
    TASK6_ACTIONS.has(segment.action) &&
    validTimestamp(segment.startUs) &&
    validTimestamp(segment.endUs) &&
    segment.startUs < segment.endUs &&
    Number.isInteger(segment.rendererPid) &&
    Number.isInteger(segment.layerTreeHostId) &&
    Number.isInteger(segment.frameSource)
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

function frameIntervalsFor(traceRecord, segments, spans, diagnostics) {
  const base = { samples: [] };
  const lossReason = dataLossReason(traceRecord);
  if (lossReason !== null) {
    return {
      ...base,
      status: "unavailable",
      reasonCodes: [lossReason],
    };
  }

  if (!Array.isArray(segments) || segments.length === 0) {
    return {
      ...base,
      status: "unavailable",
      reasonCodes: ["NO_MEASUREMENT_SEGMENT"],
    };
  }

  const traceName = traceRecord?.trace;
  const traceSegments = segments.filter(
    (segment) => isRecord(segment) && segment.trace === traceName,
  );
  if (traceSegments.length === 0) {
    return {
      ...base,
      status: "unavailable",
      reasonCodes: ["NO_MEASUREMENT_SEGMENT"],
    };
  }

  const samples = [];
  const reasonCodes = new Set();
  for (const segment of traceSegments) {
    if (!validSegment(segment, traceName)) {
      addDiagnostic(diagnostics, "INVALID_MEASUREMENT_SEGMENT");
      reasonCodes.add("INVALID_MEASUREMENT_SEGMENT");
      continue;
    }

    const candidates = [];
    for (const span of spans) {
      if (span.name !== "PipelineReporter") continue;
      if (span.begin.pid !== segment.rendererPid) continue;
      if (span.end.ts < segment.startUs || span.end.ts >= segment.endUs)
        continue;

      const reporter = span.begin.args?.frame_reporter;
      if (!isRecord(reporter) || reporter.state !== PRESENTED_STATE) continue;
      const identity = frameIdentity(span, diagnostics);
      if (!identity) {
        reasonCodes.add("INCOMPLETE_FRAME_IDENTITY");
        continue;
      }
      if (
        identity.layerTreeHostId !== segment.layerTreeHostId ||
        identity.frameSource !== segment.frameSource
      ) {
        continue;
      }

      candidates.push({
        identityKey: `${identity.surface.toString()}:${identity.display.toString()}`,
        surface: identity.surface,
        display: identity.display,
        endpoint: span.end.ts,
      });
    }

    const byIdentity = new Map();
    const ambiguousIdentity = new Set();
    for (const candidate of candidates) {
      const previous = byIdentity.get(candidate.identityKey);
      if (!previous) {
        byIdentity.set(candidate.identityKey, candidate);
      } else if (previous.endpoint !== candidate.endpoint) {
        ambiguousIdentity.add(candidate.identityKey);
        addDiagnostic(diagnostics, "DUPLICATE_FRAME_IDENTITY");
        reasonCodes.add("DUPLICATE_FRAME_IDENTITY");
      }
    }

    const frames = [...byIdentity.values()]
      .filter((frame) => !ambiguousIdentity.has(frame.identityKey))
      .sort((left, right) => left.endpoint - right.endpoint);
    let segmentSamples = 0;
    for (let index = 1; index < frames.length; index += 1) {
      const previous = frames[index - 1];
      const current = frames[index];
      const intervalUs = current.endpoint - previous.endpoint;
      if (!Number.isFinite(intervalUs) || intervalUs <= 0) {
        addDiagnostic(diagnostics, "NONPOSITIVE_FRAME_INTERVAL");
        reasonCodes.add("NONPOSITIVE_FRAME_INTERVAL");
        continue;
      }
      samples.push({
        action: segment.action,
        rendererPid: segment.rendererPid,
        layerTreeHostId: segment.layerTreeHostId,
        frameSource: segment.frameSource,
        fromEndpointUs: previous.endpoint,
        toEndpointUs: current.endpoint,
        intervalUs,
      });
      segmentSamples += 1;
    }

    if (segmentSamples === 0) reasonCodes.add("NO_ADJACENT_PRESENTED_FRAMES");
  }

  return {
    status: samples.length > 0 ? "diagnostic" : "unavailable",
    samples,
    reasonCodes: [...reasonCodes].sort(),
  };
}

export function analyzeTrace(trace, traceRecord, segments = []) {
  if (
    !isRecord(trace) ||
    !Array.isArray(trace.traceEvents) ||
    !isRecord(traceRecord)
  ) {
    throw new TypeError("Analyzer requires a parsed trace and trace record.");
  }

  const diagnosticCounts = new Map();
  const spans = pairAsyncSlices(trace.traceEvents, diagnosticCounts);
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
    diagnosticCounts,
  );

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
  };
}
