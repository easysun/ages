import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import {
  analyzeTrace,
  eventTimingInventory,
  nearestRank,
  parseTrace,
} from "./chromium-trace-metrics.mjs";
import {
  OWNED_CLEANUP_RECEIPT_BYTE_LIMIT,
  OWNED_CLEANUP_RECEIPT_FILENAME,
  parseOwnedCleanupReceipt,
  summarizeOwnedCleanupReceipt,
} from "./lib/owned-cleanup-receipt.mjs";

const USAGE =
  "Usage: node scripts/analyze-chromium-traces.mjs <manifest.json> [--out <new-report.json>]";
const METADATA_TEXT_LIMIT = 256;
const OBSERVER_TRACE_BYTE_LIMIT = 16 * 1024 * 1024;
const OBSERVER_SIDECAR_BYTE_LIMIT = 256 * 1024;
const PROTOCOL_GROUP_LIMIT = 56;
const PROTOCOL_SEGMENT_LIMIT = PROTOCOL_GROUP_LIMIT * 120;
const PROTOCOL_ACTIONS = new Set([
  "open",
  "fit-all",
  "pan",
  "zoom",
  "resize",
  "append",
  "scroll",
]);
const PROTOCOL_GROUP_KEYS = new Set([
  "deviceKey",
  "browserKey",
  "workload",
  "action",
  "plannedTrials",
  "sessions",
  "trials",
]);
const PROTOCOL_SEGMENT_KEYS = new Set([
  "trace",
  "action",
  "startUs",
  "endUs",
  "rendererPid",
  "layerTreeHostId",
  "frameSource",
  "activeWindows",
  "protocolGroupIndex",
  "session",
  "trial",
]);
const TRIAL_REASONS = new Map([
  ["missing", new Set(["NOT_CAPTURED", "UNSUPPORTED_INPUT"])],
  ["censored", new Set(["TRACE_TRUNCATED", "ACTION_INCOMPLETE"])],
  [
    "invalid",
    new Set(["TRACE_DATA_LOSS", "AMBIGUOUS_CORRELATION", "MALFORMED_TRACE"]),
  ],
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeText(value) {
  const hasControlCharacters =
    typeof value === "string" &&
    Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint < 32 || codePoint === 127);
    });
  return (
    typeof value === "string" &&
    value.length <= METADATA_TEXT_LIMIT &&
    !hasControlCharacters &&
    !/https?:\/\//i.test(value)
  );
}

function selectTextFields(record, fieldNames) {
  if (!isRecord(record)) return {};
  return Object.fromEntries(
    fieldNames
      .filter((name) => safeText(record[name]))
      .map((name) => [name, record[name]]),
  );
}

function selectNumberFields(record, fieldNames) {
  if (!isRecord(record)) return {};
  return Object.fromEntries(
    fieldNames
      .filter(
        (name) =>
          typeof record[name] === "number" && Number.isFinite(record[name]),
      )
      .map((name) => [name, record[name]]),
  );
}

function hasOnlyKeys(record, allowedKeys) {
  return Object.keys(record).every((key) => allowedKeys.has(key));
}

function protocolError() {
  throw new Error("Invalid protocol group or linked measurement segment.");
}

function validProtocolSegment(segment) {
  if (
    typeof segment.action !== "string" ||
    !Number.isFinite(segment.startUs) ||
    !Number.isFinite(segment.endUs) ||
    segment.startUs >= segment.endUs ||
    !Number.isInteger(segment.rendererPid) ||
    segment.rendererPid <= 0 ||
    !Number.isInteger(segment.layerTreeHostId) ||
    segment.layerTreeHostId < 0 ||
    !Number.isInteger(segment.frameSource) ||
    segment.frameSource < 0 ||
    !Array.isArray(segment.activeWindows) ||
    segment.activeWindows.length === 0 ||
    segment.activeWindows.length > 120
  ) {
    return false;
  }

  const ids = new Set();
  let previousEnd = -Infinity;
  for (const window of segment.activeWindows) {
    if (
      !isRecord(window) ||
      !hasOnlyKeys(window, new Set(["id", "startUs", "endUs"])) ||
      typeof window.id !== "string" ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(window.id) ||
      ids.has(window.id) ||
      !Number.isFinite(window.startUs) ||
      !Number.isFinite(window.endUs) ||
      window.startUs < segment.startUs ||
      window.endUs > segment.endUs ||
      window.startUs >= window.endUs ||
      window.startUs < previousEnd
    ) {
      return false;
    }
    ids.add(window.id);
    previousEnd = window.endUs;
  }
  return true;
}

