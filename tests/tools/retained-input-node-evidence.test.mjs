import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const DOC = "d-0123456789abcdef01234567";
const ROOT_FRAME = "root-frame-1";
const ROOT_LOADER = "root-loader-1";
const TARGET = "selected-target-1";
const TARGET_SESSION = "selected-session-1";
const CONTEXT = "unique-context-1";
const TOKEN = "t-0123456789abcdef01234567";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function validFrozenObservation(
  observer,
  { retainedReasonCode, recordLimit = false } = {},
) {
  let records = [
    {
      kind: "dom",
      documentId: DOC,
      type: "click",
      timeStamp: 12,
      isTrusted: true,
      targetToken: TOKEN,
      targetLabel: "open-primary",
      targetResolution: "registered-target",
      phase: "primary",
    },
  ];
  const payload = observer.createUnavailableRetainedNodeObservation(
    "OBSERVATION_DRAIN_FAILED",
    DOC,
    retainedReasonCode,
  );
  payload.status = "diagnostic";
  payload.reasonCode = null;
  payload.apiStatus = "thresholded";
  payload.records = records;
  payload.recordCount = records.length;
  payload.recordBytes = Buffer.byteLength(JSON.stringify(records));
  if (recordLimit) {
    records = Array.from({ length: 512 }, (_, index) => ({
      ...records[0],
      targetToken:
        index < 32
          ? `t-${index.toString(16).padStart(24, "0")}`
          : `t-${"0".repeat(24)}`,
    }));
    payload.status = "censored";
    payload.reasonCode = "OBSERVATION_RECORD_LIMIT_EXCEEDED";
    payload.records = records;
    payload.recordCount = records.length;
    payload.recordBytes = Buffer.byteLength(JSON.stringify(records));
  }
  payload.retainedNodeEvidence.scope = {
    rootIsSelectedDocument: true,
    pointerCaptureUncertain: false,
    shadowTreeUncertain: false,
  };
  return observer.validateTrustedStimulusObservation(payload, DOC);
}

class FakeSession extends EventEmitter {
  constructor(name, state, options = {}) {
    super();
    this.name = name;
    this.state = state;
    this.options = options;
    this.requests = [];
    this.pending = new Set();
    this.detachCount = 0;
    this.sessionId = name.startsWith("page")
      ? TARGET_SESSION
      : "browser-session-1";
    this._session = { _sessionId: this.sessionId };
  }

  send(method, params = {}) {
    this.requests.push({ method, params });
    this.state.log.push(`${this.name}:${method}`);
    this.options.onSend?.(this, method, params);

    if (this.options.rejectMethod === method) {
      return Promise.reject(new Error("SYNTHETIC_PROTOCOL_FAILURE"));
    }
    if (this.options.pendingMethod === method) {
      return new Promise((resolve, reject) => {
        const pending = { resolve, reject };
        this.pending.add(pending);
        this.options.onPending?.(pending);
      });
    }

    const response = (value) => {
      if (typeof this.options.afterResponse !== "function") {
        return Promise.resolve(value);
      }
      return Promise.resolve(value).then((result) => {
        this.options.afterResponse(this, method, result);
        return result;
      });
    };

    if (method === "Runtime.enable" && !this.state.runtimeEnabled) {
      this.state.runtimeEnabled = true;
      this.emit("Runtime.executionContextCreated", {
        context: {
          id: 1,
          uniqueId: CONTEXT,
          origin: "http://127.0.0.1",
          name: "",
          auxData: { isDefault: true, type: "default", frameId: ROOT_FRAME },
        },
      });
    }
    if (method === "Target.getTargetInfo") {
      return response({
        targetInfo: {
          targetId: TARGET,
          type: "page",
          browserContextId: "ctx-1",
        },
      });
    }
    if (method === "Target.getTargets") {
      return response({
        targetInfos: [
          { targetId: TARGET, type: "page", browserContextId: "ctx-1" },
        ],
      });
    }
    if (method === "Page.getFrameTree") {
      return response({
        frameTree: {
          frame: { id: ROOT_FRAME, loaderId: ROOT_LOADER },
        },
      });
    }
    if (method === "Runtime.evaluate") {
      const token = TOKEN;
      return response({
        result: {
          type: "object",
          subtype: "node",
          objectId: `remote-${token}`,
        },
      });
    }
    if (method === "DOM.describeNode") {
      return response({ node: { backendNodeId: 42 } });
    }
    if (method === "Tracing.end") {
      queueMicrotask(() =>
        this.emit("Tracing.tracingComplete", {
          stream: "trace-stream-1",
          dataLossOccurred: false,
        }),
      );
    }
    if (method === "IO.read") {
      return Promise.resolve({
        data: JSON.stringify({ traceEvents: [] }),
        base64Encoded: false,
        eof: true,
      });
    }
    return Promise.resolve({});
  }

  async detach() {
    this.detachCount += 1;
    this.state.log.push(`${this.name}:detach`);
    this.emit("close");
    for (const pending of this.pending) {
      pending.reject(new Error("SYNTHETIC_SESSION_DETACHED"));
    }
    this.pending.clear();
  }
}

class FakeLocator {
  constructor(page, name = "locator", click = null) {
    this.page = page;
    this.name = name;
    this.clickAction = click;
  }

  getByRole(role, options = {}) {
    return new FakeLocator(this.page, `${role}:${options.name ?? ""}`);
  }

  locator(selector) {
    return new FakeLocator(this.page, selector);
  }

  filter() {
    return this;
  }

  async waitFor() {
    return undefined;
  }

  async evaluate() {
    return true;
  }

  async click() {
    if (this.clickAction) return this.clickAction();
    return undefined;
  }
}

