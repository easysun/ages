import { createHash } from "node:crypto";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const OBSERVATION_LIMITS = Object.freeze({
  records: 512,
  recordBytes: 240 * 1024,
  sidecarBytes: 256 * 1024,
  drainTimeoutMs: 1000,
});

export const RETAINED_NODE_PROTOCOL_CATALOG_ID =
  "chromium-43a195105613ac83c21d3f14de279f4a045c7da0+v8-d89479ac5446a374c55a35be19b5a23437558d99";

export const RETAINED_NODE_EVIDENCE_POLICY = Object.freeze({
  enabled: true,
  maxNodes: 32,
  mappingByteLimit: 16 * 1024,
  protocolCatalogId: RETAINED_NODE_PROTOCOL_CATALOG_ID,
});

export const RETAINED_NODE_ENVELOPE_RESERVE_BYTES = 36 * 1024;
export const RETAINED_NODE_RECORD_BYTE_LIMIT =
  OBSERVATION_LIMITS.sidecarBytes - RETAINED_NODE_ENVELOPE_RESERVE_BYTES;

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
  "INPUT_FRAME_PROVENANCE_UNAVAILABLE",
]);
const ALLOWED_INPUT_FRAME_PROVENANCE_REASONS = new Set([
  "PROVENANCE_ACQUISITION_FAILED",
  "PROVENANCE_DOCUMENT_ID_MISMATCH",
  "PROVENANCE_MALFORMED_RESPONSE",
  "PROVENANCE_NOT_ARMED",
  "PROVENANCE_NOT_CAPTURED",
  "PROVENANCE_TIMEOUT",
  "ROOT_DOCUMENT_CHANGED",
  "ROOT_DOCUMENT_NAVIGATED",
  "ROOT_EVENT_BEFORE_BASELINE",
  "ROOT_FRAME_CHANGED",
  "ROOT_FRAME_DETACHED",
  "EXECUTION_CONTEXTS_CLEARED",
  "CDP_SESSION_LOST",
  "TARGET_CRASHED",
]);
const INPUT_FRAME_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const RETAINED_NODE_REASON_CODES = new Set([
  "RETAINED_NODE_CONTEXT_AMBIGUOUS",
  "RETAINED_NODE_SCOPE_UNSUPPORTED",
  "RETAINED_NODE_LIFECYCLE_INVALIDATED",
  "RETAINED_NODE_TRACE_ASSOCIATION_INVALID",
  "RETAINED_NODE_LIMIT_EXCEEDED",
  "RETAINED_NODE_MAPPING_FAILED",
  "RETAINED_NODE_COMMAND_TIMEOUT",
  "RETAINED_NODE_ENVELOPE_LIMIT_EXCEEDED",
  "RETAINED_NODE_CLEANUP_FAILED",
  "RETAINED_NODE_EVIDENCE_INVALID",
]);
const RETAINED_NODE_LOSS_REASONS = new Set([
  "NAVIGATION",
  "DOCUMENT_OPENED",
  "BF_CACHE_RESTORED",
  "FRAME_SCOPE_CHANGED",
  "EXECUTION_CONTEXT_LOST",
  "TARGET_CHANGED",
  "TARGET_CRASHED",
  "SESSION_LOST",
  "TRANSPORT_LOST",
  "TRACE_LOSS",
  "UNKNOWN_EVENT_SCOPE",
]);
const RETAINED_NODE_TOKEN_PATTERN = /^t-[a-f0-9]{24}$/;
const RETAINED_NODE_DOCUMENT_PATTERN = /^d-[a-f0-9]{24}$/;
const RETAINED_NODE_OPAQUE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

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