function validateProtocolGroups(manifest) {
  if (manifest.protocolGroups === undefined) return;
  if (
    !Array.isArray(manifest.protocolGroups) ||
    manifest.protocolGroups.length === 0 ||
    manifest.protocolGroups.length > PROTOCOL_GROUP_LIMIT
  ) {
    protocolError();
  }

  const groupKeys = new Set();
  for (const group of manifest.protocolGroups) {
    if (
      !isRecord(group) ||
      !hasOnlyKeys(group, PROTOCOL_GROUP_KEYS) ||
      !["mac", "s25-ultra"].includes(group.deviceKey) ||
      !["brave", "chrome", "samsung-internet"].includes(group.browserKey) ||
      (group.deviceKey === "mac" && group.browserKey !== "brave") ||
      !["100-interactive", "10000-chronological"].includes(group.workload) ||
      !PROTOCOL_ACTIONS.has(group.action) ||
      group.plannedTrials !== 120 ||
      !Array.isArray(group.sessions) ||
      group.sessions.length !== 3 ||
      !Array.isArray(group.trials) ||
      group.trials.length > 120
    ) {
      protocolError();
    }

    const cellKey = JSON.stringify([
      group.deviceKey,
      group.browserKey,
      group.workload,
      group.action,
    ]);
    if (groupKeys.has(cellKey)) protocolError();
    groupKeys.add(cellKey);

    const sessions = new Set();
    for (const session of group.sessions) {
      if (
        !isRecord(session) ||
        !hasOnlyKeys(session, new Set(["session", "plannedTrials"])) ||
        !Number.isInteger(session.session) ||
        session.session < 1 ||
        session.session > 3 ||
        session.plannedTrials !== 40 ||
        sessions.has(session.session)
      ) {
        protocolError();
      }
      sessions.add(session.session);
    }
    if (sessions.size !== 3) protocolError();

    const trials = new Set();
    for (const trial of group.trials) {
      if (
        !isRecord(trial) ||
        !hasOnlyKeys(
          trial,
          new Set(["session", "trial", "status", "reason"]),
        ) ||
        !Number.isInteger(trial.session) ||
        trial.session < 1 ||
        trial.session > 3 ||
        !Number.isInteger(trial.trial) ||
        trial.trial < 1 ||
        trial.trial > 40 ||
        !TRIAL_REASONS.has(trial.status) ||
        !TRIAL_REASONS.get(trial.status).has(trial.reason)
      ) {
        protocolError();
      }
      const trialKey = `${trial.session}:${trial.trial}`;
      if (trials.has(trialKey)) protocolError();
      trials.add(trialKey);
    }
  }
}

function validateProtocolSegments(manifest) {
  const groups = manifest.protocolGroups;
  const segments = manifest.measurementSegments ?? [];
  const traceNames = new Set(manifest.traces.map(({ trace }) => trace));
  const linkedTrials = new Set();
  const declaredNonValidTrials = new Set();
  const linkedWindowsByTrace = new Map();

  for (const [groupIndex, group] of (groups ?? []).entries()) {
    for (const trial of group.trials) {
      declaredNonValidTrials.add(
        `${groupIndex}:${trial.session}:${trial.trial}`,
      );
    }
  }

  for (const segment of segments) {
    if (!isRecord(segment)) continue;
    const hasGroupReference =
      Object.hasOwn(segment, "protocolGroupIndex") ||
      Object.hasOwn(segment, "session") ||
      Object.hasOwn(segment, "trial");
    if (!hasGroupReference) continue;
    if (
      !hasOnlyKeys(segment, PROTOCOL_SEGMENT_KEYS) ||
      !Array.isArray(groups) ||
      !Number.isInteger(segment.protocolGroupIndex) ||
      segment.protocolGroupIndex < 0 ||
      segment.protocolGroupIndex >= groups.length ||
      !Number.isInteger(segment.session) ||
      segment.session < 1 ||
      segment.session > 3 ||
      !Number.isInteger(segment.trial) ||
      segment.trial < 1 ||
      segment.trial > 40 ||
      !traceNames.has(segment.trace) ||
      !validProtocolSegment(segment)
    ) {
      protocolError();
    }

    const group = groups[segment.protocolGroupIndex];
    const trialKey = `${segment.protocolGroupIndex}:${segment.session}:${segment.trial}`;
    if (
      group.action !== segment.action ||
      declaredNonValidTrials.has(trialKey) ||
      linkedTrials.has(trialKey)
    ) {
      protocolError();
    }
    linkedTrials.add(trialKey);

    for (const window of segment.activeWindows) {
      const traceWindows = linkedWindowsByTrace.get(segment.trace) ?? [];
      traceWindows.push({ startUs: window.startUs, endUs: window.endUs });
      linkedWindowsByTrace.set(segment.trace, traceWindows);
    }
  }

  for (const windows of linkedWindowsByTrace.values()) {
    windows.sort((left, right) => left.startUs - right.startUs);
    for (let index = 1; index < windows.length; index += 1) {
      if (windows[index].startUs < windows[index - 1].endUs) protocolError();
    }
  }
}

