import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  copyFileSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { arch, cpus, platform, release, totalmem } from "node:os";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ARTIFACTS = resolve(ROOT, ".superpowers/sdd/chromium-method-runner");
const RUNS = resolve(ARTIFACTS, "runs");
const INSTALLED_BRAVE_APP = "/Applications/Brave Browser.app";
const INSTALLED_BRAVE_EXECUTABLE = `${INSTALLED_BRAVE_APP}/Contents/MacOS/Brave Browser`;
const INSTALLED_BRAVE_INFO_PLIST = `${INSTALLED_BRAVE_APP}/Contents/Info.plist`;
const INSTALLED_BRAVE_QUALIFICATION = "installed-brave-schema-probe";
const CHROMIUM_LAUNCH_ARGS = [
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-sync",
  "--no-first-run",
];
const ACTIONS = [
  "open",
  "fit-all",
  "pan",
  "zoom",
  "resize",
  "append",
  "scroll",
];
const CATEGORY_CANDIDATES = [
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
];
const SAFE_CATEGORIES = new Set(CATEGORY_CANDIDATES);
const SAFE_EVENT_NAMES = new Set([
  "EventCreation",
  "EventEndTime",
  "EventFallbackTime",
  "EventLatency",
  "EventPresentation",
  "EventProcessing",
  "EventTiming",
  "EventsInAnimationFrame",
  "InputLatency::MouseUp",
  "PipelineReporter",
  "TimeStamp",
]);
const SAFE_FIELDS = {
  EventCreation: [
    "id",
    "id2.local",
    "args.event_latency.event_latency_id",
    "args.chrome_track_event.event_timing.interaction_id",
  ],
  EventEndTime: [
    "id",
    "id2.local",
    "args.event_latency.event_latency_id",
    "args.chrome_track_event.event_timing.interaction_id",
  ],
  EventFallbackTime: [
    "id2.local",
    "args.frame_index",
    "args.fallback_time",
    "args.fallback_reason",
  ],
  EventLatency: [
    "id2.local",
    "args.event_latency.event_type",
    "args.event_latency.event_latency_id",
    "args.event_latency.surface_frame_trace_id",
    "args.event_latency.display_trace_id",
  ],
  EventPresentation: [
    "id2.local",
    "args.frame_index",
    "args.presentation_time",
  ],
  EventProcessing: [
    "id2.local",
    "args.fallback_reason",
    "args.fallback_time",
    "args.chrome_track_event.event_timing.duration",
    "args.chrome_track_event.event_timing.interaction_id",
    "args.chrome_track_event.event_timing.type",
    "args.chrome_track_event.event_timing.processing_start",
    "args.chrome_track_event.event_timing.processing_end",
    "args.event_timing.duration",
  ],
  EventTiming: [
    "id",
    "id2.local",
    "args.data.interactionId",
    "args.data.duration",
    "args.chrome_track_event.event_timing.interaction_id",
  ],
  EventsInAnimationFrame: ["id2.local", "args.frame_index"],
  PipelineReporter: [
    "id2.local",
    "args.frame_reporter.state",
    "args.frame_reporter.surface_frame_trace_id",
    "args.frame_reporter.display_trace_id",
    "args.frame_reporter.layer_tree_host_id",
    "args.frame_reporter.frame_source",
  ],
  TimeStamp: ["args.data.message"],
};
const TRACE_BYTE_LIMIT = 16 * 1024 * 1024;
const TRACE_CHUNK_LIMIT = 256;
const SERVER_TIMEOUT_MS = 90_000;
const UI_TIMEOUT_MS = 120_000;
const COMPLETION_HOLD_MS = 200;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const SAFE_CHILD_ERROR_CODES = new Set([
  "E2BIG",
  "EACCES",
  "EAGAIN",
  "EBADF",
  "EBUSY",
  "ECONNRESET",
  "EPIPE",
  "EMFILE",
  "ENFILE",
  "ENOBUFS",
  "ENOENT",
  "EPERM",
  "ETIMEDOUT",
  "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
]);
const SAFE_SDK_ERROR_CODES = [
  "SQLITE_CONSTRAINT_UNIQUE",
  "SQLITE_CONSTRAINT_FOREIGNKEY",
  "SQLITE_CONSTRAINT",
  "SQLITE_CORRUPT",
  "SQLITE_FULL",
  "SQLITE_IOERR",
  "SQLITE_MISMATCH",
  "SQLITE_NOMEM",
  "SQLITE_READONLY",
  "SQLITE_TOOBIG",
  "SQLITE_BUSY",
  "SQLITE_ERROR",
  "D1_EXECUTE_ERROR",
  "D1_ERROR",
];
const CLOUD_AUTH_KEYS = [
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_API_KEY",
  "CLOUDFLARE_EMAIL",
  "CF_API_TOKEN",
  "CF_API_KEY",
];

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function safeDirectory(path) {
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("Unsafe run directory.");
  }
}

function ensureRealDirectory(path) {
  try {
    safeDirectory(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    mkdirSync(path);
    safeDirectory(path);
  }
}

function ensureArtifactRoot(artifactRoot = ARTIFACTS) {
  const runsRoot = resolve(artifactRoot, "runs");
  for (const path of [
    resolve(ROOT, ".superpowers"),
    resolve(ROOT, ".superpowers/sdd"),
    artifactRoot,
  ]) {
    ensureRealDirectory(path);
  }
  const ignorePath = resolve(artifactRoot, ".gitignore");
  try {
    const info = lstatSync(ignorePath);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error("Unsafe local artifact ignore file.");
    }
    const contents = readFileSync(ignorePath, "utf8");
    const rules = contents.split(/\r?\n/);
    if (!rules.includes("*") || !rules.includes("!.gitignore")) {
      throw new Error("Local artifact ignore file does not ignore run data.");
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    writeFileSync(ignorePath, "*\n!.gitignore\n", { flag: "wx" });
  }
  ensureRealDirectory(runsRoot);
  return { artifactRoot, runsRoot };
}

export function createRunDirectory(runsRoot, runId) {
  if (
    typeof runId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,100}$/.test(runId)
  ) {
    throw new Error("Run ID must be a safe run ID.");
  }
  try {
    safeDirectory(runsRoot);
  } catch {
    throw new Error("Unsafe run root.");
  }
  const root = resolve(runsRoot);
  const destination = resolve(root, runId);
  if (dirname(destination) !== root) {
    throw new Error("Run ID must be a safe run ID.");
  }
  try {
    mkdirSync(destination, { recursive: false });
  } catch (error) {
    if (error.code === "EEXIST")
      throw new Error("Run directory already exists.");
    throw error;
  }
  safeDirectory(destination);
  return destination;
}

function writeNewFile(path, contents) {
  writeFileSync(path, contents, { flag: "wx" });
}

export function describeTraceArtifact(path) {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error("Trace artifact must be a regular file.");
  }
  const bytes = readFileSync(path);
  return {
    byteCount: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export function verifyTraceArtifact(path, expected) {
  try {
    const current = describeTraceArtifact(path);
    return (
      isRecord(expected) &&
      current.byteCount === expected.byteCount &&
      current.sha256 === expected.sha256
    );
  } catch {
    return false;
  }
}

export function parseRunnerArgs(args) {
  if (args.length === 0) return { mode: "preview" };
  if (args.length === 1 && args[0] === "--run") return { mode: "run" };
  if (
    args.length === 2 &&
    args[0] === "--run" &&
    args[1] === "--browser=installed-brave"
  ) {
    return { mode: "run", browser: "installed-brave" };
  }
  throw new Error("unsupported capture option");
}

export function artifactRootsForBrowser(browser = "playwright-chromium") {
  if (browser === "playwright-chromium") {
    return { artifactRoot: ARTIFACTS, runsRoot: RUNS };
  }
  if (browser === "installed-brave") {
    const artifactRoot = resolve(
      ROOT,
      ".superpowers/sdd/installed-brave-schema-probe",
    );
    return { artifactRoot, runsRoot: resolve(artifactRoot, "runs") };
  }
  throw new Error("unsupported capture option");
}

export function buildChromiumLaunchOptions(browser = "playwright-chromium") {
  if (browser !== "playwright-chromium" && browser !== "installed-brave") {
    throw new Error("unsupported capture option");
  }
  return {
    headless: false,
    ...(browser === "installed-brave"
      ? { executablePath: INSTALLED_BRAVE_EXECUTABLE }
      : {}),
    args: [...CHROMIUM_LAUNCH_ARGS],
  };
}

function readInstalledBraveBundleInfo() {
  const json = execFileSync(
    "/usr/bin/plutil",
    ["-convert", "json", "-o", "-", "--", INSTALLED_BRAVE_INFO_PLIST],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  const bundleInfo = JSON.parse(json);
  if (!isRecord(bundleInfo)) throw new Error("invalid bundle metadata");
  return bundleInfo;
}

function safeBundleVersion(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 100 &&
    /^[A-Za-z0-9._+-]+$/.test(value)
  );
}

export function validateInstalledBraveInstallation({
  lstat = lstatSync,
  readBundleInfo = readInstalledBraveBundleInfo,
} = {}) {
  try {
    for (const path of [
      "/Applications",
      INSTALLED_BRAVE_APP,
      `${INSTALLED_BRAVE_APP}/Contents`,
      `${INSTALLED_BRAVE_APP}/Contents/MacOS`,
    ]) {
      const info = lstat(path);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new Error("invalid bundle directory");
      }
    }

    const executable = lstat(INSTALLED_BRAVE_EXECUTABLE);
    if (
      executable.isSymbolicLink() ||
      !executable.isFile() ||
      (executable.mode & 0o111) === 0
    ) {
      throw new Error("invalid browser executable");
    }

    const plist = lstat(INSTALLED_BRAVE_INFO_PLIST);
    if (plist.isSymbolicLink() || !plist.isFile()) {
      throw new Error("invalid bundle metadata file");
    }
    const bundleInfo = readBundleInfo(INSTALLED_BRAVE_INFO_PLIST);
    if (
      !isRecord(bundleInfo) ||
      bundleInfo.CFBundleIdentifier !== "com.brave.Browser" ||
      !safeBundleVersion(bundleInfo.CFBundleShortVersionString) ||
      !safeBundleVersion(bundleInfo.CFBundleVersion)
    ) {
      throw new Error("invalid bundle identity");
    }
    return bundleInfo;
  } catch {
    throw new Error("INSTALLED_BRAVE_UNAVAILABLE");
  }
}

function hashInstalledBraveExecutable() {
  let descriptor;
  try {
    descriptor = openSync(
      INSTALLED_BRAVE_EXECUTABLE,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const info = fstatSync(descriptor);
    if (!info.isFile() || (info.mode & 0o111) === 0) {
      throw new Error("invalid browser executable");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(1024 * 1024);
    let bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
    while (bytesRead > 0) {
      hash.update(buffer.subarray(0, bytesRead));
      bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
    }
    return hash.digest("hex");
  } catch {
    throw new Error("INSTALLED_BRAVE_UNAVAILABLE");
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {}
    }
  }
}

function safeBrowserObservation(value, limit) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= limit &&
    /^[A-Za-z0-9 (),._/;+ -]+$/.test(value)
  );
}

function safeBrowserRevision(value) {
  return (
    typeof value === "string" &&
    (/^@[a-f0-9]{39,40}$/i.test(value) || /^[a-f0-9]{40}$/i.test(value))
  );
}