class FakePage extends EventEmitter {
  constructor(state, observer, options = {}) {
    super();
    this.state = state;
    this.observer = observer;
    this.options = options;
    this.routeHandler = null;
    this.response = deferred();
    this.initScripts = [];
    this.closed = false;
  }

  async addInitScript(_script, options) {
    this.initScripts.push(options ?? null);
  }

  async route(_pattern, handler) {
    this.routeHandler = handler;
  }

  async unroute() {
    if (this.options.unrouteBehavior === "reject") {
      throw new Error("SYNTHETIC_UNROUTE_FAILURE");
    }
    if (this.options.unrouteBehavior === "stall") {
      return new Promise(() => {});
    }
    this.routeHandler = null;
  }

  async goto() {
    if (this.options.setupFailure) throw new Error("SYNTHETIC_SETUP_FAILURE");
  }

  getByRole(role, options = {}) {
    const isPrimaryLink = role === "link";
    return new FakeLocator(
      this,
      `${role}:${options.name ?? ""}`,
      isPrimaryLink ? () => this.clickPrimary() : null,
    );
  }

  locator(selector) {
    return new FakeLocator(this, selector);
  }

  async evaluate(callback, argument) {
    const source = String(callback);
    if (source.includes("observer.arm()")) {
      this.state.log.push("observer:arm");
      if (this.options.armError) {
        throw new Error("SYNTHETIC_ARM_REJECTED");
      }
      if (this.options.armResult !== undefined) return this.options.armResult;
      return { status: "armed", documentId: DOC };
    }
    if (source.includes("observer.freeze(expected)")) {
      this.state.log.push("observer:drain-freeze");
      if (this.options.actionFailure) {
        this.state.actionFailureObservedAtFreeze = true;
      }
      return (
        this.options.frozenObservation?.(this.observer) ??
        validFrozenObservation(this.observer)
      );
    }
    if (source.includes("observer.clearRetainedNodes()")) {
      this.state.log.push("observer:clear-references");
      return {
        windowListenersRemoved: true,
        strongReferencesCleared: true,
      };
    }
    if (source.includes("observer.setPhase(")) return true;
    if (source.includes("observer.close()")) return undefined;
    if (source.includes("console.timeStamp")) return undefined;
    if (source.includes("innerWidth")) {
      return {
        innerWidth: 1280,
        innerHeight: 800,
        devicePixelRatio: 1,
        screenWidth: 1280,
        screenHeight: 800,
      };
    }
    return argument;
  }

  async waitForResponse() {
    return this.response.promise;
  }

  async close() {
    this.state.log.push("page:close");
    this.closed = true;
    this.emit("close");
  }

  async clickPrimary() {
    this.state.log.push("page:click-primary");
    if (this.options.actionFailure) {
      throw new Error("SYNTHETIC_ACTION_FAILURE");
    }
    this.options.beforeAction?.(this);
    const handler = this.routeHandler;
    if (handler) {
      void handler({
        request: () => ({
          url: () =>
            "http://127.0.0.1/api/timelines/timeline-1/overview?projection=chronological",
        }),
        continue: async () => {
          this.response.resolve({ ok: () => true });
        },
        abort: async () => undefined,
      });
    }
  }
}

function createHarness(options = {}) {
  const state = { log: [], runtimeEnabled: false };
  const observerPromise = import("../../scripts/browser-stimulus-observer.mjs");
  let page;
  let browser;
  let pageSession;
  let browserSession;
  return observerPromise.then((observer) => {
    page = new FakePage(state, observer, options);
    browser = new EventEmitter();
    browserSession = new FakeSession("browser-cdp", state, {
      rejectMethod: options.browserRejectMethod,
      pendingMethod: options.browserPendingMethod,
      onSend: options.onSend,
    });
    pageSession = new FakeSession("page-cdp", state, {
      rejectMethod: options.pageRejectMethod,
      pendingMethod: options.pagePendingMethod,
      onPending: options.onPending,
      onSend: options.onSend,
      afterResponse: options.afterResponse,
    });
    const context = {
      async newPage() {
        state.log.push("context:newPage");
        return page;
      },
      async newCDPSession(targetPage) {
        assert.equal(targetPage, page);
        state.log.push("context:newPageSession");
        return pageSession;
      },
      browser() {
        return browser;
      },
    };
    page.context = () => context;
    browser.newBrowserCDPSession = async () => {
      state.log.push("browser:newSession");
      return browserSession;
    };
    return {
      state,
      page,
      browser,
      pageSession,
      browserSession,
      context,
      observer,
    };
  });
}

function eventFor(name) {
  if (name === "Page.frameAttached") {
    return { frameId: "child-frame-1", parentFrameId: ROOT_FRAME };
  }
  if (name === "Page.frameStartedLoading") return { frameId: ROOT_FRAME };
  if (name === "Page.frameNavigated") {
    return {
      frame: { id: ROOT_FRAME, loaderId: "new-loader" },
      type: "Navigation",
    };
  }
  if (name === "Page.navigatedWithinDocument") {
    return {
      frameId: ROOT_FRAME,
      url: "https://private.invalid/other",
      navigationType: "historyApi",
    };
  }
  if (name === "Page.documentOpened") {
    return { frame: { id: ROOT_FRAME, loaderId: ROOT_LOADER } };
  }
  if (name === "Page.frameDetached")
    return { frameId: ROOT_FRAME, reason: "swap" };
  if (name === "Page.frameSubtreeWillBeDetached")
    return { frameId: ROOT_FRAME };
  if (name === "Page.backForwardCacheNotUsed") {
    return {
      frameId: ROOT_FRAME,
      loaderId: ROOT_LOADER,
      notRestoredExplanations: [],
    };
  }
  if (name === "Runtime.executionContextDestroyed") {
    return { executionContextId: 1, executionContextUniqueId: CONTEXT };
  }
  if (name === "Runtime.executionContextsCleared") return undefined;
  if (name === "Target.targetInfoChanged") {
    return { targetInfo: { targetId: TARGET, type: "page" } };
  }
  if (name === "Target.targetDestroyed") return { targetId: TARGET };
  if (name === "Target.targetCrashed") {
    return { targetId: TARGET, status: "crashed", errorCode: 1 };
  }
  if (name === "Target.attachedToTarget") {
    return {
      sessionId: "new-session",
      targetInfo: { targetId: TARGET, type: "page" },
      waitingForDebugger: false,
    };
  }
  if (name === "Target.detachedFromTarget")
    return { sessionId: TARGET_SESSION };
  if (name === "Inspector.targetCrashed") return undefined;
  if (name === "Inspector.detached") return { reason: "target_closed" };
  return {};
}

