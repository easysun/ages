export function createClickCountCalibration(target, documentId) {
  if (
    typeof documentId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(documentId)
  ) {
    throw new Error("CALIBRATION_INVALID_DOCUMENT_ID");
  }

  let document;
  let window;
  let performance;
  let eventCounts;
  let initialParent;
  try {
    document = target?.ownerDocument;
    window = document?.defaultView;
    if (
      target?.nodeType !== 1 ||
      !document ||
      !window ||
      window.document !== document ||
      target.isConnected !== true
    ) {
      throw new Error();
    }
    initialParent = target.parentNode;
  } catch {
    throw new Error("CALIBRATION_TARGET_UNAVAILABLE");
  }

  let protocol;
  let hostname;
  try {
    protocol = window.location.protocol;
    hostname = window.location.hostname;
  } catch {
    throw new Error("CALIBRATION_ORIGIN_NOT_ALLOWED");
  }
  if (
    protocol !== "http:" ||
    (hostname !== "127.0.0.1" && hostname !== "localhost")
  ) {
    throw new Error("CALIBRATION_ORIGIN_NOT_ALLOWED");
  }

  try {
    if (document.visibilityState !== "visible" || document.hidden === true) {
      throw new Error();
    }
  } catch {
    throw new Error("CALIBRATION_NOT_VISIBLE");
  }

  try {
    performance = window.performance;
    eventCounts = performance?.eventCounts;
  } catch {
    throw new Error("CALIBRATION_COUNTER_UNAVAILABLE");
  }
  if (
    !performance ||
    !eventCounts ||
    typeof performance.now !== "function" ||
    typeof eventCounts.entries !== "function"
  ) {
    throw new Error("CALIBRATION_COUNTER_UNAVAILABLE");
  }

  const isSafeCounter = (value) => Number.isSafeInteger(value) && value >= 0;
  const isSafeTimestamp = (value) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0;
  const freezeSnapshot = (snapshot) => {
    Object.freeze(snapshot.counters);
    return Object.freeze(snapshot);
  };
  const readSnapshot = (sourcePerformance, sourceCounters) => {
    try {
      const timeOrigin = sourcePerformance.timeOrigin;
      const observedAt = sourcePerformance.now();
      const counters = {};
      let count = 0;
      let hasClick = false;
      for (const entry of sourceCounters.entries()) {
        if (!Array.isArray(entry) || entry.length !== 2) {
          return { kind: "invalid" };
        }
        const [key, value] = entry;
        if (
          typeof key !== "string" ||
          !/^[a-z][a-z0-9_-]{0,31}$/.test(key) ||
          Object.hasOwn(counters, key) ||
          !isSafeCounter(value)
        ) {
          return { kind: "invalid" };
        }
        count += 1;
        if (count > 64) return { kind: "invalid" };
        counters[key] = value;
        if (key === "click") hasClick = true;
      }
      if (
        !hasClick ||
        !isSafeTimestamp(timeOrigin) ||
        !isSafeTimestamp(observedAt)
      ) {
        return { kind: "invalid" };
      }
      return {
        kind: "ok",
        value: freezeSnapshot({ timeOrigin, observedAt, counters }),
      };
    } catch {
      return { kind: "read-failed" };
    }
  };

  const initial = readSnapshot(performance, eventCounts);
  if (initial.kind !== "ok") {
    throw new Error("CALIBRATION_COUNTER_INVALID");
  }
  const before = initial.value;
  const invalidReasons = new Set();
  const clicks = [];
  const installedListeners = [];
  let overflow = false;
  let cachedResult = null;

  const cleanup = () => {
    for (const [targetObject, type, listener, options] of installedListeners) {
      try {
        targetObject.removeEventListener(type, listener, options);
      } catch {
        // Listener cleanup is best-effort, and exception contents stay private.
      }
    }
    installedListeners.length = 0;
  };

  const install = (targetObject, type, listener, options) => {
    installedListeners.push([targetObject, type, listener, options]);
    targetObject.addEventListener(type, listener, options);
  };

  const onClick = (event) => {
    if (cachedResult) return;
    if (clicks.length === 2) {
      overflow = true;
      return;
    }

    let isTrusted = false;
    let targetMatched = false;
    let timeStamp = null;
    let observedAt = null;
    let invalidRecord = false;
    try {
      isTrusted = event.isTrusted === true;
      if (typeof event.isTrusted !== "boolean") invalidRecord = true;
      targetMatched = event.target === target;
      const suppliedTimeStamp = event.timeStamp;
      if (isSafeTimestamp(suppliedTimeStamp)) timeStamp = suppliedTimeStamp;
      else invalidRecord = true;
    } catch {
      invalidRecord = true;
    }
    try {
      const suppliedObservationTime = performance.now();
      if (isSafeTimestamp(suppliedObservationTime)) {
        observedAt = suppliedObservationTime;
      } else {
        invalidRecord = true;
      }
    } catch {
      invalidRecord = true;
    }
    if (invalidRecord) invalidReasons.add("EVENT_RECORD_INVALID");
    clicks.push({
      type: "click",
      isTrusted,
      targetMatched,
      timeStamp,
      observedAt,
    });
  };

  const onVisibilityChange = () => {
    try {
      if (document.visibilityState !== "visible" || document.hidden === true) {
        invalidReasons.add("VISIBILITY_CHANGED");
      }
    } catch {
      invalidReasons.add("VISIBILITY_CHANGED");
    }
  };

  const onPageHide = () => invalidReasons.add("DOCUMENT_CHANGED");

  try {
    install(document, "click", onClick, { capture: true, passive: true });
    install(document, "visibilitychange", onVisibilityChange, false);
    install(window, "pagehide", onPageHide, false);
  } catch {
    cleanup();
    throw new Error("CALIBRATION_INSTALL_FAILED");
  }

  const makeResult = (after, clickDelta) => {
    const reasons = new Set(invalidReasons);

    if (clicks.length === 0) reasons.add("CLICK_MISSING");
    if (clicks.length > 1 || overflow) reasons.add("EXTRA_CLICK");
    for (const click of clicks) {
      if (!click.isTrusted) reasons.add("UNTRUSTED_CLICK");
      if (!click.targetMatched) reasons.add("TARGET_MISMATCH");
    }

    let previousObservedAt = before.observedAt;
    for (const click of clicks) {
      if (
        click.timeStamp === null ||
        click.observedAt === null ||
        click.observedAt < previousObservedAt ||
        (after !== null && click.observedAt > after.observedAt)
      ) {
        reasons.add("EVENT_RECORD_INVALID");
      }
      if (click.observedAt !== null) previousObservedAt = click.observedAt;
    }
    if (
      clicks.length > 0 &&
      clickDelta !== null &&
      !overflow &&
      clickDelta !== clicks.length
    ) {
      reasons.add("CLICK_COUNTER_MISMATCH");
    }

    const sortedReasons = [...reasons].sort();
    const status = sortedReasons.length === 0 ? "collected" : "invalid";
    const frozenClicks = clicks.map((click) => Object.freeze({ ...click }));
    Object.freeze(frozenClicks);
    Object.freeze(sortedReasons);
    return Object.freeze({
      schemaVersion: 1,
      evidenceClass: "same-document-click-count-calibration",
      documentId,
      diagnosticOnly: true,
      formalStatus: "unavailable",
      status,
      reasons: sortedReasons,
      before,
      after,
      clickDelta,
      clicks: frozenClicks,
      overflow,
    });
  };

  const finalize = (aborted) => {
    if (cachedResult) return cachedResult;
    if (aborted) invalidReasons.add("ABORTED");

    let after = null;
    let clickDelta = null;
    if (!aborted) {
      let documentChanged = false;
      let countersChanged = false;
      try {
        if (window.document !== document || document.defaultView !== window) {
          invalidReasons.add("DOCUMENT_CHANGED");
          documentChanged = true;
        }
        if (window.performance !== performance) {
          invalidReasons.add("DOCUMENT_CHANGED");
          documentChanged = true;
        }
        if (performance.eventCounts !== eventCounts) {
          invalidReasons.add("COUNTER_SOURCE_CHANGED");
          countersChanged = true;
        }
      } catch {
        invalidReasons.add("DOCUMENT_CHANGED");
        documentChanged = true;
      }

      try {
        if (
          target.ownerDocument !== document ||
          target.isConnected !== true ||
          target.parentNode !== initialParent
        ) {
          invalidReasons.add("TARGET_CHANGED");
        }
      } catch {
        invalidReasons.add("TARGET_CHANGED");
      }
      try {
        if (
          document.visibilityState !== "visible" ||
          document.hidden === true
        ) {
          invalidReasons.add("VISIBILITY_CHANGED");
        }
      } catch {
        invalidReasons.add("VISIBILITY_CHANGED");
      }

      if (!documentChanged && !countersChanged) {
        const finalSnapshot = readSnapshot(performance, eventCounts);
        if (finalSnapshot.kind === "read-failed") {
          invalidReasons.add("COUNTER_READ_FAILED");
        } else if (finalSnapshot.kind !== "ok") {
          invalidReasons.add("COUNTER_INVALID");
        } else {
          const snapshot = finalSnapshot.value;
          const timeOriginMatches = snapshot.timeOrigin === before.timeOrigin;
          const clockIsMonotonic = snapshot.observedAt >= before.observedAt;
          if (!timeOriginMatches) {
            invalidReasons.add("DOCUMENT_CHANGED");
          }
          if (!clockIsMonotonic) {
            invalidReasons.add("COUNTER_INVALID");
          }
          const beforeKeys = Object.keys(before.counters).sort();
          const afterKeys = Object.keys(snapshot.counters).sort();
          const countersAreValid = !(
            beforeKeys.length !== afterKeys.length ||
            beforeKeys.some((key, index) => key !== afterKeys[index]) ||
            beforeKeys.some(
              (key) => snapshot.counters[key] < before.counters[key],
            )
          );
          if (!countersAreValid) {
            invalidReasons.add("COUNTER_INVALID");
          }
          if (clockIsMonotonic && countersAreValid) {
            after = snapshot;
            if (timeOriginMatches) {
              clickDelta = after.counters.click - before.counters.click;
            }
          }
        }
      }
    }

    try {
      cachedResult = makeResult(after, clickDelta);
      return cachedResult;
    } finally {
      cleanup();
    }
  };

  return Object.freeze({
    getBaseline: () => before,
    close: () => finalize(false),
    abort: () => finalize(true),
  });
}

export function clickCountCalibrationFunctionDeclaration() {
  return `function(documentId) {
  const createClickCountCalibration = ${createClickCountCalibration.toString()};
  return createClickCountCalibration(this, documentId);
}`;
}
