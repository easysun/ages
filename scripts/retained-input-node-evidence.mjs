import { randomUUID } from "node:crypto";
import {
  RETAINED_NODE_EVIDENCE_POLICY,
  RETAINED_NODE_PROTOCOL_CATALOG_ID,
  validateRetainedNodeEvidence,
} from "./browser-stimulus-observer.mjs";

const DOCUMENT_ID = /^d-[a-f0-9]{24}$/;
const OPAQUE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const TARGET_TOKEN = /^t-[a-f0-9]{24}$/;
const MAX_BACKEND_NODE_ID = 2147483647;
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
}) {
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
    if (failureReasonCode !== null) return;
    failureReasonCode = EVIDENCE_REASONS.has(evidenceReason)
      ? evidenceReason
      : "RETAINED_NODE_LIFECYCLE_INVALIDATED";
    lossReasonCode = LIFECYCLE_LOSSES.has(reasonCode) ? reasonCode : null;
    const error = protocolError(failureReasonCode);
    error.lossReasonCode = lossReasonCode;
    rejectInvalidation(error);
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
      mappings: [],
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
        handlePageEvent(kind, payload),
      );
    }
    addListener(pageSession, "close", () => invalidate("SESSION_LOST"));
    addListener(browserSession, "close", () => invalidate("SESSION_LOST"));
    for (const eventName of TARGET_EVENTS) {
      addListener(browserSession, eventName, (payload) =>
        handleTargetEvent(eventName, payload),
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
    return resolved.map((mapping) => ({ ...mapping }));
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
      mappings: reasonCode === null ? mappings : [],
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

  const finalize = async ({
    documentId,
    scope,
    observerCleanup,
    observerFailureReasonCode = null,
  } = {}) => {
    if (finalEvidence !== null) return finalEvidence;
    if (!started || closed) {
      listenersRemoved ??= removeListeners();
      finalEvidence = unavailable(
        "RETAINED_NODE_CLEANUP_FAILED",
        documentId,
        scope,
        observerCleanup,
      );
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
      await snapshot("afterCleanup", documentId);
      await Promise.allSettled([...pending]);
      ensureAvailable();
      removeListeners();
      finalEvidence = buildEvidence({
        documentId,
        scope,
        observerCleanup,
        observerFailureReasonCode,
      });
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
      finalEvidence = unavailable(
        failureReasonCode,
        documentId,
        scope,
        observerCleanup,
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
    finalize,
    close,
    isAvailable: () => started && !closed && failureReasonCode === null,
  };
}