export function validateInputFrameProvenance(payload, expectedDocumentId) {
  const fail = () => {
    throw new Error("INPUT_FRAME_PROVENANCE_INVALID");
  };
  const isSnapshot = (snapshot) =>
    snapshot === null ||
    (hasExactKeys(snapshot, ["frameId", "loaderId"]) &&
      typeof snapshot.frameId === "string" &&
      INPUT_FRAME_ID_PATTERN.test(snapshot.frameId) &&
      typeof snapshot.loaderId === "string" &&
      INPUT_FRAME_ID_PATTERN.test(snapshot.loaderId));

  if (
    !hasExactKeys(payload, [
      "schemaVersion",
      "status",
      "reasonCode",
      "documentId",
      "beforeArm",
      "afterArm",
      "afterDrain",
    ]) ||
    payload.schemaVersion !== 1 ||
    !["stable", "invalid", "unknown"].includes(payload.status) ||
    (payload.reasonCode !== null &&
      (typeof payload.reasonCode !== "string" ||
        !ALLOWED_INPUT_FRAME_PROVENANCE_REASONS.has(payload.reasonCode))) ||
    (payload.documentId !== null &&
      (typeof payload.documentId !== "string" ||
        !/^d-[a-f0-9]{24}$/.test(payload.documentId))) ||
    (expectedDocumentId !== null &&
      (typeof expectedDocumentId !== "string" ||
        !/^d-[a-f0-9]{24}$/.test(expectedDocumentId))) ||
    (payload.documentId !== null &&
      expectedDocumentId !== null &&
      payload.documentId !== expectedDocumentId) ||
    !isSnapshot(payload.beforeArm) ||
    !isSnapshot(payload.afterArm) ||
    !isSnapshot(payload.afterDrain)
  ) {
    fail();
  }

  const snapshots = [payload.beforeArm, payload.afterArm, payload.afterDrain];
  const sameRootDocument = snapshots.every(
    (snapshot) =>
      snapshot !== null &&
      snapshot.frameId === snapshots[0]?.frameId &&
      snapshot.loaderId === snapshots[0]?.loaderId,
  );
  if (
    (payload.status === "stable" &&
      (payload.reasonCode !== null ||
        payload.documentId === null ||
        !sameRootDocument)) ||
    (payload.status !== "stable" && payload.reasonCode === null)
  ) {
    fail();
  }

  return {
    schemaVersion: 1,
    status: payload.status,
    reasonCode: payload.reasonCode,
    documentId: payload.documentId,
    beforeArm: payload.beforeArm ? { ...payload.beforeArm } : null,
    afterArm: payload.afterArm ? { ...payload.afterArm } : null,
    afterDrain: payload.afterDrain ? { ...payload.afterDrain } : null,
  };
}

function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

