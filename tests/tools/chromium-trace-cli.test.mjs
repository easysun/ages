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