export function buildInstalledBraveBrowserIdentity({
  bundleInfo,
  executableSha256,
  runtime,
}) {
  if (
    !isRecord(bundleInfo) ||
    bundleInfo.CFBundleIdentifier !== "com.brave.Browser" ||
    !safeBundleVersion(bundleInfo.CFBundleShortVersionString) ||
    !safeBundleVersion(bundleInfo.CFBundleVersion) ||
    typeof executableSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(executableSha256) ||
    !isRecord(runtime) ||
    !safeBrowserObservation(runtime.version, 100) ||
    !safeBrowserObservation(runtime.product, 256) ||
    !safeBrowserRevision(runtime.revision) ||
    !safeBrowserObservation(runtime.userAgent, 512)
  ) {
    throw new Error("BROWSER_METADATA_UNAVAILABLE");
  }
  const scmRevision = bundleInfo.SCMRevision;
  return {
    bundle: {
      identifier: "com.brave.Browser",
      shortVersion: bundleInfo.CFBundleShortVersionString,
      bundleVersion: bundleInfo.CFBundleVersion,
      ...(typeof scmRevision === "string" &&
      /^[a-f0-9]{7,64}$/i.test(scmRevision)
        ? { scmRevision }
        : {}),
    },
    executableSha256,
    runtime: {
      version: runtime.version,
      product: runtime.product,
      revision: runtime.revision,
      userAgent: runtime.userAgent,
    },
    chromiumSourceIdentity: "unverified",
  };
}

export function qualifyInstalledBraveProbeEvidence(cases, measurementSegments) {
  const inputToNextPaint = {
    status: "unproven",
    reasonCode: "NEXT_PAINT_METHOD_UNPROVEN",
  };
  return {
    cases: cases.map((caseRecord) => ({
      ...caseRecord,
      qualification: INSTALLED_BRAVE_QUALIFICATION,
      inputToNextPaint,
    })),
    measurementSegments: measurementSegments.map((segment) => ({
      ...segment,
      qualification: INSTALLED_BRAVE_QUALIFICATION,
      inputToNextPaint,
    })),
  };
}

export function validateCaptureTimeMetadata(metadata) {
  const version = metadata?.browser?.version;
  if (typeof version !== "string" || version.trim().length === 0) {
    throw new Error("capture-time browser version is required");
  }
  const started = Date.parse(metadata.captureStartedAtUtc);
  const ended = Date.parse(metadata.captureEndedAtUtc);
  if (
    typeof metadata.captureStartedAtUtc !== "string" ||
    typeof metadata.captureEndedAtUtc !== "string" ||
    !Number.isFinite(started) ||
    !Number.isFinite(ended) ||
    started >= ended
  ) {
    throw new Error("capture timestamps must be valid and ordered");
  }
  return true;
}

function readPath(value, path) {
  let current = value;
  for (const part of path.split(".")) {
    if (!isRecord(current) || !Object.hasOwn(current, part)) return undefined;
    current = current[part];
  }
  return current;
}

function valueType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  return typeof value;
}

export function summarizeTraceEvidence(traceEvents, enabledCategories) {
  const eventCounts = new Map();
  const fieldTypes = new Map();
  const observedCategories = new Set();
  const events = Array.isArray(traceEvents) ? traceEvents : [];

  for (const event of events) {
    if (!isRecord(event) || !SAFE_EVENT_NAMES.has(event.name)) continue;
    eventCounts.set(event.name, (eventCounts.get(event.name) ?? 0) + 1);
    if (typeof event.cat === "string") {
      for (const category of event.cat.split(",")) {
        if (SAFE_CATEGORIES.has(category)) observedCategories.add(category);
      }
    }
    for (const path of SAFE_FIELDS[event.name] ?? []) {
      const value = readPath(event, path);
      if (value === undefined) continue;
      const fields = fieldTypes.get(event.name) ?? new Map();
      fields.set(path, valueType(value));
      fieldTypes.set(event.name, fields);
    }
  }

  const sortObject = (entries) =>
    Object.fromEntries(
      [...entries].sort(([left], [right]) => left.localeCompare(right)),
    );
  return {
    enabledCategories: [...new Set(enabledCategories)]
      .filter((category) => SAFE_CATEGORIES.has(category))
      .sort(),
    observedCategories: [...observedCategories].sort(),
    eventCounts: sortObject(eventCounts),
    fieldTypes: Object.fromEntries(
      [...fieldTypes]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, fields]) => [name, sortObject(fields)]),
    ),
  };
}

function timestampMarkers(events, label) {
  return events.filter(
    (event) =>
      isRecord(event) &&
      event.name === "TimeStamp" &&
      (event.ph === "I" || event.ph === "R") &&
      typeof event.ts === "number" &&
      Number.isFinite(event.ts) &&
      Number.isInteger(event.pid) &&
      typeof event.cat === "string" &&
      event.cat
        .split(",")
        .some((category) =>
          ["devtools.timeline", "blink.user_timing"].includes(category),
        ) &&
      event.args?.data?.message === label,
  );
}

function unavailable(reasonCode) {
  return { status: "unavailable", reasonCode };
}

function pipelineReporterSpans(events) {
  const groups = new Map();
  const malformedBegins = [];
  for (const [index, event] of events.entries()) {
    if (!isRecord(event) || event.name !== "PipelineReporter") continue;
    if (event.ph !== "b" && event.ph !== "e") continue;
    if (
      !Number.isInteger(event.pid) ||
      !Number.isInteger(event.tid) ||
      typeof event.cat !== "string" ||
      !event.cat.split(",").includes("cc") ||
      typeof event.id2?.local !== "string" ||
      event.id2.local.length === 0 ||
      !Number.isFinite(event.ts)
    ) {
      if (event.ph === "b") malformedBegins.push(event);
      continue;
    }
    const key = JSON.stringify([
      event.pid,
      event.tid,
      event.cat,
      event.id2.local,
    ]);
    const items = groups.get(key) ?? [];
    items.push({ event, index });
    groups.set(key, items);
  }

  const spans = [];
  const ambiguousGroups = [];
  for (const items of groups.values()) {
    items.sort((left, right) =>
      left.event.ts === right.event.ts
        ? left.index - right.index
        : left.event.ts - right.event.ts,
    );
    const pending = [];
    let ambiguous = false;
    for (const item of items) {
      if (item.event.ph === "b") {
        if (pending.length > 0) ambiguous = true;
        pending.push(item);
      } else if (pending.length === 1) {
        const begin = pending.pop();
        if (begin.event.ts <= item.event.ts) {
          spans.push({ begin: begin.event, end: item.event });
        } else {
          ambiguous = true;
        }
      } else {
        ambiguous = true;
      }
    }
    if (pending.length > 0) ambiguous = true;
    if (ambiguous) ambiguousGroups.push(items.map(({ event }) => event));
  }
  return { spans, ambiguousGroups, malformedBegins };
}

export function buildMeasurementSegment({
  trace,
  action,
  traceEvents,
  startMarker,
  endMarker,
  activeWindows,
}) {
  const events = Array.isArray(traceEvents) ? traceEvents : [];
  if (
    typeof trace !== "string" ||
    !trace.endsWith(".trace.json") ||
    !ACTIONS.includes(action) ||
    typeof startMarker !== "string" ||
    typeof endMarker !== "string" ||
    !Array.isArray(activeWindows) ||
    activeWindows.length === 0 ||
    activeWindows.length > 120
  ) {
    return unavailable("TRACE_SEGMENT_INVALID");
  }

  const windows = [];
  const labels = [startMarker];
  const ids = new Set();
  for (const window of activeWindows) {
    if (
      !isRecord(window) ||
      typeof window.id !== "string" ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(window.id) ||
      ids.has(window.id) ||
      typeof window.startMarker !== "string" ||
      typeof window.endMarker !== "string"
    ) {
      return unavailable("TRACE_SEGMENT_INVALID");
    }
    ids.add(window.id);
    labels.push(window.startMarker, window.endMarker);
    windows.push(window);
  }
  labels.push(endMarker);

  const markerEvents = new Map();
  for (const label of new Set(labels)) {
    const matches = timestampMarkers(events, label);
    if (matches.length === 0) return unavailable("TRACE_MARKER_MISSING");
    if (matches.length !== 1) return unavailable("TRACE_MARKER_AMBIGUOUS");
    markerEvents.set(label, matches[0]);
  }

  const orderedMarkers = [];
  for (const label of labels) {
    if (orderedMarkers.at(-1)?.label === label) continue;
    if (orderedMarkers.some((item) => item.label === label)) {
      return unavailable("TRACE_SEGMENT_INVALID");
    }
    orderedMarkers.push({ label, event: markerEvents.get(label) });
  }
  for (let index = 1; index < orderedMarkers.length; index += 1) {
    if (orderedMarkers[index - 1].event.ts >= orderedMarkers[index].event.ts) {
      return unavailable("TRACE_MARKER_NON_MONOTONIC");
    }
    if (
      orderedMarkers[index - 1].event.pid !== orderedMarkers[index].event.pid
    ) {
      return unavailable("TRACE_MARKER_PID_MISMATCH");
    }
  }

  const start = markerEvents.get(startMarker);
  const end = markerEvents.get(endMarker);
  const resolvedWindows = [];
  let previousEnd = start.ts;
  for (const window of windows) {
    const windowStart = markerEvents.get(window.startMarker);
    const windowEnd = markerEvents.get(window.endMarker);
    if (
      windowStart.ts < start.ts ||
      windowEnd.ts > end.ts ||
      windowStart.ts >= windowEnd.ts ||
      windowStart.ts < previousEnd
    ) {
      return unavailable("TRACE_MARKER_NON_MONOTONIC");
    }
    previousEnd = windowEnd.ts;
    resolvedWindows.push({
      id: window.id,
      startUs: windowStart.ts,
      endUs: windowEnd.ts,
    });
  }

  const reporterEvidence = pipelineReporterSpans(events);
  const overlapsSegment = (event) =>
    Number.isFinite(event?.ts) && event.ts >= start.ts && event.ts <= end.ts;
  if (
    reporterEvidence.ambiguousGroups.some((group) =>
      group.some((event) => event.pid === start.pid && overlapsSegment(event)),
    )
  ) {
    return unavailable("FRAME_STREAM_AMBIGUOUS");
  }
  const streamIds = new Set();
  for (const window of resolvedWindows) {
    const presenters = reporterEvidence.spans.filter(
      ({ begin, end: spanEnd }) =>
        begin.pid === start.pid &&
        spanEnd.ts >= window.startUs &&
        spanEnd.ts < window.endUs &&
        begin.args?.frame_reporter?.state === "STATE_PRESENTED_ALL",
    );
    if (presenters.length === 0) return unavailable("FRAME_STREAM_MISSING");
    for (const { begin } of presenters) {
      const reporter = begin.args?.frame_reporter;
      if (
        !isRecord(reporter) ||
        !Number.isInteger(reporter.layer_tree_host_id) ||
        !Number.isInteger(reporter.frame_source) ||
        reporter.layer_tree_host_id < 0 ||
        reporter.frame_source < 0
      ) {
        return unavailable("FRAME_STREAM_IDENTITY_MISSING");
      }
      streamIds.add(
        JSON.stringify([
          begin.pid,
          reporter.layer_tree_host_id,
          reporter.frame_source,
        ]),
      );
    }
  }
  if (
    reporterEvidence.malformedBegins.some(
      (event) => event.pid === start.pid && overlapsSegment(event),
    )
  ) {
    return unavailable("FRAME_STREAM_IDENTITY_MISSING");
  }
  if (streamIds.size !== 1) return unavailable("FRAME_STREAM_AMBIGUOUS");
  const [rendererPid, layerTreeHostId, frameSource] = JSON.parse(
    [...streamIds][0],
  );

  return {
    status: "resolved",
    segment: {
      trace,
      action,
      startUs: start.ts,
      endUs: end.ts,
      rendererPid,
      layerTreeHostId,
      frameSource,
      activeWindows: resolvedWindows,
    },
  };
}

export function buildCaptureCases() {
  return [
    { workload: "100-interactive", rowCount: 100 },
    { workload: "10000-chronological", rowCount: 10_000 },
  ].flatMap(({ workload, rowCount }) =>
    ACTIONS.map((action) => ({ workload, rowCount, action })),
  );
}