function selectedMetadata(manifest) {
  const hardware = isRecord(manifest.hardware) ? manifest.hardware : {};
  const activeDisplay = isRecord(hardware.activeDisplay)
    ? hardware.activeDisplay
    : {};
  const metadata = {
    inputMethod: safeText(manifest.inputMethod) ? manifest.inputMethod : null,
    renderer: safeText(manifest.renderer) ? manifest.renderer : null,
    browser: selectTextFields(manifest.browser, ["product", "version"]),
    hardware: {
      ...selectTextFields(hardware, [
        "qualification",
        "modelIdentifier",
        "chip",
        "os",
        "osBuild",
      ]),
      ...selectNumberFields(hardware, ["memoryGB"]),
      activeDisplay: selectNumberFields(activeDisplay, [
        "width",
        "height",
        "refreshRateHz",
      ]),
    },
    viewport: selectNumberFields(manifest.viewport, [
      "innerWidth",
      "innerHeight",
      "devicePixelRatio",
      "screenWidth",
      "screenHeight",
    ]),
    cache: safeText(manifest.cache) ? manifest.cache : null,
  };

  if (safeText(manifest.sourceRevision))
    metadata.sourceRevision = manifest.sourceRevision;
  if (
    typeof manifest.sourceHashSha256 === "string" &&
    /^[a-f0-9]{64}$/i.test(manifest.sourceHashSha256)
  ) {
    metadata.sourceHashSha256 = manifest.sourceHashSha256;
  }

  return metadata;
}

function validateManifest(manifest) {
  if (!isRecord(manifest) || !Array.isArray(manifest.traces)) {
    throw new Error("Invalid manifest: expected a traces array.");
  }
  if (manifest.traces.length === 0) {
    throw new Error("Invalid manifest: traces array must not be empty.");
  }
  if (
    manifest.measurementSegments !== undefined &&
    !Array.isArray(manifest.measurementSegments)
  ) {
    throw new Error("Invalid manifest: measurementSegments must be an array.");
  }
  if (
    Array.isArray(manifest.measurementSegments) &&
    manifest.measurementSegments.length > PROTOCOL_SEGMENT_LIMIT
  ) {
    throw new Error("Invalid manifest: too many measurement segments.");
  }

  const traceNames = new Set();
  for (const record of manifest.traces) {
    if (
      !isRecord(record) ||
      !safeText(record.fixture) ||
      record.fixture.length === 0 ||
      !safeText(record.trace) ||
      record.trace.length === 0
    ) {
      throw new Error("Invalid manifest: each trace needs a fixture and path.");
    }
    if (
      record.trace !== basename(record.trace) ||
      /[\\/]/.test(record.trace) ||
      !record.trace.endsWith(".trace.json")
    ) {
      throw new Error("Trace path must be a basename ending in .trace.json.");
    }
    if (traceNames.has(record.trace)) {
      throw new Error("Invalid manifest: duplicate trace basename.");
    }
    traceNames.add(record.trace);
    if (
      record.dataLossOccurred !== undefined &&
      record.dataLossOccurred !== null &&
      typeof record.dataLossOccurred !== "boolean"
    ) {
      throw new Error(
        "Invalid manifest: dataLossOccurred must be boolean or unknown.",
      );
    }
  }

  validateProtocolGroups(manifest);
  validateProtocolSegments(manifest);

  return manifest;
}

function parseManifest(bytes) {
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Invalid manifest JSON.");
  }
  return validateManifest(manifest);
}

function isSafeManifestBasename(fileName) {
  return (
    typeof fileName === "string" &&
    fileName.length > 0 &&
    fileName !== "." &&
    fileName !== ".." &&
    fileName === basename(fileName) &&
    !/[\\/]/.test(fileName)
  );
}

