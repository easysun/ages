import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { chromium } from "playwright";
import {
  clickCountCalibrationFunctionDeclaration,
  createClickCountCalibration,
} from "../../scripts/click-count-calibration.mjs";

class ControlledEventTarget {
  listeners = new Map();
  failOnType = null;

  addEventListener(type, callback, options) {
    if (type === this.failOnType) throw new Error("private install failure");
    const listeners = this.listeners.get(type) ?? [];
    listeners.push({ callback, options });
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, callback) {
    const listeners = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      listeners.filter((listener) => listener.callback !== callback),
    );
  }

  dispatchEvent(event) {
    for (const { callback } of [...(this.listeners.get(event.type) ?? [])]) {
      callback.call(this, event);
    }
  }

  listenerCount() {
    return [...this.listeners.values()].reduce(
      (total, listeners) => total + listeners.length,
      0,
    );
  }
}

function makeCounters(initialEntries) {
  const values = new Map(initialEntries);
  let readFailure = false;
  const source = {
    get size() {
      return values.size;
    },
    entries() {
      if (readFailure) throw new Error("private counter failure");
      return values.entries();
    },
  };
  return {
    source,
    values,
    setReadFailure(value) {
      readFailure = value;
    },
  };
}

function createFixture({
  counterEntries = [
    ["click", 10],
    ["pointerdown", 3],
    ["keydown", 0],
  ],
  hostname = "127.0.0.1",
  protocol = "http:",
  visible = true,
  connected = true,
} = {}) {
  const document = new ControlledEventTarget();
  const window = new ControlledEventTarget();
  const counters = makeCounters(counterEntries);
  let clock = 10;
  const performance = {
    timeOrigin: 1000,
    now: () => clock,
    eventCounts: counters.source,
  };
  const parent = {};
  const target = {
    nodeType: 1,
    ownerDocument: document,
    isConnected: connected,
    parentNode: parent,
  };
  const foreignTarget = {
    nodeType: 1,
    ownerDocument: document,
    isConnected: true,
    parentNode: parent,
  };
  Object.assign(document, {
    defaultView: window,
    visibilityState: visible ? "visible" : "hidden",
    hidden: !visible,
  });
  Object.assign(window, {
    document,
    performance,
    location: { protocol, hostname },
  });

  return {
    document,
    window,
    performance,
    counters,
    target,
    foreignTarget,
    parent,
    listenerCount: () => document.listenerCount() + window.listenerCount(),
    setClock(value) {
      clock = value;
    },
    getClock() {
      return clock;
    },
    dispatchClick({
      target: eventTarget = target,
      isTrusted = true,
      timeStamp = 7,
    } = {}) {
      document.dispatchEvent({
        type: "click",
        target: eventTarget,
        isTrusted,
        timeStamp,
      });
    },
    incrementClick(amount = 1) {
      counters.values.set("click", counters.values.get("click") + amount);
    },
  };
}

function reasonCodes(result) {
  return result.reasons;
}

test("trusted exact-target click collects one immutable bounded baseline delta", () => {
  const fixture = createFixture();
  const collector = createClickCountCalibration(fixture.target, "doc-1");
  const baseline = collector.getBaseline();

  assert.equal(fixture.listenerCount(), 3);
  assert.equal(baseline.observedAt, 10);
  assert.equal(baseline.counters.click, 10);
  assert.ok(Object.isFrozen(baseline));
  assert.ok(Object.isFrozen(baseline.counters));

  fixture.dispatchClick({ timeStamp: 5000 });
  fixture.incrementClick();
  fixture.setClock(10);
  const result = collector.close();

  assert.equal(result.schemaVersion, 1);
  assert.equal(result.evidenceClass, "same-document-click-count-calibration");
  assert.equal(result.documentId, "doc-1");
  assert.equal(result.status, "collected");
  assert.equal(result.clickDelta, 1);
  assert.equal(result.diagnosticOnly, true);
  assert.equal(result.formalStatus, "unavailable");
  assert.deepEqual(reasonCodes(result), []);
  assert.deepEqual(Object.keys(result).sort(), [
    "after",
    "before",
    "clickDelta",
    "clicks",
    "diagnosticOnly",
    "documentId",
    "evidenceClass",
    "formalStatus",
    "overflow",
    "reasons",
    "schemaVersion",
    "status",
  ]);
  assert.equal(result.before, baseline);
  assert.equal(result.clicks.length, 1);
  assert.deepEqual(result.clicks[0], {
    type: "click",
    isTrusted: true,
    targetMatched: true,
    timeStamp: 5000,
    observedAt: 10,
  });
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.reasons));
  assert.ok(Object.isFrozen(result.before.counters));
  assert.ok(Object.isFrozen(result.after.counters));
  assert.ok(Object.isFrozen(result.clicks));
  assert.ok(Object.isFrozen(result.clicks[0]));
  assert.equal(collector.getBaseline(), baseline);
  assert.equal(collector.close(), result);
  assert.equal(collector.abort(), result);
  assert.equal(fixture.listenerCount(), 0);
});