const SAFE_FAILURE_STAGES = new Set([
  "preflight",
  "browser-installation-preflight",
  "workspace",
  "server-startup",
  "browser-startup",
  "seed-library",
  "manifest",
  "owned-process-cleanup",
  ...["seed-fixture", "capture"].flatMap((kind) =>
    buildCaptureCases().map(
      ({ workload, action }) => `${kind}:${workload}:${action}`,
    ),
  ),
]);
const SAFE_CLEANUP_STEPS = new Set([
  "terminate-process-group",
  "probe-process-group",
  "kill-process-group",
]);
const MAX_OWNED_PROCESS_GROUP_MEMBERS = 256;
const SAFE_PROCESS_GROUP_STATES = [
  "running",
  "sleeping",
  "idle",
  "uninterruptible",
  "stopped",
  "zombie",
  "other",
];
const SAFE_ACTION_DIAGNOSTIC_PHASES = new Set([
  "append-input",
  "append-request-start",
  "append-progress-indicator",
  "append-immediate-paint",
  "append-completion-hold",
  "append-response-headers",
  "append-commit-ack",
  "append-write-ack-marker",
  "append-visible-count",
  "append-completion-paint",
  "fit-all-initial-bounds",
  "fit-all-zoom-in",
  "fit-all-pan-earlier",
  "fit-all-button",
]);
const SAFE_ACTION_DIAGNOSTIC_REASONS = new Set([
  "ACTION_TIMEOUT",
  "APPEND_REQUEST_START_FAILED",
  "APPEND_PROGRESS_INDICATOR_FAILED",
  "APPEND_IMMEDIATE_PAINT_FAILED",
  "APPEND_RESPONSE_HEADERS_FAILED",
  "APPEND_COMMIT_ACK_FAILED",
  "APPEND_VISIBLE_COMPLETION_FAILED",
  "APPEND_GROUND_TRUTH_FAILED",
  "FIT_ALL_GROUND_TRUTH_FAILED",
  "MANUAL_FRAME_NOT_CHANGED",
  "VIEWPORT_BOUNDS_UNAVAILABLE",
]);
const SAFE_VIEWPORT_BOUND_KEYS = new Set([
  "initial",
  "manualZoom",
  "manualPan",
  "fitAll",
]);
const SAFE_VIEWPORT_METRICS = ["center", "span", "extent", "width"];
const SAFE_CONTROL_MATCH_KEYS = ["zoomIn", "panEarlier", "fitAll"];

export function summarizeSafeFailure(
  error,
  stage,
  traceCategoryCatalogReadCount,
) {
  const summary = {
    stage: SAFE_FAILURE_STAGES.has(stage) ? stage : "unknown",
  };
  if (
    Number.isInteger(traceCategoryCatalogReadCount) &&
    traceCategoryCatalogReadCount >= 1 &&
    traceCategoryCatalogReadCount <= 2
  ) {
    summary.traceCategoryCatalogReadCount = traceCategoryCatalogReadCount;
  }
  if (
    Number.isInteger(error?.status) &&
    error.status > 0 &&
    error.status <= 255
  ) {
    summary.childExitCode = error.status;
  }
  if (SAFE_CHILD_ERROR_CODES.has(error?.code)) {
    summary.processErrorCode = error.code;
  }
  if (SAFE_CLEANUP_STEPS.has(error?.cleanupStep)) {
    summary.cleanupStep = error.cleanupStep;
  }
  if (isRecord(error?.processGroupSnapshot)) {
    const source = error.processGroupSnapshot;
    const snapshot = {};
    for (const key of ["snapshotAvailable", "childExitKnown", "sameUidKnown"]) {
      if (typeof source[key] === "boolean") snapshot[key] = source[key];
    }
    for (const key of ["memberCount", "sameUidCount"]) {
      if (
        Number.isInteger(source[key]) &&
        source[key] >= 0 &&
        source[key] <= MAX_OWNED_PROCESS_GROUP_MEMBERS
      ) {
        snapshot[key] = source[key];
      }
    }
    if (isRecord(source.stateCounts)) {
      const stateCounts = {};
      for (const state of SAFE_PROCESS_GROUP_STATES) {
        const count = source.stateCounts[state];
        if (
          Number.isInteger(count) &&
          count >= 0 &&
          count <= MAX_OWNED_PROCESS_GROUP_MEMBERS
        ) {
          stateCounts[state] = count;
        }
      }
      if (Object.keys(stateCounts).length === SAFE_PROCESS_GROUP_STATES.length)
        snapshot.stateCounts = stateCounts;
    }
    if (Object.keys(snapshot).length > 0)
      summary.processGroupSnapshot = snapshot;
  }
  const outputs = [error?.stderr, error?.stdout];
  for (const output of outputs) {
    const text = Buffer.isBuffer(output)
      ? output.subarray(0, 64 * 1024).toString("utf8")
      : typeof output === "string"
        ? output.slice(0, 64 * 1024)
        : "";
    const sdkErrorCode = SAFE_SDK_ERROR_CODES.find((code) =>
      text.includes(code),
    );
    if (sdkErrorCode) {
      summary.sdkErrorCode = sdkErrorCode;
      break;
    }
  }
  return summary;
}

export function serializeActionDiagnostic(diagnostic) {
  if (!isRecord(diagnostic)) return null;
  const result = {};
  if (SAFE_ACTION_DIAGNOSTIC_PHASES.has(diagnostic.phase))
    result.phase = diagnostic.phase;
  if (SAFE_ACTION_DIAGNOSTIC_REASONS.has(diagnostic.reasonCode))
    result.reasonCode = diagnostic.reasonCode;
  for (const key of [
    "responseHeadersReceived",
    "responseFinished",
    "responseFinishWaitSkippedFor204",
    "commitAcknowledged",
  ]) {
    if (typeof diagnostic[key] === "boolean") result[key] = diagnostic[key];
  }
  if (
    Number.isInteger(diagnostic.responseStatus) &&
    diagnostic.responseStatus >= 100 &&
    diagnostic.responseStatus <= 599
  ) {
    result.responseStatus = diagnostic.responseStatus;
  }
  if (isRecord(diagnostic.controlMatchCounts)) {
    const counts = {};
    for (const key of SAFE_CONTROL_MATCH_KEYS) {
      const count = diagnostic.controlMatchCounts[key];
      if (Number.isInteger(count) && count >= 0 && count <= 100)
        counts[key] = count;
    }
    if (Object.keys(counts).length > 0) result.controlMatchCounts = counts;
  }
  if (isRecord(diagnostic.viewportBounds)) {
    const bounds = {};
    for (const key of SAFE_VIEWPORT_BOUND_KEYS) {
      const value = diagnostic.viewportBounds[key];
      if (!isRecord(value)) continue;
      const metrics = {};
      for (const metric of SAFE_VIEWPORT_METRICS) {
        if (Number.isFinite(value[metric])) metrics[metric] = value[metric];
      }
      if (Object.keys(metrics).length === SAFE_VIEWPORT_METRICS.length)
        bounds[key] = metrics;
    }
    if (Object.keys(bounds).length > 0) result.viewportBounds = bounds;
  }
  return Object.keys(result).length > 0 ? result : null;
}

export function buildSyntheticTimelineQuotaSql(owner, limit) {
  if (
    typeof owner !== "string" ||
    owner.length === 0 ||
    owner.length > 128 ||
    !Number.isSafeInteger(limit) ||
    limit < 0
  ) {
    throw new Error("SYNTHETIC_TIMELINE_QUOTA_INVALID");
  }
  const escapedOwner = owner.replaceAll("'", "''");
  return `UPDATE usage_quotas SET timeline_limit=${limit} WHERE user_id='${escapedOwner}';`;
}

export function probeTraceCategories(availableCategories) {
  const available = new Set(
    Array.isArray(availableCategories)
      ? availableCategories.filter((category) => typeof category === "string")
      : [],
  );
  return {
    available: CATEGORY_CANDIDATES.filter((category) =>
      available.has(category),
    ).sort(),
    unavailable: CATEGORY_CANDIDATES.filter(
      (category) => !available.has(category),
    ).sort(),
  };
}

export function requireTraceCategories(categoryAvailability) {
  if (
    !Array.isArray(categoryAvailability?.available) ||
    categoryAvailability.available.length === 0
  ) {
    throw new Error("TRACE_CATEGORIES_UNAVAILABLE");
  }
  return categoryAvailability.available;
}

export async function readTraceCategoriesForMode({
  browser,
  context,
  page,
  browserMode,
  onRead,
}) {
  const session =
    browserMode === "installed-brave"
      ? await browser.newBrowserCDPSession()
      : await context.newCDPSession(page);
  try {
    let readCount = 0;
    const readCategories = async () => {
      const response = await session.send("Tracing.getCategories");
      readCount += 1;
      onRead?.(readCount);
      return response?.categories;
    };
    const categories = await readCategories();
    if (
      browserMode === "installed-brave" &&
      Array.isArray(categories) &&
      categories.length === 0
    ) {
      return await readCategories();
    }
    return categories;
  } finally {
    await session.detach();
  }
}

export function isInitialChronologicalOverviewRequest(url, timelineId) {
  return (
    url instanceof URL &&
    url.pathname === `/api/timelines/${timelineId}/overview` &&
    url.searchParams.get("projection") === "chronological" &&
    !url.searchParams.has("version") &&
    !url.searchParams.has("cursor")
  );
}

export function parseViewportAttributes(attributes) {
  const numberFromString = (value) =>
    typeof value === "string" && value.trim().length > 0
      ? Number(value)
      : Number.NaN;
  return {
    center: numberFromString(attributes.center),
    span: numberFromString(attributes.span),
    extent: numberFromString(attributes.extent),
    width: Number.isFinite(attributes.width) ? attributes.width : Number.NaN,
  };
}

export function outcomeStatus({
  actionOutcome,
  actionFailureCode,
  captureFailureCode,
}) {
  if (actionOutcome && !actionFailureCode) return { actionStatus: "completed" };
  return {
    actionStatus: "unavailable",
    actionReasonCode:
      actionFailureCode ?? captureFailureCode ?? "ACTION_INCOMPLETE",
  };
}

export function isLoopbackUrl(value) {
  try {
    const url = new URL(value);
    if (["data:", "blob:"].includes(url.protocol)) return true;
    return (
      ["http:", "https:", "ws:", "wss:"].includes(url.protocol) &&
      LOOPBACK_HOSTS.has(url.hostname)
    );
  } catch {
    return false;
  }
}

export async function readTraceStream(session, handle, onChunk) {
  let total = 0;
  for (let index = 0; index < TRACE_CHUNK_LIMIT; index += 1) {
    const part = await session.send("IO.read", { handle, size: 64 * 1024 });
    const bytes = part.base64Encoded
      ? Buffer.from(part.data, "base64")
      : Buffer.from(part.data);
    if (total + bytes.length > TRACE_BYTE_LIMIT) {
      throw new Error("TRACE_BYTE_LIMIT");
    }
    onChunk(bytes);
    total += bytes.length;
    if (part.eof) return total;
  }
  throw new Error("TRACE_CHUNK_LIMIT");
}

export function buildLocalWorkerConfig(source, databaseId, kvId, app) {
  const sourceDatabase = source.d1_databases?.find(
    ({ binding }) => binding === "DB",
  );
  if (!source.name || !sourceDatabase?.database_name) {
    throw new Error("LOCAL_WORKER_CONFIG_INVALID");
  }
  const config = {
    $schema: resolve(ROOT, "node_modules/wrangler/config-schema.json"),
    name: source.name,
    main: resolve(ROOT, source.main),
    compatibility_date: source.compatibility_date,
    compatibility_flags: source.compatibility_flags,
    workers_dev: false,
    preview_urls: false,
    send_metrics: false,
    vars: { APP_ENV: "local" },
    d1_databases: source.d1_databases.map((database) => ({
      ...database,
      database_id: databaseId,
      migrations_dir: database.migrations_dir
        ? resolve(ROOT, database.migrations_dir)
        : resolve(ROOT, "migrations"),
    })),
  };
  if (app) {
    if (!Array.isArray(source.r2_buckets) || source.r2_buckets.length === 0) {
      throw new Error("LOCAL_WORKER_CONFIG_INVALID");
    }
    Object.assign(config, {
      assets: {
        ...source.assets,
        directory: resolve(ROOT, source.assets.directory),
      },
      r2_buckets: source.r2_buckets.map((bucket) => ({ ...bucket })),
      kv_namespaces: [{ binding: "LINK_CACHE", id: kvId }],
    });
  }
  return config;
}