function readVerifiedRegularFile(
  directory,
  fileName,
  {
    byteCount,
    sha256,
    maxBytes,
    invalidFileMessage,
    integrityMessage,
    tooLargeMessage,
  },
) {
  if (!isSafeManifestBasename(fileName)) {
    throw new Error(invalidFileMessage);
  }
  const filePath = resolve(directory, fileName);
  if (dirname(filePath) !== directory) throw new Error(invalidFileMessage);

  let descriptor;
  try {
    descriptor = openSync(
      filePath,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
  } catch {
    throw new Error(invalidFileMessage);
  }

  try {
    const fileInfo = fstatSync(descriptor);
    if (!fileInfo.isFile()) throw new Error(invalidFileMessage);
    if (fileInfo.size > maxBytes) {
      throw new Error(tooLargeMessage ?? integrityMessage);
    }
    if (
      !Number.isSafeInteger(byteCount) ||
      byteCount < 1 ||
      byteCount > maxBytes ||
      typeof sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(sha256) ||
      fileInfo.size !== byteCount
    ) {
      throw new Error(integrityMessage);
    }

    const bytes = readFileSync(descriptor);
    if (
      bytes.byteLength !== byteCount ||
      createHash("sha256").update(bytes).digest("hex") !== sha256
    ) {
      throw new Error(integrityMessage);
    }
    return bytes;
  } catch (error) {
    if (
      error instanceof Error &&
      [invalidFileMessage, integrityMessage, tooLargeMessage].includes(
        error.message,
      )
    ) {
      throw error;
    }
    throw new Error(invalidFileMessage);
  } finally {
    try {
      closeSync(descriptor);
    } catch {
      // Preserve a read or verification error if the descriptor already closed.
    }
  }
}

function readTrace(directory, record, verifyObserverIntegrity = false) {
  if (verifyObserverIntegrity) {
    const bytes = readVerifiedRegularFile(directory, record.trace, {
      byteCount: record.byteCount,
      sha256: record.sha256,
      maxBytes: OBSERVER_TRACE_BYTE_LIMIT,
      invalidFileMessage: "Unable to read observer trace.",
      integrityMessage: "Observer trace integrity check failed.",
      tooLargeMessage: "Observer trace exceeds the 16 MiB limit.",
    });
    let trace;
    try {
      trace = parseTrace(bytes.toString("utf8"));
    } catch {
      throw new Error("Invalid observer trace JSON.");
    }
    return { bytes, trace };
  }

  const tracePath = resolve(directory, record.trace);
  let fileInfo;
  try {
    fileInfo = lstatSync(tracePath);
  } catch {
    throw new Error(`Unable to read trace '${record.trace}'.`);
  }
  if (!fileInfo.isFile()) {
    throw new Error(`Trace '${record.trace}' must be a regular file.`);
  }

  let bytes;
  try {
    bytes = readFileSync(tracePath);
  } catch {
    throw new Error(`Unable to read trace '${record.trace}'.`);
  }

  let trace;
  try {
    trace = parseTrace(bytes.toString("utf8"));
  } catch {
    throw new Error(`Invalid trace JSON '${record.trace}'.`);
  }

  return { bytes, trace };
}

function parseObserverSidecar(bytes) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Invalid observer sidecar JSON.");
  }
}

