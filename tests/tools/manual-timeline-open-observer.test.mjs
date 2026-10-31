import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { chromium } from "playwright";
import {
  createTimelineOpenObserver,
  manualTimelineOpenObserverFunctionDeclaration,
} from "../../scripts/manual-timeline-open-observer.mjs";

const expectedPath = "/timelines/synthetic-story";
const statusKeys = [
  "captureStartMarkerSeen",
  "clickCount",
  "completionEndMarkerSeen",
  "expectedCount",
  "pathMatches",
  "primaryClickMarkerSeen",
  "rangeValid",
  "reason",
  "renderedCount",
  "sameDocument",
  "schemaVersion",
  "stableFrameCount",
  "state",
  "visible",
  "workload",
].sort();

function groupsFor(count) {
  const width = count === 100 ? 10 : 1000;
  const groups = [];
  for (let first = 1; first <= count; first += width) {
    const last = Math.min(first + width - 1, count);
    groups.push({ first, last, count: last - first + 1 });
  }
  return groups;
}

function fixtureHtml() {
  return `<!doctype html>
    <html><head><meta charset="utf-8"><title>Private synthetic fixture</title></head>
    <body>
      <div id="root">
        <main id="main" class="timeline-page">
          <div class="timeline-list">
            <a id="target" class="timeline-tile" href="/timelines/synthetic-story"><span id="child">Open synthetic story</span></a>
            <a id="wrong" class="timeline-tile" href="/timelines/wrong-story">Wrong story</a>
          </div>
        </main>
      </div>
      <button id="extra" type="button">Extra activation</button>
      <script>
        window.markerLabels = [];
        console.timeStamp = (label) => window.markerLabels.push(label);
        window.applicationClicks = 0;
        window.lastApplicationClickTrusted = null;
        window.destinationPath = ${JSON.stringify(expectedPath)};
        window.projectionMode = "valid";
        window.groupRanges = null;
        window.renderOnClick = true;
        window.popstateCount = 0;
        window.addEventListener("popstate", () => { window.popstateCount += 1; });
        window.renderProjection = (mode) => {
          const main = document.querySelector("main#main.timeline-page");
          if (mode === "detach-root") {
            document.querySelector("#root").remove();
            return;
          }
          if (mode === "transparent-ancestor") {
            document.querySelector("#root").style.opacity = "0";
          }
          if (mode === "missing") return;
          if (mode === "error") {
            const error = document.createElement("p");
            error.className = "error";
            error.setAttribute("role", "alert");
            error.textContent = "Private failure details";
            main.append(error);
            return;
          }
          const section = document.createElement("section");
          section.className = "story-viewport";
          section.dataset.viewport = "story";
          const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
          svg.setAttribute("role", "img");
          svg.setAttribute("aria-label", "Narrative order overview");
          svg.setAttribute("width", "100");
          svg.setAttribute("height", "40");
          const ranges = window.groupRanges || [{ first: 1, last: 100, count: 100 }];
          for (const range of ranges) {
            const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
            group.setAttribute("data-first-ordinal", String(range.first));
            group.setAttribute("data-last-ordinal", String(range.last));
            group.setAttribute("data-moment-count", String(range.count));
            svg.append(group);
          }
          section.append(svg);
          main.append(section);
        };
        document.querySelector("#target").addEventListener("click", (event) => {
          window.applicationClicks += 1;
          window.lastApplicationClickTrusted = event.isTrusted;
          if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          history.pushState({}, "", window.destinationPath);
          if (window.projectionMode === "wrong-route") history.pushState({}, "", "/wrong-destination");
          if (window.renderOnClick) queueMicrotask(() => window.renderProjection(window.projectionMode));
        });
        document.querySelector("#wrong").addEventListener("click", (event) => {
          event.preventDefault();
        });
        document.querySelector("#target").addEventListener("auxclick", (event) => {
          event.preventDefault();
        });
        document.querySelector("#target").addEventListener("contextmenu", (event) => {
          event.preventDefault();
        });
      </script>
    </body></html>`;
}