function prepareWorkspace(runDirectory) {
  const workspace = resolve(runDirectory, "workspace");
  mkdirSync(workspace);
  mkdirSync(resolve(workspace, "tests"));
  mkdirSync(resolve(workspace, "tests/e2e"));
  const dependencies = resolve(ROOT, "node_modules");
  const dependenciesInfo = lstatSync(dependencies);
  if (!dependenciesInfo.isDirectory() || dependenciesInfo.isSymbolicLink()) {
    throw new Error("LOCAL_DEPENDENCIES_UNAVAILABLE");
  }
  for (const path of [
    resolve(dependencies, "wrangler/config-schema.json"),
    resolve(ROOT, "dist/client"),
    resolve(ROOT, "migrations"),
  ]) {
    lstatSync(path);
  }

  const databaseId = randomUUID();
  const kvId = randomUUID().replaceAll("-", "");
  const app = JSON.parse(readFileSync(resolve(ROOT, "wrangler.jsonc"), "utf8"));
  const tracking = JSON.parse(
    readFileSync(resolve(ROOT, "wrangler.tracking.jsonc"), "utf8"),
  );
  writeNewFile(
    resolve(workspace, "wrangler.jsonc"),
    JSON.stringify(
      buildLocalWorkerConfig(app, databaseId, kvId, true),
      null,
      2,
    ),
  );
  writeNewFile(
    resolve(workspace, "wrangler.tracking.jsonc"),
    JSON.stringify(
      buildLocalWorkerConfig(tracking, databaseId, kvId, false),
      null,
      2,
    ),
  );
  for (const file of ["start-server.mjs", "gateway.mjs"]) {
    copyFileSync(
      resolve(ROOT, "tests/e2e", file),
      resolve(workspace, "tests/e2e", file),
      constants.COPYFILE_EXCL,
    );
  }
  symlinkSync(dependencies, resolve(workspace, "node_modules"), "dir");
  return { workspace };
}

function stripCloudAuth() {
  for (const key of CLOUD_AUTH_KEYS) delete process.env[key];
  process.env.WRANGLER_SEND_METRICS = "false";
}

function deferred() {
  let resolvePromise;
  const promise = new Promise((resolveValue) => {
    resolvePromise = resolveValue;
  });
  return { promise, resolve: resolvePromise };
}

function withTimeout(promise, timeoutMs, reasonCode) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(reasonCode)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function waitForOwnedReadiness(
  child,
  appPort,
  trackingPort,
  timeoutMs = SERVER_TIMEOUT_MS,
) {
  if (!child.stdout || !child.stderr) {
    return Promise.reject(new Error("OWNED_SERVER_OUTPUT_UNAVAILABLE"));
  }
  let appReady = false;
  let trackingReady = false;
  let line = [];
  let oversized = false;
  let settled = false;
  let timer;
  return new Promise((resolveReady, rejectReady) => {
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("error", onError);
      child.off("exit", onExit);
      child.stdout.off("close", onStdoutClose);
      if (error) rejectReady(error);
      else resolveReady();
    };
    const onError = () => finish(new Error("OWNED_SERVER_START_FAILED"));
    const onExit = () => finish(new Error("OWNED_SERVER_EXITED_EARLY"));
    const onStdoutClose = () => finish(new Error("OWNED_SERVER_OUTPUT_CLOSED"));
    child.stdout.on("data", (chunk) => {
      if (settled) return;
      for (const byte of chunk) {
        if (byte === 10) {
          if (!oversized) {
            const message = Buffer.from(line)
              .toString("utf8")
              .replace(/\r$/, "");
            if (message === `App origin: http://127.0.0.1:${appPort}`)
              appReady = true;
            if (message === `Tracking origin: http://localhost:${trackingPort}`)
              trackingReady = true;
          }
          line = [];
          oversized = false;
          if (appReady && trackingReady) finish();
        } else if (line.length < 256) {
          if (!oversized) line.push(byte);
        } else {
          line = [];
          oversized = true;
        }
      }
    });
    child.stderr.on("data", () => {});
    child.on("error", onError);
    child.on("exit", onExit);
    child.stdout.on("close", onStdoutClose);
    timer = setTimeout(
      () => finish(new Error("OWNED_SERVER_READINESS_TIMEOUT")),
      timeoutMs,
    );
    if (child.exitCode !== null || child.signalCode !== null) onExit();
  });
}

function waitForChildClose(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve();
  return new Promise((done) => {
    const onClose = () => {
      clearTimeout(timer);
      done();
    };
    const timer = setTimeout(() => {
      child.off("close", onClose);
      done();
    }, timeoutMs);
    child.once("close", onClose);
  });
}

export async function stopOwnedProcess(
  child,
  graceMs = 5000,
  readProcessTable,
) {
  if (!child?.pid) return;
  const group = -child.pid;
  if (
    !signalOwnedGroup(
      group,
      "SIGTERM",
      "terminate-process-group",
      child,
      readProcessTable,
    )
  )
    return;
  await waitForOwnedGroupDisappearance(child, graceMs, readProcessTable);
  if (
    !signalOwnedGroup(group, 0, "probe-process-group", child, readProcessTable)
  )
    return;
  if (
    !signalOwnedGroup(
      group,
      "SIGKILL",
      "kill-process-group",
      child,
      readProcessTable,
    )
  )
    return;
  await waitForChildClose(child, 1000);
}

async function waitForOwnedGroupDisappearance(
  child,
  graceMs,
  readProcessTable,
) {
  const deadline = performance.now() + graceMs;
  while (true) {
    const remainingMs = deadline - performance.now();
    if (remainingMs <= 0) return;
    const snapshotTimeoutMs = Math.max(
      1,
      Math.min(1500, Math.ceil(remainingMs)),
    );
    const snapshot = snapshotOwnedProcessGroup(
      child,
      readProcessTable,
      snapshotTimeoutMs,
    );
    if (snapshot.snapshotAvailable && snapshot.memberCount === 0) return;

    const remainingAfterReadMs = deadline - performance.now();
    if (remainingAfterReadMs <= 0) return;
    await new Promise((resolveWait) =>
      setTimeout(resolveWait, Math.min(100, remainingAfterReadMs)),
    );
  }
}

export function snapshotOwnedProcessGroup(
  child,
  readProcessTable,
  timeoutMs = 1500,
) {
  const childExitKnown = child?.exitCode != null || child?.signalCode != null;
  const groupId = child?.pid;
  const unavailable = { snapshotAvailable: false, childExitKnown };
  if (!Number.isSafeInteger(groupId) || groupId <= 0) return unavailable;

  try {
    const output =
      typeof readProcessTable === "function"
        ? readProcessTable(timeoutMs)
        : execFileSync("ps", ["-axo", "pid=,ppid=,pgid=,uid=,stat="], {
            encoding: "utf8",
            maxBuffer: 256 * 1024,
            stdio: ["ignore", "pipe", "ignore"],
            timeout: timeoutMs,
          });
    if (typeof output !== "string") return unavailable;
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    const stateCounts = Object.fromEntries(
      SAFE_PROCESS_GROUP_STATES.map((state) => [state, 0]),
    );
    let memberCount = 0;
    let sameUidCount = 0;

    for (const line of output.split(/\r?\n/)) {
      if (line.trim() === "") continue;
      const fields = line.trim().split(/\s+/);
      if (
        fields.length !== 5 ||
        fields.slice(0, 4).some((field) => !/^\d+$/.test(field)) ||
        !/^[A-Za-z+?<>-]+$/.test(fields[4])
      ) {
        return unavailable;
      }
      const [pid, parentPid, processGroupId, processUid] = fields
        .slice(0, 4)
        .map(Number);
      if (
        ![pid, parentPid, processGroupId, processUid].every(
          Number.isSafeInteger,
        )
      )
        return unavailable;
      if (processGroupId !== groupId) continue;
      memberCount += 1;
      if (memberCount > MAX_OWNED_PROCESS_GROUP_MEMBERS) return unavailable;
      if (uid !== null && processUid === uid) sameUidCount += 1;
      const state = fields[4][0].toUpperCase();
      const stateKey =
        {
          D: "uninterruptible",
          I: "idle",
          R: "running",
          S: "sleeping",
          T: "stopped",
          U: "uninterruptible",
          Z: "zombie",
        }[state] ?? "other";
      stateCounts[stateKey] += 1;
    }

    const snapshot = {
      snapshotAvailable: true,
      childExitKnown,
      memberCount,
      sameUidKnown: uid !== null,
      stateCounts,
    };
    if (uid !== null) snapshot.sameUidCount = sameUidCount;
    return snapshot;
  } catch {
    return unavailable;
  }
}

export async function stopOwnedProcessForRun(child, setStage) {
  try {
    await stopOwnedProcess(child);
  } catch (error) {
    setStage("owned-process-cleanup");
    throw error;
  }
}

function signalOwnedGroup(group, signal, cleanupStep, child, readProcessTable) {
  try {
    process.kill(group, signal);
    return true;
  } catch (cause) {
    if (cause?.code === "ESRCH") return false;
    const error = new Error("OWNED_PROCESS_CLEANUP_FAILED");
    if (SAFE_CHILD_ERROR_CODES.has(cause?.code)) error.code = cause.code;
    error.cleanupStep = cleanupStep;
    if (cleanupStep === "probe-process-group" && cause?.code === "EPERM") {
      error.processGroupSnapshot = snapshotOwnedProcessGroup(
        child,
        readProcessTable,
      );
    }
    throw error;
  }
}

async function availablePort(excluded) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const server = net.createServer();
    await new Promise((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(0, "127.0.0.1", resolveListen);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      await new Promise((resolveClose) => server.close(resolveClose));
      throw new Error("LOOPBACK_PORT_UNAVAILABLE");
    }
    const port = address.port;
    await new Promise((resolveClose, rejectClose) =>
      server.close((error) => (error ? rejectClose(error) : resolveClose())),
    );
    if (!excluded.has(port)) return String(port);
  }
  throw new Error("LOOPBACK_PORT_UNAVAILABLE");
}

async function localPorts() {
  const appPort = await availablePort(new Set());
  const trackingPort = await availablePort(new Set([Number(appPort)]));
  return { appPort, trackingPort };
}