const ASYNC_LIFECYCLE_INJECTIONS = [
  ...[
    "Page.frameAttached",
    "Page.frameStartedLoading",
    "Page.frameNavigated",
    "Page.navigatedWithinDocument",
    "Page.documentOpened",
    "Page.backForwardCacheNotUsed",
    "Page.frameDetached",
    "Page.frameSubtreeWillBeDetached",
    "Runtime.executionContextDestroyed",
    "Runtime.executionContextsCleared",
    "Inspector.detached",
    "Inspector.targetCrashed",
  ].map((eventName) => ({ eventName, source: "pageSession" })),
  ...[
    "Target.targetInfoChanged",
    "Target.targetDestroyed",
    "Target.targetCrashed",
    "Target.attachedToTarget",
    "Target.detachedFromTarget",
  ].map((eventName) => ({ eventName, source: "browserSession" })),
  { eventName: "close", source: "page" },
  { eventName: "disconnected", source: "browser" },
  { eventName: "close", source: "pageSession" },
  { eventName: "close", source: "browserSession" },
  {
    eventName: "Runtime.executionContextCreated",
    source: "pageSession",
    payload: {
      context: {
        uniqueId: "another-default-context",
        auxData: { isDefault: true, type: "default", frameId: ROOT_FRAME },
      },
    },
  },
];

function injectLifecycle(harness, injection) {
  const emitter = harness[injection.source];
  const payload = injection.payload ?? eventFor(injection.eventName);
  emitter.emit(injection.eventName, payload);
}

async function loadTrackerModule() {
  return import("../../scripts/retained-input-node-evidence.mjs");
}

test("tracker establishes one default root context and maps only validated backend IDs", async () => {
  const harness = await createHarness();
  const { createRetainedInputNodeEvidenceTracker } = await loadTrackerModule();
  const tracker = createRetainedInputNodeEvidenceTracker({
    page: harness.page,
    pageSession: harness.pageSession,
    browserSession: harness.browserSession,
    timeoutMs: 100,
  });
  await tracker.start();
  await tracker.snapshot("beforeArm", null);
  await tracker.snapshot("afterArm", DOC);
  const mappings = await tracker.mapTargets(DOC, [TOKEN]);
  assert.deepEqual(mappings, [{ targetToken: TOKEN, backendNodeId: 42 }]);

  const evaluate = harness.pageSession.requests.find(
    ({ method }) => method === "Runtime.evaluate",
  );
  assert.match(evaluate.params.objectGroup, /^retained-input-node-[a-f0-9-]+$/);
  assert.deepEqual(evaluate.params, {
    expression: `globalThis.__agesTrustedStimulusObserver.getRetainedInputNode("${TOKEN}")`,
    uniqueContextId: CONTEXT,
    returnByValue: false,
    objectGroup: evaluate.params.objectGroup,
  });
  assert.deepEqual(
    harness.pageSession.requests.find(
      ({ method }) => method === "DOM.describeNode",
    ).params,
    { objectId: `remote-${TOKEN}`, depth: 0, pierce: false },
  );
  assert.deepEqual(
    harness.browserSession.requests.find(
      ({ method }) => method === "Target.setDiscoverTargets",
    ).params,
    { discover: true },
  );

  await tracker.snapshot("afterDrain", DOC);
  await tracker.snapshot("afterMapping", DOC);
  harness.state.log.push("observer:clear-references");
  const evidence = await tracker.finalize({
    documentId: DOC,
    scope: {
      rootIsSelectedDocument: true,
      pointerCaptureUncertain: false,
      shadowTreeUncertain: false,
    },
    observerCleanup: {
      windowListenersRemoved: true,
      strongReferencesCleared: true,
    },
  });
  assert.equal(evidence.status, "complete");
  assert.deepEqual(evidence.mappings, mappings);
  assert.equal(evidence.executionContext.uniqueId, CONTEXT);
  assert.equal(evidence.cleanup.objectGroupReleased, true);
  assert.equal(evidence.cleanup.cdpListenersRemoved, true);
  assert.equal(
    harness.pageSession.listenerCount("Runtime.executionContextCreated"),
    0,
  );
  assert.equal(
    harness.browserSession.listenerCount("Target.targetInfoChanged"),
    0,
  );
  await tracker.close();
  await tracker.close();
  assert.equal(harness.pageSession.detachCount, 1);
  assert.equal(harness.browserSession.detachCount, 1);
});