function loadObserverInputs(manifest, directory) {
  if (!Array.isArray(manifest.cases)) {
    throw new Error("Invalid observer case and trace linkage.");
  }

  const linkedCases = new Map();
  const usedCases = new Set();
  for (const traceRecord of manifest.traces) {
    const candidates = manifest.cases.filter(
      (caseRecord) =>
        isRecord(caseRecord) &&
        (caseRecord.fixture === traceRecord.fixture ||
          caseRecord.trace === traceRecord.trace),
    );
    if (
      candidates.length !== 1 ||
      candidates[0].fixture !== traceRecord.fixture ||
      candidates[0].trace !== traceRecord.trace ||
      usedCases.has(candidates[0])
    ) {
      throw new Error("Invalid observer case and trace linkage.");
    }
    usedCases.add(candidates[0]);
    linkedCases.set(traceRecord.trace, candidates[0]);
  }

  const traceInputs = new Map();
  for (const traceRecord of manifest.traces) {
    traceInputs.set(traceRecord.trace, readTrace(directory, traceRecord, true));
  }

  const sidecarsByCase = new Map();
  const referencedNames = new Set();
  for (const caseRecord of manifest.cases) {
    if (!isRecord(caseRecord)) {
      throw new Error("Invalid observer case and trace linkage.");
    }
    const declaration = caseRecord.trustedStimulusObservation;
    const hasFileName =
      isRecord(declaration) && Object.hasOwn(declaration, "fileName");
    if (!hasFileName) {
      if (usedCases.has(caseRecord)) {
        throw new Error("Invalid observer sidecar reference.");
      }
      continue;
    }

    const fileName = declaration.fileName;
    if (!isSafeManifestBasename(fileName) || referencedNames.has(fileName)) {
      throw new Error("Invalid observer sidecar reference.");
    }
    referencedNames.add(fileName);
    const bytes = readVerifiedRegularFile(directory, fileName, {
      byteCount: declaration.byteCount,
      sha256: declaration.sha256,
      maxBytes: OBSERVER_SIDECAR_BYTE_LIMIT,
      invalidFileMessage: "Unable to read observer sidecar.",
      integrityMessage: "Observer sidecar integrity check failed.",
    });
    sidecarsByCase.set(caseRecord, parseObserverSidecar(bytes));
  }

  const evidenceByTrace = new Map();
  for (const traceRecord of manifest.traces) {
    const caseRecord = linkedCases.get(traceRecord.trace);
    const sidecar = sidecarsByCase.get(caseRecord);
    if (sidecar === undefined) {
      throw new Error("Invalid observer sidecar reference.");
    }
    evidenceByTrace.set(traceRecord.trace, {
      declaration: manifest.observationEvidence,
      sidecar,
      capture: {
        sourceHashSha256: manifest.sourceHashSha256,
        caseRecord,
      },
    });
  }

  return { traceInputs, evidenceByTrace };
}

function buildTraceReport(
  directory,
  record,
  measurementSegments,
  browserSourceObservations,
  preparedInput,
  observerEvidence,
) {
  const { bytes, trace } = preparedInput ?? readTrace(directory, record);
  const traceRecordForAnalysis =
    observerEvidence === undefined
      ? {
          trace: record.trace,
          dataLossOccurred:
            typeof record.dataLossOccurred === "boolean"
              ? record.dataLossOccurred
              : undefined,
        }
      : record;
  const analysis = analyzeTrace(
    trace,
    traceRecordForAnalysis,
    measurementSegments,
    browserSourceObservations,
    observerEvidence,
  );
  const reportedFrameIntervals = { ...analysis.frameIntervals };
  delete reportedFrameIntervals.qualifiedProtocolTrials;
  delete reportedFrameIntervals.unqualifiedProtocolTrials;

  return {
    analysis,
    report: {
      fixture: record.fixture,
      trace: record.trace,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      dataLossOccurred:
        typeof record.dataLossOccurred === "boolean"
          ? record.dataLossOccurred
          : null,
      counts: analysis.counts,
      eventTimingInventory: eventTimingInventory(trace),
      discreteEventTimingCrosswalk: analysis.discreteEventTimingCrosswalk,
      inputToPresentedFrameSamples: analysis.inputToPresentedFrameSamples.map(
        ({ durationUs, status, reasonCodes }) => ({
          duration: durationUs,
          unit: "microseconds",
          status,
          reasonCodes,
        }),
      ),
      frameIntervals: {
        ...reportedFrameIntervals,
        unit: "microseconds",
      },
      diagnostics: analysis.diagnostics,
      ...(observerEvidence === undefined
        ? {}
        : { observedDiscreteInputs: analysis.observedDiscreteInputs }),
    },
  };
}

function countByStatus(trials, session) {
  const counts = { missing: 0, censored: 0, invalid: 0 };
  for (const trial of trials) {
    if (session !== undefined && trial.session !== session) continue;
    counts[trial.status] += 1;
  }
  return counts;
}

function countReasons(
  trials,
  session,
  unreportedMissing = 0,
  derivedTrials = [],
) {
  const counts = new Map();
  for (const trial of trials) {
    if (session !== undefined && trial.session !== session) continue;
    counts.set(trial.reason, (counts.get(trial.reason) ?? 0) + 1);
  }
  for (const trial of derivedTrials) {
    if (session !== undefined && trial.session !== session) continue;
    counts.set(trial.reason, (counts.get(trial.reason) ?? 0) + 1);
  }
  if (unreportedMissing > 0) {
    counts.set(
      "NOT_CAPTURED",
      (counts.get("NOT_CAPTURED") ?? 0) + unreportedMissing,
    );
  }
  return Object.fromEntries(
    [...counts].sort(([left], [right]) => left.localeCompare(right)),
  );
}