async function waitForAppHealth(appPort) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${appPort}/health`, {
        signal: AbortSignal.timeout(500),
      });
      if (
        response.status === 200 &&
        JSON.stringify(await response.json()) ===
          JSON.stringify({ status: "ok", service: "ages" })
      ) {
        return;
      }
    } catch {}
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error("LOCAL_APP_HEALTH_FAILED");
}

function waitForTraceComplete(session, timeoutMs = 15_000) {
  return new Promise((resolveComplete, rejectComplete) => {
    const finish = (error, event) => {
      clearTimeout(timer);
      session.off("Tracing.tracingComplete", onComplete);
      if (error) rejectComplete(error);
      else resolveComplete(event);
    };
    const onComplete = (event) => finish(null, event);
    const timer = setTimeout(
      () => finish(new Error("TRACE_COMPLETION_TIMEOUT")),
      timeoutMs,
    );
    session.on("Tracing.tracingComplete", onComplete);
  });
}

async function closeTraceStream(session, handle) {
  try {
    await withTimeout(
      session.send("IO.close", { handle }),
      3000,
      "TRACE_CLOSE_TIMEOUT",
    );
  } catch {}
}

async function captureTrace(
  session,
  tracePath,
  categories,
  action,
  actionDiagnostic,
) {
  const chunks = [];
  let traceStarted = false;
  let completionPromise;
  let completion;
  let failureCode = null;
  let actionResult = null;
  let byteCount = 0;
  try {
    await withTimeout(
      session.send("Tracing.start", {
        categories: categories.join(","),
        options: "record-until-full",
        transferMode: "ReturnAsStream",
        bufferUsageReportingInterval: 500,
      }),
      10_000,
      "TRACE_START_TIMEOUT",
    );
    traceStarted = true;
    actionResult = await withTimeout(
      action(),
      UI_TIMEOUT_MS * 2,
      "ACTION_TIMEOUT",
    );
  } catch (error) {
    if (error?.message === "ACTION_TIMEOUT" && actionDiagnostic) {
      actionDiagnostic.actionTimedOut = true;
      actionDiagnostic.reasonCode = "ACTION_TIMEOUT";
    }
    failureCode = traceStarted
      ? "ACTION_GROUND_TRUTH_FAILED"
      : "TRACE_START_FAILED";
  } finally {
    if (traceStarted) {
      completionPromise = waitForTraceComplete(session);
      try {
        await withTimeout(
          session.send("Tracing.end"),
          10_000,
          "TRACE_END_TIMEOUT",
        );
      } catch {
        failureCode ??= "TRACE_END_FAILED";
      }
      try {
        completion = await completionPromise;
      } catch {
        failureCode ??= "TRACE_COMPLETION_FAILED";
      }
    }
  }

  if (!completion?.stream) {
    failureCode ??= "TRACE_STREAM_MISSING";
    return {
      tracePath: null,
      byteCount: 0,
      dataLossOccurred: null,
      actionResult,
      failureCode,
    };
  }

  try {
    byteCount = await withTimeout(
      readTraceStream(session, completion.stream, (chunk) =>
        chunks.push(chunk),
      ),
      20_000,
      "TRACE_STREAM_TIMEOUT",
    );
  } catch {
    failureCode ??= "TRACE_STREAM_INCOMPLETE";
  } finally {
    await closeTraceStream(session, completion.stream);
  }
  if (completion.dataLossOccurred !== false)
    failureCode ??= "TRACE_DATA_LOSS_UNKNOWN";

  const bytes = Buffer.concat(chunks);
  if (
    failureCode === "TRACE_STREAM_INCOMPLETE" ||
    failureCode === "TRACE_BYTE_LIMIT" ||
    failureCode === "TRACE_CHUNK_LIMIT"
  ) {
    if (bytes.byteLength > 0) writeNewFile(`${tracePath}.partial`, bytes);
    return {
      tracePath: null,
      byteCount: bytes.byteLength,
      dataLossOccurred: completion.dataLossOccurred ?? null,
      actionResult,
      failureCode,
    };
  }
  writeNewFile(tracePath, bytes);
  return {
    tracePath,
    byteCount,
    dataLossOccurred: completion.dataLossOccurred ?? null,
    actionResult,
    failureCode,
  };
}

function tracePathFor(runDirectory, item) {
  return resolve(runDirectory, `${item.workload}-${item.action}.trace.json`);
}

function markerNames(item) {
  const prefix = `pilot-${item.workload}-${item.action}`;
  return {
    start: `${prefix}:segment-start`,
    immediateEnd: `${prefix}:immediate-end`,
    completionStart: `${prefix}:completion-start`,
    completionEnd: `${prefix}:completion-end`,
    secondaryStart: `${prefix}:secondary-chronological-mode-start`,
    secondaryEnd: `${prefix}:secondary-chronological-mode-end`,
    end: `${prefix}:segment-end`,
  };
}

async function mark(page, label) {
  await page.evaluate((message) => console.timeStamp(message), label);
}

async function twoFrames(page) {
  await page.evaluate(
    () =>
      new Promise((resolveFrame) =>
        requestAnimationFrame(() => requestAnimationFrame(resolveFrame)),
      ),
  );
}

function deferredRoute(page, timelineId, shouldHold) {
  const started = deferred();
  const release = deferred();
  let held = false;
  let releaseRequested = false;
  let cancelled = false;
  const routeHandler = async (route) => {
    const url = new URL(route.request().url());
    if (
      !held &&
      shouldHold(url, route.request()) &&
      url.pathname === `/api/timelines/${timelineId}/overview`
    ) {
      held = true;
      started.resolve();
      await release.promise;
      if (cancelled) {
        await route.abort().catch(() => {});
        return;
      }
    }
    await route.continue();
  };
  return {
    started: started.promise,
    release: () => {
      releaseRequested = true;
      release.resolve();
    },
    install: () =>
      page.route(`**/api/timelines/${timelineId}/overview?**`, routeHandler),
    remove: async () => {
      if (!releaseRequested) {
        cancelled = true;
        release.resolve();
      }
      await page.unroute(
        `**/api/timelines/${timelineId}/overview?**`,
        routeHandler,
      );
    },
  };
}

function timelineTitle(item) {
  return `Synthetic method ${item.workload} ${item.action}`;
}

async function waitForStoryEditor(page, title) {
  await page
    .getByRole("heading", { name: title, exact: true })
    .waitFor({ timeout: UI_TIMEOUT_MS });
  await page
    .getByRole("region", { name: "Story viewport", exact: true })
    .waitFor({ timeout: UI_TIMEOUT_MS });
  await page
    .locator(
      'svg[aria-label="Narrative order overview"] [data-first-ordinal="1"]',
    )
    .waitFor({ timeout: UI_TIMEOUT_MS });
}

async function waitForChronologicalView(page, undatedCount) {
  await page
    .getByRole("region", { name: "Calendar dates viewport", exact: true })
    .waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
  await page
    .getByText("Loading complete chronological overview…", { exact: true })
    .waitFor({ state: "hidden", timeout: UI_TIMEOUT_MS });
  await page
    .locator(".undated-track")
    .getByRole("button", {
      name: `Undated · ${undatedCount} moments`,
      exact: true,
    })
    .waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
}

async function readViewport(viewport) {
  const attributes = await viewport.evaluate((element) => ({
    center: element.getAttribute("data-center"),
    span: element.getAttribute("data-span"),
    extent: element.getAttribute("data-extent"),
    width: element.clientWidth,
  }));
  return parseViewportAttributes(attributes);
}

function finiteViewport(view) {
  return [view.center, view.span, view.extent, view.width].every(
    Number.isFinite,
  );
}

async function activeViewport(page, item) {
  const name =
    item.workload === "100-interactive"
      ? "Story viewport"
      : "Calendar dates viewport";
  const viewport = page.getByRole("region", { name, exact: true });
  await viewport.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
  return viewport;
}

async function prepareActionPage(page, item, timelineId) {
  const title = timelineTitle(item);
  await page.goto(
    `http://127.0.0.1:${process.env.AGES_E2E_PORT}/timelines/${encodeURIComponent(timelineId)}`,
    {
      waitUntil: "domcontentloaded",
    },
  );
  await waitForStoryEditor(page, title);
  if (item.workload === "10000-chronological") {
    await page
      .getByRole("button", { name: "Chronological", exact: true })
      .click();
    await waitForChronologicalView(page, 3333);
  }
}

async function setupOpenCase(page, item, timelineId, timelineListUrl) {
  const title = timelineTitle(item);
  const marker = markerNames(item);
  const gate = deferredRoute(page, timelineId, (url) =>
    isInitialChronologicalOverviewRequest(url, timelineId),
  );
  await gate.install();
  await page.goto(timelineListUrl, { waitUntil: "domcontentloaded" });
  const link = page.getByRole("link", { name: title });
  await link.waitFor({ timeout: UI_TIMEOUT_MS });
  return {
    marker,
    stimulus: "timeline-route-activation",
    openEntryPoint: "timeline-route",
    ...(item.workload === "10000-chronological"
      ? {
          secondaryStimuli: [
            {
              stimulus: "chronological-mode-button",
              activeWindowId: "secondary-chronological-mode",
            },
          ],
        }
      : {}),
    action: async () =>
      runOpenStimuli(item.workload, {
        primaryOpen: async () => {
          await mark(page, marker.start);
          await link.click();
          await withTimeout(
            gate.started,
            UI_TIMEOUT_MS,
            "OPEN_REQUEST_TIMEOUT",
          );
          await page
            .getByRole("status")
            .filter({ hasText: "Loading timeline index" })
            .waitFor({ timeout: UI_TIMEOUT_MS });
          await twoFrames(page);
          await mark(page, marker.immediateEnd);
          await new Promise((done) => setTimeout(done, COMPLETION_HOLD_MS));
          await mark(page, marker.completionStart);
          const response = page.waitForResponse(
            (candidate) =>
              isInitialChronologicalOverviewRequest(
                new URL(candidate.url()),
                timelineId,
              ),
            { timeout: UI_TIMEOUT_MS },
          );
          gate.release();
          const opened = await response;
          if (!opened.ok()) throw new Error("OPEN_RESPONSE_FAILED");
          await waitForStoryEditor(page, title);
          await twoFrames(page);
          await mark(page, marker.completionEnd);
          return {
            immediateLoadingPaintObserved: true,
            primaryProjectionReady: true,
            storyEditorReady: true,
          };
        },
        secondaryChronological: async () => {
          await mark(page, marker.secondaryStart);
          await page
            .getByRole("button", { name: "Chronological", exact: true })
            .click();
          await waitForChronologicalView(page, 3333);
          await twoFrames(page);
          await mark(page, marker.secondaryEnd);
          return {
            chronologicalModeInputObserved: true,
            completeOverviewVisible: true,
          };
        },
        finish: () => mark(page, marker.end),
      }),
    cleanup: gate.remove,
  };
}

async function prepareAppend(page, item, timelineId) {
  const title = timelineTitle(item);
  await prepareActionPage(page, item, timelineId);
  const dialog = page.getByRole("dialog", { name: "Add moments", exact: true });
  await page.getByRole("button", { name: "Add moments", exact: true }).click();
  await dialog.waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
  await dialog
    .getByRole("checkbox", { name: "Select Coastal light.png", exact: true })
    .check();

  const started = deferred();
  const release = deferred();
  let held = false;
  let releaseRequested = false;
  let cancelled = false;
  const routePath = `**/api/timelines/${timelineId}/items`;
  const handler = async (route) => {
    if (route.request().method() === "POST" && !held) {
      held = true;
      started.resolve();
      await release.promise;
      if (cancelled) {
        await route.abort().catch(() => {});
        return;
      }
    }
    await route.continue();
  };
  await page.route(routePath, handler);
  return {
    title,
    dialog,
    routePath,
    handler,
    requestStarted: started.promise,
    release: () => {
      releaseRequested = true;
      release.resolve();
    },
    remove: async () => {
      if (!releaseRequested) {
        cancelled = true;
        release.resolve();
      }
      await page.unroute(routePath, handler);
    },
  };
}

async function runOpenAction(setup) {
  return setup.action();
}

export async function runOpenStimuli(
  workload,
  { primaryOpen, secondaryChronological, finish },
) {
  const primary = await primaryOpen();
  if (workload === "10000-chronological") {
    const secondary = await secondaryChronological();
    await finish();
    return { ...primary, secondaryChronological: secondary };
  }
  await finish();
  return primary;
}

function setActionDiagnosticPhase(diagnostic, phase) {
  if (diagnostic && !diagnostic.actionTimedOut) diagnostic.phase = phase;
}

function recordViewportBounds(diagnostic, label, viewport) {
  if (!diagnostic || !finiteViewport(viewport)) return;
  diagnostic.viewportBounds ??= {};
  diagnostic.viewportBounds[label] = {
    center: viewport.center,
    span: viewport.span,
    extent: viewport.extent,
    width: viewport.width,
  };
}