async function startObserver(
  _page,
  session,
  {
    selector = "#target",
    path = expectedPath,
    items = 100,
    timeoutMs = 1000,
  } = {},
) {
  const target = await session.send("Runtime.evaluate", {
    expression: `document.querySelector(${JSON.stringify(selector)})`,
    returnByValue: false,
  });
  assert.ok(target.result.objectId, `fixture target not found: ${selector}`);
  const created = await session.send("Runtime.callFunctionOn", {
    functionDeclaration: manualTimelineOpenObserverFunctionDeclaration(),
    objectId: target.result.objectId,
    arguments: [
      {
        value: {
          expectedPath: path,
          expectedItems: items,
          timeoutMs,
        },
      },
    ],
    returnByValue: false,
  });
  assert.ok(
    created.result.objectId,
    "serialized observer did not return a handle",
  );
  const armed = await session.send("Runtime.callFunctionOn", {
    functionDeclaration:
      "function() { window.__observerUnderTest = this; this.arm(); return this.status(); }",
    objectId: created.result.objectId,
    returnByValue: true,
  });
  assert.ok(
    armed.result.value,
    "observer did not return an allowlisted status",
  );
  return armed.result.value;
}

async function statusOf(page) {
  return page.evaluate(() => window.__observerUnderTest?.status() ?? null);
}

async function waitForState(page, state, timeout = 1500) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    const current = await statusOf(page);
    if (current?.state === state) return current;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `Timed out waiting for ${state}; current state: ${JSON.stringify(await statusOf(page))}`,
  );
}

async function disposeObserver(page) {
  await page.evaluate(() => window.__observerUnderTest?.dispose());
}

async function instrumentListeners(page) {
  await page.evaluate(() => {
    window.observerListenerAudit = { added: [], removed: [] };
    for (const target of [document, window]) {
      const add = target.addEventListener.bind(target);
      const remove = target.removeEventListener.bind(target);
      target.addEventListener = (type, listener, options) => {
        if (
          [
            "click",
            "auxclick",
            "contextmenu",
            "visibilitychange",
            "resize",
            "pagehide",
          ].includes(type)
        ) {
          window.observerListenerAudit.added.push({ target, type, listener });
        }
        return add(type, listener, options);
      };
      target.removeEventListener = (type, listener, options) => {
        if (
          [
            "click",
            "auxclick",
            "contextmenu",
            "visibilitychange",
            "resize",
            "pagehide",
          ].includes(type)
        ) {
          window.observerListenerAudit.removed.push({ target, type, listener });
        }
        return remove(type, listener, options);
      };
    }
  });
}

async function assertListenersClean(page) {
  const audit = await page.evaluate(() => {
    const { added, removed } = window.observerListenerAudit;
    const missing = added.filter(
      (item) =>
        !removed.some(
          (candidate) =>
            candidate.target === item.target &&
            candidate.type === item.type &&
            candidate.listener === item.listener,
        ),
    );
    return {
      added: added.length,
      removed: removed.length,
      missing: missing.map((item) => ({
        type: item.type,
        target: item.target === window ? "window" : "document",
        source: String(item.listener).slice(0, 60),
      })),
    };
  });
  assert.ok(audit);
  assert.equal(audit.added, audit.removed, JSON.stringify(audit));
  assert.deepEqual(audit.missing, [], JSON.stringify(audit));
}

