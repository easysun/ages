import { describe, expect, it, vi } from "vitest";
import {
  validateReleaseTarget,
  verifyReleaseResources,
} from "../../src/operations/preflight";

const account = "a".repeat(32);
const database = "11111111-1111-4111-8111-111111111111";
const namespace = "b".repeat(32);
function configured() {
  return {
    account_id: account,
    main: "src/index.ts",
    workers_dev: false,
    triggers: { crons: ["*/15 * * * *"] },
    assets: {
      directory: "./dist/client",
      run_worker_first: [
        "/api",
        "/api/*",
        "/auth",
        "/auth/*",
        "/health",
        "/health/*",
        "/t",
        "/t/*",
        "/c",
        "/c/*",
        "/s",
        "/s/*",
      ],
    },
    env: {
      preview: {
        name: "ages-preview",
        vars: {
          APP_ENV: "preview",
          APP_ORIGIN: "https://preview.example.test",
          TRACKING_ORIGIN: "https://events.tracking.test",
          APP_REGISTRABLE_DOMAIN: "example.test",
          TRACKING_REGISTRABLE_DOMAIN: "tracking.test",
          R2_ACCOUNT_ID: account,
          R2_BUCKET_NAME: "ages-preview-media",
          GOOGLE_CLIENT_ID: "synthetic-client",
        },
        routes: [{ pattern: "preview.example.test", custom_domain: true }],
        d1_databases: [{ binding: "DB", database_id: database }],
        r2_buckets: [{ binding: "MEDIA", bucket_name: "ages-preview-media" }],
        kv_namespaces: [{ binding: "LINK_CACHE", id: namespace }],
      },
      production: {
        name: "ages-production",
        vars: { APP_ORIGIN: "https://example.test" },
        d1_databases: [
          {
            binding: "DB",
            database_id: "22222222-2222-4222-8222-222222222222",
          },
        ],
        r2_buckets: [
          { binding: "MEDIA", bucket_name: "ages-production-media" },
        ],
        kv_namespaces: [{ binding: "LINK_CACHE", id: "c".repeat(32) }],
      },
    },
  };
}
function trackingConfigured() {
  return {
    main: "src/tracking/index.ts",
    workers_dev: false,
    vars: { APP_ENV: "local" },
    env: {
      preview: {
        name: "ages-tracking-preview",
        vars: {
          APP_ENV: "preview",
          APP_ORIGIN: "https://preview.example.test",
          TRACKING_ORIGIN: "https://events.tracking.test",
        },
        routes: [{ pattern: "events.tracking.test", custom_domain: true }],
        d1_databases: [{ binding: "DB", database_id: database }],
      },
    },
  };
}
function releaseTarget(configuration = configured(), environment = "preview") {
  return validateReleaseTarget(
    configuration,
    environment,
    trackingConfigured(),
  );
}
const validateTrackingReleaseTarget = validateReleaseTarget;
const migrations = ["0001_initial.sql", "0002_auth.sql"];
function responses(overrides: Record<string, unknown> = {}) {
  const seen: string[] = [];
  const fetcher = vi.fn(
    async (input: string | URL | Request, options?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      seen.push(path);
      const value = overrides[path];
      if (value !== undefined) return Response.json(value);
      if (path.endsWith("/query")) {
        expect(JSON.parse(String(options?.body))).toEqual({
          sql: "SELECT name FROM d1_migrations ORDER BY name",
        });
        return Response.json({
          success: true,
          result: [
            { success: true, results: migrations.map((name) => ({ name })) },
          ],
        });
      }
      if (path.endsWith("/secrets"))
        return Response.json({
          success: true,
          result: [
            "GOOGLE_CLIENT_SECRET",
            "R2_ACCESS_KEY_ID",
            "R2_SECRET_ACCESS_KEY",
          ].map((name) => ({ name, type: "secret_text" })),
        });
      if (path.endsWith("/schedules"))
        return Response.json({
          success: true,
          result: { schedules: [{ cron: "*/15 * * * *" }] },
        });
      if (path.endsWith("/namespaces"))
        return Response.json({
          success: true,
          result: [{ id: namespace }],
          result_info: { total_count: 1 },
        });
      if (path.includes("/r2/buckets/"))
        return Response.json({
          success: true,
          result: { name: "ages-preview-media" },
        });
      return Response.json({ success: true, result: { uuid: database } });
    },
  );
  return { fetcher, seen };
}