async function recordFitControlCounts(page, diagnostic) {
  if (!diagnostic) return;
  const controls = [
    ["zoomIn", "Zoom in"],
    ["panEarlier", "Pan earlier"],
    ["fitAll", "Fit all"],
  ];
  const counts = {};
  await Promise.all(
    controls.map(async ([key, name]) => {
      try {
        const count = await page
          .getByRole("button", { name, exact: true })
          .count();
        if (Number.isInteger(count) && count >= 0 && count <= 100)
          counts[key] = count;
      } catch {}
    }),
  );
  if (Object.keys(counts).length > 0) diagnostic.controlMatchCounts = counts;
}

export async function runFitAll(page, item, viewport, diagnostic) {
  try {
    setActionDiagnosticPhase(diagnostic, "fit-all-initial-bounds");
    const initial = await readViewport(viewport);
    recordViewportBounds(diagnostic, "initial", initial);
    if (!finiteViewport(initial))
      throw new Error("VIEWPORT_BOUNDS_UNAVAILABLE");
    await recordFitControlCounts(page, diagnostic);

    setActionDiagnosticPhase(diagnostic, "fit-all-zoom-in");
    await viewport
      .getByRole("button", { name: "Zoom in", exact: true })
      .click();
    await twoFrames(page);
    const zoomed = await readViewport(viewport);
    recordViewportBounds(diagnostic, "manualZoom", zoomed);
    if (!(zoomed.span < initial.span))
      throw new Error("MANUAL_FRAME_NOT_CHANGED");

    setActionDiagnosticPhase(diagnostic, "fit-all-pan-earlier");
    await viewport
      .getByRole("button", { name: "Pan earlier", exact: true })
      .click();
    await twoFrames(page);
    const panned = await readViewport(viewport);
    recordViewportBounds(diagnostic, "manualPan", panned);
    if (!(Math.abs(panned.center - initial.center) > 1e-9))
      throw new Error("MANUAL_FRAME_NOT_CHANGED");

    const marker = markerNames(item);
    await mark(page, marker.start);
    setActionDiagnosticPhase(diagnostic, "fit-all-button");
    await viewport
      .getByRole("button", { name: "Fit all", exact: true })
      .click();
    await twoFrames(page);
    const fitted = await readViewport(viewport);
    recordViewportBounds(diagnostic, "fitAll", fitted);
    if (
      Math.abs(fitted.center - initial.center) >
        Math.max(1e-6, Math.abs(initial.center) * 1e-9) ||
      Math.abs(fitted.span - initial.span) > Math.max(1e-6, initial.span * 1e-6)
    ) {
      throw new Error("FIT_ALL_GROUND_TRUTH_FAILED");
    }
    await mark(page, marker.immediateEnd);
    await mark(page, marker.end);
    return { manualFrameChanged: true, fitRestoredInitialBounds: true };
  } catch (cause) {
    const causeCode =
      typeof cause?.message === "string" &&
      [
        "VIEWPORT_BOUNDS_UNAVAILABLE",
        "MANUAL_FRAME_NOT_CHANGED",
        "FIT_ALL_GROUND_TRUTH_FAILED",
      ].includes(cause.message)
        ? cause.message
        : "FIT_ALL_GROUND_TRUTH_FAILED";
    if (diagnostic && !diagnostic.actionTimedOut)
      diagnostic.reasonCode = causeCode;
    throw new Error(causeCode);
  }
}

async function runPan(page, item, viewport) {
  const before = await readViewport(viewport);
  if (!finiteViewport(before)) throw new Error("VIEWPORT_BOUNDS_UNAVAILABLE");
  const plot =
    item.workload === "100-interactive"
      ? viewport.locator("svg[aria-label='Narrative order overview']")
      : viewport.locator(".chronological-bin-layer");
  const box = await plot.boundingBox();
  if (!box) throw new Error("PAN_GROUND_TRUTH_FAILED");
  const startPoint =
    item.workload === "100-interactive"
      ? { x: box.x + box.width / 2, y: box.y + box.height / 2 }
      : { x: box.x + Math.min(47, box.width - 2), y: box.y + box.height / 2 };
  const marker = markerNames(item);
  await page.mouse.move(startPoint.x, startPoint.y);
  await mark(page, marker.start);
  await page.mouse.down();
  await page.mouse.move(startPoint.x + 100, startPoint.y, { steps: 8 });
  await page.mouse.up();
  await twoFrames(page);
  const after = await readViewport(viewport);
  if (!(Math.abs(after.center - before.center) > 1e-9))
    throw new Error("PAN_GROUND_TRUTH_FAILED");
  await mark(page, marker.immediateEnd);
  await mark(page, marker.end);
  return { viewportCenterChanged: true };
}

async function runZoom(page, item, viewport) {
  const before = await readViewport(viewport);
  if (!finiteViewport(before)) throw new Error("VIEWPORT_BOUNDS_UNAVAILABLE");
  const box = await viewport.boundingBox();
  if (!box) throw new Error("ZOOM_GROUND_TRUTH_FAILED");
  const marker = markerNames(item);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.down("Shift");
  await mark(page, marker.start);
  await page.mouse.wheel(0, -120);
  await page.keyboard.up("Shift");
  await twoFrames(page);
  const after = await readViewport(viewport);
  if (!(after.span < before.span)) throw new Error("ZOOM_GROUND_TRUTH_FAILED");
  await mark(page, marker.immediateEnd);
  await mark(page, marker.end);
  return { viewportSpanChanged: true };
}

async function runResize(page, item, viewport) {
  const before = await readViewport(viewport);
  const initialWindow = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
  }));
  if (!finiteViewport(before) || initialWindow.width < 600)
    throw new Error("VIEWPORT_BOUNDS_UNAVAILABLE");
  const targetWidth = initialWindow.width > 900 ? 900 : 720;
  const marker = markerNames(item);
  await mark(page, marker.start);
  await page.setViewportSize({
    width: targetWidth,
    height: initialWindow.height,
  });
  await page.waitForFunction(
    (width) => window.innerWidth === width,
    targetWidth,
    { timeout: UI_TIMEOUT_MS },
  );
  await twoFrames(page);
  const after = await readViewport(viewport);
  if (after.width === before.width || after.extent === before.extent)
    throw new Error("RESIZE_GROUND_TRUTH_FAILED");
  await mark(page, marker.immediateEnd);
  await mark(page, marker.end);
  return {
    viewportWidthChanged: true,
    extentChanged: true,
    inputMethod: "playwright-viewport-resize",
    noMouseUpClaim: true,
  };
}

export async function runAppend(page, item, timelineId, setup, diagnostic) {
  const marker = markerNames(item);
  const existingCount = item.workload === "100-interactive" ? 100 : 3333;
  if (diagnostic && !diagnostic.actionTimedOut) {
    diagnostic.responseHeadersReceived = false;
    diagnostic.responseFinished = false;
    diagnostic.responseFinishWaitSkippedFor204 = false;
    diagnostic.commitAcknowledged = false;
  }
  let phase = "append-input";
  try {
    const responsePromise = page.waitForResponse(
      (candidate) => {
        const url = new URL(candidate.url());
        return (
          url.pathname === `/api/timelines/${timelineId}/items` &&
          candidate.request().method() === "POST"
        );
      },
      { timeout: UI_TIMEOUT_MS },
    );
    responsePromise.catch(() => {});
    setActionDiagnosticPhase(diagnostic, phase);
    await mark(page, marker.start);
    await setup.dialog
      .getByRole("button", { name: "Add selected moments", exact: true })
      .click();

    phase = "append-request-start";
    setActionDiagnosticPhase(diagnostic, phase);
    await withTimeout(
      setup.requestStarted,
      UI_TIMEOUT_MS,
      "APPEND_REQUEST_TIMEOUT",
    );
    phase = "append-progress-indicator";
    setActionDiagnosticPhase(diagnostic, phase);
    await setup.dialog
      .getByRole("button", { name: "Adding moments…", exact: true })
      .waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });

    phase = "append-immediate-paint";
    setActionDiagnosticPhase(diagnostic, phase);
    await twoFrames(page);
    await mark(page, marker.immediateEnd);
    phase = "append-completion-hold";
    setActionDiagnosticPhase(diagnostic, phase);
    await new Promise((done) => setTimeout(done, COMPLETION_HOLD_MS));
    await mark(page, marker.completionStart);

    phase = "append-response-headers";
    setActionDiagnosticPhase(diagnostic, phase);
    setup.release();
    const response = await responsePromise;
    if (diagnostic && !diagnostic.actionTimedOut)
      diagnostic.responseHeadersReceived = true;
    const responseStatus = response.status();
    if (diagnostic && !diagnostic.actionTimedOut) {
      if (
        Number.isInteger(responseStatus) &&
        responseStatus >= 100 &&
        responseStatus <= 599
      ) {
        diagnostic.responseStatus = responseStatus;
      }
    }

    phase = "append-commit-ack";
    setActionDiagnosticPhase(diagnostic, phase);
    if (responseStatus !== 204) throw new Error("APPEND_COMMIT_ACK_FAILED");
    if (diagnostic && !diagnostic.actionTimedOut) {
      diagnostic.responseFinishWaitSkippedFor204 = true;
      diagnostic.commitAcknowledged = true;
    }

    phase = "append-write-ack-marker";
    setActionDiagnosticPhase(diagnostic, phase);
    await mark(page, `${marker.completionStart}:write-ack`);

    phase = "append-visible-count";
    setActionDiagnosticPhase(diagnostic, phase);
    if (item.workload === "100-interactive") {
      await page
        .getByText("101 moments, with more to come.", { exact: true })
        .waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
      await page
        .locator(
          'svg[aria-label="Narrative order overview"] [data-last-ordinal="101"]',
        )
        .waitFor({ timeout: UI_TIMEOUT_MS });
    } else {
      await page
        .locator(".undated-track")
        .getByRole("button", { name: "Undated · 3334 moments", exact: true })
        .waitFor({ state: "visible", timeout: UI_TIMEOUT_MS });
    }
    phase = "append-completion-paint";
    setActionDiagnosticPhase(diagnostic, phase);
    await twoFrames(page);
    await mark(page, marker.completionEnd);
    await mark(page, marker.end);
    return {
      committedResponseStatus: responseStatus,
      visibleCompletionObserved: true,
      visibleCountBefore: existingCount,
      visibleCountAfter: existingCount + 1,
      visibleCompletionKind:
        item.workload === "100-interactive"
          ? "story-ordinal"
          : "undated-aggregate-count",
    };
  } catch (cause) {
    const phaseFailure = {
      "append-request-start": "APPEND_REQUEST_START_FAILED",
      "append-progress-indicator": "APPEND_PROGRESS_INDICATOR_FAILED",
      "append-immediate-paint": "APPEND_IMMEDIATE_PAINT_FAILED",
      "append-response-headers": "APPEND_RESPONSE_HEADERS_FAILED",
      "append-commit-ack": "APPEND_COMMIT_ACK_FAILED",
      "append-write-ack-marker": "APPEND_COMMIT_ACK_FAILED",
      "append-visible-count": "APPEND_VISIBLE_COMPLETION_FAILED",
      "append-completion-paint": "APPEND_VISIBLE_COMPLETION_FAILED",
    };
    const causeCode =
      typeof cause?.message === "string" &&
      SAFE_ACTION_DIAGNOSTIC_REASONS.has(cause.message) &&
      cause.message.startsWith("APPEND_")
        ? cause.message
        : (phaseFailure[phase] ?? "APPEND_GROUND_TRUTH_FAILED");
    if (diagnostic && !diagnostic.actionTimedOut)
      diagnostic.reasonCode = causeCode;
    throw new Error(causeCode);
  }
}