test("document identity and finalization failures never read replacement counters", async (t) => {
  const cases = [
    ["document replacement", "DOCUMENT_CHANGED", "document"],
    ["performance replacement", "DOCUMENT_CHANGED", "performance"],
    ["counter replacement", "COUNTER_SOURCE_CHANGED", "counters"],
  ];

  for (const [name, reason, replacement] of cases) {
    await t.test(name, () => {
      const fixture = createFixture();
      const originalEntries = fixture.counters.values.entries;
      let originalReads = 0;
      fixture.counters.source.entries = function entries() {
        originalReads += 1;
        return originalEntries.call(fixture.counters.values);
      };
      const collector = createClickCountCalibration(fixture.target, "doc-2");
      assert.equal(originalReads, 1);

      let replacementReads = 0;
      const replacementCounters = {
        size: 1,
        entries() {
          replacementReads += 1;
          return [["click", 999]][Symbol.iterator]();
        },
      };
      if (replacement === "document") {
        fixture.window.document = new ControlledEventTarget();
        fixture.window.document.defaultView = fixture.window;
      } else if (replacement === "performance") {
        fixture.window.performance = {
          timeOrigin: 2000,
          now: () => 20,
          eventCounts: replacementCounters,
        };
      } else {
        fixture.performance.eventCounts = replacementCounters;
      }

      const result = collector.close();
      assert.equal(result.status, "invalid");
      assert.ok(reasonCodes(result).includes(reason));
      assert.equal(result.after, null);
      assert.equal(result.clickDelta, null);
      assert.equal(originalReads, 1);
      assert.equal(replacementReads, 0);
      assert.equal(fixture.listenerCount(), 0);
    });
  }
});

test("untrusted and foreign-target clicks cannot produce a collected result", async (t) => {
  const cases = [
    ["untrusted click", { isTrusted: false }, "UNTRUSTED_CLICK"],
    ["foreign target", { target: "foreignTarget" }, "TARGET_MISMATCH"],
  ];

  for (const [name, options, reason] of cases) {
    await t.test(name, () => {
      const fixture = createFixture();
      const collector = createClickCountCalibration(fixture.target, "doc-3");
      fixture.dispatchClick({
        ...options,
        ...(options.target === "foreignTarget"
          ? { target: fixture.foreignTarget }
          : {}),
      });
      const result = collector.close();

      assert.equal(result.status, "invalid");
      assert.ok(reasonCodes(result).includes(reason));
      assert.deepEqual(reasonCodes(result), [...reasonCodes(result)].sort());
      assert.equal(
        result.clicks[0].targetMatched,
        reason !== "TARGET_MISMATCH",
      );
      assert.equal(fixture.listenerCount(), 0);
    });
  }
});

test("extra clicks are recorded only up to two and overflow is explicit", async (t) => {
  for (const clickCount of [2, 3]) {
    await t.test(`${clickCount} clicks`, () => {
      const fixture = createFixture();
      const collector = createClickCountCalibration(fixture.target, "doc-4");
      for (let index = 0; index < clickCount; index += 1) {
        fixture.dispatchClick({ timeStamp: 7 + index });
        fixture.incrementClick();
      }
      const result = collector.close();

      assert.equal(result.status, "invalid");
      assert.equal(result.clicks.length, 2);
      assert.equal(result.overflow, clickCount === 3);
      assert.ok(reasonCodes(result).includes("EXTRA_CLICK"));
      assert.equal(fixture.listenerCount(), 0);
    });
  }
});

test("missing clicks and click-counter mismatches remain invalid", async (t) => {
  await t.test("no click", () => {
    const fixture = createFixture();
    const collector = createClickCountCalibration(fixture.target, "doc-5");
    const result = collector.close();
    assert.equal(result.status, "invalid");
    assert.equal(result.clickDelta, 0);
    assert.ok(reasonCodes(result).includes("CLICK_MISSING"));
    assert.equal(fixture.listenerCount(), 0);
  });

  await t.test("one trusted click with a non-one counter delta", () => {
    const fixture = createFixture();
    const collector = createClickCountCalibration(fixture.target, "doc-6");
    fixture.dispatchClick();
    const result = collector.close();
    assert.equal(result.status, "invalid");
    assert.equal(result.clickDelta, 0);
    assert.ok(reasonCodes(result).includes("CLICK_COUNTER_MISMATCH"));
    assert.equal(fixture.listenerCount(), 0);
  });
});