function countDerivedStatuses(trials, session) {
  const counts = { missing: 0, censored: 0, invalid: 0 };
  for (const trial of trials) {
    if (session !== undefined && trial.session !== session) continue;
    counts[trial.status] += 1;
  }
  return counts;
}

function buildProtocolGroupReport(group, groupIndex, manifest, builtTraces) {
  const linkedBySession = [new Set(), new Set(), new Set()];
  for (const segment of manifest.measurementSegments ?? []) {
    if (segment.protocolGroupIndex !== groupIndex) continue;
    linkedBySession[segment.session - 1].add(segment.trial);
  }

  const protocolSamples = builtTraces.flatMap(({ analysis }) =>
    analysis.frameIntervals.samples.filter(
      (sample) => sample.protocolGroupIndex === groupIndex,
    ),
  );
  const intervalSamples = protocolSamples.map((sample) => sample.intervalUs);
  const qualifiedBySession = [new Set(), new Set(), new Set()];
  for (const { analysis } of builtTraces) {
    for (const trial of analysis.frameIntervals.qualifiedProtocolTrials) {
      if (trial.protocolGroupIndex === groupIndex) {
        qualifiedBySession[trial.session - 1].add(trial.trial);
      }
    }
  }
  const intervalTrialsBySession = [new Set(), new Set(), new Set()];
  const unqualifiedBySession = [[], [], []];
  for (const sample of protocolSamples) {
    intervalTrialsBySession[sample.session - 1].add(sample.trial);
  }
  for (const { analysis } of builtTraces) {
    for (const trial of analysis.frameIntervals.unqualifiedProtocolTrials) {
      if (trial.protocolGroupIndex === groupIndex) {
        unqualifiedBySession[trial.session - 1].push(trial);
      }
    }
  }

  const sessions = group.sessions
    .slice()
    .sort((left, right) => left.session - right.session)
    .map(({ session, plannedTrials }) => {
      const declared = countByStatus(group.trials, session);
      const linked = linkedBySession[session - 1];
      const qualified = qualifiedBySession[session - 1];
      const derived = countDerivedStatuses(unqualifiedBySession[session - 1]);
      const unreportedTrials = Math.max(
        0,
        plannedTrials -
          declared.missing -
          declared.censored -
          declared.invalid -
          linked.size,
      );
      return {
        session,
        plannedTrials,
        trialCounts: {
          qualifiedFrameTrials: qualified.size,
          noAdjacentPresentedFrameTrials:
            qualified.size - intervalTrialsBySession[session - 1].size,
          missing: declared.missing + unreportedTrials + derived.missing,
          censored: declared.censored + derived.censored,
          invalid: declared.invalid + derived.invalid,
        },
        trialReasonCounts: countReasons(
          group.trials,
          session,
          unreportedTrials,
          unqualifiedBySession[session - 1],
        ),
        frameIntervalSampleCount: protocolSamples.filter(
          (sample) => sample.session === session,
        ).length,
      };
    });

  const declared = countByStatus(group.trials);
  const qualifiedTrialCount = qualifiedBySession.reduce(
    (total, trials) => total + trials.size,
    0,
  );
  const linkedTrialCount = linkedBySession.reduce(
    (total, trials) => total + trials.size,
    0,
  );
  const unqualifiedLinkedTrials = linkedTrialCount - qualifiedTrialCount;
  const derivedStatuses = countDerivedStatuses(unqualifiedBySession.flat());
  const unreportedTrials = Math.max(
    0,
    group.plannedTrials -
      declared.missing -
      declared.censored -
      declared.invalid -
      linkedTrialCount,
  );
  const missing = declared.missing + unreportedTrials + derivedStatuses.missing;
  const intervalTrialCount = intervalTrialsBySession.reduce(
    (total, trials) => total + trials.size,
    0,
  );
  const noAdjacentPresentedFrameTrials =
    qualifiedTrialCount - intervalTrialCount;
  const frameIntervals = {
    status: "unavailable",
    sampleCount: intervalSamples.length,
    qualifiedTrialCount,
    noAdjacentPresentedFrameTrials,
    minimums: { intervals: 100, qualifiedTrials: 100 },
    p50: null,
    p95: null,
    unit: "microseconds",
    reasonCodes: [],
  };
  if (unqualifiedLinkedTrials > 0) {
    frameIntervals.reasonCodes.push("UNQUALIFIED_LINKED_TRIALS");
  }
  if (intervalSamples.length >= 100 && qualifiedTrialCount >= 100) {
    frameIntervals.status = "observed-only";
    frameIntervals.p50 = nearestRank(intervalSamples, 0.5);
    frameIntervals.p95 = nearestRank(intervalSamples, 0.95);
    frameIntervals.reasonCodes.push("SOURCE_COMPLETENESS_UNPROVEN");
    if (noAdjacentPresentedFrameTrials > 0) {
      frameIntervals.reasonCodes.push("NO_ADJACENT_PRESENTED_FRAME");
    }
    if (qualifiedTrialCount < group.plannedTrials) {
      frameIntervals.reasonCodes.push("INCOMPLETE_PLANNED_COVERAGE");
    }
  } else {
    if (noAdjacentPresentedFrameTrials > 0) {
      frameIntervals.reasonCodes.push("NO_ADJACENT_PRESENTED_FRAME");
    }
    frameIntervals.reasonCodes.push("INSUFFICIENT_VALID_SAMPLES");
  }

  return {
    deviceKey: group.deviceKey,
    browserKey: group.browserKey,
    workload: group.workload,
    action: group.action,
    plannedTrials: group.plannedTrials,
    trialCounts: {
      planned: group.plannedTrials,
      qualifiedFrameTrials: qualifiedTrialCount,
      noAdjacentPresentedFrameTrials:
        qualifiedTrialCount -
        intervalTrialsBySession.reduce(
          (total, trials) => total + trials.size,
          0,
        ),
      missing,
      censored: declared.censored + derivedStatuses.censored,
      invalid: declared.invalid + derivedStatuses.invalid,
    },
    trialReasonCounts: countReasons(
      group.trials,
      undefined,
      unreportedTrials,
      unqualifiedBySession.flat(),
    ),
    sessions,
    nextPaint: {
      status: "unavailable",
      samples: [],
      reasonCodes: ["NEXT_PAINT_METHOD_UNPROVEN"],
    },
    frameIntervals,
  };
}