async function runScroll(page, item) {
  const media = page.locator(".moment-media img, .moment-media video");
  const beforeMedia = await media.count();
  const beforeScroll = await page.evaluate(() => window.scrollY);
  const marker = markerNames(item);
  await page.mouse.move(700, 700);
  await mark(page, marker.start);
  await page.mouse.wheel(0, 700);
  await page.waitForFunction(
    (previous) => window.scrollY > previous,
    beforeScroll,
    { timeout: UI_TIMEOUT_MS },
  );
  await twoFrames(page);
  const afterScroll = await page.evaluate(() => window.scrollY);
  const afterMedia = await media.count();
  if (!(afterScroll > beforeScroll))
    throw new Error("SCROLL_GROUND_TRUTH_FAILED");
  await mark(page, marker.immediateEnd);
  await mark(page, marker.end);
  return {
    scrollPositionChanged: true,
    mountedMediaBefore: beforeMedia,
    mountedMediaAfter: afterMedia,
  };
}

export function measurementWindows(item, marker) {
  if (item.action === "open") {
    const windows = [
      {
        id: "primary-immediate-input",
        startMarker: marker.start,
        endMarker: marker.immediateEnd,
      },
      {
        id: "primary-operation-completion",
        startMarker: marker.completionStart,
        endMarker: marker.completionEnd,
      },
    ];
    if (item.workload === "10000-chronological") {
      windows.push({
        id: "secondary-chronological-mode",
        startMarker: marker.secondaryStart,
        endMarker: marker.secondaryEnd,
      });
    }
    return windows;
  }
  if (item.action === "append") {
    return [
      {
        id: "immediate-input",
        startMarker: marker.start,
        endMarker: marker.immediateEnd,
      },
      {
        id: "operation-completion",
        startMarker: marker.completionStart,
        endMarker: marker.completionEnd,
      },
    ];
  }
  return [
    {
      id: "active-input",
      startMarker: marker.start,
      endMarker: marker.immediateEnd,
    },
  ];
}

function stimulusForAction(item) {
  return {
    "fit-all": "fit-all-button-click",
    pan: "viewport-pointer-drag",
    zoom: "shift-wheel-over-viewport",
    resize: "playwright-viewport-resize",
    append: "append-submit-button-click",
    scroll: "ordinary-wheel-scroll",
  }[item.action];
}

function outcomeReason(error, actionName) {
  const code = typeof error?.message === "string" ? error.message : "";
  const allowed = new Set([
    "OPEN_RESPONSE_FAILED",
    "VIEWPORT_BOUNDS_UNAVAILABLE",
    "MANUAL_FRAME_NOT_CHANGED",
    "FIT_ALL_GROUND_TRUTH_FAILED",
    "PAN_GROUND_TRUTH_FAILED",
    "ZOOM_GROUND_TRUTH_FAILED",
    "RESIZE_GROUND_TRUTH_FAILED",
    "APPEND_COMMIT_ACK_FAILED",
    "SCROLL_GROUND_TRUTH_FAILED",
  ]);
  return allowed.has(code)
    ? code
    : `${actionName.toUpperCase().replaceAll("-", "_")}_GROUND_TRUTH_FAILED`;
}

async function captureCase(
  context,
  item,
  timelineId,
  listUrl,
  runDirectory,
  categories,
  workloadCount,
) {
  const page = await context.newPage();
  let session;
  let setup;
  let captured;
  let actionOutcome = null;
  let actionReason = null;
  let activeWindowDefinitions = null;
  const actionDiagnostic = {};
  const trace = `${item.workload}-${item.action}.trace.json`;
  const tracePath = tracePathFor(runDirectory, item);
  let captureStartedAtUtc;
  let viewport = null;

  try {
    if (item.action === "open") {
      setup = await setupOpenCase(page, item, timelineId, listUrl);
    } else if (item.action === "append") {
      setup = await prepareAppend(page, item, timelineId);
    } else {
      await prepareActionPage(page, item, timelineId);
    }

    if (item.action !== "open") {
      const targetViewport = await activeViewport(page, item);
      viewport = await targetViewport.evaluate((element) => ({
        innerWidth,
        innerHeight,
        devicePixelRatio,
        screenWidth: screen.width,
        screenHeight: screen.height,
        extent: Number(element.getAttribute("data-extent")),
      }));
    } else {
      viewport = await page.evaluate(() => ({
        innerWidth,
        innerHeight,
        devicePixelRatio,
        screenWidth: screen.width,
        screenHeight: screen.height,
      }));
    }
    session = await context.newCDPSession(page);
    const names = markerNames(item);
    captureStartedAtUtc = new Date().toISOString();

    captured = await captureTrace(
      session,
      tracePath,
      categories,
      async () => {
        try {
          if (item.action === "open") {
            actionOutcome = await runOpenAction(setup);
          } else if (item.action === "fit-all") {
            actionOutcome = await runFitAll(
              page,
              item,
              await activeViewport(page, item),
              actionDiagnostic,
            );
          } else if (item.action === "pan") {
            actionOutcome = await runPan(
              page,
              item,
              await activeViewport(page, item),
            );
          } else if (item.action === "zoom") {
            actionOutcome = await runZoom(
              page,
              item,
              await activeViewport(page, item),
            );
          } else if (item.action === "resize") {
            actionOutcome = await runResize(
              page,
              item,
              await activeViewport(page, item),
            );
          } else if (item.action === "append") {
            actionOutcome = await runAppend(
              page,
              item,
              timelineId,
              setup,
              actionDiagnostic,
            );
          } else {
            actionOutcome = await runScroll(page, item);
          }
          activeWindowDefinitions = measurementWindows(item, names);
        } catch (error) {
          actionReason = outcomeReason(error, item.action);
          throw error;
        }
        return actionOutcome;
      },
      actionDiagnostic,
    );

    const safeActionDiagnostic = serializeActionDiagnostic(actionDiagnostic);

    if (captured.tracePath) {
      const metadata = describeTraceArtifact(captured.tracePath);
      if (!verifyTraceArtifact(captured.tracePath, metadata))
        actionReason ??= "TRACE_IMMUTABILITY_FAILED";
      const bytes = readFileSync(captured.tracePath);
      let traceEvents = [];
      try {
        const parsed = JSON.parse(bytes.toString("utf8"));
        if (Array.isArray(parsed.traceEvents)) traceEvents = parsed.traceEvents;
        else actionReason ??= "TRACE_SHAPE_UNSUPPORTED";
      } catch {
        actionReason ??= "TRACE_JSON_INVALID";
      }
      const evidence = summarizeTraceEvidence(traceEvents, categories);
      const marker = markerNames(item);
      const segmentResult =
        actionReason ||
        captured.failureCode ||
        captured.dataLossOccurred !== false
          ? unavailable(
              actionReason ??
                captured.failureCode ??
                (captured.dataLossOccurred === true
                  ? "TRACE_DATA_LOSS"
                  : "TRACE_DATA_LOSS_UNKNOWN"),
            )
          : buildMeasurementSegment({
              trace,
              action: item.action,
              traceEvents,
              startMarker: marker.start,
              endMarker: marker.end,
              activeWindows: activeWindowDefinitions ?? [],
            });
      const caseRecord = {
        fixture: `${item.workload}-${item.action}`,
        trace,
        workload: item.workload,
        rowCount: workloadCount,
        action: item.action,
        stimulus: setup?.stimulus ?? stimulusForAction(item),
        ...(setup?.openEntryPoint
          ? { openEntryPoint: setup.openEntryPoint }
          : {}),
        ...(setup?.secondaryStimuli
          ? { secondaryStimuli: setup.secondaryStimuli }
          : {}),
        byteCount: metadata.byteCount,
        sha256: metadata.sha256,
        dataLossOccurred: captured.dataLossOccurred,
        enabledCategories: evidence.enabledCategories,
        traceEvidence: evidence,
        measurementStatus: segmentResult.status,
        ...(segmentResult.status === "resolved"
          ? {}
          : { measurementReasonCode: segmentResult.reasonCode }),
        inputToNextPaint: {
          status: "unproven",
          reasonCode: "NEXT_PAINT_METHOD_UNPROVEN",
        },
        ...(safeActionDiagnostic
          ? { actionDiagnostic: safeActionDiagnostic }
          : {}),
        ...outcomeStatus({
          actionOutcome,
          actionFailureCode: actionReason,
          captureFailureCode: captured.failureCode,
        }),
        ...(actionOutcome ? { groundTruth: actionOutcome } : {}),
        captureStartedAtUtc: captureStartedAtUtc ?? new Date().toISOString(),
        captureEndedAtUtc: new Date().toISOString(),
        ...(viewport ? { viewport } : {}),
      };
      const traceRecord = {
        fixture: caseRecord.fixture,
        trace,
        byteCount: metadata.byteCount,
        sha256: metadata.sha256,
        dataLossOccurred: captured.dataLossOccurred,
        categories: evidence.enabledCategories,
        traceEvidence: evidence,
      };
      return {
        caseRecord,
        traceRecord,
        segment:
          segmentResult.status === "resolved" ? segmentResult.segment : null,
      };
    }
    return {
      caseRecord: {
        fixture: `${item.workload}-${item.action}`,
        trace: null,
        workload: item.workload,
        rowCount: workloadCount,
        action: item.action,
        stimulus: setup?.stimulus ?? stimulusForAction(item),
        ...(setup?.openEntryPoint
          ? { openEntryPoint: setup.openEntryPoint }
          : {}),
        ...(setup?.secondaryStimuli
          ? { secondaryStimuli: setup.secondaryStimuli }
          : {}),
        measurementStatus: "unavailable",
        measurementReasonCode: actionReason ?? captured.failureCode,
        inputToNextPaint: {
          status: "unproven",
          reasonCode: "NEXT_PAINT_METHOD_UNPROVEN",
        },
        ...(safeActionDiagnostic
          ? { actionDiagnostic: safeActionDiagnostic }
          : {}),
        ...outcomeStatus({
          actionOutcome,
          actionFailureCode: actionReason,
          captureFailureCode: captured.failureCode,
        }),
        captureStartedAtUtc: captureStartedAtUtc ?? new Date().toISOString(),
        captureEndedAtUtc: new Date().toISOString(),
      },
      traceRecord: null,
      segment: null,
    };
  } catch {
    const code = actionReason ?? "CASE_SETUP_FAILED";
    return {
      caseRecord: {
        fixture: `${item.workload}-${item.action}`,
        trace: null,
        workload: item.workload,
        rowCount: workloadCount,
        action: item.action,
        stimulus: setup?.stimulus ?? stimulusForAction(item),
        ...(setup?.openEntryPoint
          ? { openEntryPoint: setup.openEntryPoint }
          : {}),
        measurementStatus: "unavailable",
        measurementReasonCode: code,
        inputToNextPaint: {
          status: "unproven",
          reasonCode: "NEXT_PAINT_METHOD_UNPROVEN",
        },
        actionStatus: "unavailable",
        actionReasonCode: code,
        captureStartedAtUtc: captureStartedAtUtc ?? new Date().toISOString(),
        captureEndedAtUtc: new Date().toISOString(),
      },
      traceRecord: null,
      segment: null,
    };
  } finally {
    try {
      if (setup?.cleanup)
        await withTimeout(setup.cleanup(), 3000, "ROUTE_CLEANUP_TIMEOUT");
      if (setup?.remove)
        await withTimeout(setup.remove(), 3000, "ROUTE_CLEANUP_TIMEOUT");
      if (session)
        await withTimeout(
          session.detach(),
          3000,
          "TRACE_SESSION_CLEANUP_TIMEOUT",
        );
    } catch {}
    await withTimeout(page.close(), 5000, "PAGE_CLEANUP_TIMEOUT").catch(
      () => {},
    );
  }
}