test("tracker installs every lifecycle listener before its first successful enable", async () => {
  let harness;
  harness = await createHarness({
    onSend(_session, method) {
      if (
        [
          "Page.enable",
          "Runtime.enable",
          "Inspector.enable",
          "Target.setDiscoverTargets",
        ].includes(method)
      ) {
        assert.ok(harness.page.listenerCount("close") > 0);
        assert.ok(harness.browser.listenerCount("disconnected") > 0);
        assert.ok(harness.pageSession.listenerCount("close") > 0);
        assert.ok(harness.browserSession.listenerCount("close") > 0);
        for (const event of [
          "Target.targetInfoChanged",
          "Target.targetDestroyed",
          "Target.targetCrashed",
          "Target.attachedToTarget",
          "Target.detachedFromTarget",
        ]) {
          assert.ok(harness.browserSession.listenerCount(event) > 0, event);
        }
        assert.ok(harness.pageSession.listenerCount("Page.frameNavigated") > 0);
        assert.ok(
          harness.pageSession.listenerCount(
            "Runtime.executionContextsCleared",
          ) > 0,
        );
      }
    },
  });
  const { createRetainedInputNodeEvidenceTracker } = await loadTrackerModule();
  const tracker = createRetainedInputNodeEvidenceTracker({
    page: harness.page,
    pageSession: harness.pageSession,
    browserSession: harness.browserSession,
    timeoutMs: 100,
  });
  await tracker.start();
  await tracker.close();
});

test("lifecycle loss interrupts a pending mapping and prevents a describe command", async () => {
  const pending = deferred();
  const harness = await createHarness({
    pagePendingMethod: "Runtime.evaluate",
    onPending({ resolve }) {
      pending.resolve(resolve);
    },
  });
  const { createRetainedInputNodeEvidenceTracker } = await loadTrackerModule();
  const tracker = createRetainedInputNodeEvidenceTracker({
    page: harness.page,
    pageSession: harness.pageSession,
    browserSession: harness.browserSession,
    timeoutMs: 100,
  });
  await tracker.start();
  const mapping = tracker.mapTargets(DOC, [TOKEN]);
  await pending.promise;
  harness.pageSession.emit("Page.frameStartedLoading", { frameId: ROOT_FRAME });
  await assert.rejects(mapping, /RETAINED_NODE_LIFECYCLE_INVALIDATED/);
  assert.equal(
    harness.pageSession.requests.some(
      ({ method }) => method === "DOM.describeNode",
    ),
    false,
  );
  await tracker.close();
  assert.equal(
    harness.pageSession.listenerCount("Page.frameStartedLoading"),
    0,
  );
  assert.equal(harness.browserSession.listenerCount("Target.targetCrashed"), 0);
});

test("tracker refuses more than 32 retained targets without mapping a prefix", async () => {
  const harness = await createHarness();
  const { createRetainedInputNodeEvidenceTracker } = await loadTrackerModule();
  const tracker = createRetainedInputNodeEvidenceTracker({
    page: harness.page,
    pageSession: harness.pageSession,
    browserSession: harness.browserSession,
    timeoutMs: 100,
  });
  await tracker.start();
  const tokens = Array.from(
    { length: 33 },
    (_, index) => `t-${index.toString(16).padStart(24, "0")}`,
  );
  await assert.rejects(
    tracker.mapTargets(DOC, tokens),
    /RETAINED_NODE_LIMIT_EXCEEDED/,
  );
  assert.equal(
    harness.pageSession.requests.some(
      ({ method }) => method === "Runtime.evaluate",
    ),
    false,
  );
  await tracker.close();
});

test("page, browser, and both session disconnects permanently invalidate mapping", async (t) => {
  const cases = [
    ["page close", (harness) => harness.page.emit("close")],
    ["browser disconnect", (harness) => harness.browser.emit("disconnected")],
    ["page session close", (harness) => harness.pageSession.emit("close")],
    [
      "browser session close",
      (harness) => harness.browserSession.emit("close"),
    ],
  ];
  for (const [name, disconnect] of cases) {
    await t.test(name, async () => {
      const harness = await createHarness();
      const { createRetainedInputNodeEvidenceTracker } =
        await loadTrackerModule();
      const tracker = createRetainedInputNodeEvidenceTracker({
        page: harness.page,
        pageSession: harness.pageSession,
        browserSession: harness.browserSession,
        timeoutMs: 100,
      });
      await tracker.start();
      disconnect(harness);
      await assert.rejects(
        tracker.mapTargets(DOC, [TOKEN]),
        /RETAINED_NODE_LIFECYCLE_INVALIDATED/,
      );
      assert.equal(
        harness.pageSession.requests.some(
          ({ method }) => method === "Runtime.evaluate",
        ),
        false,
      );
      await tracker.close();
    });
  }
});

test("every pinned lifecycle event invalidates selected evidence before mapping", async (t) => {
  const cases = [
    "Page.frameStartedLoading",
    "Page.frameNavigated",
    "Page.navigatedWithinDocument",
    "Page.documentOpened",
    "Page.backForwardCacheNotUsed",
    "Page.frameDetached",
    "Page.frameSubtreeWillBeDetached",
    "Runtime.executionContextDestroyed",
    "Runtime.executionContextsCleared",
    "Target.targetInfoChanged",
    "Target.targetDestroyed",
    "Target.targetCrashed",
    "Target.attachedToTarget",
    "Target.detachedFromTarget",
    "Inspector.targetCrashed",
  ];
  for (const eventName of cases) {
    await t.test(eventName, async () => {
      const harness = await createHarness();
      const { createRetainedInputNodeEvidenceTracker } =
        await loadTrackerModule();
      const tracker = createRetainedInputNodeEvidenceTracker({
        page: harness.page,
        pageSession: harness.pageSession,
        browserSession: harness.browserSession,
        timeoutMs: 100,
      });
      await tracker.start();
      const session = eventName.startsWith("Target.")
        ? harness.browserSession
        : harness.pageSession;
      session.emit(eventName, eventFor(eventName));
      await assert.rejects(
        tracker.mapTargets(DOC, [TOKEN]),
        /RETAINED_NODE_LIFECYCLE_INVALIDATED/,
      );
      assert.equal(
        harness.pageSession.requests.some(
          ({ method }) => method === "Runtime.evaluate",
        ),
        false,
      );
      await tracker.close();
      assert.equal(harness.pageSession.eventNames().length, 0);
      assert.equal(harness.browserSession.eventNames().length, 0);
    });
  }
});