describe("Release environment isolation", () => {
  it("requires an explicit named environment and never releases the local default", () => {
    expect(() => releaseTarget(configured(), "local")).toThrow(
      "named environment",
    );
    expect(releaseTarget(configured(), "preview").databaseId).toBe(database);
  });
  it("rejects placeholders and a preview binding that points at production", () => {
    const config = configured();
    const [preview] = config.env.preview.d1_databases;
    const [production] = config.env.production.d1_databases;
    if (!preview || !production) throw new Error("Missing fixture binding");
    preview.database_id = "REPLACE_PREVIEW_D1_ID";
    expect(() => releaseTarget(config, "preview")).toThrow("DB");
    preview.database_id = production.database_id;
    expect(() => releaseTarget(config, "preview")).toThrow("isolation");
  });
  it("requires canonical HTTPS routing, direct-upload configuration and Worker route precedence", () => {
    const config = configured();
    config.env.preview.vars.APP_ORIGIN = "http://preview.example.test";
    expect(() => releaseTarget(config, "preview")).toThrow("APP_ORIGIN");
    config.env.preview.vars.APP_ORIGIN = "https://preview.example.test";
    config.env.preview.vars.R2_BUCKET_NAME = "different-bucket";
    expect(() => releaseTarget(config, "preview")).toThrow("R2_BUCKET_NAME");
    config.env.preview.vars.R2_BUCKET_NAME = "ages-preview-media";
    config.assets.run_worker_first = ["/api/*"];
    expect(() => releaseTarget(config, "preview")).toThrow("Worker route");

    const missingContentNodeRoute = configured();
    missingContentNodeRoute.assets.run_worker_first =
      missingContentNodeRoute.assets.run_worker_first.filter(
        (route) => route !== "/c" && route !== "/c/*",
      );
    expect(() => releaseTarget(missingContentNodeRoute, "preview")).toThrow(
      "Worker route",
    );
  });
  it("never accepts credential values in committed configuration", () => {
    const config = configured();
    Object.assign(config.env.preview.vars, {
      GOOGLE_CLIENT_SECRET: "synthetic-sensitive-value",
    });
    expect(() => releaseTarget(config, "preview")).toThrow("secret storage");
  });
  it("binds every environment to the declared account and exact application entry points", () => {
    const config = configured();
    const preview = config.env.preview as Record<string, unknown>;
    const previewVars = preview.vars as Record<string, string>;
    preview.account_id = "d".repeat(32);
    previewVars.R2_ACCOUNT_ID = "d".repeat(32);
    expect(() => releaseTarget(config, "preview")).toThrow("account");
    delete preview.account_id;
    previewVars.R2_ACCOUNT_ID = account;
    config.main = "src/other.ts";
    expect(() => releaseTarget(config, "preview")).toThrow("Worker entry");
    config.main = "src/index.ts";
    config.assets.directory = "./public";
    expect(() => releaseTarget(config, "preview")).toThrow("assets directory");
  });
  it("requires the deployed scheduled cleanup cadence", () => {
    const config = configured();
    config.triggers.crons = ["0 0 * * *"];
    expect(() => releaseTarget(config, "preview")).toThrow("15-minute cleanup");
  });
  it("checks the inherited custom-domain route used by Wrangler environments", () => {
    const config = configured();
    (config as Record<string, unknown>).routes = config.env.preview.routes;
    delete (config.env.preview as Record<string, unknown>).routes;
    expect(releaseTarget(config, "preview").workerName).toBe("ages-preview");
  });
  it("rejects matching or nested registrable-domain declarations", () => {
    const config = configured();
    config.env.preview.vars.TRACKING_REGISTRABLE_DOMAIN = "example.test";
    expect(() => releaseTarget(config, "preview")).toThrow(
      "separate registrable domains",
    );

    config.env.preview.vars.TRACKING_REGISTRABLE_DOMAIN = "events.example.test";
    expect(() => releaseTarget(config, "preview")).toThrow(
      "separate registrable domains",
    );

    config.env.preview.vars.APP_REGISTRABLE_DOMAIN = "sub.tracking.test";
    config.env.preview.vars.TRACKING_REGISTRABLE_DOMAIN = "tracking.test";
    expect(() => releaseTarget(config, "preview")).toThrow(
      "separate registrable domains",
    );
  });
  it("rejects origins outside their declared domains or with the same origin", () => {
    const config = configured();
    config.env.preview.vars.APP_ORIGIN = "https://outside.example.net";
    expect(() => releaseTarget(config, "preview")).toThrow(
      "APP_ORIGIN must belong to APP_REGISTRABLE_DOMAIN",
    );

    config.env.preview.vars.APP_ORIGIN = "https://preview.example.test";
    config.env.preview.vars.TRACKING_ORIGIN =
      "https://outside.tracking-example.test";
    expect(() => releaseTarget(config, "preview")).toThrow(
      "TRACKING_ORIGIN must belong to TRACKING_REGISTRABLE_DOMAIN",
    );

    config.env.preview.vars.TRACKING_ORIGIN =
      config.env.preview.vars.APP_ORIGIN;
    expect(() => releaseTarget(config, "preview")).toThrow("different origins");
  });
  it("requires an explicit HTTPS tracking origin and both domain declarations", () => {
    const config = configured();
    config.env.preview.vars.TRACKING_ORIGIN = "http://events.tracking.test";
    expect(() => releaseTarget(config, "preview")).toThrow(
      "exact HTTPS TRACKING_ORIGIN",
    );

    config.env.preview.vars.TRACKING_ORIGIN = "https://events.tracking.test";
    delete (config.env.preview.vars as Record<string, string>)
      .TRACKING_REGISTRABLE_DOMAIN;
    expect(() => releaseTarget(config, "preview")).toThrow(
      "TRACKING_REGISTRABLE_DOMAIN",
    );
  });
  it("requires a dedicated tracking Worker route and its single ticket D1 binding", () => {
    const tracking = trackingConfigured();
    expect(
      validateTrackingReleaseTarget(configured(), "preview", tracking)
        .trackingWorkerName,
    ).toBe("ages-tracking-preview");
    tracking.env.preview.routes = [];
    expect(() =>
      validateTrackingReleaseTarget(configured(), "preview", tracking),
    ).toThrow("only the exact tracking custom-domain route");

    tracking.env.preview.routes = [
      { pattern: "events.tracking.test", custom_domain: true },
    ];
    tracking.env.preview.d1_databases = [
      { binding: "DB", database_id: database },
      {
        binding: "OTHER_DB",
        database_id: "33333333-3333-4333-8333-333333333333",
      },
    ];
    expect(() =>
      validateTrackingReleaseTarget(configured(), "preview", tracking),
    ).toThrow("only its ticket D1 binding");

    tracking.env.preview.d1_databases = [
      { binding: "DB", database_id: "44444444-4444-4444-8444-444444444444" },
    ];
    expect(() =>
      validateTrackingReleaseTarget(configured(), "preview", tracking),
    ).toThrow("must match the ticket database");
  });
  it("rejects an extra app-host route on the tracking Worker", () => {
    const extraRoute = trackingConfigured();
    extraRoute.env.preview.routes = [
      { pattern: "events.tracking.test", custom_domain: true },
      { pattern: "preview.example.test", custom_domain: true },
    ];
    expect(() =>
      validateTrackingReleaseTarget(configured(), "preview", extraRoute),
    ).toThrow("only the exact tracking custom-domain route");
  });

  it("rejects a legacy selected-environment route on the tracking Worker", () => {
    const legacyEnvironmentRoute = trackingConfigured();
    (legacyEnvironmentRoute.env.preview as Record<string, unknown>).route =
      "preview.example.test/*";
    expect(() =>
      validateTrackingReleaseTarget(
        configured(),
        "preview",
        legacyEnvironmentRoute,
      ),
    ).toThrow("only the exact tracking custom-domain route");
  });

  it("rejects a legacy top-level route on the tracking Worker", () => {
    const legacyTopLevelRoute = trackingConfigured();
    (legacyTopLevelRoute as Record<string, unknown>).route =
      "preview.example.test/*";
    expect(() =>
      validateTrackingReleaseTarget(
        configured(),
        "preview",
        legacyTopLevelRoute,
      ),
    ).toThrow("only the exact tracking custom-domain route");
  });
  it("rejects a tracking Worker name that matches the app Worker", () => {
    const tracking = trackingConfigured();
    (tracking.env.preview as Record<string, unknown>).name = "ages-preview";

    expect(() =>
      validateTrackingReleaseTarget(configured(), "preview", tracking),
    ).toThrow("different name from the application Worker");
  });
  it("rejects application bindings and assets on the tracking Worker", () => {
    const tracking = trackingConfigured();
    (tracking.env.preview as Record<string, unknown>).r2_buckets = [
      { binding: "MEDIA", bucket_name: "ages-preview-media" },
    ];
    expect(() =>
      validateTrackingReleaseTarget(configured(), "preview", tracking),
    ).toThrow("only its ticket D1 binding");

    delete (tracking.env.preview as Record<string, unknown>).r2_buckets;
    (tracking as Record<string, unknown>).assets = {
      directory: "./dist/client",
    };
    expect(() =>
      validateTrackingReleaseTarget(configured(), "preview", tracking),
    ).toThrow("only its ticket D1 binding");
  });
});

