export function createTimelineOpenObserver(options) {
  let target;
  let expectedPath;
  let expectedItems;
  let timeoutMs;
  try {
    target = options?.target;
    expectedPath = options?.expectedPath;
    expectedItems = options?.expectedItems;
    timeoutMs = options?.timeoutMs ?? 120_000;
    if (
      !target ||
      typeof expectedPath !== "string" ||
      !expectedPath.startsWith("/") ||
      expectedPath.includes("?") ||
      expectedPath.includes("#") ||
      (expectedItems !== 100 && expectedItems !== 10_000) ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 120_000
    ) {
      throw new Error();
    }
  } catch {
    throw new Error("OBSERVER_INVALID_CONFIGURATION");
  }
  options = null;

  const workload =
    expectedItems === 100 ? "100-interactive" : "10000-chronological";
  let document;
  let window;
  try {
    document = target.ownerDocument;
    window = document?.defaultView;
    if (
      target.nodeType !== 1 ||
      !document ||
      !window ||
      window.document !== document ||
      target.isConnected !== true
    ) {
      throw new Error();
    }
  } catch {
    throw new Error("OBSERVER_INVALID_CONFIGURATION");
  }

  const markerLabels = Object.freeze({
    captureStart: `ages-open-v1:${workload}:capture-start`,
    primaryClick: `ages-open-v1:${workload}:primary-click`,
    completionEnd: `ages-open-v1:${workload}:completion-end`,
  });
  let state = "armed";
  let reason = null;
  let started = false;
  let clickCount = 0;
  let renderedCount = 0;
  let rangeValid = false;
  let sameDocument = false;
  let pathMatches = false;
  let visible = false;
  let stableFrameCount = 0;
  let captureStartMarkerSeen = false;
  let primaryClickMarkerSeen = false;
  let completionEndMarkerSeen = false;
  let performance;
  let initialTimeOrigin;
  let initialPath;
  let root;
  let rootParent;
  let documentElement;
  let observer;
  let timeoutId = null;
  let evaluationQueued = false;
  let pendingFrameId = null;
  let candidateSignature = null;
  let framePhase = 0;
  let retainedTarget = target;
  let pointerModality = null;
  const listenerEntries = [];

  const status = () =>
    Object.freeze({
      schemaVersion: 1,
      workload,
      state,
      reason,
      clickCount,
      expectedCount: expectedItems,
      renderedCount,
      rangeValid,
      sameDocument,
      pathMatches,
      visible,
      stableFrameCount,
      captureStartMarkerSeen,
      primaryClickMarkerSeen,
      completionEndMarkerSeen,
    });

  const clearPendingFrame = () => {
    if (pendingFrameId !== null) {
      try {
        window.cancelAnimationFrame(pendingFrameId);
      } catch {
        // Keep browser error details private.
      }
      pendingFrameId = null;
    }
    framePhase = 0;
  };

  const cleanup = () => {
    if (timeoutId !== null) {
      try {
        window.clearTimeout(timeoutId);
      } catch {
        // Keep browser error details private.
      }
      timeoutId = null;
    }
    clearPendingFrame();
    if (observer) {
      try {
        observer.disconnect();
      } catch {
        // Keep browser error details private.
      }
      observer = null;
    }
    for (const [
      eventTarget,
      type,
      listener,
      listenerOptions,
    ] of listenerEntries) {
      try {
        eventTarget.removeEventListener(type, listener, listenerOptions);
      } catch {
        // Listener cleanup is best-effort; never expose exception contents.
      }
    }
    listenerEntries.length = 0;
    retainedTarget = null;
    target = null;
    expectedPath = null;
    initialPath = null;
    pointerModality = null;
    performance = null;
    root = null;
    rootParent = null;
    documentElement = null;
    document = null;
    window = null;
    candidateSignature = null;
    evaluationQueued = false;
  };

  const finish = (nextState, nextReason) => {
    if (state !== "armed") return;
    state = nextState;
    reason = nextReason;
    cleanup();
  };

  const invalidate = (code) => finish("invalid", code);

  const emitMarker = (label) => {
    try {
      const consoleObject = window.console;
      if (!consoleObject || typeof consoleObject.timeStamp !== "function") {
        return false;
      }
      consoleObject.timeStamp.call(consoleObject, label);
      return true;
    } catch {
      return false;
    }
  };

  const installListener = (eventTarget, type, listener, listenerOptions) => {
    eventTarget.addEventListener(type, listener, listenerOptions);
    listenerEntries.push([eventTarget, type, listener, listenerOptions]);
  };

  const pageIsVisible = () => {
    try {
      return document.visibilityState === "visible" && document.hidden !== true;
    } catch {
      return false;
    }
  };

  const nodeIsVisible = (node) => {
    try {
      if (
        !node ||
        node.ownerDocument !== document ||
        node.isConnected !== true ||
        node.hidden === true
      ) {
        return false;
      }
      const style = window.getComputedStyle(node);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse" ||
        Number(style.opacity) === 0
      ) {
        return false;
      }
      if (node.getClientRects().length === 0) return false;
      const bounds = node.getBoundingClientRect();
      return bounds.width > 0 && bounds.height > 0;
    } catch {
      throw new Error("OBSERVER_DOM_READ_FAILED");
    }
  };

  const refreshEnvironment = () => {
    let documentMatches = false;
    let originMatches = false;
    let currentPath;
    let rootConnected = false;
    try {
      documentMatches =
        window.document === document &&
        document.defaultView === window &&
        window.performance === performance;
      if (documentMatches) {
        originMatches = performance.timeOrigin === initialTimeOrigin;
      }
      currentPath = window.location.pathname;
      rootConnected =
        root.ownerDocument === document && root.isConnected === true;
    } catch {
      sameDocument = false;
      pathMatches = false;
      visible = false;
      return { kind: "error" };
    }
    sameDocument = documentMatches && originMatches;
    pathMatches = currentPath === expectedPath;
    visible = pageIsVisible();
    if (!sameDocument || !rootConnected) return { kind: "document-changed" };
    if (!visible) return { kind: "visibility-changed" };
    const localDocument = (() => {
      try {
        const protocol = window.location.protocol;
        const hostname = window.location.hostname;
        return (
          protocol === "http:" &&
          (hostname === "127.0.0.1" || hostname === "localhost")
        );
      } catch {
        return false;
      }
    })();
    if (!localDocument) return { kind: "wrong-route" };
    if (clickCount === 0) {
      if (currentPath !== initialPath) return { kind: "wrong-route" };
      try {
        if (
          !retainedTarget ||
          retainedTarget.ownerDocument !== document ||
          retainedTarget.isConnected !== true
        ) {
          return { kind: "wrong-target" };
        }
      } catch {
        return { kind: "wrong-target" };
      }
    } else if (currentPath !== initialPath && currentPath !== expectedPath) {
      return { kind: "wrong-route" };
    }
    return { kind: "ok", currentPath };
  };

  const inspectGroups = (svg) => {
    let groupNodes;
    try {
      groupNodes = svg.querySelectorAll("g");
    } catch {
      throw new Error("OBSERVER_DOM_READ_FAILED");
    }
    if (groupNodes.length === 0 || groupNodes.length > expectedItems) {
      return { valid: false, count: 0, signature: null };
    }
    const ranges = [];
    let sum = 0;
    for (const group of groupNodes) {
      let firstValue;
      let lastValue;
      let countValue;
      try {
        firstValue = group.getAttribute("data-first-ordinal");
        lastValue = group.getAttribute("data-last-ordinal");
        countValue = group.getAttribute("data-moment-count");
      } catch {
        throw new Error("OBSERVER_DOM_READ_FAILED");
      }
      if (
        typeof firstValue !== "string" ||
        typeof lastValue !== "string" ||
        typeof countValue !== "string" ||
        !/^[1-9][0-9]*$/.test(firstValue) ||
        !/^[1-9][0-9]*$/.test(lastValue) ||
        !/^[1-9][0-9]*$/.test(countValue)
      ) {
        return { valid: false, count: 0, signature: null };
      }
      const first = Number(firstValue);
      const last = Number(lastValue);
      const count = Number(countValue);
      if (
        !Number.isSafeInteger(first) ||
        !Number.isSafeInteger(last) ||
        !Number.isSafeInteger(count) ||
        last < first ||
        last - first + 1 !== count
      ) {
        return { valid: false, count: 0, signature: null };
      }
      sum = Math.min(expectedItems + 1, sum + count);
      ranges.push({ first, last, count });
    }
    ranges.sort(
      (left, right) =>
        left.first - right.first ||
        left.last - right.last ||
        left.count - right.count,
    );
    let nextOrdinal = 1;
    for (const range of ranges) {
      if (range.first !== nextOrdinal) {
        return { valid: false, count: sum, signature: null };
      }
      nextOrdinal = range.last + 1;
    }
    const valid = sum === expectedItems && nextOrdinal === expectedItems + 1;
    return {
      valid,
      count: sum,
      signature: valid
        ? ranges
            .map((range) => `${range.first}-${range.last}-${range.count}`)
            .join(";")
        : null,
    };
  };

  const inspectProjection = () => {
    let main;
    try {
      main = document.querySelector("main#main.timeline-page");
      if (!main) return { ready: false, rangeValid: false, count: 0 };
      if (main.querySelector(':scope > p[role="alert"].error')) {
        return { kind: "projection-error" };
      }
      const sections = main.querySelectorAll(
        'section.story-viewport[data-viewport="story"]',
      );
      const visibleSections = [];
      for (const section of sections) {
        if (nodeIsVisible(section)) visibleSections.push(section);
      }
      if (visibleSections.length !== 1) {
        return { ready: false, rangeValid: false, count: 0 };
      }
      const svgs = visibleSections[0].querySelectorAll(
        'svg[role="img"][aria-label="Narrative order overview"]',
      );
      const visibleSvgs = [];
      for (const svg of svgs) {
        if (nodeIsVisible(svg)) visibleSvgs.push(svg);
      }
      if (visibleSvgs.length !== 1) {
        return { ready: false, rangeValid: false, count: 0 };
      }
      const groups = inspectGroups(visibleSvgs[0]);
      return {
        ready: groups.valid,
        rangeValid: groups.valid,
        count: groups.count,
        signature: groups.signature,
      };
    } catch (error) {
      if (error?.message === "OBSERVER_DOM_READ_FAILED") {
        return { kind: "observer-error" };
      }
      return { kind: "observer-error" };
    }
  };

  const resetCandidate = () => {
    clearPendingFrame();
    candidateSignature = null;
    stableFrameCount = 0;
  };

  const readForEvaluation = () => {
    const environment = refreshEnvironment();
    if (environment.kind !== "ok") {
      if (environment.kind === "document-changed")
        invalidate("DOCUMENT_CHANGED");
      else if (environment.kind === "visibility-changed") {
        invalidate("VISIBILITY_CHANGED");
      } else if (environment.kind === "wrong-target")
        invalidate("WRONG_TARGET");
      else if (environment.kind === "wrong-route") invalidate("WRONG_ROUTE");
      else invalidate("OBSERVER_ERROR");
      return null;
    }
    if (clickCount === 0 || environment.currentPath !== expectedPath) {
      resetCandidate();
      return null;
    }
    const projection = inspectProjection();
    if (projection.kind === "projection-error") {
      invalidate("PROJECTION_ERROR");
      return null;
    }
    if (projection.kind === "observer-error") {
      invalidate("OBSERVER_ERROR");
      return null;
    }
    renderedCount = projection.count;
    rangeValid = projection.rangeValid;
    if (!projection.ready) {
      resetCandidate();
      return null;
    }
    return projection;
  };

  let onAnimationFrame;
  const requestFrame = (phase) => {
    framePhase = phase;
    try {
      pendingFrameId = window.requestAnimationFrame(onAnimationFrame);
    } catch {
      invalidate("OBSERVER_ERROR");
    }
  };

  onAnimationFrame = () => {
    pendingFrameId = null;
    if (state !== "armed" || !started) return;
    const projection = readForEvaluation();
    if (!projection) return;
    if (candidateSignature !== projection.signature) {
      candidateSignature = projection.signature;
      stableFrameCount = 1;
      requestFrame(2);
      return;
    }
    if (framePhase === 1) {
      stableFrameCount = 1;
      requestFrame(2);
      return;
    }
    stableFrameCount = 2;
    state = "projection-ready";
    reason = null;
    completionEndMarkerSeen = emitMarker(markerLabels.completionEnd);
    cleanup();
  };

  const evaluate = () => {
    if (state !== "armed" || !started) return;
    const projection = readForEvaluation();
    if (!projection) return;
    if (candidateSignature !== projection.signature) {
      resetCandidate();
      candidateSignature = projection.signature;
      requestFrame(1);
    } else if (pendingFrameId === null) {
      requestFrame(1);
    }
  };

  const scheduleEvaluation = () => {
    if (state !== "armed" || !started || evaluationQueued) return;
    evaluationQueued = true;
    try {
      window.queueMicrotask(() => {
        evaluationQueued = false;
        evaluate();
      });
    } catch {
      evaluationQueued = false;
      invalidate("OBSERVER_ERROR");
    }
  };

  const recordActivation = (event, nonPrimaryActivation = false) => {
    if (state !== "armed" || !started) return;
    if (clickCount >= 1) {
      clickCount = 2;
      invalidate("EXTRA_CLICK");
      return;
    }
    clickCount = 1;
    let pathHasTarget = false;
    let trusted = false;
    let primary = false;
    let modified = false;
    try {
      const path = event.composedPath();
      pathHasTarget = Array.isArray(path) && path.includes(retainedTarget);
      if (!pathHasTarget && event.target === retainedTarget)
        pathHasTarget = true;
      trusted = event.isTrusted === true;
      primary = !nonPrimaryActivation && event.button === 0;
      modified =
        nonPrimaryActivation ||
        event.altKey === true ||
        event.ctrlKey === true ||
        event.metaKey === true ||
        event.shiftKey === true;
      const suppliedPointerType = event.pointerType;
      pointerModality =
        typeof suppliedPointerType === "string" &&
        ["mouse", "pen", "touch"].includes(suppliedPointerType)
          ? suppliedPointerType
          : null;
    } catch {
      invalidate("OBSERVER_ERROR");
      return;
    }
    if (!pathHasTarget) {
      invalidate("WRONG_TARGET");
      return;
    }
    if (!trusted) {
      invalidate("UNTRUSTED_INPUT");
      return;
    }
    if (!primary || modified) {
      invalidate("MODIFIED_INPUT");
      return;
    }
    const environment = refreshEnvironment();
    if (environment.kind === "document-changed") {
      invalidate("DOCUMENT_CHANGED");
      return;
    }
    if (environment.kind === "visibility-changed") {
      invalidate("VISIBILITY_CHANGED");
      return;
    }
    if (environment.kind === "wrong-route") {
      invalidate("WRONG_ROUTE");
      return;
    }
    if (environment.kind !== "ok") {
      invalidate("OBSERVER_ERROR");
      return;
    }
    primaryClickMarkerSeen = emitMarker(markerLabels.primaryClick);
    retainedTarget = null;
    scheduleEvaluation();
    void pointerModality;
  };

  const onClick = (event) => recordActivation(event);
  const onAuxClick = (event) => recordActivation(event, true);
  const onContextMenu = (event) => recordActivation(event, true);

  const onVisibilityChange = () => {
    if (state !== "armed" || !started) return;
    visible = pageIsVisible();
    if (!visible) invalidate("VISIBILITY_CHANGED");
    else scheduleEvaluation();
  };

  const onResize = () => scheduleEvaluation();
  const onPageHide = () => invalidate("DOCUMENT_CHANGED");
  const onMutations = (records) => {
    if (state !== "armed" || !started) return;
    try {
      for (const record of records) {
        if (record.target === rootParent || record.target === documentElement) {
          for (const removedNode of record.removedNodes) {
            if (
              removedNode === root ||
              (typeof removedNode.contains === "function" &&
                removedNode.contains(root))
            ) {
              invalidate("DOCUMENT_CHANGED");
              return;
            }
          }
          if (root.isConnected !== true || root.parentNode !== rootParent) {
            invalidate("DOCUMENT_CHANGED");
            return;
          }
        } else {
          scheduleEvaluation();
        }
      }
    } catch {
      invalidate("OBSERVER_ERROR");
    }
  };

  const arm = () => {
    if (state !== "armed" || started) return status();
    try {
      performance = window.performance;
      initialTimeOrigin = performance?.timeOrigin;
      initialPath = window.location.pathname;
      root = document.querySelector("#root");
      rootParent = root?.parentNode;
      documentElement = document.documentElement;
      const main = document.querySelector("main#main.timeline-page");
      const timelineList = main?.querySelector(".timeline-list");
      const protocol = window.location.protocol;
      const hostname = window.location.hostname;
      if (
        target.ownerDocument !== document ||
        target.isConnected !== true ||
        !target.matches("a.timeline-tile") ||
        !timelineList?.contains(target)
      ) {
        invalidate("WRONG_TARGET");
        return status();
      }
      if (
        root?.isConnected !== true ||
        !root.contains(main) ||
        !rootParent ||
        !documentElement ||
        window.document !== document ||
        document.defaultView !== window ||
        window.performance !== performance ||
        !Number.isFinite(initialTimeOrigin)
      ) {
        invalidate("DOCUMENT_CHANGED");
        return status();
      }
      if (
        typeof initialPath !== "string" ||
        initialPath === expectedPath ||
        protocol !== "http:" ||
        (hostname !== "127.0.0.1" && hostname !== "localhost")
      ) {
        invalidate("WRONG_ROUTE");
        return status();
      }
      if (!pageIsVisible()) {
        invalidate("VISIBILITY_CHANGED");
        return status();
      }
      sameDocument = true;
      pathMatches = false;
      visible = true;
      observer = new window.MutationObserver(onMutations);
      observer.observe(root, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: [
          "data-first-ordinal",
          "data-last-ordinal",
          "data-moment-count",
          "hidden",
          "style",
          "class",
        ],
      });
      observer.observe(rootParent, { childList: true });
      if (documentElement !== rootParent) {
        observer.observe(documentElement, { childList: true });
      }
      installListener(document, "click", onClick, {
        capture: true,
        passive: true,
      });
      installListener(document, "auxclick", onAuxClick, {
        capture: true,
        passive: true,
      });
      installListener(document, "contextmenu", onContextMenu, {
        capture: true,
        passive: true,
      });
      installListener(document, "visibilitychange", onVisibilityChange, false);
      installListener(window, "resize", onResize, { passive: true });
      installListener(window, "pagehide", onPageHide, false);
      started = true;
      timeoutId = window.setTimeout(
        () => finish("timed-out", "TIMEOUT"),
        timeoutMs,
      );
      captureStartMarkerSeen = emitMarker(markerLabels.captureStart);
    } catch {
      invalidate("OBSERVER_ERROR");
    }
    return status();
  };

  const cancel = () => {
    if (state === "armed") finish("cancelled", "CANCELLED");
    return status();
  };

  const dispose = () => {
    if (state === "armed") finish("cancelled", "CANCELLED");
    else cleanup();
    return status();
  };

  return Object.freeze({ arm, status, cancel, dispose });
}

export function manualTimelineOpenObserverFunctionDeclaration() {
  return `function(config) {
  const createTimelineOpenObserver = ${createTimelineOpenObserver.toString()};
  return createTimelineOpenObserver({
    target: this,
    expectedPath: config && config.expectedPath,
    expectedItems: config && config.expectedItems,
    timeoutMs: config && config.timeoutMs
  });
}`;
}