test("ambiguous browser-target lifecycle payloads invalidate evidence", async (t) => {
  const cases = [
    ["Target.targetInfoChanged", { targetInfo: { type: "page" } }],
    ["Target.targetDestroyed", {}],
    ["Target.targetCrashed", { status: "crashed" }],
    [
      "Target.attachedToTarget",
      { sessionId: "other-session", targetInfo: { type: "page" } },
    ],
    ["Target.detachedFromTarget", { sessionId: "other-session" }],
  ];
  for (const [eventName, payload] of cases) {
    await t.test(eventName, async () => {
      const harness = await createHarness();
      const { createRetainedInputNodeEvidenceTracker } =
        await loadTrackerModule();
      const tracker = createRetainedInputNodeEvidenceTracker({
        page: harness.page,
        pageSession: harness.pageSession,
        browserSession: harness.browserSession,
        timeoutMs: 100,
      });
      try {
        await tracker.start();
        harness.browserSession.emit(eventName, payload);
        assert.equal(tracker.isAvailable(), false);
        await assert.rejects(
          tracker.mapTargets(DOC, [TOKEN]),
          /RETAINED_NODE_LIFECYCLE_INVALIDATED/,
        );
        assert.equal(
          harness.pageSession.requests.some(
            ({ method }) => method === "Runtime.evaluate",
          ),
          false,
        );
      } finally {
        await tracker.close();
      }
    });
  }
});

test("real captureCase composes drain, mapping, clear, release, final snapshot, and close", async () => {
  const harness = await createHarness();
  const runner = await import(
    "../../scripts/capture-chromium-method-pilot.mjs"
  );
  assert.equal(typeof runner.captureCase, "function");
  const runDirectory = mkdtempSync(join(tmpdir(), "retained-input-case-"));
  try {
    await runner.captureCase(
      harness.context,
      { workload: "100-interactive", action: "open" },
      "timeline-1",
      "http://127.0.0.1/timelines",
      runDirectory,
      ["devtools.timeline"],
      100,
      true,
      true,
    );
    const order = harness.state.log;
    const sidecar = JSON.parse(
      readFileSync(
        join(runDirectory, "100-interactive-open.stimulus.json"),
        "utf8",
      ),
    );
    const index = (entry) => order.indexOf(entry);
    assert.ok(index("observer:drain-freeze") >= 0);
    assert.ok(
      index("page-cdp:Runtime.evaluate") > index("observer:drain-freeze"),
    );
    assert.ok(
      index("observer:clear-references") > index("page-cdp:DOM.describeNode"),
    );
    assert.ok(
      index("page-cdp:Runtime.releaseObjectGroup") >
        index("observer:clear-references"),
    );
    assert.ok(
      order.lastIndexOf("page-cdp:Page.getFrameTree") >
        index("page-cdp:Runtime.releaseObjectGroup"),
    );
    assert.ok(
      index("browser-cdp:detach") >
        index("browser-cdp:Target.setDiscoverTargets"),
    );
    assert.ok(index("page:close") > index("page-cdp:detach"));
    assert.equal(sidecar.observation.schemaVersion, 2);
    assert.equal(sidecar.observation.retainedNodeEvidence.status, "complete");
    assert.deepEqual(sidecar.observation.retainedNodeEvidence.mappings, [
      { targetToken: TOKEN, backendNodeId: 42 },
    ]);
    assert.equal(harness.pageSession.eventNames().length, 0);
    assert.equal(harness.browserSession.eventNames().length, 0);
    assert.equal(harness.page.listenerCount("close"), 0);
    assert.equal(harness.browser.listenerCount("disconnected"), 0);
  } finally {
    rmSync(runDirectory, { recursive: true, force: true });
  }
});