export function validateRetainedNodeEvidence(evidence) {
  const fail = (code = "RETAINED_NODE_EVIDENCE_INVALID") => {
    throw new Error(code);
  };
  const isDocumentId = (value) =>
    typeof value === "string" && RETAINED_NODE_DOCUMENT_PATTERN.test(value);
  const isSnapshot = (snapshot) =>
    snapshot === null ||
    (hasExactKeys(snapshot, ["documentId", "frameId", "loaderId"]) &&
      isDocumentId(snapshot.documentId) &&
      typeof snapshot.frameId === "string" &&
      RETAINED_NODE_OPAQUE_ID_PATTERN.test(snapshot.frameId) &&
      typeof snapshot.loaderId === "string" &&
      RETAINED_NODE_OPAQUE_ID_PATTERN.test(snapshot.loaderId));
  const isNullableBoolean = (value) =>
    value === null || typeof value === "boolean";

  if (
    !hasExactKeys(evidence, [
      "status",
      "reasonCode",
      "mappings",
      "executionContext",
      "documentId",
      "snapshots",
      "protocolCatalogId",
      "lifecycle",
      "scope",
      "cleanup",
    ]) ||
    !["complete", "unavailable"].includes(evidence.status) ||
    (evidence.reasonCode !== null &&
      (typeof evidence.reasonCode !== "string" ||
        !RETAINED_NODE_REASON_CODES.has(evidence.reasonCode))) ||
    (evidence.status === "complete" && evidence.reasonCode !== null) ||
    (evidence.status === "unavailable" && evidence.reasonCode === null) ||
    !Array.isArray(evidence.mappings) ||
    evidence.protocolCatalogId !== RETAINED_NODE_PROTOCOL_CATALOG_ID ||
    (evidence.documentId !== null && !isDocumentId(evidence.documentId)) ||
    !hasExactKeys(evidence.snapshots, [
      "beforeArm",
      "afterArm",
      "afterDrain",
      "afterMapping",
      "afterCleanup",
    ]) ||
    ![
      evidence.snapshots.beforeArm,
      evidence.snapshots.afterArm,
      evidence.snapshots.afterDrain,
      evidence.snapshots.afterMapping,
      evidence.snapshots.afterCleanup,
    ].every(isSnapshot) ||
    !hasExactKeys(evidence.lifecycle, [
      "coverage",
      "lossReasonCode",
      "overflow",
    ]) ||
    !["complete", "incomplete"].includes(evidence.lifecycle.coverage) ||
    (evidence.lifecycle.lossReasonCode !== null &&
      !RETAINED_NODE_LOSS_REASONS.has(evidence.lifecycle.lossReasonCode)) ||
    typeof evidence.lifecycle.overflow !== "boolean" ||
    !hasExactKeys(evidence.scope, [
      "rootIsSelectedDocument",
      "pointerCaptureUncertain",
      "shadowTreeUncertain",
    ]) ||
    ![
      evidence.scope.rootIsSelectedDocument,
      evidence.scope.pointerCaptureUncertain,
      evidence.scope.shadowTreeUncertain,
    ].every(isNullableBoolean) ||
    !hasExactKeys(evidence.cleanup, [
      "windowListenersRemoved",
      "strongReferencesCleared",
      "objectGroupReleased",
      "cdpListenersRemoved",
    ]) ||
    ![
      evidence.cleanup.windowListenersRemoved,
      evidence.cleanup.strongReferencesCleared,
      evidence.cleanup.objectGroupReleased,
      evidence.cleanup.cdpListenersRemoved,
    ].every(isNullableBoolean)
  ) {
    fail();
  }

  if (evidence.mappings.length > RETAINED_NODE_EVIDENCE_POLICY.maxNodes) {
    fail("RETAINED_NODE_LIMIT_EXCEEDED");
  }
  const tokens = new Set();
  const mappings = [];
  for (const mapping of evidence.mappings) {
    if (
      !hasExactKeys(mapping, ["targetToken", "backendNodeId"]) ||
      typeof mapping.targetToken !== "string" ||
      !RETAINED_NODE_TOKEN_PATTERN.test(mapping.targetToken) ||
      tokens.has(mapping.targetToken) ||
      !Number.isSafeInteger(mapping.backendNodeId) ||
      mapping.backendNodeId < 1 ||
      mapping.backendNodeId > 2147483647
    ) {
      fail();
    }
    tokens.add(mapping.targetToken);
    mappings.push({ ...mapping });
  }
  if (
    byteLength(JSON.stringify(mappings)) >
    RETAINED_NODE_EVIDENCE_POLICY.mappingByteLimit
  ) {
    fail("RETAINED_NODE_LIMIT_EXCEEDED");
  }

  if (evidence.executionContext !== null) {
    if (
      !hasExactKeys(evidence.executionContext, [
        "uniqueId",
        "frameId",
        "isDefault",
      ]) ||
      typeof evidence.executionContext.uniqueId !== "string" ||
      !RETAINED_NODE_OPAQUE_ID_PATTERN.test(
        evidence.executionContext.uniqueId,
      ) ||
      typeof evidence.executionContext.frameId !== "string" ||
      !RETAINED_NODE_OPAQUE_ID_PATTERN.test(
        evidence.executionContext.frameId,
      ) ||
      evidence.executionContext.isDefault !== true
    ) {
      fail();
    }
  }

  if (
    evidence.status === "complete" &&
    (evidence.documentId === null ||
      evidence.lifecycle.coverage !== "complete" ||
      evidence.lifecycle.lossReasonCode !== null ||
      evidence.lifecycle.overflow !== false ||
      evidence.scope.rootIsSelectedDocument !== true ||
      evidence.scope.pointerCaptureUncertain !== false ||
      evidence.scope.shadowTreeUncertain !== false ||
      evidence.executionContext === null ||
      Object.values(evidence.snapshots).some((snapshot) => snapshot === null) ||
      Object.values(evidence.cleanup).some((value) => value !== true))
  ) {
    fail();
  }
  if (evidence.status === "complete") {
    const snapshots = Object.values(evidence.snapshots);
    const root = snapshots[0];
    if (
      snapshots.some(
        (snapshot) =>
          snapshot.documentId !== evidence.documentId ||
          snapshot.frameId !== root.frameId ||
          snapshot.loaderId !== root.loaderId,
      ) ||
      evidence.executionContext.frameId !== root.frameId
    ) {
      fail();
    }
  }

  return {
    status: evidence.status,
    reasonCode: evidence.reasonCode,
    mappings,
    executionContext: evidence.executionContext
      ? { ...evidence.executionContext }
      : null,
    documentId: evidence.documentId,
    snapshots: Object.fromEntries(
      Object.entries(evidence.snapshots).map(([name, snapshot]) => [
        name,
        snapshot ? { ...snapshot } : null,
      ]),
    ),
    protocolCatalogId: evidence.protocolCatalogId,
    lifecycle: { ...evidence.lifecycle },
    scope: { ...evidence.scope },
    cleanup: { ...evidence.cleanup },
  };
}