test("manual Timeline-open observer stays bounded, passive, and sanitized", {
  timeout: 120_000,
}, async (t) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(fixtureHtml());
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
    const url = `http://127.0.0.1:${address.port}/timelines`;

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
      "self-contained CDP declaration observes a trusted nested click",
      async () => {
        await withPage(async ({ page, session }) => {
          const declaration = manualTimelineOpenObserverFunctionDeclaration();
          assert.match(declaration, /^function\s*\(/);
          assert.doesNotMatch(declaration, /node_modules|from\s+["']/);
          const initial = await startObserver(page, session);
          assert.deepEqual(Object.keys(initial).sort(), statusKeys);
          assert.equal(initial.state, "armed");
          assert.equal(initial.workload, "100-interactive");
          assert.deepEqual(await page.evaluate(() => window.markerLabels), [
            "ages-open-v1:100-interactive:capture-start",
          ]);

          await page.locator("#child").click();
          const status = await waitForState(page, "projection-ready");
          assert.equal(
            await page.evaluate(() => window.location.pathname),
            expectedPath,
          );
          assert.equal(await page.evaluate(() => window.applicationClicks), 1);
          assert.equal(
            await page.evaluate(() => window.lastApplicationClickTrusted),
            true,
          );
          assert.equal(await page.evaluate(() => window.popstateCount), 0);
          assert.equal(status.reason, null);
          assert.equal(status.clickCount, 1);
          assert.equal(status.expectedCount, 100);
          assert.equal(status.renderedCount, 100);
          assert.equal(status.rangeValid, true);
          assert.equal(status.sameDocument, true);
          assert.equal(status.pathMatches, true);
          assert.equal(status.visible, true);
          assert.equal(status.stableFrameCount, 2);
          assert.deepEqual(await page.evaluate(() => window.markerLabels), [
            "ages-open-v1:100-interactive:capture-start",
            "ages-open-v1:100-interactive:primary-click",
            "ages-open-v1:100-interactive:completion-end",
          ]);
          assert.equal(JSON.stringify(status).includes(expectedPath), false);
          await disposeObserver(page);
        });
      },
    );

    await t.test("10000-item contiguous projection is accepted", async () => {
      await withPage(async ({ page, session }) => {
        await page.evaluate((ranges) => {
          window.groupRanges = ranges;
        }, groupsFor(10_000));
        await startObserver(page, session, { items: 10_000 });
        await page.locator("#child").click();
        const status = await waitForState(page, "projection-ready");
        assert.equal(status.workload, "10000-chronological");
        assert.equal(status.expectedCount, 10_000);
        assert.equal(status.renderedCount, 10_000);
        assert.equal(status.rangeValid, true);
        await disposeObserver(page);
      });
    });

    await t.test("100-item contiguous ranges are fully covered", async () => {
      await withPage(async ({ page, session }) => {
        await page.evaluate((ranges) => {
          window.groupRanges = ranges;
        }, groupsFor(100));
        await startObserver(page, session);
        await page.locator("#child").click();
        const status = await waitForState(page, "projection-ready");
        assert.equal(status.renderedCount, 100);
        assert.equal(status.rangeValid, true);
        await disposeObserver(page);
      });
    });

    const malformedGroups = [
      ["missing groups", []],
      [
        "duplicate groups",
        [
          { first: 1, last: 100, count: 100 },
          { first: 1, last: 100, count: 100 },
        ],
      ],
      [
        "overlapping ranges",
        [
          { first: 1, last: 60, count: 60 },
          { first: 50, last: 100, count: 51 },
        ],
      ],
      [
        "gapped ranges",
        [
          { first: 1, last: 40, count: 40 },
          { first: 42, last: 100, count: 59 },
        ],
      ],
      ["zero counts", [{ first: 1, last: 0, count: 0 }]],
      ["fractional attributes", [{ first: "1.5", last: 100, count: 100 }]],
      ["count and range disagreement", [{ first: 1, last: 100, count: 99 }]],
      ["wrong first endpoint", [{ first: 2, last: 100, count: 99 }]],
    ];

    for (const [label, ranges] of malformedGroups) {
      await t.test(`${label} never becomes projection-ready`, async () => {
        await withPage(async ({ page, session }) => {
          await page.evaluate((groupRanges) => {
            window.groupRanges = groupRanges;
          }, ranges);
          await startObserver(page, session, { timeoutMs: 80 });
          await page.locator("#child").click();
          const status = await waitForState(page, "timed-out");
          assert.equal(status.reason, "TIMEOUT");
          assert.equal(status.rangeValid, false);
          assert.equal(status.completionEndMarkerSeen, false);
          assert.equal(
            (await page.evaluate(() => window.markerLabels)).includes(
              "ages-open-v1:100-interactive:completion-end",
            ),
            false,
          );
        });
      });
    }

    await t.test(
      "a click on another anchor invalidates the selected binding",
      async () => {
        await withPage(async ({ page, session }) => {
          await instrumentListeners(page);
          await startObserver(page, session);
          await page.locator("#wrong").click();
          const status = await waitForState(page, "invalid");
          assert.equal(status.reason, "WRONG_TARGET");
          assert.equal(status.clickCount, 1);
          assert.equal(await page.evaluate(() => window.applicationClicks), 0);
          await assertListenersClean(page);
        });
      },
    );

    await t.test(
      "synthetic click stays untrusted and is not blocked",
      async () => {
        await withPage(async ({ page, session }) => {
          await startObserver(page, session);
          await page.evaluate(() => document.querySelector("#target").click());
          const status = await waitForState(page, "invalid");
          assert.equal(status.reason, "UNTRUSTED_INPUT");
          assert.equal(
            await page.evaluate(() => window.lastApplicationClickTrusted),
            false,
          );
          assert.equal(
            await page.evaluate(() => window.location.pathname),
            expectedPath,
          );
          assert.equal(status.completionEndMarkerSeen, false);
        });
      },
    );

    await t.test(
      "modified trusted click is rejected without stopping the app listener",
      async () => {
        await withPage(async ({ page, session }) => {
          await startObserver(page, session);
          await page.locator("#target").click({ modifiers: ["Shift"] });
          const status = await waitForState(page, "invalid");
          assert.equal(status.reason, "MODIFIED_INPUT");
          assert.equal(
            await page.evaluate(() => window.lastApplicationClickTrusted),
            true,
          );
          assert.equal(
            await page.evaluate(() => window.location.pathname),
            "/timelines",
          );
          assert.equal(status.completionEndMarkerSeen, false);
        });
      },
    );

    await t.test(
      "middle and right activations are rejected without a primary-click gate",
      async () => {
        await withPage(async ({ page, session }) => {
          await startObserver(page, session);
          const targetBox = await page.locator("#target").boundingBox();
          assert.ok(targetBox);
          await page.mouse.click(
            targetBox.x + targetBox.width / 2,
            targetBox.y + targetBox.height / 2,
            { button: "middle" },
          );
          const status = await waitForState(page, "invalid");
          assert.equal(status.reason, "MODIFIED_INPUT");
          assert.equal(status.clickCount, 1);
          assert.equal(await page.evaluate(() => window.applicationClicks), 0);
        });
        await withPage(async ({ page, session }) => {
          await startObserver(page, session);
          const targetBox = await page.locator("#target").boundingBox();
          assert.ok(targetBox);
          await page.mouse.click(
            targetBox.x + targetBox.width / 2,
            targetBox.y + targetBox.height / 2,
            { button: "right" },
          );
          const status = await waitForState(page, "invalid");
          assert.equal(status.reason, "MODIFIED_INPUT");
          assert.equal(status.clickCount, 1);
          assert.equal(await page.evaluate(() => window.applicationClicks), 0);
        });
      },
    );

    await t.test(
      "a second click before projection completion invalidates the run",
      async () => {
        await withPage(async ({ page, session }) => {
          await page.evaluate(() => {
            window.renderOnClick = false;
          });
          await startObserver(page, session, { timeoutMs: 1000 });
          const targetBox = await page.locator("#child").boundingBox();
          assert.ok(targetBox);
          await page.mouse.click(
            targetBox.x + targetBox.width / 2,
            targetBox.y + targetBox.height / 2,
          );
          const extraBox = await page.locator("#extra").boundingBox();
          assert.ok(extraBox);
          await page.mouse.click(
            extraBox.x + extraBox.width / 2,
            extraBox.y + extraBox.height / 2,
          );
          const status = await waitForState(page, "invalid");
          assert.equal(status.reason, "EXTRA_CLICK");
          assert.equal(status.clickCount, 2);
          assert.equal(status.completionEndMarkerSeen, false);
        });
      },
    );

    await t.test(
      "SPA pushState with a stable root is observed without popstate",
      async () => {
        await withPage(async ({ page, session }) => {
          const root = await page
            .locator("#root")
            .evaluate((element) => element);
          await startObserver(page, session);
          const targetBox = await page.locator("#target").boundingBox();
          assert.ok(targetBox);
          await page.mouse.click(
            targetBox.x + targetBox.width / 2,
            targetBox.y + targetBox.height / 2,
          );
          const status = await waitForState(page, "projection-ready");
          assert.equal(status.pathMatches, true);
          assert.equal(
            await page.evaluate(
              () => document.querySelector("#root").isConnected,
            ),
            true,
          );
          assert.equal(await page.evaluate(() => window.popstateCount), 0);
          assert.equal(
            await page.evaluate(() => window.location.pathname),
            expectedPath,
          );
          assert.ok(root);
          await disposeObserver(page);
        });
      },
    );

    await t.test(
      "waiting can be cancelled and dispose is idempotent",
      async () => {
        await withPage(async ({ page, session }) => {
          await instrumentListeners(page);
          const initial = await startObserver(page, session, {
            timeoutMs: 1000,
          });
          assert.equal(initial.state, "armed");
          assert.equal(initial.clickCount, 0);
          const cancelled = await page.evaluate(() => {
            window.__observerUnderTest.cancel();
            return window.__observerUnderTest.status();
          });
          assert.equal(cancelled.state, "cancelled");
          assert.equal(cancelled.reason, "CANCELLED");
          await disposeObserver(page);
          await disposeObserver(page);
          assert.deepEqual(await statusOf(page), cancelled);
          await assertListenersClean(page);
        });
      },
    );

    await t.test(
      "timeout starts at arm and exposes no completion marker",
      async () => {
        await withPage(async ({ page, session }) => {
          await startObserver(page, session, { timeoutMs: 35 });
          const status = await waitForState(page, "timed-out");
          assert.equal(status.reason, "TIMEOUT");
          assert.equal(status.clickCount, 0);
          assert.equal(status.captureStartMarkerSeen, true);
          assert.equal(status.completionEndMarkerSeen, false);
        });
      },
    );

    await t.test(
      "invalid configuration and wrong selected element are sanitized",
      async () => {
        assert.throws(
          () =>
            createTimelineOpenObserver({
              target: null,
              expectedPath: "/timelines/private-secret",
              expectedItems: 100,
            }),
          { message: "OBSERVER_INVALID_CONFIGURATION" },
        );
        assert.throws(
          () =>
            createTimelineOpenObserver({
              get target() {
                throw new Error("private-title-and-route");
              },
            }),
          { message: "OBSERVER_INVALID_CONFIGURATION" },
        );
        await withPage(async ({ page, session }) => {
          const initial = await startObserver(page, session, {
            selector: "#extra",
          });
          assert.equal(initial.state, "invalid");
          assert.equal(initial.reason, "WRONG_TARGET");
          assert.equal(JSON.stringify(initial).includes("private"), false);
        });
      },
    );

    await t.test("visibility loss invalidates and cleans up", async () => {
      await withPage(async ({ page, session }) => {
        await instrumentListeners(page);
        await startObserver(page, session);
        await page.evaluate(() => {
          Object.defineProperty(document, "visibilityState", {
            configurable: true,
            get: () => "hidden",
          });
          document.dispatchEvent(new Event("visibilitychange"));
        });
        const status = await waitForState(page, "invalid");
        assert.equal(status.reason, "VISIBILITY_CHANGED");
        assert.equal(status.visible, false);
        await assertListenersClean(page);
      });
    });

    await t.test(
      "transparent ancestor never marks a projection complete",
      async () => {
        await withPage(async ({ page, session }) => {
          await page.evaluate(() => {
            window.projectionMode = "transparent-ancestor";
          });
          await startObserver(page, session, { timeoutMs: 500 });
          await page.locator("#target").click();
          await page.waitForFunction(
            () => {
              const state = window.__observerUnderTest?.status().state;
              return state === "projection-ready" || state === "timed-out";
            },
            null,
            { timeout: 1500 },
          );
          const status = await statusOf(page);
          const computed = await page.evaluate(() => {
            const root = document.querySelector("#root");
            const section = document.querySelector("section.story-viewport");
            const svg = document.querySelector(
              'svg[aria-label="Narrative order overview"]',
            );
            return {
              rootOpacity: getComputedStyle(root).opacity,
              sectionOpacity: getComputedStyle(section).opacity,
              svgOpacity: getComputedStyle(svg).opacity,
              sectionHasBounds: section.getBoundingClientRect().width > 0,
              svgHasBounds: svg.getBoundingClientRect().width > 0,
            };
          });

          assert.deepEqual(computed, {
            rootOpacity: "0",
            sectionOpacity: "1",
            svgOpacity: "1",
            sectionHasBounds: true,
            svgHasBounds: true,
          });
          assert.equal(status.state, "timed-out");
          assert.equal(status.reason, "TIMEOUT");
          assert.equal(status.completionEndMarkerSeen, false);
          assert.deepEqual(await page.evaluate(() => window.markerLabels), [
            "ages-open-v1:100-interactive:capture-start",
            "ages-open-v1:100-interactive:primary-click",
          ]);
        });
      },
    );

    await t.test(
      "wrong destination and detached root are rejected",
      async () => {
        await withPage(async ({ page, session }) => {
          await page.evaluate(() => {
            window.projectionMode = "wrong-route";
          });
          await startObserver(page, session);
          await page.locator("#target").click();
          const status = await waitForState(page, "invalid");
          assert.equal(status.reason, "WRONG_ROUTE");
        });
        await withPage(async ({ page, session }) => {
          await page.evaluate(() => {
            window.projectionMode = "detach-root";
          });
          await startObserver(page, session);
          await page.locator("#target").click();
          const status = await waitForState(page, "invalid");
          assert.equal(status.reason, "DOCUMENT_CHANGED");
          assert.equal(status.sameDocument, true);
        });
      },
    );

    await t.test("time-origin changes are detected", async () => {
      await withPage(async ({ page, session }) => {
        await startObserver(page, session);
        await page.evaluate(() => {
          const original = performance.timeOrigin;
          Object.defineProperty(performance, "timeOrigin", {
            configurable: true,
            get: () => original + 1,
          });
          window.dispatchEvent(new Event("resize"));
        });
        const status = await waitForState(page, "invalid");
        assert.equal(status.reason, "DOCUMENT_CHANGED");
        assert.equal(status.sameDocument, false);
      });
    });

    await t.test(
      "direct projection errors do not expose their text",
      async () => {
        await withPage(async ({ page, session }) => {
          await page.evaluate(() => {
            window.projectionMode = "error";
          });
          await startObserver(page, session);
          await page.locator("#target").click();
          const status = await waitForState(page, "invalid");
          assert.equal(status.reason, "PROJECTION_ERROR");
          assert.equal(
            JSON.stringify(status).includes("Private failure details"),
            false,
          );
        });
      },
    );

    await t.test(
      "mutation bursts coalesce and DOM changes between frames revalidate",
      async () => {
        await withPage(async ({ page, session }) => {
          await page.evaluate(() => {
            const nativeRequest = window.requestAnimationFrame.bind(window);
            const nativeCancel = window.cancelAnimationFrame.bind(window);
            const frameHandles = new Set();
            window.rafCalls = 0;
            window.rafOutstanding = 0;
            window.maxRafOutstanding = 0;
            window.requestAnimationFrame = (callback) => {
              window.rafCalls += 1;
              let id;
              id = nativeRequest((time) => {
                if (frameHandles.delete(id)) window.rafOutstanding -= 1;
                if (window.rafCalls === 2 && !window.didChangeGroups) {
                  window.didChangeGroups = true;
                  window.groupRanges = [
                    { first: 1, last: 50, count: 50 },
                    { first: 51, last: 100, count: 50 },
                  ];
                  const svg = document.querySelector(
                    'svg[aria-label="Narrative order overview"]',
                  );
                  for (const child of [...svg.children]) child.remove();
                  for (const range of window.groupRanges) {
                    const group = document.createElementNS(
                      "http://www.w3.org/2000/svg",
                      "g",
                    );
                    group.setAttribute(
                      "data-first-ordinal",
                      String(range.first),
                    );
                    group.setAttribute("data-last-ordinal", String(range.last));
                    group.setAttribute(
                      "data-moment-count",
                      String(range.count),
                    );
                    svg.append(group);
                  }
                }
                callback(time);
              });
              frameHandles.add(id);
              window.rafOutstanding += 1;
              window.maxRafOutstanding = Math.max(
                window.maxRafOutstanding,
                window.rafOutstanding,
              );
              return id;
            };
            window.cancelAnimationFrame = (id) => {
              if (frameHandles.delete(id)) window.rafOutstanding -= 1;
              return nativeCancel(id);
            };
          });
          await startObserver(page, session);
          const targetBox = await page.locator("#target").boundingBox();
          assert.ok(targetBox);
          await page.mouse.click(
            targetBox.x + targetBox.width / 2,
            targetBox.y + targetBox.height / 2,
          );
          const status = await waitForState(page, "projection-ready");
          const rafStats = await page.evaluate(() => ({
            calls: window.rafCalls,
            maxOutstanding: window.maxRafOutstanding,
          }));
          assert.ok(rafStats.calls >= 3, JSON.stringify(rafStats));
          assert.equal(rafStats.maxOutstanding, 1);
          assert.equal(status.stableFrameCount, 2);
          assert.equal(status.rangeValid, true);
          await disposeObserver(page);
        });
      },
    );

    await t.test(
      "marker exceptions are contained and do not become evidence",
      async () => {
        await withPage(async ({ page, session }) => {
          await page.evaluate(() => {
            console.timeStamp = () => {
              throw new Error("private marker failure /timelines/private-id");
            };
          });
          await startObserver(page, session);
          await page.locator("#target").click();
          const status = await waitForState(page, "projection-ready");
          assert.equal(status.captureStartMarkerSeen, false);
          assert.equal(status.primaryClickMarkerSeen, false);
          assert.equal(status.completionEndMarkerSeen, false);
          assert.equal(JSON.stringify(status).includes("private"), false);
          assert.equal(status.reason, null);
          await disposeObserver(page);
        });
      },
    );

    await t.test(
      "failed listener setup removes earlier listeners without leaking errors",
      async () => {
        await withPage(async ({ page, session }) => {
          await instrumentListeners(page);
          await page.evaluate(() => {
            const nativeAdd = window.addEventListener.bind(window);
            window.addEventListener = (type, listener, options) => {
              if (type === "resize") throw new Error("private setup failure");
              return nativeAdd(type, listener, options);
            };
          });
          const status = await startObserver(page, session);
          assert.equal(status.state, "invalid");
          assert.equal(status.reason, "OBSERVER_ERROR");
          assert.equal(JSON.stringify(status).includes("private"), false);
          await assertListenersClean(page);
        });
      },
    );

    await t.test(
      "observer exceptions return only fixed status fields",
      async () => {
        await withPage(async ({ page, session }) => {
          await startObserver(page, session);
          await page.evaluate(() => {
            const viewport = document.createElement("section");
            viewport.className = "story-viewport";
            viewport.dataset.viewport = "story";
            viewport.getClientRects = () => {
              throw new Error("private title, token, and route");
            };
            document.querySelector("#main").append(viewport);
            window.dispatchEvent(new Event("resize"));
          });
          await page.locator("#target").click();
          const status = await waitForState(page, "invalid");
          assert.equal(status.reason, "OBSERVER_ERROR");
          assert.deepEqual(Object.keys(status).sort(), statusKeys);
          assert.equal(JSON.stringify(status).includes("private"), false);
        });
      },
    );

    await t.test(
      "completion and invalidation remove all owned listeners",
      async () => {
        await withPage(async ({ page, session }) => {
          await instrumentListeners(page);
          await startObserver(page, session);
          await page.locator("#target").click();
          await waitForState(page, "projection-ready");
          await assertListenersClean(page);
        });
      },
    );
  } finally {
    await Promise.allSettled([...contexts].map((context) => context.close()));
    if (browser) await browser.close();
    if (serverStarted) {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }
});