test("real captureCase writes version-correct unavailable observations after arm failures", async (t) => {
  const armFailures = [
    {
      name: "arm returns unavailable",
      options: {
        armResult: {
          status: "unavailable",
          reasonCode: "OBSERVATION_DRAIN_FAILED",
        },
      },
    },
    {
      name: "arm operation rejects",
      options: { armError: true },
    },
  ];

  for (const armFailure of armFailures) {
    for (const retainInputNodes of [true, false]) {
      await t.test(
        `${armFailure.name}; retained=${retainInputNodes}`,
        async () => {
          const harness = await createHarness(armFailure.options);
          const runner = await import(
            "../../scripts/capture-chromium-method-pilot.mjs"
          );
          const runDirectory = mkdtempSync(
            join(tmpdir(), "retained-input-arm-failure-"),
          );
          try {
            const result = await runner.captureCase(
              harness.context,
              { workload: "100-interactive", action: "open" },
              "timeline-1",
              "http://127.0.0.1/timelines",
              runDirectory,
              ["devtools.timeline"],
              100,
              true,
              retainInputNodes,
            );
            const sidecarPath = join(
              runDirectory,
              "100-interactive-open.stimulus.json",
            );
            const sidecarBytes = readFileSync(sidecarPath);
            const sidecar = JSON.parse(sidecarBytes.toString("utf8"));

            assert.ok(harness.state.log.includes("page:click-primary"));
            assert.ok(harness.state.log.includes("page-cdp:Tracing.start"));
            assert.ok(harness.state.log.includes("page-cdp:Tracing.end"));
            assert.ok(result.traceRecord);
            assert.equal(result.traceRecord.dataLossOccurred, false);
            assert.equal(sidecar.schemaVersion, retainInputNodes ? 2 : 1);
            assert.equal(
              sidecar.observation.schemaVersion,
              retainInputNodes ? 2 : 1,
            );
            assert.equal(
              Object.hasOwn(sidecar.observation, "retainedNodeEvidence"),
              retainInputNodes,
            );
            assert.equal(
              result.caseRecord.trustedStimulusObservation.byteCount,
              sidecarBytes.byteLength,
            );
            assert.equal(
              result.caseRecord.trustedStimulusObservation.fileName,
              "100-interactive-open.stimulus.json",
            );
            assert.equal(
              result.caseRecord.trustedStimulusObservation.sha256,
              createHash("sha256").update(sidecarBytes).digest("hex"),
            );

            if (retainInputNodes) {
              const evidence = sidecar.observation.retainedNodeEvidence;
              assert.equal(evidence.status, "unavailable");
              assert.ok(
                Object.values(evidence.cleanup).every(
                  (value) => value === null || typeof value === "boolean",
                ),
              );
              assert.ok(
                harness.state.log.includes("observer:clear-references"),
              );
              assert.equal(
                harness.pageSession.requests.some(({ method }) =>
                  ["Runtime.evaluate", "DOM.describeNode"].includes(method),
                ),
                false,
              );
              assert.equal(harness.pageSession.detachCount, 1);
              assert.equal(harness.browserSession.detachCount, 1);
              assert.equal(harness.pageSession.eventNames().length, 0);
              assert.equal(harness.browserSession.eventNames().length, 0);
              assert.equal(harness.page.listenerCount("close"), 0);
              assert.equal(harness.browser.listenerCount("disconnected"), 0);

              assert.throws(
                () => writeFileSync(sidecarPath, "{}", { flag: "wx" }),
                { code: "EEXIST" },
              );
              assert.equal(
                readFileSync(sidecarPath).equals(sidecarBytes),
                true,
              );
            }
          } finally {
            rmSync(runDirectory, { recursive: true, force: true });
          }
        },
      );
    }
  }
});

test("real collector disposes frame-provenance listeners after pre-drain retention loss", async () => {
  let harness;
  harness = await createHarness({
    beforeAction: () =>
      harness.pageSession.emit("Page.frameStartedLoading", {
        frameId: ROOT_FRAME,
      }),
  });
  const runner = await import(
    "../../scripts/capture-chromium-method-pilot.mjs"
  );
  const runDirectory = mkdtempSync(
    join(tmpdir(), "retained-input-pre-drain-loss-"),
  );
  try {
    await runner.captureCase(
      harness.context,
      { workload: "100-interactive", action: "open" },
      "timeline-1",
      "http://127.0.0.1/timelines",
      runDirectory,
      ["devtools.timeline"],
      100,
      true,
      true,
    );
    for (const eventName of [
      "Page.frameNavigated",
      "Page.frameDetached",
      "Runtime.executionContextsCleared",
      "Inspector.detached",
      "Inspector.targetCrashed",
      "close",
    ]) {
      assert.equal(
        harness.pageSession.listenerCount(eventName),
        0,
        `orphaned frame-provenance listener for ${eventName}`,
      );
    }
  } finally {
    rmSync(runDirectory, { recursive: true, force: true });
  }
});

test("real collector closes owned sessions after route cleanup rejects or stalls", async (t) => {
  for (const behavior of ["reject", "stall"]) {
    await t.test(behavior, async () => {
      const harness = await createHarness({ unrouteBehavior: behavior });
      const runner = await import(
        "../../scripts/capture-chromium-method-pilot.mjs"
      );
      const runDirectory = mkdtempSync(
        join(tmpdir(), `retained-input-route-${behavior}-`),
      );
      try {
        await runner.captureCase(
          harness.context,
          { workload: "100-interactive", action: "open" },
          "timeline-1",
          "http://127.0.0.1/timelines",
          runDirectory,
          ["devtools.timeline"],
          100,
          true,
          true,
        );
        assert.equal(harness.pageSession.detachCount, 1);
        assert.equal(harness.browserSession.detachCount, 1);
        assert.equal(harness.pageSession.eventNames().length, 0);
        assert.equal(harness.browserSession.eventNames().length, 0);
        assert.equal(harness.page.listenerCount("close"), 0);
        assert.equal(harness.browser.listenerCount("disconnected"), 0);
      } finally {
        rmSync(runDirectory, { recursive: true, force: true });
      }
    });
  }
});

test("real collector preserves retained-node overflow when the record limit rejects another target", async () => {
  const harness = await createHarness({
    frozenObservation: (observer) =>
      validFrozenObservation(observer, {
        retainedReasonCode: "RETAINED_NODE_LIMIT_EXCEEDED",
        recordLimit: true,
      }),
  });
  const runner = await import(
    "../../scripts/capture-chromium-method-pilot.mjs"
  );
  const runDirectory = mkdtempSync(
    join(tmpdir(), "retained-input-combined-overflow-"),
  );
  try {
    await runner.captureCase(
      harness.context,
      { workload: "100-interactive", action: "open" },
      "timeline-1",
      "http://127.0.0.1/timelines",
      runDirectory,
      ["devtools.timeline"],
      100,
      true,
      true,
    );
    const sidecar = JSON.parse(
      readFileSync(
        join(runDirectory, "100-interactive-open.stimulus.json"),
        "utf8",
      ),
    );
    assert.equal(sidecar.observation.status, "censored");
    assert.equal(
      sidecar.observation.reasonCode,
      "OBSERVATION_RECORD_LIMIT_EXCEEDED",
    );
    assert.equal(sidecar.observation.recordCount, 512);
    assert.equal(
      sidecar.observation.retainedNodeEvidence.status,
      "unavailable",
    );
    assert.equal(
      sidecar.observation.retainedNodeEvidence.reasonCode,
      "RETAINED_NODE_LIMIT_EXCEEDED",
    );
    assert.equal(
      harness.pageSession.requests.some(
        ({ method }) => method === "Runtime.evaluate",
      ),
      false,
    );
  } finally {
    rmSync(runDirectory, { recursive: true, force: true });
  }
});

