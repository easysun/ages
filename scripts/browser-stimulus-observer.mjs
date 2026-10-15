import { createHash } from "node:crypto";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const OBSERVATION_LIMITS = Object.freeze({
  records: 512,
  recordBytes: 240 * 1024,
  sidecarBytes: 256 * 1024,
  drainTimeoutMs: 1000,
});

export const TRUSTED_STIMULUS_EVIDENCE_CLASS =
  "synthetic-Playwright-stimulus-discovery";

const ALLOWED_DOM_TYPES = [
  "click",
  "pointerdown",
  "pointerup",
  "pointermove",
  "keydown",
  "keyup",
  "wheel",
  "resize",
];
const ALLOWED_EVENT_TIMING_TYPES = [
  "click",
  "pointerdown",
  "pointerup",
  "keydown",
  "keyup",
];
const ALLOWED_TARGET_LABELS = [
  "open-primary",
  "open-secondary",
  "fit-all",
  "story-viewport",
  "calendar-viewport",
  "append-confirm",
  "scroll-container",
  "window",
];
const ALLOWED_PHASES = [
  "preparatory",
  "primary",
  "immediate",
  "completion-hold",
  "completion",
  "secondary",
  "scroll",
];
const ALLOWED_TARGET_RESOLUTIONS = [
  "registered-target",
  "registered-ancestor",
  "unknown",
  "removed-or-unknown",
  "window",
];
const ALLOWED_REASON_CODES = new Set([
  "NAVIGATION_OBSERVATION_LOST",
  "OBSERVATION_RECORD_LIMIT_EXCEEDED",
  "OBSERVATION_RECORD_BYTES_EXCEEDED",
  "OBSERVATION_SIDECAR_BYTE_LIMIT_EXCEEDED",
  "OBSERVATION_DRAIN_TIMEOUT",
  "OBSERVATION_DRAIN_FAILED",
  "OBSERVATION_PAYLOAD_INVALID",
  "OBSERVATION_NOT_ARMED",
  "OBSERVATION_ALREADY_CLOSED",
  "PERFORMANCE_EVENT_TIMING_UNSUPPORTED",
  "PERFORMANCE_EVENT_TIMING_UNAVAILABLE",
  "OBSERVATION_SIDECAR_WRITE_FAILED",
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, expected) {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  const allowed = [...expected].sort();
  return (
    keys.length === allowed.length &&
    keys.every((key, index) => key === allowed[index])
  );
}

function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

function browserObservationBytes(records) {
  return byteLength(JSON.stringify(records));
}

function unavailableObservation(reasonCode, documentId) {
  const safeReason = ALLOWED_REASON_CODES.has(reasonCode)
    ? reasonCode
    : "OBSERVATION_DRAIN_FAILED";
  return {
    schemaVersion: 1,
    status: "unavailable",
    reasonCode: safeReason,
    documentId,
    apiStatus: "unknown",
    apiMetadata: {
      entryType: "event",
      durationThresholdMs: 16,
      buffered: false,
      quantized: true,
      continuousInputExcluded: true,
    },
    records: [],
    recordCount: 0,
    recordBytes: 2,
  };
}

function lostNavigationObservation(documentId) {
  return {
    schemaVersion: 1,
    status: "censored",
    reasonCode: "NAVIGATION_OBSERVATION_LOST",
    documentId,
    apiStatus: "unknown",
    apiMetadata: {
      entryType: "event",
      durationThresholdMs: 16,
      buffered: false,
      quantized: true,
      continuousInputExcluded: true,
    },
    records: [],
    recordCount: 0,
    recordBytes: 2,
  };
}

/** This function is serialized into each owned case page and must stay self-contained. */
export function initializeTrustedStimulusObserver() {
  const property = "__agesTrustedStimulusObserver";
  if (globalThis[property]) return;

  const domTypes = [
    "click",
    "pointerdown",
    "pointerup",
    "pointermove",
    "keydown",
    "keyup",
    "wheel",
    "resize",
  ];
  const timingTypes = ["click", "pointerdown", "pointerup", "keydown", "keyup"];
  const targetLabels = [
    "open-primary",
    "open-secondary",
    "fit-all",
    "story-viewport",
    "calendar-viewport",
    "append-confirm",
    "scroll-container",
    "window",
  ];
  const phases = [
    "preparatory",
    "primary",
    "immediate",
    "completion-hold",
    "completion",
    "secondary",
    "scroll",
  ];
  const limits = {
    records: 512,
    recordBytes: 240 * 1024,
    sidecarBytes: 256 * 1024,
  };
  const metadata = {
    entryType: "event",
    durationThresholdMs: 16,
    buffered: false,
    quantized: true,
    continuousInputExcluded: true,
  };
  const newOpaqueId = (prefix) => {
    const bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    let hex = "";
    for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
    return `${prefix}-${hex}`;
  };
  const documentId = newOpaqueId("d");
  const tokens = new WeakMap();
  const labels = new WeakMap();
  const listenerEntries = [];
  const records = [];
  let recordBytes = 2;
  let armedAt = null;
  let armed = false;
  let armCount = 0;
  let currentPhase = "primary";
  let overflowReason = null;
  let apiStatus = "unsupported";
  let performanceObserver = null;
  let disposed = false;

  const bytesOf = (value) => new TextEncoder().encode(value).byteLength;
  const rememberToken = (target) => {
    if (
      target === null ||
      (typeof target !== "object" && typeof target !== "function")
    ) {
      return null;
    }
    let token = tokens.get(target);
    if (!token) {
      token = newOpaqueId("t");
      tokens.set(target, token);
    }
    return token;
  };
  const resolveTarget = (target) => {
    if (target === window) {
      return {
        targetToken: null,
        targetLabel: "window",
        targetResolution: "window",
      };
    }
    const targetToken = rememberToken(target);
    if (
      target === null ||
      (typeof target !== "object" && typeof target !== "function")
    ) {
      return {
        targetToken: null,
        targetLabel: null,
        targetResolution: "unknown",
      };
    }
    if (target.isConnected === false) {
      return {
        targetToken,
        targetLabel: null,
        targetResolution: "removed-or-unknown",
      };
    }
    let current = target;
    for (let depth = 0; current && depth < 64; depth += 1) {
      const label = labels.get(current);
      if (label) {
        return {
          targetToken,
          targetLabel: label,
          targetResolution:
            current === target ? "registered-target" : "registered-ancestor",
        };
      }
      current = current.parentNode;
    }
    return {
      targetToken,
      targetLabel: null,
      targetResolution: "unknown",
    };
  };
  const updateRecordBytes = (record) => {
    const nextBytes =
      recordBytes +
      bytesOf(JSON.stringify(record)) +
      (records.length > 0 ? 1 : 0);
    if (records.length >= limits.records) {
      overflowReason ??= "OBSERVATION_RECORD_LIMIT_EXCEEDED";
      return false;
    }
    if (nextBytes > limits.recordBytes) {
      overflowReason ??= "OBSERVATION_RECORD_BYTES_EXCEEDED";
      return false;
    }
    records.push(record);
    recordBytes = nextBytes;
    return true;
  };
  const validTime = (value) => Number.isFinite(value) && value >= 0;
  const collectEventTiming = (entry) => {
    if (!armed || overflowReason) return;
    const type = entry?.name;
    if (!timingTypes.includes(type)) return;
    const startTime = entry.startTime;
    if (!validTime(startTime)) {
      apiStatus = "failed";
      return;
    }
    if (startTime < armedAt) return;
    const processingStart = entry.processingStart;
    const processingEnd = entry.processingEnd;
    const duration = entry.duration;
    const interactionId = entry.interactionId;
    if (
      !validTime(processingStart) ||
      !validTime(processingEnd) ||
      !validTime(duration) ||
      processingStart < startTime ||
      processingEnd < processingStart ||
      !Number.isSafeInteger(interactionId) ||
      interactionId < 0
    ) {
      apiStatus = "failed";
      return;
    }
    const target = resolveTarget(entry.target ?? null);
    updateRecordBytes({
      kind: "event-timing",
      documentId,
      type,
      startTime,
      processingStart,
      processingEnd,
      duration,
      interactionId,
      ...target,
      deliveryPhase: currentPhase,
    });
  };
  if (
    typeof PerformanceObserver === "function" &&
    Array.isArray(PerformanceObserver.supportedEntryTypes) &&
    PerformanceObserver.supportedEntryTypes.includes("event")
  ) {
    try {
      performanceObserver = new PerformanceObserver((list) => {
        if (!armed || overflowReason) return;
        try {
          for (const entry of list.getEntries()) collectEventTiming(entry);
        } catch {
          apiStatus = "failed";
        }
      });
      performanceObserver.observe({
        type: "event",
        buffered: false,
        durationThreshold: 16,
      });
      apiStatus = "thresholded";
    } catch {
      performanceObserver = null;
      apiStatus = "failed";
    }
  }

  const onDomEvent = (event) => {
    if (
      !armed ||
      overflowReason ||
      !domTypes.includes(event?.type) ||
      !validTime(event.timeStamp) ||
      event.timeStamp < armedAt ||
      typeof event.isTrusted !== "boolean"
    ) {
      return;
    }
    updateRecordBytes({
      kind: "dom",
      documentId,
      type: event.type,
      timeStamp: event.timeStamp,
      isTrusted: event.isTrusted,
      ...resolveTarget(event.target ?? null),
      phase: currentPhase,
    });
  };
  for (const type of domTypes) {
    const target = type === "resize" ? window : document;
    const capture = type !== "resize";
    target.addEventListener(type, onDomEvent, capture);
    listenerEntries.push([target, type, onDomEvent, capture]);
  }

  const apiMetadata = () => ({ ...metadata });
  const snapshot = (status, reasonCode) => {
    let payload = {
      schemaVersion: 1,
      status,
      reasonCode,
      documentId,
      apiStatus,
      apiMetadata: apiMetadata(),
      records: [...records],
      recordCount: records.length,
      recordBytes,
    };
    const sidecarByteCount = (currentObservation) =>
      bytesOf(
        `${JSON.stringify(
          {
            schemaVersion: 1,
            evidenceClass: "synthetic-Playwright-stimulus-discovery",
            instrumented: true,
            qualification: "diagnostic-only",
            fixture: "x".repeat(101),
            inputMethod:
              "Synthetic Playwright stimulus; DOM isTrusted means browser-dispatched only and does not establish human input or physical equivalence.",
            interpretation: {
              eventTiming:
                "PerformanceEventTiming is thresholded at 16 ms and browser-quantized; continuous input is excluded.",
              targets:
                "Target IDs are opaque per-document tokens; unknown, null, and removed targets remain uncertain.",
            },
            observation: currentObservation,
          },
          null,
          2,
        )}\n`,
      );
    while (
      records.length > 0 &&
      sidecarByteCount(payload) > limits.sidecarBytes
    ) {
      records.pop();
      recordBytes = bytesOf(JSON.stringify(records));
      payload.records = [...records];
      payload.recordCount = records.length;
      payload.recordBytes = recordBytes;
      payload.status = "censored";
      payload.reasonCode ??= "OBSERVATION_SIDECAR_BYTE_LIMIT_EXCEEDED";
    }
    if (sidecarByteCount(payload) > limits.sidecarBytes) {
      payload = {
        schemaVersion: 1,
        status: "unavailable",
        reasonCode: "OBSERVATION_SIDECAR_BYTE_LIMIT_EXCEEDED",
        documentId,
        apiStatus: "unknown",
        apiMetadata: apiMetadata(),
        records: [],
        recordCount: 0,
        recordBytes: 2,
      };
    }
    return payload;
  };
  const close = () => {
    if (disposed) return;
    armed = false;
    disposed = true;
    try {
      performanceObserver?.disconnect();
    } catch {}
    for (const [target, type, listener, capture] of listenerEntries) {
      try {
        target.removeEventListener(type, listener, capture);
      } catch {}
    }
  };
  const state = {
    documentId,
    arm() {
      if (disposed)
        return {
          status: "unavailable",
          reasonCode: "OBSERVATION_ALREADY_CLOSED",
        };
      if (armCount !== 0)
        return {
          status: "unavailable",
          reasonCode: "OBSERVATION_ALREADY_CLOSED",
        };
      records.length = 0;
      recordBytes = 2;
      overflowReason = null;
      try {
        performanceObserver?.takeRecords();
      } catch {
        apiStatus = "failed";
      }
      armedAt = performance.now();
      currentPhase = "primary";
      armed = true;
      armCount = 1;
      return { status: "armed", documentId };
    },
    setPhase(phase) {
      if (!armed || !phases.includes(phase)) return false;
      currentPhase = phase;
      return true;
    },
    registerTarget(target, label) {
      if (
        disposed ||
        !target ||
        (typeof target !== "object" && typeof target !== "function") ||
        !targetLabels.includes(label)
      ) {
        return false;
      }
      labels.set(target, label);
      return true;
    },
    async finish(expectedDocumentId) {
      if (expectedDocumentId !== documentId) {
        close();
        return {
          schemaVersion: 1,
          status: "censored",
          reasonCode: "NAVIGATION_OBSERVATION_LOST",
          documentId: expectedDocumentId,
          apiStatus: "unknown",
          apiMetadata: apiMetadata(),
          records: [],
          recordCount: 0,
          recordBytes: 2,
        };
      }
      if (!armed) {
        close();
        return {
          schemaVersion: 1,
          status: "unavailable",
          reasonCode: "OBSERVATION_NOT_ARMED",
          documentId,
          apiStatus,
          apiMetadata: apiMetadata(),
          records: [],
          recordCount: 0,
          recordBytes: 2,
        };
      }
      const deadline = performance.now() + 1000;
      let quietDrains = 0;
      let attempts = 0;
      let drainFailed = false;
      try {
        while (
          quietDrains < 2 &&
          attempts < 50 &&
          performance.now() < deadline
        ) {
          const before = records.length;
          await new Promise((resolve) => setTimeout(resolve, 20));
          for (const entry of performanceObserver?.takeRecords() ?? []) {
            collectEventTiming(entry);
          }
          quietDrains = before === records.length ? quietDrains + 1 : 0;
          attempts += 1;
        }
        if (quietDrains < 2) drainFailed = true;
      } catch {
        drainFailed = true;
      }
      try {
        for (const entry of performanceObserver?.takeRecords() ?? []) {
          collectEventTiming(entry);
        }
      } catch {
        drainFailed = true;
      }
      armed = false;
      if (drainFailed) overflowReason ??= "OBSERVATION_DRAIN_TIMEOUT";
      const reasonCode =
        overflowReason ??
        (apiStatus === "unsupported"
          ? "PERFORMANCE_EVENT_TIMING_UNSUPPORTED"
          : apiStatus === "failed"
            ? "PERFORMANCE_EVENT_TIMING_UNAVAILABLE"
            : null);
      const status =
        overflowReason || apiStatus !== "thresholded"
          ? "censored"
          : "diagnostic";
      const result = snapshot(status, reasonCode);
      close();
      return result;
    },
    close,
  };
  Object.defineProperty(globalThis, property, {
    configurable: true,
    enumerable: false,
    value: state,
  });
}

export async function installTrustedStimulusObserver(page) {
  await page.addInitScript(initializeTrustedStimulusObserver);
}

export async function armTrustedStimulusObserver(page) {
  const result = await page.evaluate(() => {
    const observer = globalThis.__agesTrustedStimulusObserver;
    return observer
      ? observer.arm()
      : { status: "unavailable", reasonCode: "OBSERVATION_DRAIN_FAILED" };
  });
  if (
    !isRecord(result) ||
    result.status !== "armed" ||
    typeof result.documentId !== "string" ||
    !/^d-[a-f0-9]{24}$/.test(result.documentId)
  ) {
    return { status: "unavailable", reasonCode: "OBSERVATION_DRAIN_FAILED" };
  }
  return result;
}

export async function setTrustedStimulusPhase(page, phase) {
  if (!ALLOWED_PHASES.includes(phase)) return false;
  try {
    return await page.evaluate((nextPhase) => {
      const observer = globalThis.__agesTrustedStimulusObserver;
      return observer ? observer.setPhase(nextPhase) : false;
    }, phase);
  } catch {
    return false;
  }
}

export async function registerTrustedStimulusTarget(_page, locator, label) {
  if (!ALLOWED_TARGET_LABELS.includes(label)) return false;
  try {
    return await locator.evaluate((element, targetLabel) => {
      const observer = globalThis.__agesTrustedStimulusObserver;
      return observer ? observer.registerTarget(element, targetLabel) : false;
    }, label);
  } catch {
    return false;
  }
}

export async function closeTrustedStimulusObserver(page, timeoutMs = 100) {
  if (!page || typeof page.evaluate !== "function") return;
  let timer;
  try {
    await Promise.race([
      page.evaluate(() => {
        globalThis.__agesTrustedStimulusObserver?.close();
      }),
      new Promise((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } catch {
  } finally {
    clearTimeout(timer);
  }
}

export function validateTrustedStimulusObservation(
  payload,
  expectedDocumentId,
) {
  const fail = (code = "OBSERVATION_PAYLOAD_INVALID") => {
    throw new Error(code);
  };
  if (!isRecord(payload)) fail();
  if (
    Number.isSafeInteger(payload.recordBytes) &&
    payload.recordBytes > OBSERVATION_LIMITS.recordBytes
  ) {
    fail("OBSERVATION_RECORD_BYTES_EXCEEDED");
  }
  if (
    !hasExactKeys(payload, [
      "schemaVersion",
      "status",
      "reasonCode",
      "documentId",
      "apiStatus",
      "apiMetadata",
      "records",
      "recordCount",
      "recordBytes",
    ]) ||
    payload.schemaVersion !== 1 ||
    !["diagnostic", "censored", "unavailable"].includes(payload.status) ||
    (payload.reasonCode !== null &&
      (typeof payload.reasonCode !== "string" ||
        !ALLOWED_REASON_CODES.has(payload.reasonCode))) ||
    typeof payload.documentId !== "string" ||
    !/^d-[a-f0-9]{24}$/.test(payload.documentId) ||
    payload.documentId !== expectedDocumentId ||
    !["thresholded", "unsupported", "failed", "unknown"].includes(
      payload.apiStatus,
    ) ||
    !hasExactKeys(payload.apiMetadata, [
      "entryType",
      "durationThresholdMs",
      "buffered",
      "quantized",
      "continuousInputExcluded",
    ]) ||
    payload.apiMetadata.entryType !== "event" ||
    payload.apiMetadata.durationThresholdMs !== 16 ||
    payload.apiMetadata.buffered !== false ||
    payload.apiMetadata.quantized !== true ||
    payload.apiMetadata.continuousInputExcluded !== true ||
    !Array.isArray(payload.records) ||
    payload.records.length > OBSERVATION_LIMITS.records ||
    payload.recordCount !== payload.records.length ||
    !Number.isSafeInteger(payload.recordBytes) ||
    payload.recordBytes < 0
  ) {
    fail();
  }

  const safeRecords = [];
  for (const record of payload.records) {
    if (!isRecord(record)) fail();
    if (record.kind === "dom") {
      if (
        !hasExactKeys(record, [
          "kind",
          "documentId",
          "type",
          "timeStamp",
          "isTrusted",
          "targetToken",
          "targetLabel",
          "targetResolution",
          "phase",
        ]) ||
        record.documentId !== payload.documentId ||
        !ALLOWED_DOM_TYPES.includes(record.type) ||
        !Number.isFinite(record.timeStamp) ||
        record.timeStamp < 0 ||
        typeof record.isTrusted !== "boolean" ||
        !ALLOWED_PHASES.includes(record.phase)
      ) {
        fail();
      }
    } else if (record.kind === "event-timing") {
      if (
        !hasExactKeys(record, [
          "kind",
          "documentId",
          "type",
          "startTime",
          "processingStart",
          "processingEnd",
          "duration",
          "interactionId",
          "targetToken",
          "targetLabel",
          "targetResolution",
          "deliveryPhase",
        ]) ||
        record.documentId !== payload.documentId ||
        !ALLOWED_EVENT_TIMING_TYPES.includes(record.type) ||
        ![
          record.startTime,
          record.processingStart,
          record.processingEnd,
          record.duration,
        ].every((time) => Number.isFinite(time) && time >= 0) ||
        record.processingStart < record.startTime ||
        record.processingEnd < record.processingStart ||
        !Number.isSafeInteger(record.interactionId) ||
        record.interactionId < 0 ||
        !ALLOWED_PHASES.includes(record.deliveryPhase)
      ) {
        fail();
      }
    } else {
      fail();
    }
    if (
      (record.targetToken !== null &&
        (typeof record.targetToken !== "string" ||
          !/^t-[a-f0-9]{24}$/.test(record.targetToken))) ||
      (record.targetLabel !== null &&
        !ALLOWED_TARGET_LABELS.includes(record.targetLabel)) ||
      !ALLOWED_TARGET_RESOLUTIONS.includes(record.targetResolution) ||
      ((record.targetResolution === "registered-target" ||
        record.targetResolution === "registered-ancestor") &&
        record.targetLabel === null) ||
      (record.targetResolution === "window" &&
        (record.targetToken !== null || record.targetLabel !== "window")) ||
      (record.targetResolution !== "window" && record.targetLabel === "window")
    ) {
      fail();
    }
    safeRecords.push({ ...record });
  }

  if (browserObservationBytes(safeRecords) !== payload.recordBytes) fail();
  if (payload.status === "diagnostic" && payload.reasonCode !== null) fail();
  if (payload.status !== "diagnostic" && payload.reasonCode === null) fail();
  if (
    payload.status === "diagnostic" &&
    (payload.apiStatus !== "thresholded" ||
      payload.records.some(
        (record) => record.kind === "event-timing" && record.type === "wheel",
      ))
  ) {
    fail();
  }

  return {
    schemaVersion: 1,
    status: payload.status,
    reasonCode: payload.reasonCode,
    documentId: payload.documentId,
    apiStatus: payload.apiStatus,
    apiMetadata: { ...payload.apiMetadata },
    records: safeRecords,
    recordCount: safeRecords.length,
    recordBytes: payload.recordBytes,
  };
}

export async function finishTrustedStimulusObserver(
  page,
  expectedDocumentId,
  timeoutMs = OBSERVATION_LIMITS.drainTimeoutMs,
) {
  if (!/^d-[a-f0-9]{24}$/.test(expectedDocumentId ?? "")) {
    return unavailableObservation(
      "OBSERVATION_DRAIN_FAILED",
      "d-000000000000000000000000",
    );
  }
  let timer;
  try {
    const payload = await Promise.race([
      page.evaluate(async (expected) => {
        const observer = globalThis.__agesTrustedStimulusObserver;
        if (observer) return observer.finish(expected);
        return {
          schemaVersion: 1,
          status: "censored",
          reasonCode: "NAVIGATION_OBSERVATION_LOST",
          documentId: expected,
          apiStatus: "unknown",
          apiMetadata: {
            entryType: "event",
            durationThresholdMs: 16,
            buffered: false,
            quantized: true,
            continuousInputExcluded: true,
          },
          records: [],
          recordCount: 0,
          recordBytes: 2,
        };
      }, expectedDocumentId),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("OBSERVATION_DRAIN_TIMEOUT")),
          timeoutMs,
        );
      }),
    ]);
    try {
      return validateTrustedStimulusObservation(payload, expectedDocumentId);
    } catch (error) {
      const reasonCode = ALLOWED_REASON_CODES.has(error?.message)
        ? error.message
        : "OBSERVATION_PAYLOAD_INVALID";
      return unavailableObservation(reasonCode, expectedDocumentId);
    }
  } catch (error) {
    return error?.message === "OBSERVATION_DRAIN_TIMEOUT"
      ? unavailableObservation("OBSERVATION_DRAIN_TIMEOUT", expectedDocumentId)
      : lostNavigationObservation(expectedDocumentId);
  } finally {
    clearTimeout(timer);
    await closeTrustedStimulusObserver(page, Math.min(100, timeoutMs));
  }
}

export function writeTrustedStimulusSidecar({ directory, fixture, payload }) {
  if (
    typeof fixture !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,100}$/.test(fixture)
  ) {
    throw new Error("OBSERVATION_PAYLOAD_INVALID");
  }
  let directoryInfo;
  try {
    directoryInfo = lstatSync(directory);
  } catch {
    throw new Error("OBSERVATION_SIDECAR_WRITE_FAILED");
  }
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
    throw new Error("OBSERVATION_SIDECAR_WRITE_FAILED");
  }
  const observation = validateTrustedStimulusObservation(
    payload,
    payload?.documentId,
  );
  const sidecar = {
    schemaVersion: 1,
    evidenceClass: TRUSTED_STIMULUS_EVIDENCE_CLASS,
    instrumented: true,
    qualification: "diagnostic-only",
    fixture,
    inputMethod:
      "Synthetic Playwright stimulus; DOM isTrusted means browser-dispatched only and does not establish human input or physical equivalence.",
    interpretation: {
      eventTiming:
        "PerformanceEventTiming is thresholded at 16 ms and browser-quantized; continuous input is excluded.",
      targets:
        "Target IDs are opaque per-document tokens; unknown, null, and removed targets remain uncertain.",
    },
    observation,
  };
  const serialized = `${JSON.stringify(sidecar, null, 2)}\n`;
  const byteCount = byteLength(serialized);
  if (byteCount > OBSERVATION_LIMITS.sidecarBytes) {
    throw new Error("OBSERVATION_SIDECAR_BYTE_LIMIT_EXCEEDED");
  }
  const fileName = `${fixture}.stimulus.json`;
  const path = join(directory, fileName);
  try {
    writeFileSync(path, serialized, { flag: "wx", mode: 0o600 });
  } catch {
    throw new Error("OBSERVATION_SIDECAR_WRITE_FAILED");
  }
  let bytes;
  try {
    bytes = readFileSync(path);
  } catch {
    throw new Error("OBSERVATION_SIDECAR_WRITE_FAILED");
  }
  return {
    fileName,
    byteCount: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    evidenceClass: TRUSTED_STIMULUS_EVIDENCE_CLASS,
    status: observation.status,
    reasonCode: observation.reasonCode,
    recordCount: observation.recordCount,
    apiStatus: observation.apiStatus,
  };
}

export function createUnavailableTrustedStimulusObservation(
  reasonCode,
  documentId = "d-000000000000000000000000",
) {
  const safeDocumentId = /^d-[a-f0-9]{24}$/.test(documentId)
    ? documentId
    : "d-000000000000000000000000";
  return unavailableObservation(reasonCode, safeDocumentId);
}