test("constructor rejects unsafe, missing, throwing, oversized, and malformed counters", async (t) => {
  const invalidCounterCases = [
    ["missing click", [["pointerdown", 1]]],
    ["missing counter value", [["click", undefined]]],
    ["negative value", [["click", -1]]],
    ["unsafe value", [["click", Number.MAX_SAFE_INTEGER + 1]]],
    [
      "invalid key",
      [
        ["Click", 0],
        ["click", 0],
      ],
    ],
    [
      "long key",
      [
        ["click", 0],
        ["a".repeat(33), 0],
      ],
    ],
    [
      "more than 64 keys",
      [["click", 0], ...Array.from({ length: 64 }, (_, i) => [`k${i}`, 0])],
    ],
  ];

  for (const [name, entries] of invalidCounterCases) {
    await t.test(name, () => {
      const fixture = createFixture({ counterEntries: entries });
      assert.throws(
        () => createClickCountCalibration(fixture.target, "doc-7"),
        { message: "CALIBRATION_COUNTER_INVALID" },
      );
      assert.equal(fixture.listenerCount(), 0);
    });
  }

  await t.test("throwing initial counter read", () => {
    const fixture = createFixture();
    fixture.counters.setReadFailure(true);
    assert.throws(() => createClickCountCalibration(fixture.target, "doc-8"), {
      message: "CALIBRATION_COUNTER_INVALID",
    });
    assert.equal(fixture.listenerCount(), 0);
  });

  await t.test(
    "throwing API getter probes return sanitized unavailable errors",
    async (t) => {
      const cases = [
        [
          "performance.now getter",
          (fixture) => {
            Object.defineProperty(fixture.performance, "now", {
              get() {
                throw new Error("private performance detail");
              },
            });
          },
        ],
        [
          "eventCounts.entries getter",
          (fixture) => {
            Object.defineProperty(fixture.counters.source, "entries", {
              get() {
                throw new Error("private counter detail");
              },
            });
          },
        ],
      ];

      for (const [name, replaceGetter] of cases) {
        await t.test(name, () => {
          const fixture = createFixture();
          replaceGetter(fixture);
          assert.throws(
            () => createClickCountCalibration(fixture.target, "doc-8b"),
            { message: "CALIBRATION_COUNTER_UNAVAILABLE" },
          );
          assert.equal(fixture.listenerCount(), 0);
        });
      }
    },
  );

  await t.test("duplicate counter key", () => {
    const fixture = createFixture();
    fixture.counters.source.entries = () =>
      [
        ["click", 10],
        ["click", 10],
      ][Symbol.iterator]();
    assert.throws(() => createClickCountCalibration(fixture.target, "doc-8a"), {
      message: "CALIBRATION_COUNTER_INVALID",
    });
    assert.equal(fixture.listenerCount(), 0);
  });
});

test("constructor validates document, target, local origin, and visibility before listening", async (t) => {
  const cases = [
    [
      "invalid document label",
      () => createFixture(),
      "target",
      "bad label",
      "CALIBRATION_INVALID_DOCUMENT_ID",
    ],
    [
      "missing target",
      () => createFixture(),
      null,
      "doc-9",
      "CALIBRATION_TARGET_UNAVAILABLE",
    ],
    [
      "disconnected target",
      () => createFixture({ connected: false }),
      "target",
      "doc-9",
      "CALIBRATION_TARGET_UNAVAILABLE",
    ],
    [
      "non-local origin",
      () => createFixture({ hostname: "example.test" }),
      "target",
      "doc-9",
      "CALIBRATION_ORIGIN_NOT_ALLOWED",
    ],
    [
      "non-http origin",
      () => createFixture({ protocol: "https:" }),
      "target",
      "doc-9",
      "CALIBRATION_ORIGIN_NOT_ALLOWED",
    ],
    [
      "initially hidden document",
      () => createFixture({ visible: false }),
      "target",
      "doc-9",
      "CALIBRATION_NOT_VISIBLE",
    ],
  ];

  for (const [
    name,
    fixtureFactory,
    targetChoice,
    documentId,
    errorCode,
  ] of cases) {
    await t.test(name, () => {
      const fixture = fixtureFactory();
      const target = targetChoice === "target" ? fixture.target : targetChoice;
      assert.throws(() => createClickCountCalibration(target, documentId), {
        message: errorCode,
      });
      assert.equal(fixture.listenerCount(), 0);
    });
  }

  await t.test("unavailable counter source", () => {
    const fixture = createFixture();
    fixture.performance.eventCounts = null;
    assert.throws(() => createClickCountCalibration(fixture.target, "doc-10"), {
      message: "CALIBRATION_COUNTER_UNAVAILABLE",
    });
    assert.equal(fixture.listenerCount(), 0);
  });
});