test("collector leaves the retained path disabled and preserves page-session close order", async () => {
  const harness = await createHarness();
  const runner = await import(
    "../../scripts/capture-chromium-method-pilot.mjs"
  );
  assert.equal(typeof runner.captureCase, "function");
  const runDirectory = mkdtempSync(join(tmpdir(), "retained-input-disabled-"));
  try {
    await runner.captureCase(
      harness.context,
      { workload: "100-interactive", action: "open" },
      "timeline-1",
      "http://127.0.0.1/timelines",
      runDirectory,
      ["devtools.timeline"],
      100,
      false,
      false,
    );
    assert.equal(harness.state.log.includes("browser:newSession"), false);
    assert.equal(harness.state.log.includes("observer:drain-freeze"), false);
    assert.equal(
      harness.pageSession.requests.some(({ method }) =>
        [
          "Runtime.evaluate",
          "DOM.describeNode",
          "Runtime.releaseObjectGroup",
        ].includes(method),
      ),
      false,
    );
    assert.ok(
      harness.state.log.indexOf("page-cdp:detach") <
        harness.state.log.indexOf("page:close"),
    );
  } finally {
    rmSync(runDirectory, { recursive: true, force: true });
  }
});

test("collector performs bounded cleanup after setup, action, and tracker startup failures", async (t) => {
  const cases = [
    { name: "setup", options: { setupFailure: true }, expectTracker: false },
    { name: "action", options: { actionFailure: true }, expectTracker: true },
    {
      name: "startup",
      options: { pageRejectMethod: "Inspector.enable" },
      expectTracker: true,
    },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const harness = await createHarness(entry.options);
      const runner = await import(
        "../../scripts/capture-chromium-method-pilot.mjs"
      );
      assert.equal(typeof runner.captureCase, "function");
      const runDirectory = mkdtempSync(
        join(tmpdir(), "retained-input-failure-"),
      );
      try {
        const result = await runner.captureCase(
          harness.context,
          { workload: "100-interactive", action: "open" },
          "timeline-1",
          "http://127.0.0.1/timelines",
          runDirectory,
          ["devtools.timeline"],
          100,
          true,
          true,
        );
        assert.equal(result.caseRecord.measurementStatus, "unavailable");
        assert.equal(harness.pageSession.eventNames().length, 0);
        assert.equal(harness.browserSession.eventNames().length, 0);
        assert.equal(harness.page.listenerCount("close"), 0);
        assert.equal(harness.browser.listenerCount("disconnected"), 0);
        assert.equal(
          harness.state.log.includes("browser:newSession"),
          entry.expectTracker,
        );
        if (entry.name === "action") {
          assert.equal(harness.state.actionFailureObservedAtFreeze, true);
          assert.ok(harness.state.log.includes("observer:clear-references"));
          assert.ok(
            harness.state.log.includes("page-cdp:Runtime.releaseObjectGroup"),
          );
        }
      } finally {
        rmSync(runDirectory, { recursive: true, force: true });
      }
    });
  }
});

test("real collector stops mapping and final snapshots after asynchronous lifecycle loss", async (t) => {
  for (const boundary of ["mapping", "after-node", "cleanup"]) {
    await t.test(boundary, async () => {
      const harness = await createHarness({
        onSend(session, method) {
          if (
            session.name !== "page-cdp" ||
            (boundary === "cleanup" && method !== "Runtime.releaseObjectGroup")
          ) {
            return;
          }
          if (boundary === "cleanup") {
            session.emit("Runtime.executionContextsCleared");
          }
        },
        afterResponse(session, method) {
          if (
            session.name !== "page-cdp" ||
            boundary === "cleanup" ||
            (boundary === "mapping" && method !== "Runtime.evaluate") ||
            (boundary === "after-node" && method !== "DOM.describeNode")
          ) {
            return;
          }
          session.emit("Page.frameStartedLoading", { frameId: ROOT_FRAME });
        },
      });
      const pageSession = harness.pageSession;
      const runner = await import(
        "../../scripts/capture-chromium-method-pilot.mjs"
      );
      const runDirectory = mkdtempSync(
        join(tmpdir(), `retained-input-${boundary}-`),
      );
      try {
        await runner.captureCase(
          harness.context,
          { workload: "100-interactive", action: "open" },
          "timeline-1",
          "http://127.0.0.1/timelines",
          runDirectory,
          ["devtools.timeline"],
          100,
          true,
          true,
        );
        const evidence = JSON.parse(
          readFileSync(
            join(runDirectory, "100-interactive-open.stimulus.json"),
            "utf8",
          ),
        ).observation.retainedNodeEvidence;
        assert.equal(evidence.status, "unavailable");
        assert.equal(evidence.lifecycle.coverage, "incomplete");
        assert.equal(
          pageSession.requests.some(
            ({ method }) => method === "DOM.describeNode",
          ),
          boundary !== "mapping",
        );
        const releaseIndex = pageSession.requests.findIndex(
          ({ method }) => method === "Runtime.releaseObjectGroup",
        );
        if (boundary !== "cleanup") {
          assert.equal(releaseIndex, -1);
          if (boundary === "after-node") {
            const describeIndex = pageSession.requests.findIndex(
              ({ method }) => method === "DOM.describeNode",
            );
            assert.ok(describeIndex >= 0);
            assert.equal(
              pageSession.requests
                .slice(describeIndex + 1)
                .some(({ method }) => method === "Page.getFrameTree"),
              false,
            );
          }
        } else {
          assert.ok(releaseIndex >= 0);
          assert.equal(
            pageSession.requests
              .slice(releaseIndex + 1)
              .some(({ method }) => method === "Page.getFrameTree"),
            false,
          );
        }
        assert.equal(harness.pageSession.eventNames().length, 0);
        assert.equal(harness.browserSession.eventNames().length, 0);
        assert.equal(harness.page.listenerCount("close"), 0);
        assert.equal(harness.browser.listenerCount("disconnected"), 0);
      } finally {
        rmSync(runDirectory, { recursive: true, force: true });
      }
    });
  }
});