function buildReport(manifest, manifestPath, ownedCleanupReceipt = null) {
  if (manifest.observationEvidence?.schemaVersion === 3) {
    const measurementSegments = manifest.measurementSegments ?? [];
    if (
      !Array.isArray(manifest.traces) ||
      manifest.traces.length !== 1 ||
      !Array.isArray(manifest.cases) ||
      manifest.cases.length !== 1 ||
      !Array.isArray(measurementSegments) ||
      measurementSegments.length !== 0 ||
      (manifest.protocolGroups !== undefined &&
        (!Array.isArray(manifest.protocolGroups) ||
          manifest.protocolGroups.length !== 0))
    ) {
      throw new Error(
        "Version-three analysis requires one case and trace without action segments.",
      );
    }
  }
  const manifestDirectory = dirname(manifestPath);
  const observerInputs =
    manifest.observationEvidence === undefined
      ? undefined
      : loadObserverInputs(manifest, manifestDirectory);
  const browserSourceObservations = {
    browser: manifest.browser,
    browserIdentity: manifest.browserIdentity,
    ...(manifest.qualification === undefined
      ? {}
      : { qualification: manifest.qualification }),
    status: manifest.status,
  };
  const builtTraces = manifest.traces.map((record) =>
    buildTraceReport(
      manifestDirectory,
      record,
      manifest.measurementSegments ?? [],
      browserSourceObservations,
      observerInputs?.traceInputs.get(record.trace),
      observerInputs?.evidenceByTrace.get(record.trace),
    ),
  );
  const report = {
    schemaVersion: 1,
    status: "diagnostic-only",
    metric: "input-to-presented-frame",
    metadata: selectedMetadata(manifest),
    traces: builtTraces.map(({ report: traceReport }) => traceReport),
  };
  if (ownedCleanupReceipt !== null) {
    report.metadata.ownedCleanupReceipt = ownedCleanupReceipt;
  }
  if (manifest.protocolGroups !== undefined) {
    report.protocolGroups = manifest.protocolGroups.map((group, index) =>
      buildProtocolGroupReport(group, index, manifest, builtTraces),
    );
  }
  return report;
}