test("final counter read and validation failures return no final snapshot", async (t) => {
  const cases = [
    [
      "decreasing value",
      (fixture) => fixture.counters.values.set("click", 9),
      "COUNTER_INVALID",
    ],
    [
      "unsafe value",
      (fixture) =>
        fixture.counters.values.set("click", Number.MAX_SAFE_INTEGER + 1),
      "COUNTER_INVALID",
    ],
    [
      "missing key",
      (fixture) => fixture.counters.values.delete("click"),
      "COUNTER_INVALID",
    ],
    [
      "invalid key",
      (fixture) => fixture.counters.values.set("Bad", 0),
      "COUNTER_INVALID",
    ],
    [
      "over 64 keys",
      (fixture) => {
        for (let i = 0; i < 62; i += 1) fixture.counters.values.set(`k${i}`, 0);
      },
      "COUNTER_INVALID",
    ],
    [
      "throwing read",
      (fixture) => fixture.counters.setReadFailure(true),
      "COUNTER_READ_FAILED",
    ],
  ];

  for (const [name, invalidate, reason] of cases) {
    await t.test(name, () => {
      const fixture = createFixture();
      const collector = createClickCountCalibration(fixture.target, "doc-11");
      invalidate(fixture);
      const result = collector.close();
      assert.equal(result.status, "invalid");
      assert.ok(reasonCodes(result).includes(reason));
      assert.equal(result.after, null);
      assert.equal(result.clickDelta, null);
      assert.equal(fixture.listenerCount(), 0);
    });
  }
});

test("target removal and reparenting invalidate finalization", async (t) => {
  for (const kind of ["removed", "reparented"]) {
    await t.test(kind, () => {
      const fixture = createFixture();
      const collector = createClickCountCalibration(fixture.target, "doc-12");
      if (kind === "removed") fixture.target.isConnected = false;
      else fixture.target.parentNode = {};
      const result = collector.close();
      assert.equal(result.status, "invalid");
      assert.ok(reasonCodes(result).includes("TARGET_CHANGED"));
      assert.equal(fixture.listenerCount(), 0);
    });
  }
});

test("pagehide and visibility loss invalidate the collector", async (t) => {
  await t.test("pagehide", () => {
    const fixture = createFixture();
    const collector = createClickCountCalibration(fixture.target, "doc-13");
    fixture.window.dispatchEvent({ type: "pagehide" });
    const result = collector.close();
    assert.equal(result.status, "invalid");
    assert.ok(reasonCodes(result).includes("DOCUMENT_CHANGED"));
    assert.equal(fixture.listenerCount(), 0);
  });

  await t.test("visibility transition", () => {
    const fixture = createFixture();
    const collector = createClickCountCalibration(fixture.target, "doc-14");
    fixture.document.visibilityState = "hidden";
    fixture.document.hidden = true;
    fixture.document.dispatchEvent({ type: "visibilitychange" });
    const result = collector.close();
    assert.equal(result.status, "invalid");
    assert.ok(reasonCodes(result).includes("VISIBILITY_CHANGED"));
    assert.equal(fixture.listenerCount(), 0);
  });
});