export function createUnavailableRetainedNodeEvidence(
  reasonCode,
  documentId = null,
  overrides = {},
) {
  const safeReason = RETAINED_NODE_REASON_CODES.has(reasonCode)
    ? reasonCode
    : "RETAINED_NODE_EVIDENCE_INVALID";
  return validateRetainedNodeEvidence({
    status: "unavailable",
    reasonCode: safeReason,
    mappings: [],
    executionContext: null,
    documentId: isDocumentIdValue(documentId) ? documentId : null,
    snapshots: {
      beforeArm: null,
      afterArm: null,
      afterDrain: null,
      afterMapping: null,
      afterCleanup: null,
    },
    protocolCatalogId: RETAINED_NODE_PROTOCOL_CATALOG_ID,
    lifecycle: {
      coverage: "incomplete",
      lossReasonCode: null,
      overflow: false,
    },
    scope: {
      rootIsSelectedDocument: null,
      pointerCaptureUncertain: null,
      shadowTreeUncertain: null,
    },
    cleanup: {
      windowListenersRemoved: null,
      strongReferencesCleared: null,
      objectGroupReleased: null,
      cdpListenersRemoved: null,
    },
    ...overrides,
  });
}

function isDocumentIdValue(value) {
  return (
    typeof value === "string" && RETAINED_NODE_DOCUMENT_PATTERN.test(value)
  );
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
export function initializeTrustedStimulusObserver(options = {}) {
  const property = "__agesTrustedStimulusObserver";
  if (globalThis[property]) return;
  const retainInputNodes = options?.retainInputNodes === true;

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
    // Keep the worst-case version-two sidecar envelope reserved before recording.
    recordBytes: retainInputNodes ? 256 * 1024 - 36 * 1024 : 240 * 1024,
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
  const retainedNodes = retainInputNodes ? new Map() : null;
  const listenerEntries = [];
  const records = [];
  let recordBytes = 2;
  let armedAt = null;
  let armed = false;
  let armCount = 0;
  let currentPhase = "primary";
  let overflowReason = null;
  let retainedNodeReasonCode = null;
  let rootIsSelectedDocument = true;
  let pointerCaptureUncertain = false;
  let shadowTreeUncertain = false;
  let inputListenersRemoved = false;
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
  const supportedNodeTarget = (target) =>
    typeof Node === "function" && target instanceof Node;
  const observeRetainedTarget = (target, event) => {
    if (!retainInputNodes || (target === window && event?.type === "resize")) {
      return resolveTarget(target);
    }
    if (!supportedNodeTarget(target)) {
      retainedNodeReasonCode ??= "RETAINED_NODE_SCOPE_UNSUPPORTED";
      rootIsSelectedDocument = false;
      return {
        targetToken: null,
        targetLabel: null,
        targetResolution: target === window ? "window" : "unknown",
      };
    }

    if (target !== document && target.ownerDocument !== document) {
      rootIsSelectedDocument = false;
      retainedNodeReasonCode ??= "RETAINED_NODE_SCOPE_UNSUPPORTED";
    }
    const targetToken = rememberToken(target);
    if (!retainedNodes.has(targetToken)) {
      if (retainedNodes.size >= 32) {
        retainedNodeReasonCode ??= "RETAINED_NODE_LIMIT_EXCEEDED";
      } else {
        retainedNodes.set(targetToken, target);
      }
    }

    if (typeof event?.composedPath === "function") {
      try {
        const path = event.composedPath();
        if (!Array.isArray(path) || path.length === 0 || path[0] !== target) {
          shadowTreeUncertain = true;
          retainedNodeReasonCode ??= "RETAINED_NODE_SCOPE_UNSUPPORTED";
        }
      } catch {
        shadowTreeUncertain = true;
        retainedNodeReasonCode ??= "RETAINED_NODE_SCOPE_UNSUPPORTED";
      }
    } else {
      shadowTreeUncertain = true;
      retainedNodeReasonCode ??= "RETAINED_NODE_SCOPE_UNSUPPORTED";
    }
    if (event?.type?.startsWith("pointer")) {
      try {
        if (typeof target.hasPointerCapture !== "function") {
          pointerCaptureUncertain = true;
          retainedNodeReasonCode ??= "RETAINED_NODE_SCOPE_UNSUPPORTED";
        } else if (target.hasPointerCapture(event.pointerId) !== false) {
          pointerCaptureUncertain = true;
          retainedNodeReasonCode ??= "RETAINED_NODE_SCOPE_UNSUPPORTED";
        }
      } catch {
        pointerCaptureUncertain = true;
        retainedNodeReasonCode ??= "RETAINED_NODE_SCOPE_UNSUPPORTED";
      }
    }
    return resolveTarget(target);
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
      ...observeRetainedTarget(event.target ?? null, event),
      phase: currentPhase,
    });
  };
  for (const type of domTypes) {
    const target = retainInputNodes
      ? window
      : type === "resize"
        ? window
        : document;
    const capture = retainInputNodes || type !== "resize";
    target.addEventListener(type, onDomEvent, capture);
    listenerEntries.push([target, type, onDomEvent, capture]);
  }

  const removeInputListeners = () => {
    let removed = true;
    const failedEntries = [];
    for (const [target, type, listener, capture] of listenerEntries) {
      try {
        target.removeEventListener(type, listener, capture);
      } catch {
        removed = false;
        failedEntries.push([target, type, listener, capture]);
      }
    }
    listenerEntries.splice(0, listenerEntries.length, ...failedEntries);
    inputListenersRemoved = removed && listenerEntries.length === 0;
    return inputListenersRemoved;
  };

  const drainEventTiming = async () => {
    const deadline = performance.now() + 1000;
    let quietDrains = 0;
    let attempts = 0;
    let drainFailed = false;
    try {
      while (quietDrains < 2 && attempts < 50 && performance.now() < deadline) {
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
  };

  const apiMetadata = () => ({ ...metadata });
  const makeRetainedNodeEvidence = (reasonCode) => ({
    status: "unavailable",
    reasonCode:
      reasonCode ?? retainedNodeReasonCode ?? "RETAINED_NODE_MAPPING_FAILED",
    mappings: [],
    executionContext: null,
    documentId,
    snapshots: {
      beforeArm: null,
      afterArm: null,
      afterDrain: null,
      afterMapping: null,
      afterCleanup: null,
    },
    protocolCatalogId:
      "chromium-43a195105613ac83c21d3f14de279f4a045c7da0+v8-d89479ac5446a374c55a35be19b5a23437558d99",
    lifecycle: {
      coverage: "incomplete",
      lossReasonCode: null,
      overflow: false,
    },
    scope: {
      rootIsSelectedDocument,
      pointerCaptureUncertain,
      shadowTreeUncertain,
    },
    cleanup: {
      windowListenersRemoved: inputListenersRemoved,
      strongReferencesCleared: retainedNodes?.size === 0,
      objectGroupReleased: null,
      cdpListenersRemoved: null,
    },
  });
  const worstCaseRetainedEvidence = () => {
    const snapshot = {
      documentId: "d-ffffffffffffffffffffffff",
      frameId: "f".repeat(128),
      loaderId: "l".repeat(128),
    };
    return {
      status: "complete",
      reasonCode: null,
      mappings: Array.from({ length: 32 }, (_, index) => ({
        targetToken: `t-${index.toString(16).padStart(24, "0")}`,
        backendNodeId: 2147483647,
      })),
      executionContext: {
        uniqueId: "c".repeat(128),
        frameId: "f".repeat(128),
        isDefault: true,
      },
      documentId: snapshot.documentId,
      snapshots: {
        beforeArm: snapshot,
        afterArm: snapshot,
        afterDrain: snapshot,
        afterMapping: snapshot,
        afterCleanup: snapshot,
      },
      protocolCatalogId:
        "chromium-43a195105613ac83c21d3f14de279f4a045c7da0+v8-d89479ac5446a374c55a35be19b5a23437558d99",
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
    };
  };
  const snapshot = (status, reasonCode) => {
    let payload = {
      schemaVersion: retainInputNodes ? 2 : 1,
      status,
      reasonCode,
      documentId,
      apiStatus,
      apiMetadata: apiMetadata(),
      records: [...records],
      recordCount: records.length,
      recordBytes,
      ...(retainInputNodes
        ? { retainedNodeEvidence: makeRetainedNodeEvidence() }
        : {}),
    };
    const sidecarByteCount = (currentObservation) =>
      bytesOf(
        `${JSON.stringify(
          {
            schemaVersion: retainInputNodes ? 2 : 1,
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
            observation: {
              ...currentObservation,
              frameProvenance: {
                schemaVersion: 1,
                status: "unknown",
                reasonCode: "PROVENANCE_DOCUMENT_ID_MISMATCH",
                documentId: currentObservation.documentId,
                beforeArm: {
                  frameId: "f".repeat(128),
                  loaderId: "l".repeat(128),
                },
                afterArm: {
                  frameId: "f".repeat(128),
                  loaderId: "l".repeat(128),
                },
                afterDrain: {
                  frameId: "f".repeat(128),
                  loaderId: "l".repeat(128),
                },
              },
              ...(retainInputNodes
                ? { retainedNodeEvidence: worstCaseRetainedEvidence() }
                : {}),
            },
          },
          null,
          retainInputNodes ? undefined : 2,
        )}\n`,
      );
    if (!retainInputNodes) {
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
    }
    if (sidecarByteCount(payload) > limits.sidecarBytes && retainInputNodes) {
      payload.status = "unavailable";
      payload.reasonCode = "OBSERVATION_SIDECAR_BYTE_LIMIT_EXCEEDED";
      payload.retainedNodeEvidence = makeRetainedNodeEvidence(
        "RETAINED_NODE_ENVELOPE_LIMIT_EXCEEDED",
      );
    } else if (sidecarByteCount(payload) > limits.sidecarBytes) {
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
    removeInputListeners();
    retainedNodes?.clear();
  };
  const state = {
    documentId,
    getRetainedInputNode(targetToken) {
      if (!retainInputNodes || !/^t-[a-f0-9]{24}$/.test(targetToken ?? "")) {
        return null;
      }
      return retainedNodes.get(targetToken) ?? null;
    },
    get retainedInputNodeCount() {
      return retainedNodes?.size ?? 0;
    },
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
    async freeze(expectedDocumentId) {
      if (!retainInputNodes) {
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
      if (expectedDocumentId !== documentId) {
        retainedNodeReasonCode ??= "RETAINED_NODE_CONTEXT_AMBIGUOUS";
        armed = false;
        try {
          performanceObserver?.disconnect();
        } catch {}
        disposed = true;
        removeInputListeners();
        return snapshot("unavailable", "NAVIGATION_OBSERVATION_LOST");
      }
      if (!armed) {
        disposed = true;
        removeInputListeners();
        return snapshot("unavailable", "OBSERVATION_NOT_ARMED");
      }
      await drainEventTiming();
      removeInputListeners();
      try {
        performanceObserver?.disconnect();
      } catch {
        apiStatus = "failed";
      }
      disposed = true;
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
      return snapshot(status, reasonCode);
    },
    clearRetainedNodes() {
      const listenersRemoved = removeInputListeners();
      armed = false;
      try {
        performanceObserver?.disconnect();
      } catch {}
      retainedNodes?.clear();
      disposed = true;
      return {
        windowListenersRemoved: listenersRemoved,
        strongReferencesCleared:
          retainedNodes === null || retainedNodes.size === 0,
      };
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
      if (retainInputNodes) return state.freeze(expectedDocumentId);
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
      await drainEventTiming();
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

export async function installTrustedStimulusObserver(page, options = {}) {
  if (options.retainInputNodes === true) {
    await page.addInitScript(initializeTrustedStimulusObserver, {
      retainInputNodes: true,
    });
    return;
  }
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
  const versionTwo = payload.schemaVersion === 2;
  const maximumRecordBytes = versionTwo
    ? RETAINED_NODE_RECORD_BYTE_LIMIT
    : OBSERVATION_LIMITS.recordBytes;
  if (
    Number.isSafeInteger(payload.recordBytes) &&
    payload.recordBytes > maximumRecordBytes
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
      ...(versionTwo ? ["retainedNodeEvidence"] : []),
    ]) ||
    ![1, 2].includes(payload.schemaVersion) ||
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

  const retainedNodeEvidence = versionTwo
    ? validateRetainedNodeEvidence(payload.retainedNodeEvidence)
    : null;
  if (
    versionTwo &&
    [
      retainedNodeEvidence.documentId,
      ...Object.values(retainedNodeEvidence.snapshots).map(
        (snapshot) => snapshot?.documentId ?? null,
      ),
    ].some(
      (documentId) => documentId !== null && documentId !== payload.documentId,
    )
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
    schemaVersion: payload.schemaVersion,
    status: payload.status,
    reasonCode: payload.reasonCode,
    documentId: payload.documentId,
    apiStatus: payload.apiStatus,
    apiMetadata: { ...payload.apiMetadata },
    records: safeRecords,
    recordCount: safeRecords.length,
    recordBytes: payload.recordBytes,
    ...(versionTwo ? { retainedNodeEvidence } : {}),
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

export function createUnavailableRetainedNodeObservation(
  reasonCode,
  documentId = "d-000000000000000000000000",
  retainedReasonCode = "RETAINED_NODE_MAPPING_FAILED",
) {
  const safeDocumentId = isDocumentIdValue(documentId)
    ? documentId
    : "d-000000000000000000000000";
  const safeReasonCode = ALLOWED_REASON_CODES.has(reasonCode)
    ? reasonCode
    : "OBSERVATION_DRAIN_FAILED";
  return {
    schemaVersion: 2,
    status: "unavailable",
    reasonCode: safeReasonCode,
    documentId: safeDocumentId,
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
    retainedNodeEvidence: createUnavailableRetainedNodeEvidence(
      retainedReasonCode,
      safeDocumentId,
    ),
  };
}

export async function freezeTrustedStimulusObserver(
  page,
  expectedDocumentId,
  timeoutMs = OBSERVATION_LIMITS.drainTimeoutMs,
) {
  if (!isDocumentIdValue(expectedDocumentId)) {
    return createUnavailableRetainedNodeObservation("OBSERVATION_DRAIN_FAILED");
  }
  let timer;
  try {
    const payload = await Promise.race([
      page.evaluate((expected) => {
        const observer = globalThis.__agesTrustedStimulusObserver;
        return observer ? observer.freeze(expected) : null;
      }, expectedDocumentId),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("OBSERVATION_DRAIN_TIMEOUT")),
          timeoutMs,
        );
      }),
    ]);
    if (payload === null) {
      return createUnavailableRetainedNodeObservation(
        "NAVIGATION_OBSERVATION_LOST",
        expectedDocumentId,
        "RETAINED_NODE_CONTEXT_AMBIGUOUS",
      );
    }
    try {
      return validateTrustedStimulusObservation(payload, expectedDocumentId);
    } catch {
      return createUnavailableRetainedNodeObservation(
        "OBSERVATION_PAYLOAD_INVALID",
        expectedDocumentId,
        "RETAINED_NODE_EVIDENCE_INVALID",
      );
    }
  } catch (error) {
    return createUnavailableRetainedNodeObservation(
      error?.message === "OBSERVATION_DRAIN_TIMEOUT"
        ? "OBSERVATION_DRAIN_TIMEOUT"
        : "NAVIGATION_OBSERVATION_LOST",
      expectedDocumentId,
      error?.message === "OBSERVATION_DRAIN_TIMEOUT"
        ? "RETAINED_NODE_COMMAND_TIMEOUT"
        : "RETAINED_NODE_CONTEXT_AMBIGUOUS",
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function clearRetainedInputNodes(page, timeoutMs = 100) {
  if (!page || typeof page.evaluate !== "function") {
    return {
      windowListenersRemoved: false,
      strongReferencesCleared: false,
    };
  }
  let timer;
  try {
    const result = await Promise.race([
      page.evaluate(() => {
        const observer = globalThis.__agesTrustedStimulusObserver;
        return observer ? observer.clearRetainedNodes() : null;
      }),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("RETAINED_NODE_COMMAND_TIMEOUT")),
          timeoutMs,
        );
      }),
    ]);
    if (
      !isRecord(result) ||
      typeof result.windowListenersRemoved !== "boolean" ||
      typeof result.strongReferencesCleared !== "boolean"
    ) {
      return {
        windowListenersRemoved: false,
        strongReferencesCleared: false,
      };
    }
    return {
      windowListenersRemoved: result.windowListenersRemoved,
      strongReferencesCleared: result.strongReferencesCleared,
    };
  } catch {
    return {
      windowListenersRemoved: false,
      strongReferencesCleared: false,
    };
  } finally {
    clearTimeout(timer);
  }
}

export function writeTrustedStimulusSidecar({
  directory,
  fixture,
  payload,
  frameProvenance,
}) {
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
  const versionTwo = observation.schemaVersion === 2;
  const safeFrameProvenance = validateInputFrameProvenance(
    frameProvenance ?? {
      schemaVersion: 1,
      status: "unknown",
      reasonCode: "PROVENANCE_NOT_CAPTURED",
      documentId: null,
      beforeArm: null,
      afterArm: null,
      afterDrain: null,
    },
    observation.documentId,
  );
  observation.frameProvenance = safeFrameProvenance;
  if (safeFrameProvenance.status !== "stable") {
    observation.status = "censored";
    observation.reasonCode = "INPUT_FRAME_PROVENANCE_UNAVAILABLE";
  }
  const sidecar = {
    schemaVersion: versionTwo ? 2 : 1,
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
  const serialized = versionTwo
    ? `${JSON.stringify(sidecar)}\n`
    : `${JSON.stringify(sidecar, null, 2)}\n`;
  const byteCount = byteLength(serialized);
  if (byteCount > OBSERVATION_LIMITS.sidecarBytes) {
    throw new Error(
      versionTwo
        ? "RETAINED_NODE_ENVELOPE_LIMIT_EXCEEDED"
        : "OBSERVATION_SIDECAR_BYTE_LIMIT_EXCEEDED",
    );
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