function readOptionalOwnedCleanupReceipt(
  manifestPath,
  manifestBytes,
  required = false,
) {
  const directory = dirname(manifestPath);
  const receiptPath = resolve(directory, OWNED_CLEANUP_RECEIPT_FILENAME);
  let fileInfo;
  try {
    fileInfo = lstatSync(receiptPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      if (required) {
        throw new Error(
          "Version-three cleanup receipt is required for analysis.",
        );
      }
      return null;
    }
    throw new Error("Unable to read owned cleanup receipt.");
  }
  if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) {
    throw new Error("Invalid owned cleanup receipt file.");
  }

  let descriptor;
  try {
    descriptor = openSync(
      receiptPath,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
  } catch {
    throw new Error("Unable to read owned cleanup receipt.");
  }

  try {
    const openedInfo = fstatSync(descriptor);
    if (!openedInfo.isFile()) {
      throw new Error("Invalid owned cleanup receipt file.");
    }
    if (openedInfo.size > OWNED_CLEANUP_RECEIPT_BYTE_LIMIT) {
      throw new Error("Owned cleanup receipt exceeds the 16 KiB limit.");
    }

    const buffer = Buffer.alloc(OWNED_CLEANUP_RECEIPT_BYTE_LIMIT + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const bytesRead = readSync(
        descriptor,
        buffer,
        offset,
        buffer.byteLength - offset,
        null,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > OWNED_CLEANUP_RECEIPT_BYTE_LIMIT) {
      throw new Error("Owned cleanup receipt exceeds the 16 KiB limit.");
    }

    const receipt = parseOwnedCleanupReceipt(
      buffer.subarray(0, offset),
      manifestBytes,
    );
    if (
      required &&
      (receipt.primaryRunFailure !== null ||
        receipt.context.outcome !== "closed" ||
        receipt.browser.outcome !== "closed" ||
        receipt.ownedServer.stopHelper !== "returned" ||
        receipt.ownedServer.processGroupSnapshot.outcome === "nonempty" ||
        receipt.cleanupFailures.length !== 0)
    ) {
      throw new Error(
        "Version-three analysis requires a successful run cleanup receipt.",
      );
    }
    return summarizeOwnedCleanupReceipt(receipt);
  } catch (error) {
    if (
      error instanceof Error &&
      [
        "Invalid owned cleanup receipt file.",
        "Owned cleanup receipt exceeds the 16 KiB limit.",
        "Invalid owned cleanup receipt.",
        "Owned cleanup receipt manifest binding failed.",
        "Version-three analysis requires a successful run cleanup receipt.",
      ].includes(error.message)
    ) {
      throw error;
    }
    throw new Error("Unable to read owned cleanup receipt.");
  } finally {
    try {
      closeSync(descriptor);
    } catch {
      // Preserve the receipt read or validation error.
    }
  }
}

function writeExclusive(outputPath, contents) {
  let descriptor;
  try {
    descriptor = openSync(outputPath, "wx", 0o600);
    writeFileSync(descriptor, contents, "utf8");
    closeSync(descriptor);
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // The descriptor may already have been closed.
      }
      try {
        unlinkSync(outputPath);
      } catch {
        // Preserve the original output error.
      }
    }
    if (error?.code === "EEXIST") {
      throw new Error(
        `Output already exists or is not exclusive: ${outputPath}`,
      );
    }
    throw new Error(`Unable to write output report: ${outputPath}`);
  }
}

function parseArguments(args) {
  if (args.length === 1 && typeof args[0] === "string" && args[0].length > 0) {
    return { manifestPath: args[0], outputPath: null };
  }
  if (
    args.length === 3 &&
    typeof args[0] === "string" &&
    args[0].length > 0 &&
    args[1] === "--out" &&
    typeof args[2] === "string" &&
    args[2].length > 0
  ) {
    return { manifestPath: args[0], outputPath: args[2] };
  }
  throw new Error(USAGE);
}

function main(args) {
  const parsedArgs = parseArguments(args);
  const manifestPath = resolve(parsedArgs.manifestPath);
  let manifestBytes;
  try {
    manifestBytes = readFileSync(manifestPath);
  } catch {
    throw new Error("Unable to read manifest.");
  }

  const manifest = parseManifest(manifestBytes);
  const ownedCleanupReceipt = readOptionalOwnedCleanupReceipt(
    manifestPath,
    manifestBytes,
    manifest.observationEvidence?.schemaVersion === 3,
  );
  const report = buildReport(manifest, manifestPath, ownedCleanupReceipt);
  const reportText = `${JSON.stringify(report, null, 2)}\n`;

  if (parsedArgs.outputPath === null) {
    process.stdout.write(reportText);
    return;
  }

  const outputPath = resolve(parsedArgs.outputPath);
  writeExclusive(outputPath, reportText);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Trace analysis failed."}\n`,
  );
  process.exitCode = 1;
}