test("clock boundaries allow equality and reject inversions without latency inference", async (t) => {
  await t.test(
    "equal snapshot and event observation boundaries are accepted",
    () => {
      const fixture = createFixture();
      const collector = createClickCountCalibration(fixture.target, "doc-15");
      fixture.dispatchClick({ timeStamp: 999999 });
      fixture.incrementClick();
      const result = collector.close();
      assert.equal(result.status, "collected");
      assert.equal(result.clicks[0].observedAt, result.before.observedAt);
      assert.equal(result.clicks[0].observedAt, result.after.observedAt);
      assert.equal(result.clicks[0].timeStamp, 999999);
    },
  );

  await t.test("final clock inversion", () => {
    const fixture = createFixture();
    const collector = createClickCountCalibration(fixture.target, "doc-16");
    fixture.setClock(9);
    const result = collector.close();
    assert.equal(result.status, "invalid");
    assert.ok(reasonCodes(result).includes("COUNTER_INVALID"));
    assert.equal(result.after, null);
    assert.equal(fixture.listenerCount(), 0);
  });

  await t.test("time origin change", () => {
    const fixture = createFixture();
    const collector = createClickCountCalibration(fixture.target, "doc-17");
    fixture.performance.timeOrigin += 1;
    const result = collector.close();
    assert.equal(result.status, "invalid");
    assert.ok(reasonCodes(result).includes("DOCUMENT_CHANGED"));
    assert.equal(result.after, null);
    assert.equal(result.clickDelta, null);
    assert.equal(fixture.listenerCount(), 0);
  });

  await t.test(
    "changed time origin with an inverted final clock has no snapshot",
    () => {
      const fixture = createFixture();
      const collector = createClickCountCalibration(fixture.target, "doc-17a");
      fixture.performance.timeOrigin += 1;
      fixture.setClock(9);
      const result = collector.close();
      assert.ok(reasonCodes(result).includes("DOCUMENT_CHANGED"));
      assert.ok(reasonCodes(result).includes("COUNTER_INVALID"));
      assert.equal(result.after, null);
      assert.equal(result.clickDelta, null);
      assert.equal(fixture.listenerCount(), 0);
    },
  );
});

test("invalid event numbers become null and add a sanitized reason", async (t) => {
  await t.test("invalid event timestamp", () => {
    const fixture = createFixture();
    const collector = createClickCountCalibration(fixture.target, "doc-18");
    fixture.dispatchClick({ timeStamp: Number.NaN });
    fixture.incrementClick();
    const result = collector.close();
    assert.equal(result.clicks[0].timeStamp, null);
    assert.ok(reasonCodes(result).includes("EVENT_RECORD_INVALID"));
    assert.equal(result.status, "invalid");
    assert.equal(fixture.listenerCount(), 0);
  });

  await t.test("invalid event observation time", () => {
    const fixture = createFixture();
    let nowCalls = 0;
    fixture.performance.now = () => {
      nowCalls += 1;
      return nowCalls === 2 ? Number.NaN : 10;
    };
    const collector = createClickCountCalibration(fixture.target, "doc-19");
    fixture.dispatchClick();
    fixture.incrementClick();
    fixture.performance.now = () => 10;
    const result = collector.close();
    assert.equal(result.clicks[0].observedAt, null);
    assert.ok(reasonCodes(result).includes("EVENT_RECORD_INVALID"));
    assert.equal(fixture.listenerCount(), 0);
  });

  await t.test("nonmonotonic or out-of-bracket observations", () => {
    const fixture = createFixture();
    const collector = createClickCountCalibration(fixture.target, "doc-20");
    fixture.setClock(12);
    fixture.dispatchClick({ timeStamp: 1 });
    fixture.incrementClick();
    fixture.setClock(11);
    fixture.dispatchClick({ timeStamp: 2 });
    fixture.incrementClick();
    fixture.setClock(12);
    const result = collector.close();
    assert.ok(reasonCodes(result).includes("EVENT_RECORD_INVALID"));
    assert.equal(fixture.listenerCount(), 0);
  });

  await t.test("observation after the final snapshot is rejected", () => {
    const fixture = createFixture();
    const collector = createClickCountCalibration(fixture.target, "doc-20a");
    fixture.setClock(12);
    fixture.dispatchClick();
    fixture.incrementClick();
    fixture.setClock(11);
    const result = collector.close();
    assert.equal(result.after.observedAt, 11);
    assert.equal(result.clicks[0].observedAt, 12);
    assert.ok(reasonCodes(result).includes("EVENT_RECORD_INVALID"));
    assert.equal(fixture.listenerCount(), 0);
  });
});

test("abort before close is an idempotent invalid finalization", () => {
  const fixture = createFixture();
  const collector = createClickCountCalibration(fixture.target, "doc-21");
  const result = collector.abort();
  assert.equal(result.status, "invalid");
  assert.ok(reasonCodes(result).includes("ABORTED"));
  assert.equal(result.after, null);
  assert.equal(result.clickDelta, null);
  assert.equal(collector.close(), result);
  assert.equal(collector.abort(), result);
  assert.equal(fixture.listenerCount(), 0);
});