test("real collector rejects every lifecycle loss during mapping and object-group cleanup", async (t) => {
  for (const boundary of ["mapping", "cleanup"]) {
    for (const injection of ASYNC_LIFECYCLE_INJECTIONS) {
      await t.test(
        `${boundary}:${injection.source}:${injection.eventName}`,
        async () => {
          let harness;
          let injected = false;
          const trigger = () => {
            if (injected) return;
            injected = true;
            injectLifecycle(harness, injection);
          };
          harness = await createHarness({
            onSend(session, method) {
              if (
                boundary === "cleanup" &&
                session.name === "page-cdp" &&
                method === "Runtime.releaseObjectGroup"
              ) {
                trigger();
              }
            },
            afterResponse(session, method) {
              if (
                boundary === "mapping" &&
                session.name === "page-cdp" &&
                method === "Runtime.evaluate"
              ) {
                trigger();
              }
            },
          });
          const runner = await import(
            "../../scripts/capture-chromium-method-pilot.mjs"
          );
          const runDirectory = mkdtempSync(
            join(tmpdir(), "retained-input-lifecycle-"),
          );
          try {
            await runner.captureCase(
              harness.context,
              { workload: "100-interactive", action: "open" },
              "timeline-1",
              "http://127.0.0.1/timelines",
              runDirectory,
              ["devtools.timeline"],
              100,
              true,
              true,
            );
            const evidence = JSON.parse(
              readFileSync(
                join(runDirectory, "100-interactive-open.stimulus.json"),
                "utf8",
              ),
            ).observation.retainedNodeEvidence;
            assert.equal(injected, true);
            assert.equal(evidence.status, "unavailable");
            assert.equal(evidence.lifecycle.coverage, "incomplete");
            const pageRequests = harness.pageSession.requests;
            const releaseIndex = pageRequests.findIndex(
              ({ method }) => method === "Runtime.releaseObjectGroup",
            );
            if (boundary === "mapping") {
              assert.equal(
                pageRequests.some(
                  ({ method }) => method === "DOM.describeNode",
                ),
                false,
              );
              assert.equal(releaseIndex, -1);
            } else {
              assert.ok(
                pageRequests.some(
                  ({ method }) => method === "DOM.describeNode",
                ),
              );
              assert.ok(releaseIndex >= 0);
              assert.equal(
                pageRequests
                  .slice(releaseIndex + 1)
                  .some(({ method }) => method === "Page.getFrameTree"),
                false,
              );
            }
            assert.equal(harness.pageSession.eventNames().length, 0);
            assert.equal(harness.browserSession.eventNames().length, 0);
            assert.equal(harness.page.listenerCount("close"), 0);
            assert.equal(harness.browser.listenerCount("disconnected"), 0);
          } finally {
            rmSync(runDirectory, { recursive: true, force: true });
          }
        },
      );
    }
  }
});

test("real collector cancels pending mapping on page-session loss and settles cleanup", async () => {
  const mappingPending = deferred();
  const harness = await createHarness({
    pagePendingMethod: "Runtime.evaluate",
    onPending({ reject }) {
      mappingPending.resolve(reject);
    },
  });
  const runner = await import(
    "../../scripts/capture-chromium-method-pilot.mjs"
  );
  const runDirectory = mkdtempSync(join(tmpdir(), "retained-input-cancel-"));
  try {
    const capture = runner.captureCase(
      harness.context,
      { workload: "100-interactive", action: "open" },
      "timeline-1",
      "http://127.0.0.1/timelines",
      runDirectory,
      ["devtools.timeline"],
      100,
      true,
      true,
    );
    await mappingPending.promise;
    harness.pageSession.emit("close");
    await capture;
    const sidecar = JSON.parse(
      readFileSync(
        join(runDirectory, "100-interactive-open.stimulus.json"),
        "utf8",
      ),
    );
    assert.equal(
      sidecar.observation.retainedNodeEvidence.status,
      "unavailable",
    );
    assert.equal(
      harness.pageSession.requests.some(
        ({ method }) => method === "DOM.describeNode",
      ),
      false,
    );
    assert.equal(
      harness.pageSession.requests.some(
        ({ method }) => method === "Runtime.releaseObjectGroup",
      ),
      false,
    );
    assert.equal(harness.pageSession.eventNames().length, 0);
    assert.equal(harness.browserSession.eventNames().length, 0);
    assert.equal(harness.page.listenerCount("close"), 0);
    assert.equal(harness.browser.listenerCount("disconnected"), 0);
  } finally {
    rmSync(runDirectory, { recursive: true, force: true });
  }
});