async function seedFixtures(context, workspace, setStage) {
  const previousDirectory = process.cwd();
  process.chdir(workspace);
  try {
    const fixtures = await import(
      pathToFileURL(resolve(ROOT, "tests/e2e/fixtures.ts")).href
    );
    setStage("seed-library");
    const { owner, ids } = await fixtures.seedLibrary(context);
    fixtures.executeFixtureSql(
      buildSyntheticTimelineQuotaSql(owner, buildCaptureCases().length),
    );
    const timelineIds = new Map();
    for (const item of buildCaptureCases()) {
      setStage(`seed-fixture:${item.workload}:${item.action}`);
      const title = timelineTitle(item);
      const timeline =
        item.rowCount === 100
          ? fixtures.seedTimeline(owner, ids, item.rowCount, title)
          : fixtures.seedLargeTimeline(
              owner,
              ids[0],
              item.rowCount,
              title,
              "mixed",
            );
      timelineIds.set(`${item.workload}/${item.action}`, timeline.id);
    }
    return timelineIds;
  } finally {
    process.chdir(previousDirectory);
  }
}

function sourceHash() {
  const tracked = execFileSync("git", ["ls-files", "-z", "src", "migrations"], {
    cwd: ROOT,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
  const extras = [
    "tests/e2e/fixtures.ts",
    "tests/e2e/gateway.mjs",
    "tests/e2e/start-server.mjs",
    "scripts/capture-chromium-method-pilot.mjs",
    "wrangler.jsonc",
    "wrangler.tracking.jsonc",
  ];
  const hash = createHash("sha256");
  for (const path of [...new Set([...tracked, ...extras])].sort()) {
    hash.update(path);
    hash.update("\0");
    hash.update(readFileSync(resolve(ROOT, path)));
  }
  return hash.digest("hex");
}

function captureTimeSystem() {
  const browserCpu = cpus()[0]?.model ?? "unknown";
  return {
    hardware: {
      qualification:
        "Synthetic local method-pilot host; not hardware evidence.",
      modelIdentifier: browserCpu,
      chip: browserCpu,
      memoryGB: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
      os: `${platform()} ${release()}`,
      osBuild: release(),
    },
    architecture: arch(),
  };
}

async function runPilot(
  failureState = { stage: "preflight" },
  browserMode = "playwright-chromium",
) {
  const setStage = (stage) => {
    failureState.stage = stage;
  };
  if (platform() !== "darwin") throw new Error("UNSUPPORTED_HOST");
  setStage("preflight");
  let installedBundleInfo;
  let executableSha256;
  if (browserMode === "installed-brave") {
    setStage("browser-installation-preflight");
    installedBundleInfo = validateInstalledBraveInstallation();
    executableSha256 = hashInstalledBraveExecutable();
  }
  const artifactRoots = artifactRootsForBrowser(browserMode);
  ensureArtifactRoot(artifactRoots.artifactRoot);
  stripCloudAuth();
  const runId = `run-${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${randomUUID()}`;
  setStage("workspace");
  const runDirectory = createRunDirectory(artifactRoots.runsRoot, runId);
  const { workspace } = prepareWorkspace(runDirectory);
  const { appPort, trackingPort } = await localPorts();
  process.env.AGES_E2E_PORT = appPort;
  process.env.AGES_E2E_TRACKING_PORT = trackingPort;

  setStage("server-startup");
  const server = spawn(
    process.execPath,
    [resolve(workspace, "tests/e2e/start-server.mjs")],
    {
      cwd: workspace,
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    },
  );
  server.once("error", () => {
    server.spawnError = true;
  });
  let context;
  let browser;
  let installedBrowserIdentity;
  let sessionCategories = [];
  let categoryAvailability = { available: [], unavailable: [] };
  const captureStartedAtUtc = new Date().toISOString();
  try {
    await waitForOwnedReadiness(server, appPort, trackingPort);
    if (server.spawnError) throw new Error("OWNED_SERVER_START_FAILED");
    await waitForAppHealth(appPort);

    setStage("browser-startup");
    browser = await chromium.launch(buildChromiumLaunchOptions(browserMode));
    if (browserMode === "installed-brave") {
      try {
        const browserSession = await browser.newBrowserCDPSession();
        try {
          const version = await browserSession.send("Browser.getVersion");
          installedBrowserIdentity = buildInstalledBraveBrowserIdentity({
            bundleInfo: installedBundleInfo,
            executableSha256,
            runtime: {
              version: browser.version(),
              product: version.product,
              revision: version.revision,
              userAgent: version.userAgent,
            },
          });
        } finally {
          await browserSession.detach().catch(() => {});
        }
      } catch {
        throw new Error("BROWSER_METADATA_UNAVAILABLE");
      }
    }
    context = await browser.newContext({
      viewport: null,
      acceptDownloads: false,
      serviceWorkers: "block",
    });
    await context.route("**/*", (route) =>
      isLoopbackUrl(route.request().url())
        ? route.continue()
        : route.abort("blockedbyclient"),
    );

    const page = await context.newPage();
    const availableCategories = await readTraceCategoriesForMode({
      browser,
      context,
      page,
      browserMode,
      onRead:
        browserMode === "installed-brave"
          ? (count) => {
              failureState.traceCategoryCatalogReadCount = count;
            }
          : undefined,
    });
    categoryAvailability = probeTraceCategories(availableCategories);
    sessionCategories = categoryAvailability.available;
    await page.close();
    sessionCategories = requireTraceCategories(categoryAvailability);
    setStage("seed-library");
    const timelineIds = await seedFixtures(context, workspace, setStage);
    const timelineListUrl = `http://127.0.0.1:${appPort}/timelines`;
    let cases = [];
    const traces = [];
    let measurementSegments = [];
    for (const item of buildCaptureCases()) {
      setStage(`capture:${item.workload}:${item.action}`);
      const timelineId = timelineIds.get(`${item.workload}/${item.action}`);
      if (!timelineId) throw new Error("SYNTHETIC_FIXTURE_MISSING");
      const captured = await captureCase(
        context,
        item,
        timelineId,
        timelineListUrl,
        runDirectory,
        sessionCategories,
        item.rowCount,
      );
      cases.push(captured.caseRecord);
      if (captured.traceRecord) traces.push(captured.traceRecord);
      if (captured.segment) measurementSegments.push(captured.segment);
    }

    if (browserMode === "installed-brave") {
      const qualified = qualifyInstalledBraveProbeEvidence(
        cases,
        measurementSegments,
      );
      cases = qualified.cases;
      measurementSegments = qualified.measurementSegments;
    }

    const metadataPage = await context.newPage();
    const viewport = await metadataPage.evaluate(() => ({
      innerWidth,
      innerHeight,
      devicePixelRatio,
      screenWidth: screen.width,
      screenHeight: screen.height,
    }));
    await metadataPage.close();
    const captureEndedAtUtc = new Date().toISOString();
    const captureMetadata = {
      captureStartedAtUtc,
      captureEndedAtUtc,
      browser:
        browserMode === "installed-brave"
          ? {
              product: "Runtime browser observation",
              version: installedBrowserIdentity.runtime.version,
            }
          : { product: "Playwright Chromium", version: browser.version() },
    };
    validateCaptureTimeMetadata(captureMetadata);
    const system = captureTimeSystem();
    setStage("manifest");
    const manifest = {
      schemaVersion: 1,
      purpose:
        browserMode === "installed-brave"
          ? INSTALLED_BRAVE_QUALIFICATION
          : "Synthetic Chromium method-discovery pilot; diagnostic only.",
      status:
        browserMode === "installed-brave"
          ? INSTALLED_BRAVE_QUALIFICATION
          : "synthetic-method-pilot",
      ...(browserMode === "installed-brave"
        ? { qualification: INSTALLED_BRAVE_QUALIFICATION }
        : {}),
      inputMethod:
        "Playwright UI input against local synthetic fixtures; not physical input.",
      renderer:
        browserMode === "installed-brave"
          ? "Locally installed Brave renderer launched by Playwright."
          : "Local Playwright Chromium renderer.",
      browser: captureMetadata.browser,
      ...(browserMode === "installed-brave"
        ? { browserIdentity: installedBrowserIdentity }
        : {}),
      ...(browserMode === "installed-brave"
        ? {
            traceCategoryCatalogReadCount:
              failureState.traceCategoryCatalogReadCount,
          }
        : {}),
      hardware:
        browserMode === "installed-brave"
          ? {
              ...system.hardware,
              qualification:
                "Installed Brave schema probe host metadata; incomplete and not hardware qualification.",
            }
          : system.hardware,
      architecture: system.architecture,
      viewport,
      cache:
        "Fresh Chromium process and browser context; HTTP cache retained within this run.",
      ...(browserMode === "installed-brave"
        ? {
            requestBoundary:
              "Playwright context route blocks page requests outside loopback; it is not a process-wide egress wall.",
          }
        : {}),
      captureStartedAtUtc,
      captureEndedAtUtc,
      sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: ROOT,
        encoding: "utf8",
      }).trim(),
      sourceHashSha256: sourceHash(),
      categoryAvailability,
      inputToNextPaint: {
        status: "unproven",
        reasonCode: "NEXT_PAINT_METHOD_UNPROVEN",
      },
      cases,
      traces,
      measurementSegments,
    };
    writeNewFile(
      resolve(runDirectory, "manifest.json"),
      JSON.stringify(manifest, null, 2),
    );
    process.stdout.write(
      `${JSON.stringify(
        {
          status:
            browserMode === "installed-brave"
              ? INSTALLED_BRAVE_QUALIFICATION
              : "synthetic-method-pilot",
          runId,
          caseCount: cases.length,
          capturedTraceCount: traces.length,
          resolvedSegmentCount: measurementSegments.length,
          inputToNextPaint: "unproven",
          ...(browserMode === "installed-brave"
            ? {
                browser: "installed-brave",
                qualification: INSTALLED_BRAVE_QUALIFICATION,
                traceCategoryCatalogReadCount:
                  failureState.traceCategoryCatalogReadCount,
              }
            : {}),
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    try {
      if (context)
        await withTimeout(
          context.close(),
          5000,
          "BROWSER_CONTEXT_CLEANUP_TIMEOUT",
        ).catch(() => {});
    } finally {
      try {
        if (browser)
          await withTimeout(
            browser.close(),
            5000,
            "BROWSER_CLEANUP_TIMEOUT",
          ).catch(() => {});
      } finally {
        await stopOwnedProcessForRun(server, setStage);
      }
    }
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  let options;
  try {
    options = parseRunnerArgs(process.argv.slice(2));
  } catch {
    process.stderr.write(
      "Unsupported capture option. Use no option for preview or --run for the local pilot.\n",
    );
    process.exitCode = 2;
  }
  if (options?.mode === "preview") {
    process.stdout.write(
      "Prepared for review only. After root reviews the runner and bounded local scope, run: node --experimental-strip-types scripts/capture-chromium-method-pilot.mjs --run\n",
    );
  } else if (options?.mode === "run") {
    const failureState = { stage: "preflight" };
    runPilot(failureState, options.browser ?? "playwright-chromium").catch(
      (error) => {
        const allowed = new Set([
          "UNSUPPORTED_HOST",
          "INSTALLED_BRAVE_UNAVAILABLE",
          "LOCAL_DEPENDENCIES_UNAVAILABLE",
          "LOCAL_APP_HEALTH_FAILED",
          "OWNED_SERVER_START_FAILED",
          "OWNED_SERVER_EXITED_EARLY",
          "OWNED_SERVER_OUTPUT_CLOSED",
          "OWNED_SERVER_READINESS_TIMEOUT",
          "SYNTHETIC_FIXTURE_MISSING",
          "BROWSER_METADATA_UNAVAILABLE",
          "TRACE_CATEGORIES_UNAVAILABLE",
        ]);
        const code =
          typeof error?.message === "string" && allowed.has(error.message)
            ? error.message
            : "METHOD_PILOT_FAILED";
        process.stderr.write(
          `${options?.browser === "installed-brave" ? "browser=installed-brave " : ""}${code} ${JSON.stringify(
            summarizeSafeFailure(
              error,
              failureState.stage,
              options?.browser === "installed-brave"
                ? failureState.traceCategoryCatalogReadCount
                : undefined,
            ),
          )}\n`,
        );
        process.exitCode = 1;
      },
    );
  }
}