test("partial listener installation failure removes installed listeners", () => {
  const fixture = createFixture();
  fixture.document.failOnType = "visibilitychange";
  assert.throws(() => createClickCountCalibration(fixture.target, "doc-22"), {
    message: "CALIBRATION_INSTALL_FAILED",
  });
  assert.equal(fixture.listenerCount(), 0);
});

test("synthetic Chromium CDP invocation preserves trusted click behavior", {
  timeout: 30_000,
}, async (t) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      '<!doctype html><button id="target" type="button">Synthetic target</button><script>window.applicationClicks = 0; document.querySelector("#target").addEventListener("click", () => { window.applicationClicks += 1; });</script>',
    );
  });
  let browser;
  const contexts = new Set();
  let serverStarted = false;

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    serverStarted = true;
    browser = await chromium.launch({ headless: true });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const url = `http://127.0.0.1:${address.port}/`;

    async function withPage(run) {
      const context = await browser.newContext();
      contexts.add(context);
      try {
        const page = await context.newPage();
        await page.goto(url);
        const session = await context.newCDPSession(page);
        try {
          await run({ page, session });
        } finally {
          await session.detach();
        }
      } finally {
        contexts.delete(context);
        await context.close();
      }
    }

    await t.test(
      "synthetic trusted target click increments EventCounts.click",
      async () => {
        await withPage(async ({ page, session }) => {
          const target = await session.send("Runtime.evaluate", {
            expression: "document.querySelector('#target')",
            returnByValue: false,
          });
          const created = await session.send("Runtime.callFunctionOn", {
            functionDeclaration: clickCountCalibrationFunctionDeclaration(),
            objectId: target.result.objectId,
            arguments: [{ value: "synthetic-1" }],
            returnByValue: false,
          });
          const collectorId = created.result.objectId;
          assert.ok(collectorId);

          await page.locator("#target").click();
          const closed = await session.send("Runtime.callFunctionOn", {
            functionDeclaration: "function() { return this.close(); }",
            objectId: collectorId,
            returnByValue: true,
          });
          const result = closed.result.value;
          assert.equal(result.status, "collected");
          assert.equal(result.documentId, "synthetic-1");
          assert.equal(result.clickDelta, 1);
          assert.equal(result.clicks.length, 1);
          assert.equal(result.clicks[0].isTrusted, true);
          assert.equal(result.clicks[0].targetMatched, true);
          assert.equal(await page.evaluate(() => window.applicationClicks), 1);

          const cached = await session.send("Runtime.callFunctionOn", {
            functionDeclaration: "function() { return this.close(); }",
            objectId: collectorId,
            returnByValue: true,
          });
          assert.deepEqual(cached.result.value, result);

          await page.locator("#target").click();
          assert.equal(await page.evaluate(() => window.applicationClicks), 2);
          const stillCached = await session.send("Runtime.callFunctionOn", {
            functionDeclaration: "function() { return this.abort(); }",
            objectId: collectorId,
            returnByValue: true,
          });
          assert.deepEqual(stillCached.result.value, result);
        });
      },
    );

    await t.test(
      "synthetic dispatchEvent is rejected as untrusted",
      async () => {
        await withPage(async ({ page, session }) => {
          const target = await session.send("Runtime.evaluate", {
            expression: "document.querySelector('#target')",
            returnByValue: false,
          });
          const created = await session.send("Runtime.callFunctionOn", {
            functionDeclaration: clickCountCalibrationFunctionDeclaration(),
            objectId: target.result.objectId,
            arguments: [{ value: "synthetic-2" }],
            returnByValue: false,
          });
          await page.locator("#target").evaluate((element) => {
            element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          });
          const closed = await session.send("Runtime.callFunctionOn", {
            functionDeclaration: "function() { return this.close(); }",
            objectId: created.result.objectId,
            returnByValue: true,
          });
          const result = closed.result.value;
          assert.equal(result.status, "invalid");
          assert.ok(result.reasons.includes("UNTRUSTED_CLICK"));
          assert.deepEqual(result.reasons, [...result.reasons].sort());
          assert.equal(result.clicks.length, 1);
          assert.equal(result.clicks[0].isTrusted, false);
          assert.equal(result.clicks[0].targetMatched, true);
          assert.equal(await page.evaluate(() => window.applicationClicks), 1);
        });
      },
    );
  } finally {
    try {
      await Promise.allSettled([...contexts].map((context) => context.close()));
      if (browser) await browser.close();
    } finally {
      if (serverStarted) {
        await new Promise((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    }
  }
});
