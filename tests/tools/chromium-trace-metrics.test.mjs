import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  analyzeTrace,
  parseTrace,
} from "../../scripts/chromium-trace-metrics.mjs";

const fixtures = new URL("../fixtures/chromium-traces/", import.meta.url);

function readFixture(name) {
  return readFileSync(new URL(name, fixtures), "utf8");
}

function analyzeFixture(name, traceRecord = {}) {
  const trace = parseTrace(readFixture(name));
  return analyzeTrace(trace, {
    trace: name,
    dataLossOccurred: false,
    ...traceRecord,
  });
}

function diagnosticCodes(analysis) {
  return new Set(analysis.diagnostics.map(({ code }) => code));
}

function frameReporterEvents({
  pid,
  tid = 1,
  layerTreeHostId,
  frameSource,
  surfaceId,
  displayId,
  endpoint,
}) {
  const id = "0x1";
  const common = {
    name: "PipelineReporter",
    cat: "cc,benchmark,disabled-by-default-devtools.timeline.frame",
    pid,
    tid,
    id2: { local: id },
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
  const analysis = analyzeTrace(parseTrace(text), {
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
  const analysis = analyzeTrace(parseTrace(text), {
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

  const analysis = analyzeTrace(trace, {
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

  const analysis = analyzeTrace(trace, {
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

  const analysis = analyzeTrace(trace, {
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

  const analysis = analyzeTrace(trace, {
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

  const analysis = analyzeTrace(trace, {
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

  const analysis = analyzeTrace(trace, {
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
  const analysis = analyzeTrace(parseTrace(text), {
    trace: "exact-ids.trace.json",
    dataLossOccurred: false,
  });

  assert.deepEqual(analysis.inputToPresentedFrameSamples, []);
  assert.ok(diagnosticCodes(analysis).has("MALFORMED_TRACE_ID"));
});

test("diagnoses non-object trace entries without pairing them", () => {
  const analysis = analyzeTrace(
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
    },
    {
      trace: "frames.trace.json",
      action: "scroll",
      startUs: 0,
      endUs: 60,
      rendererPid: 202,
      layerTreeHostId: 8,
      frameSource: 10,
    },
    {
      trace: "frames.trace.json",
      action: "zoom",
      startUs: 90,
      endUs: 120,
      rendererPid: 101,
      layerTreeHostId: 7,
      frameSource: 9,
    },
  ];
  const analysis = analyzeTrace(trace, traceRecord, segments);

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
  const analysis = analyzeTrace(
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
    const analysis = analyzeTrace(
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
  const analysis = analyzeTrace(
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
  };

  const noSegments = analyzeTrace(trace, {
    trace: "frames.trace.json",
    dataLossOccurred: false,
  });
  const lossy = analyzeTrace(
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