describe("Read-only release resource verification", () => {
  it("rejects blank credentials before making provider requests", async () => {
    const { fetcher } = responses();
    await expect(
      verifyReleaseResources(
        releaseTarget(configured(), "preview"),
        "   ",
        migrations,
        fetcher,
      ),
    ).rejects.toThrow("CLOUDFLARE_API_TOKEN");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("verifies actual bindings, secret names and the complete migration ledger", async () => {
    const { fetcher, seen } = responses();
    await verifyReleaseResources(
      releaseTarget(configured(), "preview"),
      "synthetic-token",
      migrations,
      fetcher,
    );
    expect(seen).toHaveLength(6);
    expect(
      seen.every((path) => path.startsWith(`/client/v4/accounts/${account}/`)),
    ).toBe(true);
    const methods = fetcher.mock.calls.map(
      ([, options]) => options?.method ?? "GET",
    );
    expect(methods).toEqual(["GET", "GET", "GET", "GET", "GET", "POST"]);
    expect(fetcher.mock.calls.at(-1)?.[1]?.body).toBe(
      JSON.stringify({ sql: "SELECT name FROM d1_migrations ORDER BY name" }),
    );
  });
  it("finds the configured namespace after a full KV page without skipping pages", async () => {
    const paths: string[] = [];
    const { fetcher } = responses();
    fetcher.mockImplementation(async (input) => {
      const url = new URL(String(input));
      const path = url.pathname;
      paths.push(url.href);
      if (
        path.endsWith("/namespaces") &&
        url.searchParams.get("page") === "1"
      ) {
        return Response.json({
          success: true,
          result: Array.from({ length: 1000 }, (_, index) => ({
            id: `namespace-${index}`,
          })),
        });
      }
      if (
        path.endsWith("/namespaces") &&
        url.searchParams.get("page") === "2"
      ) {
        return Response.json({ success: true, result: [{ id: namespace }] });
      }
      if (path.endsWith("/query")) {
        return Response.json({
          success: true,
          result: [
            { success: true, results: migrations.map((name) => ({ name })) },
          ],
        });
      }
      if (path.endsWith("/secrets")) {
        return Response.json({
          success: true,
          result: [
            "GOOGLE_CLIENT_SECRET",
            "R2_ACCESS_KEY_ID",
            "R2_SECRET_ACCESS_KEY",
          ].map((name) => ({ name, type: "secret_text" })),
        });
      }
      if (path.endsWith("/schedules")) {
        return Response.json({
          success: true,
          result: { schedules: [{ cron: "*/15 * * * *" }] },
        });
      }
      if (path.includes("/r2/buckets/"))
        return Response.json({
          success: true,
          result: { name: "ages-preview-media" },
        });
      return Response.json({ success: true, result: { uuid: database } });
    });
    await verifyReleaseResources(
      releaseTarget(configured(), "preview"),
      "synthetic-token",
      migrations,
      fetcher,
    );
    expect(paths.filter((path) => path.includes("/namespaces?"))).toEqual([
      expect.stringContaining("page=1"),
      expect.stringContaining("page=2"),
    ]);
  });
  it("blocks an unapplied migration and a database newer than the checked-out code", async () => {
    const path = `/client/v4/accounts/${account}/d1/database/${database}/query`;
    for (const names of [[migrations[0]], [...migrations, "0003_future.sql"]]) {
      const { fetcher } = responses({
        [path]: {
          success: true,
          result: [{ success: true, results: names.map((name) => ({ name })) }],
        },
      });
      await expect(
        verifyReleaseResources(
          releaseTarget(configured(), "preview"),
          "synthetic-token",
          migrations,
          fetcher,
        ),
      ).rejects.toThrow("migration");
    }
  });
  it("blocks deployment when the live Worker lacks its cleanup schedule", async () => {
    const path = `/client/v4/accounts/${account}/workers/scripts/ages-preview/schedules`;
    const { fetcher } = responses({
      [path]: { success: true, result: { schedules: [] } },
    });
    await expect(
      verifyReleaseResources(
        releaseTarget(configured(), "preview"),
        "synthetic-token",
        migrations,
        fetcher,
      ),
    ).rejects.toThrow("15-minute cleanup schedule");
  });
  it("blocks missing secrets without fetching or printing their values", async () => {
    const path = `/client/v4/accounts/${account}/workers/scripts/ages-preview/secrets`;
    const { fetcher } = responses({
      [path]: {
        success: true,
        result: [
          {
            name: "GOOGLE_CLIENT_SECRET",
            type: "secret_text",
            text: "never-print-this",
          },
        ],
      },
    });
    await expect(
      verifyReleaseResources(
        releaseTarget(configured(), "preview"),
        "synthetic-token",
        migrations,
        fetcher,
      ),
    ).rejects.toThrow("R2_ACCESS_KEY_ID");
  });
  it("fails closed on provider errors and never includes their potentially sensitive message", async () => {
    const path = `/client/v4/accounts/${account}/r2/buckets/ages-preview-media`;
    const { fetcher } = responses({
      [path]: { success: false, errors: [{ message: "never-print-this" }] },
    });
    try {
      await verifyReleaseResources(
        releaseTarget(configured(), "preview"),
        "synthetic-token",
        migrations,
        fetcher,
      );
      throw new Error("Preflight unexpectedly passed");
    } catch (error) {
      expect(String(error)).toContain("R2 bucket");
      expect(String(error)).not.toContain("never-print-this");
    }
  });
});
