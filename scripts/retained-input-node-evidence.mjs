import { randomUUID } from "node:crypto";
import {
  RETAINED_NODE_EVIDENCE_POLICY,
  RETAINED_NODE_PROTOCOL_CATALOG_ID,
  retainedNodeFinalReferenceProofExpression,
  validateRetainedNodeEvidence,
} from "./browser-stimulus-observer.mjs";

const DOCUMENT_ID = /^d-[a-f0-9]{24}$/;
const OPAQUE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const TARGET_TOKEN = /^t-[a-f0-9]{24}$/;
const MAX_BACKEND_NODE_ID = 2147483647;
const RETAINED_NODE_EVIDENCE_VERSION_V3 = 3;
const SAME_DOCUMENT_LOADING_EVENT_LIMIT = 128;
const SAME_DOCUMENT_LOADING_WITNESS_BYTE_LIMIT = 80 * 1024;
const SAME_DOCUMENT_LOADING_PHASES = [
  "baseline",
  "before-input",
  "primary-action",
  "route-ready",
  "post-trace-analysis",
  "cleanup",
];
const SAME_DOCUMENT_LOADING_NAVIGATION_TYPES = new Set([
  "fragment",
  "historyApi",
  "other",
]);
const SAME_DOCUMENT_LOADING_DETACH_REASONS = new Set(["remove", "swap"]);
const TARGET_PROOF_SOURCE_KEYS = [
  "targetIsNode",
  "ownerDocumentMatches",
  "rootContainsTarget",
  "connected",
  "composedPathStartsAtTarget",
];
const FINAL_REFERENCE_PROOF_KEYS = [
  "savedDocumentSame",
  "savedRootSame",
  "savedTargetSame",
  "targetOwnerDocumentMatches",
  "rootContainsTarget",
  "connected",
];
const FATAL_SAME_DOCUMENT_EVENTS = new Set([
  "Page.frameNavigated",
  "Page.documentOpened",
  "Page.backForwardCacheNotUsed",
  "Page.frameDetached",
  "Page.frameSubtreeWillBeDetached",
  "Runtime.executionContextDestroyed",
  "Runtime.executionContextsCleared",
  "Inspector.detached",
  "Inspector.targetCrashed",
  "Target.targetDestroyed",
  "Target.targetCrashed",
  "Target.detachedFromTarget",
]);
const LIFECYCLE_EVENTS = [
  ["Page.frameAttached", "frame"],
  ["Page.frameStartedLoading", "navigation"],
  ["Page.frameNavigated", "navigation"],
  ["Page.navigatedWithinDocument", "navigation"],
  ["Page.documentOpened", "document"],
  ["Page.backForwardCacheNotUsed", "navigation"],
  ["Page.frameDetached", "frame"],
  ["Page.frameSubtreeWillBeDetached", "frame"],
  ["Runtime.executionContextDestroyed", "context"],
  ["Runtime.executionContextsCleared", "contexts-cleared"],
  ["Runtime.executionContextCreated", "context-created"],
  ["Inspector.detached", "session"],
  ["Inspector.targetCrashed", "crash"],
];
const TARGET_EVENTS = [
  "Target.targetInfoChanged",
  "Target.targetDestroyed",
  "Target.targetCrashed",
  "Target.attachedToTarget",
  "Target.detachedFromTarget",
];
const SNAPSHOT_STAGES = new Set([
  "beforeArm",
  "afterArm",
  "afterDrain",
  "afterMapping",
  "afterCleanup",
]);
const EVIDENCE_REASONS = new Set([
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
const LIFECYCLE_LOSSES = new Set([
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

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  return (
    isRecord(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function isOpaqueId(value) {
  return typeof value === "string" && OPAQUE_ID.test(value);
}

function isTargetProofScope(value) {
  return (
    hasExactKeys(value, [
      "frameId",
      "loaderId",
      "contextUniqueId",
      "targetId",
      "sessionId",
    ]) && Object.values(value).every(isOpaqueId)
  );
}

function sameTargetProofScope(left, right) {
  return (
    left !== null &&
    right !== null &&
    ["frameId", "loaderId", "contextUniqueId", "targetId", "sessionId"].every(
      (key) => left[key] === right[key],
    )
  );
}

function normalizeInitialSourceProof(
  value,
  { documentId, sourceRecordIndex, targetToken },
) {
  if (
    !hasExactKeys(value, [
      "sourceRecordIndex",
      "documentId",
      "targetToken",
      "mappingIndex",
      "sourceCapture",
      "baselineScope",
      "finalProof",
    ]) ||
    value.sourceRecordIndex !== sourceRecordIndex ||
    value.documentId !== documentId ||
    value.targetToken !== targetToken ||
    value.mappingIndex !== null ||
    value.baselineScope !== null ||
    value.finalProof !== null ||
    !hasExactKeys(value.sourceCapture, TARGET_PROOF_SOURCE_KEYS) ||
    !Object.values(value.sourceCapture).every(
      (entry) => typeof entry === "boolean",
    )
  ) {
    return null;
  }
  return {
    sourceRecordIndex: value.sourceRecordIndex,
    documentId: value.documentId,
    targetToken: value.targetToken,
    mappingIndex: null,
    sourceCapture: { ...value.sourceCapture },
    baselineScope: null,
    finalProof: null,
  };
}

function protocolError(message) {
  return new Error(message);
}

function withTimeout(promise, timeoutMs, timeoutCode) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(protocolError(timeoutCode)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function pageBrowser(page) {
  try {
    return page?.context?.()?.browser?.() ?? null;
  } catch {
    return null;
  }
}

function protocolSessionId(session) {
  const value =
    session?._session?._sessionId ?? session?.sessionId ?? session?._sessionId;
  return typeof value === "string" && OPAQUE_ID.test(value) ? value : null;
}

function snapshotFromResponse(response, documentId) {
  const frame = response?.frameTree?.frame;
  if (
    !isRecord(response) ||
    !isRecord(response.frameTree) ||
    !isRecord(frame) ||
    typeof frame.id !== "string" ||
    !OPAQUE_ID.test(frame.id) ||
    typeof frame.loaderId !== "string" ||
    !OPAQUE_ID.test(frame.loaderId)
  ) {
    throw protocolError("RETAINED_NODE_EVIDENCE_INVALID");
  }
  return { documentId, frameId: frame.id, loaderId: frame.loaderId };
}

export function createRetainedInputNodeEvidenceTracker({
  page,
  pageSession,
  browserSession,
  timeoutMs = 1000,
  retainedNodeEvidenceVersion = 2,
}) {
  const versionThree =
    retainedNodeEvidenceVersion === RETAINED_NODE_EVIDENCE_VERSION_V3;
  const browser = pageBrowser(page);
  const boundedTimeoutMs =
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? Math.min(5000, Math.floor(timeoutMs))
      : 1000;
  const objectGroup = `retained-input-node-${randomUUID()}`;
  const subscriptions = [];
  const pending = new Set();
  const snapshots = {
    beforeArm: null,
    afterArm: null,
    afterDrain: null,
    afterMapping: null,
    afterCleanup: null,
  };
  const contexts = [];
  const discoveredTargetEvents = [];
  const mappings = [];
  const mappedObjects = new Map();
  const lifecycleEvents = [];
  let firstInvalidation = null;
  let droppedLifecycleEventCount = 0;
  let lifecycleOverflow = false;
  let lifecycleJournalTruncated = false;
  let loadingCount = 0;
  let historyApiCount = 0;
  let phase = "baseline";
  let sourceProof = null;
  let retainedTargetProof = null;
  let finalReferenceProof = null;
  let finalLossPriority = 0;
  const pageSessionId = protocolSessionId(pageSession);
  let rootFrameId = null;
  let rootLoaderId = null;
  let selectedTargetId = null;
  let executionContext = null;
  let lossReasonCode = null;
  let failureReasonCode = null;
  let overflow = false;
  let objectGroupReleased = false;
  let listenersRemoved = null;
  let started = false;
  let closed = false;
  let closePromise = null;
  let finalEvidence = null;
  let rejectInvalidation;
  const invalidated = new Promise((_, reject) => {
    rejectInvalidation = reject;
  });
  invalidated.catch(() => {});

  const supports =
    typeof page?.on === "function" &&
    typeof page?.off === "function" &&
    typeof browser?.on === "function" &&
    typeof browser?.off === "function" &&
    typeof pageSession?.on === "function" &&
    typeof pageSession?.off === "function" &&
    typeof pageSession?.send === "function" &&
    typeof pageSession?.detach === "function" &&
    typeof browserSession?.on === "function" &&
    typeof browserSession?.off === "function" &&
    typeof browserSession?.send === "function" &&
    typeof browserSession?.detach === "function";

  const invalidate = (
    reasonCode,
    evidenceReason = "RETAINED_NODE_LIFECYCLE_INVALIDATED",
  ) => {
    const safeEvidenceReason = EVIDENCE_REASONS.has(evidenceReason)
      ? evidenceReason
      : "RETAINED_NODE_LIFECYCLE_INVALIDATED";
    const safeLossReason = LIFECYCLE_LOSSES.has(reasonCode) ? reasonCode : null;
    if (versionThree) {
      const incomingPriority =
        safeLossReason === "UNKNOWN_EVENT_SCOPE"
          ? 1
          : safeLossReason === null
            ? 0
            : 2;
      if (failureReasonCode === null || incomingPriority > finalLossPriority) {
        failureReasonCode = safeEvidenceReason;
        lossReasonCode = safeLossReason;
        finalLossPriority = incomingPriority;
      }
    } else {
      if (failureReasonCode !== null) return;
      failureReasonCode = safeEvidenceReason;
      lossReasonCode = safeLossReason;
    }
    const error = protocolError(failureReasonCode);
    error.lossReasonCode = lossReasonCode;
    rejectInvalidation(error);
  };

  const setFirstInvalidation = (method, reasonCode, sequence) => {
    if (firstInvalidation !== null) return;
    firstInvalidation = {
      sequence,
      phase,
      method,
      reasonCode,
    };
  };

  const invalidateLifecycleEvent = (
    method,
    sequence,
    lossReason,
    evidenceReason = "RETAINED_NODE_LIFECYCLE_INVALIDATED",
  ) => {
    setFirstInvalidation(method, evidenceReason, sequence);
    invalidate(lossReason, evidenceReason);
  };

  const projectLifecyclePayload = (method, source, payload) => {
    const validOptionalId = (value) => value === undefined || isOpaqueId(value);
    let fields;
    switch (method) {
      case "Page.frameAttached":
        fields = {
          frameId: payload?.frameId,
          parentFrameId: payload?.parentFrameId,
        };
        break;
      case "Page.frameStartedLoading":
      case "Page.frameSubtreeWillBeDetached":
        fields = { frameId: payload?.frameId };
        break;
      case "Page.frameNavigated":
        fields = {
          frameId: payload?.frame?.id,
          loaderId: payload?.frame?.loaderId,
          ...(payload?.frame?.parentId !== undefined
            ? { parentFrameId: payload.frame.parentId }
            : {}),
        };
        break;
      case "Page.navigatedWithinDocument":
        fields = {
          frameId: payload?.frameId,
          navigationType: payload?.navigationType,
        };
        break;
      case "Page.documentOpened":
      case "Runtime.executionContextsCleared":
      case "Inspector.detached":
      case "Inspector.targetCrashed":
        fields = {};
        break;
      case "Page.backForwardCacheNotUsed":
        fields = {
          frameId: payload?.frameId,
          loaderId: payload?.loaderId,
        };
        break;
      case "Page.frameDetached":
        fields = {
          frameId: payload?.frameId,
          detachReason: payload?.reason,
        };
        break;
      case "Runtime.executionContextCreated":
        fields = {
          executionContextId: payload?.context?.id,
          contextUniqueId: payload?.context?.uniqueId,
          frameId: payload?.context?.auxData?.frameId,
          isDefault: payload?.context?.auxData?.isDefault,
        };
        break;
      case "Runtime.executionContextDestroyed":
        fields = {
          executionContextId: payload?.executionContextId,
          contextUniqueId: payload?.executionContextUniqueId,
        };
        break;
      case "Target.targetInfoChanged":
      case "Target.targetDestroyed":
      case "Target.targetCrashed":
        fields = {
          targetId:
            method === "Target.targetInfoChanged"
              ? payload?.targetInfo?.targetId
              : payload?.targetId,
        };
        break;
      case "Target.attachedToTarget":
        fields = {
          sessionId: payload?.sessionId,
          targetId: payload?.targetInfo?.targetId,
        };
        break;
      case "Target.detachedFromTarget":
        fields = { sessionId: payload?.sessionId, targetId: payload?.targetId };
        break;
      default:
        return null;
    }

    if (source !== "page" && source !== "browser") return null;
    for (const [key, value] of Object.entries(fields)) {
      if (
        (key === "executionContextId" &&
          (!Number.isSafeInteger(value) ||
            value < 1 ||
            value > MAX_BACKEND_NODE_ID)) ||
        (key === "isDefault" && typeof value !== "boolean") ||
        (key === "navigationType" &&
          !SAME_DOCUMENT_LOADING_NAVIGATION_TYPES.has(value)) ||
        (key === "detachReason" &&
          !SAME_DOCUMENT_LOADING_DETACH_REASONS.has(value)) ||
        ((key === "frameId" ||
          key === "parentFrameId" ||
          key === "loaderId" ||
          key === "contextUniqueId" ||
          key === "targetId" ||
          key === "sessionId") &&
          !isOpaqueId(value))
      ) {
        return null;
      }
    }
    if (
      method === "Page.frameNavigated" &&
      !validOptionalId(fields.parentFrameId)
    ) {
      return null;
    }

    return {
      sequence: lifecycleEvents.length,
      phase,
      source,
      method,
      ...fields,
    };
  };

  const appendLifecycleEvent = (method, source, payload) => {
    if (lifecycleJournalTruncated) {
      droppedLifecycleEventCount = Math.min(
        Number.MAX_SAFE_INTEGER,
        droppedLifecycleEventCount + 1,
      );
      const projected = projectLifecyclePayload(method, source, payload);
      return projected
        ? { ...projected, sequence: lifecycleEvents.length }
        : null;
    }
    if (lifecycleEvents.length >= SAME_DOCUMENT_LOADING_EVENT_LIMIT) {
      droppedLifecycleEventCount += 1;
      lifecycleOverflow = true;
      lifecycleJournalTruncated = true;
      const event = projectLifecyclePayload(method, source, payload);
      invalidateLifecycleEvent(
        method,
        lifecycleEvents.length,
        null,
        "RETAINED_NODE_LIMIT_EXCEEDED",
      );
      if (event === null) {
        invalidate("UNKNOWN_EVENT_SCOPE", "RETAINED_NODE_EVIDENCE_INVALID");
        return null;
      }
      return event;
    }
    const event = projectLifecyclePayload(method, source, payload);
    if (event === null) {
      droppedLifecycleEventCount += 1;
      lifecycleJournalTruncated = true;
      invalidateLifecycleEvent(
        method,
        lifecycleEvents.length,
        "UNKNOWN_EVENT_SCOPE",
        "RETAINED_NODE_EVIDENCE_INVALID",
      );
      return null;
    }
    const candidate = [...lifecycleEvents, event];
    if (
      Buffer.byteLength(JSON.stringify(candidate), "utf8") +
        SAME_DOCUMENT_LOADING_WITNESS_BYTE_LIMIT / 4 >
      SAME_DOCUMENT_LOADING_WITNESS_BYTE_LIMIT
    ) {
      droppedLifecycleEventCount += 1;
      lifecycleOverflow = true;
      lifecycleJournalTruncated = true;
      invalidateLifecycleEvent(
        method,
        lifecycleEvents.length,
        null,
        "RETAINED_NODE_ENVELOPE_LIMIT_EXCEEDED",
      );
      return null;
    }
    lifecycleEvents.push(event);
    if (method === "Page.frameStartedLoading") loadingCount += 1;
    if (
      method === "Page.navigatedWithinDocument" &&
      event.navigationType === "historyApi"
    ) {
      historyApiCount += 1;
    }
    return event;
  };

  const handleV3LifecycleEvent = (method, source, payload) => {
    const event = appendLifecycleEvent(method, source, payload);
    if (event === null) return;

    if (method === "Runtime.executionContextCreated") {
      recordDefaultContext(payload);
      if (failureReasonCode !== null) {
        invalidateLifecycleEvent(
          method,
          event.sequence,
          lossReasonCode ?? "UNKNOWN_EVENT_SCOPE",
          failureReasonCode,
        );
        return;
      }
      const context = payload?.context;
      const currentContext = executionContext;
      if (
        source !== "page" ||
        pageSessionId === null ||
        rootFrameId === null ||
        !isRecord(context) ||
        !isRecord(context.auxData) ||
        context.auxData.isDefault !== true ||
        context.auxData.frameId !== rootFrameId ||
        contexts.length !== 1 ||
        currentContext === null ||
        currentContext.isDefault !== true ||
        currentContext.frameId !== rootFrameId ||
        currentContext.uniqueId !== event.contextUniqueId
      ) {
        invalidateLifecycleEvent(method, event.sequence, "UNKNOWN_EVENT_SCOPE");
      }
      return;
    }

    if (
      method === "Page.frameStartedLoading" &&
      event.frameId === rootFrameId &&
      event.phase === "primary-action" &&
      loadingCount === 1 &&
      historyApiCount === 0
    ) {
      return;
    }
    if (
      method === "Page.navigatedWithinDocument" &&
      event.frameId === rootFrameId &&
      event.navigationType === "historyApi" &&
      (event.phase === "primary-action" || event.phase === "route-ready") &&
      loadingCount === 1 &&
      historyApiCount === 1
    ) {
      return;
    }

    let lossReason = "UNKNOWN_EVENT_SCOPE";
    if (
      method === "Page.frameStartedLoading" ||
      method === "Page.navigatedWithinDocument"
    ) {
      lossReason =
        event.frameId !== rootFrameId
          ? "UNKNOWN_EVENT_SCOPE"
          : event.navigationType !== undefined &&
              event.navigationType !== "historyApi"
            ? "NAVIGATION"
            : "NAVIGATION";
    } else if (method === "Page.documentOpened") {
      lossReason = "DOCUMENT_OPENED";
    } else if (method === "Page.backForwardCacheNotUsed") {
      lossReason =
        event.frameId === rootFrameId
          ? "BF_CACHE_RESTORED"
          : "UNKNOWN_EVENT_SCOPE";
    } else if (method === "Page.frameNavigated") {
      lossReason =
        event.frameId === rootFrameId
          ? "NAVIGATION"
          : event.parentFrameId === rootFrameId
            ? "FRAME_SCOPE_CHANGED"
            : "UNKNOWN_EVENT_SCOPE";
    } else if (
      method === "Page.frameAttached" ||
      method === "Page.frameDetached" ||
      method === "Page.frameSubtreeWillBeDetached"
    ) {
      const frameId = event.frameId;
      lossReason =
        frameId === rootFrameId || event.parentFrameId === rootFrameId
          ? "FRAME_SCOPE_CHANGED"
          : "UNKNOWN_EVENT_SCOPE";
    } else if (method === "Runtime.executionContextDestroyed") {
      lossReason =
        event.contextUniqueId === executionContext?.uniqueId
          ? "EXECUTION_CONTEXT_LOST"
          : "UNKNOWN_EVENT_SCOPE";
    } else if (method === "Runtime.executionContextsCleared") {
      lossReason = "EXECUTION_CONTEXT_LOST";
    } else if (method === "Inspector.detached") {
      lossReason = "SESSION_LOST";
    } else if (method === "Inspector.targetCrashed") {
      lossReason = "TARGET_CRASHED";
    } else if (method.startsWith("Target.")) {
      const fatalTargetEvent = FATAL_SAME_DOCUMENT_EVENTS.has(method);
      const selectedTargetMatch =
        selectedTargetId !== null && event.targetId === selectedTargetId;
      const selectedSessionMatch =
        pageSessionId !== null && event.sessionId === pageSessionId;
      if (source !== "browser") {
        lossReason = "UNKNOWN_EVENT_SCOPE";
      } else if (method === "Target.targetInfoChanged") {
        lossReason = selectedTargetMatch
          ? "TARGET_CHANGED"
          : "UNKNOWN_EVENT_SCOPE";
      } else if (method === "Target.attachedToTarget") {
        lossReason =
          selectedTargetMatch || selectedSessionMatch
            ? "TARGET_CHANGED"
            : "UNKNOWN_EVENT_SCOPE";
      } else if (fatalTargetEvent) {
        lossReason =
          selectedTargetMatch || selectedSessionMatch
            ? method === "Target.targetCrashed"
              ? "TARGET_CRASHED"
              : "TARGET_CHANGED"
            : "UNKNOWN_EVENT_SCOPE";
      } else {
        lossReason =
          selectedTargetMatch || selectedSessionMatch
            ? "TARGET_CHANGED"
            : "UNKNOWN_EVENT_SCOPE";
      }
    }
    invalidateLifecycleEvent(method, event.sequence, lossReason);
  };

  const ensureAvailable = () => {
    if (failureReasonCode !== null) throw protocolError(failureReasonCode);
    if (!started || closed) throw protocolError("RETAINED_NODE_CLEANUP_FAILED");
  };

  const addListener = (emitter, eventName, listener) => {
    const subscription = { emitter, eventName, listener };
    subscriptions.push(subscription);
    emitter.on(eventName, listener);
  };

  const removeListeners = () => {
    const failed = [];
    for (const subscription of subscriptions) {
      try {
        subscription.emitter.off(subscription.eventName, subscription.listener);
      } catch {
        failed.push(subscription);
      }
    }
    subscriptions.length = 0;
    subscriptions.push(...failed);
    listenersRemoved = failed.length === 0;
    return listenersRemoved;
  };

  const pendingCommand = (session, method, params = {}) => {
    ensureAvailable();
    let operation;
    try {
      operation = Promise.resolve(session.send(method, params));
    } catch {
      operation = Promise.reject(protocolError("RETAINED_NODE_MAPPING_FAILED"));
    }
    pending.add(operation);
    operation.then(
      () => pending.delete(operation),
      () => pending.delete(operation),
    );
    const timed = withTimeout(
      operation,
      boundedTimeoutMs,
      "RETAINED_NODE_COMMAND_TIMEOUT",
    ).catch((error) => {
      if (error?.message === "RETAINED_NODE_COMMAND_TIMEOUT") {
        invalidate(null, "RETAINED_NODE_COMMAND_TIMEOUT");
      }
      throw error;
    });
    return Promise.race([timed, invalidated]);
  };

  const recordDefaultContext = (payload) => {
    const context = payload?.context;
    if (!isRecord(context) || !isRecord(context.auxData)) {
      invalidate("UNKNOWN_EVENT_SCOPE", "RETAINED_NODE_CONTEXT_AMBIGUOUS");
      return;
    }
    if (context.auxData.isDefault !== true) return;
    const frameId = context.auxData.frameId;
    if (typeof frameId !== "string" || !OPAQUE_ID.test(frameId)) {
      invalidate("UNKNOWN_EVENT_SCOPE", "RETAINED_NODE_CONTEXT_AMBIGUOUS");
      return;
    }
    if (rootFrameId === null || frameId !== rootFrameId) return;
    if (
      typeof context.uniqueId !== "string" ||
      !OPAQUE_ID.test(context.uniqueId)
    ) {
      invalidate("UNKNOWN_EVENT_SCOPE", "RETAINED_NODE_CONTEXT_AMBIGUOUS");
      return;
    }
    if (contexts.some((candidate) => candidate.uniqueId === context.uniqueId)) {
      return;
    }
    contexts.push({ uniqueId: context.uniqueId, frameId, isDefault: true });
    if (contexts.length > 1) {
      invalidate("UNKNOWN_EVENT_SCOPE", "RETAINED_NODE_CONTEXT_AMBIGUOUS");
      return;
    }
    executionContext = contexts[0];
  };

  const handleTargetEvent = (eventName, payload) => {
    if (selectedTargetId === null) {
      discoveredTargetEvents.push([eventName, payload]);
      if (discoveredTargetEvents.length > 128) {
        overflow = true;
        invalidate("UNKNOWN_EVENT_SCOPE", "RETAINED_NODE_LIMIT_EXCEEDED");
      }
      return;
    }
    let targetId = null;
    let sessionId = null;
    if (eventName === "Target.targetInfoChanged") {
      targetId = payload?.targetInfo?.targetId;
    } else if (eventName === "Target.attachedToTarget") {
      targetId = payload?.targetInfo?.targetId;
      sessionId = payload?.sessionId;
    } else if (eventName === "Target.detachedFromTarget") {
      targetId = payload?.targetId;
      sessionId = payload?.sessionId;
    } else {
      targetId = payload?.targetId;
    }
    if (
      (targetId !== null &&
        targetId !== undefined &&
        (typeof targetId !== "string" || !OPAQUE_ID.test(targetId))) ||
      (sessionId !== null &&
        sessionId !== undefined &&
        (typeof sessionId !== "string" || !OPAQUE_ID.test(sessionId)))
    ) {
      invalidate("UNKNOWN_EVENT_SCOPE");
      return;
    }
    if (targetId === null || targetId === undefined) {
      if (pageSessionId !== null && sessionId === pageSessionId) {
        invalidate(
          eventName === "Target.targetCrashed"
            ? "TARGET_CRASHED"
            : "TARGET_CHANGED",
        );
      } else {
        invalidate("UNKNOWN_EVENT_SCOPE");
      }
      return;
    }
    if (
      targetId === selectedTargetId ||
      (pageSessionId !== null && sessionId === pageSessionId)
    ) {
      invalidate(
        eventName === "Target.targetCrashed"
          ? "TARGET_CRASHED"
          : "TARGET_CHANGED",
      );
    }
  };

  const handlePageEvent = (kind, payload) => {
    if (kind === "session") {
      invalidate("SESSION_LOST");
      return;
    }
    if (kind === "crash") {
      invalidate("TARGET_CRASHED");
      return;
    }
    if (kind === "contexts-cleared") {
      invalidate("EXECUTION_CONTEXT_LOST");
      return;
    }
    if (kind === "context") {
      const uniqueId = payload?.executionContextUniqueId;
      if (
        typeof uniqueId !== "string" ||
        !OPAQUE_ID.test(uniqueId) ||
        executionContext === null
      ) {
        invalidate("UNKNOWN_EVENT_SCOPE", "RETAINED_NODE_CONTEXT_AMBIGUOUS");
      } else if (uniqueId === executionContext.uniqueId) {
        invalidate("EXECUTION_CONTEXT_LOST");
      }
      return;
    }
    if (kind === "context-created") {
      recordDefaultContext(payload);
      return;
    }
    if (kind === "navigation") {
      if (payload === undefined || payload === null) {
        invalidate("UNKNOWN_EVENT_SCOPE");
        return;
      }
      const frameId =
        typeof payload.frameId === "string"
          ? payload.frameId
          : payload.frame?.id;
      if (typeof frameId !== "string" || !OPAQUE_ID.test(frameId)) {
        invalidate("UNKNOWN_EVENT_SCOPE");
        return;
      }
      const type = payload.type;
      invalidate(
        type === "BackForwardCacheRestore" ? "BF_CACHE_RESTORED" : "NAVIGATION",
      );
      return;
    }
    if (kind === "document") {
      const frameId = payload?.frame?.id;
      invalidate(
        typeof frameId === "string" && OPAQUE_ID.test(frameId)
          ? "DOCUMENT_OPENED"
          : "UNKNOWN_EVENT_SCOPE",
      );
      return;
    }
    if (kind === "frame") {
      const frameId =
        typeof payload?.frameId === "string"
          ? payload.frameId
          : payload?.frame?.id;
      if (typeof frameId !== "string" || !OPAQUE_ID.test(frameId)) {
        invalidate("UNKNOWN_EVENT_SCOPE");
      } else {
        invalidate("FRAME_SCOPE_CHANGED");
      }
    }
  };

  const failForPendingContexts = () => {
    if (executionContext === null) {
      invalidate("UNKNOWN_EVENT_SCOPE", "RETAINED_NODE_CONTEXT_AMBIGUOUS");
      return;
    }
    if (contexts.length !== 1) {
      invalidate("UNKNOWN_EVENT_SCOPE", "RETAINED_NODE_CONTEXT_AMBIGUOUS");
    }
  };

  const unavailable = (reasonCode, documentId, scope, observerCleanup) => {
    const safeReason = EVIDENCE_REASONS.has(reasonCode)
      ? reasonCode
      : "RETAINED_NODE_EVIDENCE_INVALID";
    const normalizedSnapshots = Object.fromEntries(
      Object.entries(snapshots).map(([stage, snapshot]) => [
        stage,
        snapshot && documentId && snapshot.documentId === null
          ? { ...snapshot, documentId }
          : snapshot,
      ]),
    );
    const safeScope = isRecord(scope)
      ? {
          rootIsSelectedDocument:
            typeof scope.rootIsSelectedDocument === "boolean"
              ? scope.rootIsSelectedDocument
              : null,
          pointerCaptureUncertain:
            typeof scope.pointerCaptureUncertain === "boolean"
              ? scope.pointerCaptureUncertain
              : null,
          shadowTreeUncertain:
            typeof scope.shadowTreeUncertain === "boolean"
              ? scope.shadowTreeUncertain
              : null,
        }
      : {
          rootIsSelectedDocument: null,
          pointerCaptureUncertain: null,
          shadowTreeUncertain: null,
        };
    const cleanup = {
      windowListenersRemoved:
        typeof observerCleanup?.windowListenersRemoved === "boolean"
          ? observerCleanup.windowListenersRemoved
          : null,
      strongReferencesCleared:
        typeof observerCleanup?.strongReferencesCleared === "boolean"
          ? observerCleanup.strongReferencesCleared
          : null,
      objectGroupReleased:
        typeof objectGroupReleased === "boolean" && objectGroupReleased,
      cdpListenersRemoved: listenersRemoved,
    };
    return validateRetainedNodeEvidence({
      status: "unavailable",
      reasonCode: safeReason,
      mappings: versionThree ? mappings : [],
      executionContext,
      documentId: DOCUMENT_ID.test(documentId ?? "") ? documentId : null,
      snapshots: normalizedSnapshots,
      protocolCatalogId: RETAINED_NODE_PROTOCOL_CATALOG_ID,
      lifecycle: {
        coverage: "incomplete",
        lossReasonCode: LIFECYCLE_LOSSES.has(lossReasonCode)
          ? lossReasonCode
          : null,
        overflow,
      },
      scope: safeScope,
      cleanup,
    });
  };

  const installListeners = () => {
    addListener(page, "close", () => invalidate("TARGET_CHANGED"));
    addListener(browser, "disconnected", () => invalidate("TRANSPORT_LOST"));
    for (const [eventName, kind] of LIFECYCLE_EVENTS) {
      addListener(pageSession, eventName, (payload) =>
        versionThree
          ? handleV3LifecycleEvent(eventName, "page", payload)
          : handlePageEvent(kind, payload),
      );
    }
    if (versionThree) {
      for (const eventName of TARGET_EVENTS) {
        addListener(pageSession, eventName, (payload) =>
          handleV3LifecycleEvent(eventName, "page", payload),
        );
      }
    }
    addListener(pageSession, "close", () => invalidate("SESSION_LOST"));
    addListener(browserSession, "close", () => invalidate("SESSION_LOST"));
    for (const eventName of TARGET_EVENTS) {
      addListener(browserSession, eventName, (payload) =>
        versionThree
          ? handleV3LifecycleEvent(eventName, "browser", payload)
          : handleTargetEvent(eventName, payload),
      );
    }
  };

  const getRootFrame = async () => {
    const response = await pendingCommand(pageSession, "Page.getFrameTree");
    ensureAvailable();
    const snapshot = snapshotFromResponse(response, null);
    if (rootFrameId === null) {
      rootFrameId = snapshot.frameId;
      rootLoaderId = snapshot.loaderId;
    } else if (
      rootFrameId !== snapshot.frameId ||
      rootLoaderId !== snapshot.loaderId
    ) {
      invalidate(
        rootFrameId !== snapshot.frameId ? "FRAME_SCOPE_CHANGED" : "NAVIGATION",
      );
      throw protocolError("RETAINED_NODE_LIFECYCLE_INVALIDATED");
    }
    return snapshot;
  };

  const resolveTarget = async () => {
    const response = await pendingCommand(pageSession, "Target.getTargetInfo");
    ensureAvailable();
    const targetId = response?.targetInfo?.targetId;
    const targetType = response?.targetInfo?.type;
    if (
      typeof targetId !== "string" ||
      !OPAQUE_ID.test(targetId) ||
      (targetType !== undefined && targetType !== "page")
    ) {
      invalidate("UNKNOWN_EVENT_SCOPE");
      throw protocolError("RETAINED_NODE_EVIDENCE_INVALID");
    }
    selectedTargetId = targetId;
    const targets = await pendingCommand(browserSession, "Target.getTargets");
    ensureAvailable();
    if (
      !Array.isArray(targets?.targetInfos) ||
      !targets.targetInfos.some(
        (target) => isRecord(target) && target.targetId === selectedTargetId,
      )
    ) {
      invalidate("UNKNOWN_EVENT_SCOPE");
      throw protocolError("RETAINED_NODE_EVIDENCE_INVALID");
    }
    for (const [eventName, payload] of discoveredTargetEvents.splice(0)) {
      handleTargetEvent(eventName, payload);
    }
  };

  const requireContext = () => {
    if (executionContext === null || contexts.length !== 1) {
      invalidate("UNKNOWN_EVENT_SCOPE", "RETAINED_NODE_CONTEXT_AMBIGUOUS");
      throw protocolError("RETAINED_NODE_CONTEXT_AMBIGUOUS");
    }
    return executionContext;
  };

  const snapshot = async (stage, documentId) => {
    if (
      !SNAPSHOT_STAGES.has(stage) ||
      (documentId !== null && !DOCUMENT_ID.test(documentId ?? ""))
    ) {
      throw protocolError("RETAINED_NODE_EVIDENCE_INVALID");
    }
    ensureAvailable();
    if (snapshots[stage] !== null) {
      throw protocolError("RETAINED_NODE_EVIDENCE_INVALID");
    }
    const response = await pendingCommand(pageSession, "Page.getFrameTree");
    ensureAvailable();
    const result = snapshotFromResponse(response, documentId);
    if (rootFrameId === null) {
      rootFrameId = result.frameId;
      rootLoaderId = result.loaderId;
    } else if (
      result.frameId !== rootFrameId ||
      result.loaderId !== rootLoaderId
    ) {
      invalidate(
        result.frameId !== rootFrameId ? "FRAME_SCOPE_CHANGED" : "NAVIGATION",
      );
      throw protocolError("RETAINED_NODE_LIFECYCLE_INVALIDATED");
    }
    snapshots[stage] = result;
    if (
      stage === "afterArm" ||
      stage === "afterDrain" ||
      stage === "afterMapping"
    ) {
      requireContext();
    }
    return { ...result };
  };

  const mapTargets = async (documentId, targetTokens) => {
    ensureAvailable();
    if (
      !DOCUMENT_ID.test(documentId ?? "") ||
      !Array.isArray(targetTokens) ||
      targetTokens.length > RETAINED_NODE_EVIDENCE_POLICY.maxNodes ||
      targetTokens.some(
        (token) => typeof token !== "string" || !TARGET_TOKEN.test(token),
      ) ||
      new Set(targetTokens).size !== targetTokens.length
    ) {
      overflow =
        Array.isArray(targetTokens) &&
        targetTokens.length > RETAINED_NODE_EVIDENCE_POLICY.maxNodes;
      invalidate(
        null,
        overflow
          ? "RETAINED_NODE_LIMIT_EXCEEDED"
          : "RETAINED_NODE_EVIDENCE_INVALID",
      );
      throw protocolError(failureReasonCode);
    }
    const context = requireContext();
    const resolved = [];
    const resolvedObjects = [];
    for (const targetToken of targetTokens) {
      ensureAvailable();
      const evaluated = await pendingCommand(pageSession, "Runtime.evaluate", {
        expression: `globalThis.__agesTrustedStimulusObserver.getRetainedInputNode(${JSON.stringify(targetToken)})`,
        uniqueContextId: context.uniqueId,
        returnByValue: false,
        objectGroup,
      });
      ensureAvailable();
      const remoteObject = evaluated?.result;
      if (
        !isRecord(remoteObject) ||
        remoteObject.type !== "object" ||
        remoteObject.subtype !== "node" ||
        typeof remoteObject.objectId !== "string" ||
        !OPAQUE_ID.test(remoteObject.objectId) ||
        evaluated?.exceptionDetails
      ) {
        invalidate(null, "RETAINED_NODE_MAPPING_FAILED");
        throw protocolError("RETAINED_NODE_MAPPING_FAILED");
      }
      const described = await pendingCommand(pageSession, "DOM.describeNode", {
        objectId: remoteObject.objectId,
        depth: 0,
        pierce: false,
      });
      ensureAvailable();
      const backendNodeId = described?.node?.backendNodeId;
      if (
        !Number.isSafeInteger(backendNodeId) ||
        backendNodeId < 1 ||
        backendNodeId > MAX_BACKEND_NODE_ID
      ) {
        invalidate(null, "RETAINED_NODE_MAPPING_FAILED");
        throw protocolError("RETAINED_NODE_MAPPING_FAILED");
      }
      resolved.push({ targetToken, backendNodeId });
      resolvedObjects.push({ targetToken, objectId: remoteObject.objectId });
      if (
        Buffer.byteLength(JSON.stringify(resolved), "utf8") >
        RETAINED_NODE_EVIDENCE_POLICY.mappingByteLimit
      ) {
        overflow = true;
        invalidate(null, "RETAINED_NODE_LIMIT_EXCEEDED");
        throw protocolError("RETAINED_NODE_LIMIT_EXCEEDED");
      }
    }
    mappings.splice(0, mappings.length, ...resolved);
    mappedObjects.clear();
    for (const mapping of resolvedObjects) {
      mappedObjects.set(mapping.targetToken, mapping.objectId);
    }
    return resolved.map((mapping) => ({ ...mapping }));
  };

  const setPhase = (nextPhase) => {
    if (!versionThree) return;
    const nextIndex = SAME_DOCUMENT_LOADING_PHASES.indexOf(nextPhase);
    const currentIndex = SAME_DOCUMENT_LOADING_PHASES.indexOf(phase);
    if (nextIndex === -1 || nextIndex < currentIndex) {
      invalidate(null, "RETAINED_NODE_EVIDENCE_INVALID");
      throw protocolError("RETAINED_NODE_EVIDENCE_INVALID");
    }
    phase = nextPhase;
  };

  const baselineScope = () => {
    const baseline = snapshots.beforeArm;
    const context = executionContext;
    if (
      baseline === null ||
      context === null ||
      selectedTargetId === null ||
      pageSessionId === null
    ) {
      return null;
    }
    const scope = {
      frameId: baseline.frameId,
      loaderId: baseline.loaderId,
      contextUniqueId: context.uniqueId,
      targetId: selectedTargetId,
      sessionId: pageSessionId,
    };
    return isTargetProofScope(scope) ? scope : null;
  };

  const captureFinalIdentityProof = async ({
    documentId,
    sourceRecordIndex,
    targetToken,
    mappingIndex,
    sourceProof: sourceCandidate,
  } = {}) => {
    if (!versionThree) {
      throw protocolError("RETAINED_NODE_EVIDENCE_INVALID");
    }
    ensureAvailable();
    const normalizedSourceProof = normalizeInitialSourceProof(sourceCandidate, {
      documentId,
      sourceRecordIndex,
      targetToken,
    });
    if (
      phase !== "post-trace-analysis" ||
      !DOCUMENT_ID.test(documentId ?? "") ||
      !Number.isSafeInteger(sourceRecordIndex) ||
      sourceRecordIndex < 0 ||
      sourceRecordIndex >= 512 ||
      typeof targetToken !== "string" ||
      !TARGET_TOKEN.test(targetToken) ||
      !Number.isSafeInteger(mappingIndex) ||
      mappingIndex < 0 ||
      mappingIndex >= RETAINED_NODE_EVIDENCE_POLICY.maxNodes ||
      normalizedSourceProof === null
    ) {
      sourceProof = normalizedSourceProof;
      invalidate(null, "RETAINED_NODE_TRACE_ASSOCIATION_INVALID");
      throw protocolError("RETAINED_NODE_TRACE_ASSOCIATION_INVALID");
    }
    sourceProof = normalizedSourceProof;
    const mapping = mappings[mappingIndex];
    const objectId = mappedObjects.get(targetToken);
    const baseline = baselineScope();
    if (
      !mapping ||
      mapping.targetToken !== targetToken ||
      !isOpaqueId(objectId) ||
      baseline === null ||
      !snapshots.afterMapping ||
      snapshots.afterMapping.documentId !== documentId
    ) {
      retainedTargetProof = {
        ...sourceProof,
        mappingIndex:
          mapping?.targetToken === targetToken ? mappingIndex : null,
        baselineScope: baseline,
        finalProof: null,
      };
      invalidate(null, "RETAINED_NODE_TRACE_ASSOCIATION_INVALID");
      throw protocolError("RETAINED_NODE_TRACE_ASSOCIATION_INVALID");
    }
    retainedTargetProof = {
      ...sourceProof,
      mappingIndex,
      baselineScope: { ...baseline },
      finalProof: null,
    };
    if (!Object.values(sourceProof.sourceCapture).every((value) => value)) {
      invalidate(null, "RETAINED_NODE_TRACE_ASSOCIATION_INVALID");
      throw protocolError("RETAINED_NODE_TRACE_ASSOCIATION_INVALID");
    }

    try {
      const context = requireContext();
      const expression = retainedNodeFinalReferenceProofExpression({
        documentId,
        sourceRecordIndex,
        targetToken,
      });
      const evaluated = await pendingCommand(pageSession, "Runtime.evaluate", {
        expression,
        uniqueContextId: context.uniqueId,
        returnByValue: true,
      });
      ensureAvailable();
      const referenceProof = evaluated?.result?.value;
      if (
        evaluated?.exceptionDetails ||
        !hasExactKeys(referenceProof, FINAL_REFERENCE_PROOF_KEYS) ||
        !Object.values(referenceProof).every(
          (value) => typeof value === "boolean",
        )
      ) {
        invalidate(null, "RETAINED_NODE_TRACE_ASSOCIATION_INVALID");
        throw protocolError("RETAINED_NODE_TRACE_ASSOCIATION_INVALID");
      }

      const described = await pendingCommand(pageSession, "DOM.describeNode", {
        objectId,
        depth: 0,
        pierce: false,
      });
      ensureAvailable();
      const finalBackendNodeId = described?.node?.backendNodeId;
      if (
        !Number.isSafeInteger(finalBackendNodeId) ||
        finalBackendNodeId < 1 ||
        finalBackendNodeId > MAX_BACKEND_NODE_ID ||
        finalBackendNodeId !== mapping.backendNodeId
      ) {
        invalidate(null, "RETAINED_NODE_TRACE_ASSOCIATION_INVALID");
        throw protocolError("RETAINED_NODE_TRACE_ASSOCIATION_INVALID");
      }

      const frameResponse = await pendingCommand(
        pageSession,
        "Page.getFrameTree",
      );
      ensureAvailable();
      const finalFrame = snapshotFromResponse(frameResponse, documentId);
      const targetResponse = await pendingCommand(
        pageSession,
        "Target.getTargetInfo",
      );
      ensureAvailable();
      const targetId = targetResponse?.targetInfo?.targetId;
      if (
        finalFrame.frameId !== rootFrameId ||
        finalFrame.loaderId !== rootLoaderId ||
        typeof targetId !== "string" ||
        !OPAQUE_ID.test(targetId) ||
        targetId !== selectedTargetId ||
        (targetResponse?.targetInfo?.type !== undefined &&
          targetResponse.targetInfo.type !== "page")
      ) {
        invalidate(
          finalFrame.frameId !== rootFrameId
            ? "FRAME_SCOPE_CHANGED"
            : finalFrame.loaderId !== rootLoaderId
              ? "NAVIGATION"
              : "TARGET_CHANGED",
        );
        throw protocolError("RETAINED_NODE_TRACE_ASSOCIATION_INVALID");
      }
      const targets = await pendingCommand(browserSession, "Target.getTargets");
      ensureAvailable();
      if (
        !Array.isArray(targets?.targetInfos) ||
        !targets.targetInfos.some(
          (target) => isRecord(target) && target.targetId === selectedTargetId,
        )
      ) {
        invalidate("TARGET_CHANGED");
        throw protocolError("RETAINED_NODE_TRACE_ASSOCIATION_INVALID");
      }
      const finalContext = requireContext();
      const cdpScope = {
        frameId: finalFrame.frameId,
        loaderId: finalFrame.loaderId,
        contextUniqueId: finalContext.uniqueId,
        targetId,
        sessionId: pageSessionId,
      };
      if (
        !isTargetProofScope(cdpScope) ||
        !sameTargetProofScope(baseline, cdpScope)
      ) {
        invalidate("UNKNOWN_EVENT_SCOPE");
        throw protocolError("RETAINED_NODE_TRACE_ASSOCIATION_INVALID");
      }

      finalReferenceProof = {
        stage: "post-trace-before-release",
        ...referenceProof,
        mappedBackendNodeId: mapping.backendNodeId,
        finalBackendNodeId,
        cdpScope,
      };
      retainedTargetProof = {
        ...sourceProof,
        mappingIndex,
        baselineScope: { ...baseline },
        finalProof: finalReferenceProof,
      };
      if (
        ![
          referenceProof.savedDocumentSame,
          referenceProof.savedRootSame,
          referenceProof.savedTargetSame,
          referenceProof.targetOwnerDocumentMatches,
        ].every((value) => value === true)
      ) {
        invalidate(null, "RETAINED_NODE_TRACE_ASSOCIATION_INVALID");
        throw protocolError("RETAINED_NODE_TRACE_ASSOCIATION_INVALID");
      }
      return { ...finalReferenceProof, cdpScope: { ...cdpScope } };
    } catch (error) {
      if (failureReasonCode === null) {
        invalidate(
          error?.lossReasonCode ?? null,
          EVIDENCE_REASONS.has(error?.message)
            ? error.message
            : "RETAINED_NODE_TRACE_ASSOCIATION_INVALID",
        );
      }
      throw protocolError(failureReasonCode);
    }
  };

  const buildEvidence = ({
    documentId,
    scope,
    observerCleanup,
    observerFailureReasonCode,
  }) => {
    const safeObserverFailureReasonCode =
      observerFailureReasonCode === null ||
      observerFailureReasonCode === undefined
        ? null
        : EVIDENCE_REASONS.has(observerFailureReasonCode)
          ? observerFailureReasonCode
          : "RETAINED_NODE_EVIDENCE_INVALID";
    if (safeObserverFailureReasonCode === "RETAINED_NODE_LIMIT_EXCEEDED") {
      overflow = true;
    }
    const reasonCode =
      failureReasonCode ??
      safeObserverFailureReasonCode ??
      (observerCleanup?.windowListenersRemoved === true &&
      observerCleanup?.strongReferencesCleared === true &&
      objectGroupReleased &&
      listenersRemoved === true
        ? null
        : "RETAINED_NODE_CLEANUP_FAILED");
    const base = {
      status: reasonCode === null ? "complete" : "unavailable",
      reasonCode,
      mappings: reasonCode === null || versionThree ? mappings : [],
      executionContext,
      documentId: DOCUMENT_ID.test(documentId ?? "") ? documentId : null,
      snapshots: Object.fromEntries(
        Object.entries(snapshots).map(([stage, value]) => [
          stage,
          value
            ? {
                ...value,
                documentId:
                  value.documentId === null ? documentId : value.documentId,
              }
            : null,
        ]),
      ),
      protocolCatalogId: RETAINED_NODE_PROTOCOL_CATALOG_ID,
      lifecycle: {
        coverage: reasonCode === null ? "complete" : "incomplete",
        lossReasonCode,
        overflow,
      },
      scope,
      cleanup: {
        windowListenersRemoved: observerCleanup?.windowListenersRemoved ?? null,
        strongReferencesCleared:
          observerCleanup?.strongReferencesCleared ?? null,
        objectGroupReleased,
        cdpListenersRemoved: listenersRemoved,
      },
    };
    try {
      return validateRetainedNodeEvidence(base);
    } catch {
      return unavailable(
        "RETAINED_NODE_EVIDENCE_INVALID",
        documentId,
        scope,
        observerCleanup,
      );
    }
  };

  const buildSameDocumentLoadingWitness = (retainedNodeEvidence) => {
    const proof =
      retainedTargetProof ?? (sourceProof ? { ...sourceProof } : null);
    const collectorCleanup = {
      windowListenersRemoved:
        typeof retainedNodeEvidence.cleanup.windowListenersRemoved === "boolean"
          ? retainedNodeEvidence.cleanup.windowListenersRemoved
          : null,
      strongReferencesCleared:
        typeof retainedNodeEvidence.cleanup.strongReferencesCleared ===
        "boolean"
          ? retainedNodeEvidence.cleanup.strongReferencesCleared
          : null,
      objectGroupReleased,
      cdpListenersRemoved: listenersRemoved,
    };
    const loadingEvents = lifecycleEvents.filter(
      (event) => event.method === "Page.frameStartedLoading",
    );
    const historyEvents = lifecycleEvents.filter(
      (event) =>
        event.method === "Page.navigatedWithinDocument" &&
        event.navigationType === "historyApi",
    );
    const mapping =
      proof?.mappingIndex === null || proof?.mappingIndex === undefined
        ? null
        : retainedNodeEvidence.mappings[proof.mappingIndex];
    const finalProof = proof?.finalProof ?? null;
    const baseline = proof?.baselineScope ?? null;
    const rootSnapshot = retainedNodeEvidence.snapshots.beforeArm;
    const complete =
      retainedNodeEvidence.status === "complete" &&
      Object.values(collectorCleanup).every((value) => value === true) &&
      firstInvalidation === null &&
      droppedLifecycleEventCount === 0 &&
      lifecycleOverflow === false &&
      lifecycleEvents.length <= SAME_DOCUMENT_LOADING_EVENT_LIMIT &&
      loadingEvents.length === 1 &&
      historyEvents.length === 1 &&
      loadingCount === 1 &&
      historyApiCount === 1 &&
      loadingEvents[0].phase === "primary-action" &&
      (historyEvents[0].phase === "primary-action" ||
        historyEvents[0].phase === "route-ready") &&
      loadingEvents[0].frameId === historyEvents[0].frameId &&
      loadingEvents[0].frameId === rootSnapshot?.frameId &&
      historyEvents[0].navigationType === "historyApi" &&
      loadingEvents[0].sequence < historyEvents[0].sequence &&
      !lifecycleEvents.some(
        (event) =>
          FATAL_SAME_DOCUMENT_EVENTS.has(event.method) ||
          (event.method === "Page.navigatedWithinDocument" &&
            event.navigationType !== "historyApi"),
      ) &&
      proof !== null &&
      proof.targetToken !== null &&
      proof.mappingIndex !== null &&
      isTargetProofScope(baseline) &&
      finalProof !== null &&
      Object.values(proof.sourceCapture).every((value) => value === true) &&
      [
        finalProof.savedDocumentSame,
        finalProof.savedRootSame,
        finalProof.savedTargetSame,
        finalProof.targetOwnerDocumentMatches,
      ].every((value) => value === true) &&
      isTargetProofScope(finalProof.cdpScope) &&
      sameTargetProofScope(baseline, finalProof.cdpScope) &&
      baseline.frameId === rootSnapshot?.frameId &&
      baseline.loaderId === rootSnapshot?.loaderId &&
      baseline.contextUniqueId ===
        retainedNodeEvidence.executionContext?.uniqueId &&
      baseline.frameId === retainedNodeEvidence.executionContext?.frameId &&
      mapping !== null &&
      mapping.targetToken === proof.targetToken &&
      Number.isSafeInteger(finalProof.mappedBackendNodeId) &&
      finalProof.mappedBackendNodeId === mapping.backendNodeId &&
      Number.isSafeInteger(finalProof.finalBackendNodeId) &&
      finalProof.finalBackendNodeId === mapping.backendNodeId;
    const reasonCode = complete
      ? null
      : (retainedNodeEvidence.reasonCode ??
        (Object.values(collectorCleanup).some((value) => value !== true)
          ? "RETAINED_NODE_CLEANUP_FAILED"
          : (firstInvalidation?.reasonCode ??
            (loadingEvents.length !== 1 ||
            historyEvents.length !== 1 ||
            loadingCount !== 1 ||
            historyApiCount !== 1
              ? "RETAINED_NODE_LIFECYCLE_INVALIDATED"
              : "RETAINED_NODE_TRACE_ASSOCIATION_INVALID"))));
    return {
      status: complete ? "complete" : "unavailable",
      reasonCode,
      protocolCatalogId: RETAINED_NODE_PROTOCOL_CATALOG_ID,
      events: lifecycleEvents.map((event) => ({ ...event })),
      droppedCount: droppedLifecycleEventCount,
      overflow: lifecycleOverflow,
      loadingCount,
      historyApiCount,
      orderingBasis: "cdp-receipt",
      sourceOrder: "unknown",
      retainedTargetProof: proof,
      firstInvalidation: firstInvalidation ? { ...firstInvalidation } : null,
      collectorCleanup,
    };
  };

  const buildTrackerResult = (retainedNodeEvidence) => {
    if (!versionThree) return retainedNodeEvidence;
    return {
      retainedNodeEvidence,
      sameDocumentLoadingWitness:
        buildSameDocumentLoadingWitness(retainedNodeEvidence),
    };
  };

  // sourceProof carries only observer-validated source facts; mapping and final identity remain tracker-owned.
  const finalize = async ({
    documentId,
    scope,
    observerCleanup,
    observerFailureReasonCode = null,
    sourceProof: sourceCandidate = null,
  } = {}) => {
    if (finalEvidence !== null) return finalEvidence;
    if (versionThree && sourceCandidate !== null) {
      const sourceRecordIndex = sourceCandidate?.sourceRecordIndex;
      const targetToken = sourceCandidate?.targetToken;
      const normalizedSourceProof =
        DOCUMENT_ID.test(documentId ?? "") &&
        Number.isSafeInteger(sourceRecordIndex) &&
        sourceRecordIndex >= 0 &&
        sourceRecordIndex < 512 &&
        (targetToken === null ||
          (typeof targetToken === "string" && TARGET_TOKEN.test(targetToken)))
          ? normalizeInitialSourceProof(sourceCandidate, {
              documentId,
              sourceRecordIndex,
              targetToken,
            })
          : null;
      if (
        normalizedSourceProof === null ||
        (sourceProof !== null &&
          JSON.stringify(sourceProof) !== JSON.stringify(normalizedSourceProof))
      ) {
        invalidate(null, "RETAINED_NODE_TRACE_ASSOCIATION_INVALID");
      } else if (sourceProof === null) {
        sourceProof = normalizedSourceProof;
      }
    }
    if (versionThree && phase !== "cleanup") setPhase("cleanup");
    if (!started || closed) {
      listenersRemoved ??= removeListeners();
      finalEvidence = buildTrackerResult(
        unavailable(
          "RETAINED_NODE_CLEANUP_FAILED",
          documentId,
          scope,
          observerCleanup,
        ),
      );
      return finalEvidence;
    }
    if (versionThree) {
      if (
        !DOCUMENT_ID.test(documentId ?? "") ||
        snapshots.beforeArm === null ||
        snapshots.afterArm === null ||
        snapshots.afterDrain === null ||
        snapshots.afterMapping === null
      ) {
        invalidate(null, "RETAINED_NODE_EVIDENCE_INVALID");
      }

      if (!objectGroupReleased) {
        let releaseOperation;
        try {
          releaseOperation = Promise.resolve(
            pageSession.send("Runtime.releaseObjectGroup", { objectGroup }),
          );
        } catch {
          releaseOperation = Promise.reject(
            protocolError("RETAINED_NODE_CLEANUP_FAILED"),
          );
        }
        pending.add(releaseOperation);
        releaseOperation.then(
          () => pending.delete(releaseOperation),
          () => pending.delete(releaseOperation),
        );
        try {
          await withTimeout(
            releaseOperation,
            boundedTimeoutMs,
            "RETAINED_NODE_CLEANUP_FAILED",
          );
          objectGroupReleased = true;
          mappedObjects.clear();
        } catch {
          if (failureReasonCode === null) {
            invalidate(null, "RETAINED_NODE_CLEANUP_FAILED");
          }
        }
      }

      if (failureReasonCode === null) {
        try {
          await snapshot("afterCleanup", documentId);
        } catch {
          if (failureReasonCode === null) {
            invalidate(null, "RETAINED_NODE_CLEANUP_FAILED");
          }
        }
      }

      try {
        await withTimeout(
          Promise.allSettled([...pending]),
          boundedTimeoutMs,
          "RETAINED_NODE_CLEANUP_FAILED",
        );
      } catch {
        if (failureReasonCode === null) {
          invalidate(null, "RETAINED_NODE_CLEANUP_FAILED");
        }
      }

      if (failureReasonCode === null && snapshots.afterCleanup === null) {
        invalidate(null, "RETAINED_NODE_CLEANUP_FAILED");
      }
      removeListeners();
      const retainedNodeEvidence =
        failureReasonCode === null
          ? buildEvidence({
              documentId,
              scope,
              observerCleanup,
              observerFailureReasonCode,
            })
          : unavailable(failureReasonCode, documentId, scope, observerCleanup);
      finalEvidence = buildTrackerResult(retainedNodeEvidence);
      return finalEvidence;
    }
    try {
      ensureAvailable();
      if (
        !DOCUMENT_ID.test(documentId ?? "") ||
        snapshots.beforeArm === null ||
        snapshots.afterArm === null ||
        snapshots.afterDrain === null ||
        snapshots.afterMapping === null
      ) {
        invalidate(null, "RETAINED_NODE_EVIDENCE_INVALID");
        throw protocolError("RETAINED_NODE_EVIDENCE_INVALID");
      }
      await pendingCommand(pageSession, "Runtime.releaseObjectGroup", {
        objectGroup,
      });
      ensureAvailable();
      objectGroupReleased = true;
      mappedObjects.clear();
      await snapshot("afterCleanup", documentId);
      if (versionThree) {
        try {
          await withTimeout(
            Promise.allSettled([...pending]),
            boundedTimeoutMs,
            "RETAINED_NODE_CLEANUP_FAILED",
          );
        } catch {
          invalidate(null, "RETAINED_NODE_CLEANUP_FAILED");
          throw protocolError("RETAINED_NODE_CLEANUP_FAILED");
        }
      } else {
        await Promise.allSettled([...pending]);
      }
      ensureAvailable();
      removeListeners();
      finalEvidence = buildTrackerResult(
        buildEvidence({
          documentId,
          scope,
          observerCleanup,
          observerFailureReasonCode,
        }),
      );
      return finalEvidence;
    } catch (error) {
      if (failureReasonCode === null) {
        invalidate(
          null,
          EVIDENCE_REASONS.has(error?.message)
            ? error.message
            : "RETAINED_NODE_MAPPING_FAILED",
        );
      }
      removeListeners();
      finalEvidence = buildTrackerResult(
        unavailable(failureReasonCode, documentId, scope, observerCleanup),
      );
      return finalEvidence;
    }
  };

  const close = () => {
    if (closePromise !== null) return closePromise;
    closePromise = (async () => {
      if (closed) return;
      closed = true;
      removeListeners();
      for (const session of [pageSession, browserSession]) {
        if (typeof session?.detach !== "function") continue;
        try {
          await withTimeout(
            Promise.resolve().then(() => session.detach()),
            boundedTimeoutMs,
            "RETAINED_NODE_CLEANUP_FAILED",
          );
        } catch {}
      }
      if (pending.size > 0) {
        let timer;
        await Promise.race([
          Promise.allSettled([...pending]),
          new Promise((resolve) => {
            timer = setTimeout(resolve, boundedTimeoutMs);
          }),
        ]);
        clearTimeout(timer);
      }
      removeListeners();
    })();
    return closePromise;
  };

  const start = async () => {
    if (started) throw protocolError("RETAINED_NODE_EVIDENCE_INVALID");
    if (!supports || browser === null || !Number.isFinite(boundedTimeoutMs)) {
      failureReasonCode = "RETAINED_NODE_CLEANUP_FAILED";
      await close();
      throw protocolError("RETAINED_NODE_CLEANUP_FAILED");
    }
    try {
      installListeners();
      started = true;
      await pendingCommand(pageSession, "Page.enable");
      await getRootFrame();
      await pendingCommand(pageSession, "Runtime.enable");
      await pendingCommand(pageSession, "Inspector.enable");
      await pendingCommand(browserSession, "Target.setDiscoverTargets", {
        discover: true,
      });
      await resolveTarget();
      failForPendingContexts();
      requireContext();
      return;
    } catch (error) {
      if (failureReasonCode === null) {
        invalidate(
          null,
          EVIDENCE_REASONS.has(error?.message)
            ? error.message
            : "RETAINED_NODE_MAPPING_FAILED",
        );
      }
      await close();
      throw protocolError(failureReasonCode);
    }
  };

  return {
    start,
    snapshot,
    mapTargets,
    setPhase,
    captureFinalIdentityProof,
    finalize,
    close,
    isAvailable: () => started && !closed && failureReasonCode === null,
  };
}
