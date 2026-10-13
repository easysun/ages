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
    preview_urls: false,
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
function workersDevConfiguration(
  environment: "preview" | "production" = "preview",
) {
  const configuration = configured();
  const appEnvironment = configuration.env[environment] as unknown as Record<
    string,
    unknown
  >;
  const appVars = appEnvironment.vars as Record<string, unknown>;
  const appOrigin = "https://app.example.test";
  const trackingOrigin = `https://ages-tracking-${environment}.account.workers.dev`;
  Object.assign(appVars, {
    APP_ENV: environment,
    APP_ORIGIN: appOrigin,
    TRACKING_ORIGIN: trackingOrigin,
    APP_REGISTRABLE_DOMAIN: "example.test",
    TRACKING_REGISTRABLE_DOMAIN: "account.workers.dev",
    R2_ACCOUNT_ID: account,
    R2_BUCKET_NAME: `ages-${environment}-media`,
  });
  appEnvironment.name = `ages-${environment}`;
  appEnvironment.routes = [
    { pattern: "app.example.test", custom_domain: true },
  ];
  appEnvironment.r2_buckets = [
    { binding: "MEDIA", bucket_name: `ages-${environment}-media` },
  ];

  const trackingConfiguration = trackingConfigured();
  const trackingRoot = trackingConfiguration as unknown as Record<
    string,
    unknown
  >;
  trackingRoot.workers_dev = true;
  trackingRoot.preview_urls = false;
  const trackingEnvironments = trackingRoot.env as Record<string, unknown>;
  const preview = trackingEnvironments.preview as Record<string, unknown>;
  const trackingVars = preview.vars as Record<string, unknown>;
  const selectedTrackingEnvironment = {
    ...preview,
    name: `ages-tracking-${environment}`,
    vars: {
      ...trackingVars,
      APP_ENV: environment,
      APP_ORIGIN: appOrigin,
      TRACKING_ORIGIN: trackingOrigin,
    },
    routes: [],
    d1_databases: [
      {
        binding: "DB",
        database_id: (
          appEnvironment.d1_databases as Array<{ database_id: string }>
        )[0]?.database_id,
      },
    ],
  };
  trackingEnvironments[environment] = selectedTrackingEnvironment;
  return { configuration, trackingConfiguration };
}
function releaseTarget(
  configuration = configured(),
  environment = "preview",
  trackingConfiguration = trackingConfigured(),
) {
  return validateReleaseTarget(
    configuration,
    environment,
    trackingConfiguration,
  );
}
const validateTrackingReleaseTarget = validateReleaseTarget;
const migrations = ["0001_initial.sql", "0002_auth.sql"];
function responses(
  overrides: Record<string, unknown> = {},
  accountSubdomain = "account",
) {
  const seen: string[] = [];
  const fetcher = vi.fn(
    async (input: string | URL | Request, options?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      seen.push(path);
      const value = overrides[path];
      if (value !== undefined) return Response.json(value);
      if (path.endsWith("/workers/subdomain"))
        return Response.json({
          success: true,
          result: { subdomain: accountSubdomain },
        });
      const subdomainScript = path.match(
        /\/workers\/scripts\/([^/]+)\/subdomain$/,
      )?.[1];
      if (subdomainScript)
        return Response.json({
          success: true,
          result: {
            enabled: subdomainScript.startsWith("ages-tracking-"),
            previews_enabled: false,
          },
        });
      if (/\/workers\/scripts\/ages-tracking-[^/]+\/secrets$/.test(path))
        return Response.json({ success: true, result: [] });
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
  it("preserves the custom-domain tracking route mode", () => {
    expect(releaseTarget().trackingRoute).toEqual({ kind: "custom-domain" });
  });
  it("does not accept a workers.dev origin through the custom-domain route mode", () => {
    const { configuration, trackingConfiguration } = workersDevConfiguration();
    const tracking = trackingConfiguration as unknown as {
      workers_dev: boolean;
      env: { preview: Record<string, unknown> };
    };
    tracking.workers_dev = false;
    tracking.env.preview.routes = [
      {
        pattern: new URL(
          configuration.env.preview.vars.TRACKING_ORIGIN as string,
        ).hostname,
        custom_domain: true,
      },
    ];

    expect(() =>
      releaseTarget(configuration, "preview", trackingConfiguration),
    ).toThrow("workers_dev:true");
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

  it("accepts exact account-owned workers.dev tracking origins for preview and production", () => {
    for (const environment of ["preview", "production"] as const) {
      const { configuration, trackingConfiguration } =
        workersDevConfiguration(environment);
      const target = releaseTarget(
        configuration,
        environment,
        trackingConfiguration,
      );

      expect(target.trackingRoute).toEqual({
        kind: "workers-dev",
        accountSubdomain: "account",
      });
      expect(target.trackingRegistrableDomain).toBe("account.workers.dev");
    }
  });

  it.each([
    [
      "https://preview-ages-tracking-preview.account.workers.dev",
      "TRACKING_ORIGIN",
    ],
    ["https://other.account.workers.dev", "TRACKING_ORIGIN"],
    [
      "https://ages-tracking-preview.other-account.workers.dev",
      "TRACKING_REGISTRABLE_DOMAIN",
    ],
    [
      "https://ages-tracking-preview.account.extra.workers.dev",
      "TRACKING_ORIGIN",
    ],
    ["https://AGES-TRACKING-PREVIEW.account.workers.dev", "TRACKING_ORIGIN"],
    [
      "https://ages-tracking-preview.account.workers.dev:8443",
      "TRACKING_ORIGIN",
    ],
    [
      "https://ages-tracking-preview.account.workers.dev/path",
      "TRACKING_ORIGIN",
    ],
    [
      "https://ages-tracking-preview.account.workers.dev?query=1",
      "TRACKING_ORIGIN",
    ],
    [
      "https://ages-tracking-preview.account.workers.dev#fragment",
      "TRACKING_ORIGIN",
    ],
    ["http://ages-tracking-preview.account.workers.dev", "TRACKING_ORIGIN"],
  ])(
    "rejects a noncanonical workers.dev tracking origin: %s",
    (origin, message) => {
      const { configuration, trackingConfiguration } =
        workersDevConfiguration();
      const vars = (
        trackingConfiguration as unknown as {
          env: { preview: Record<string, unknown> };
        }
      ).env.preview.vars as Record<string, unknown>;
      vars.TRACKING_ORIGIN = origin;
      (
        configuration.env.preview.vars as Record<string, unknown>
      ).TRACKING_ORIGIN = origin;

      expect(() =>
        releaseTarget(configuration, "preview", trackingConfiguration),
      ).toThrow(message);
    },
  );

  it.each([
    "workers.dev",
    "ages-tracking-preview.account.workers.dev",
    "sibling.account.workers.dev",
    "account.workers.dev.attacker.test",
  ])(
    "rejects a forged workers.dev registrable-domain declaration: %s",
    (domain) => {
      const { configuration, trackingConfiguration } =
        workersDevConfiguration();
      (
        configuration.env.preview.vars as Record<string, unknown>
      ).TRACKING_REGISTRABLE_DOMAIN = domain;

      expect(() =>
        releaseTarget(configuration, "preview", trackingConfiguration),
      ).toThrow("TRACKING_REGISTRABLE_DOMAIN");
    },
  );

  it.each([
    [
      "false",
      (tracking: Record<string, unknown>) => {
        tracking.workers_dev = false;
      },
    ],
    [
      "missing",
      (tracking: Record<string, unknown>) => {
        delete tracking.workers_dev;
      },
    ],
  ])(
    "requires explicit workers_dev:true for tracking workers.dev mode (%s)",
    (_, mutate) => {
      const { configuration, trackingConfiguration } =
        workersDevConfiguration();
      mutate(trackingConfiguration as Record<string, unknown>);
      expect(() =>
        releaseTarget(configuration, "preview", trackingConfiguration),
      ).toThrow("workers_dev");
    },
  );

  it.each([
    [
      "enabled",
      (tracking: Record<string, unknown>) => {
        tracking.preview_urls = true;
      },
    ],
    [
      "missing",
      (tracking: Record<string, unknown>) => {
        delete tracking.preview_urls;
      },
    ],
  ])(
    "requires explicit preview_urls:false for tracking workers.dev mode (%s)",
    (_, mutate) => {
      const { configuration, trackingConfiguration } =
        workersDevConfiguration();
      mutate(trackingConfiguration as Record<string, unknown>);
      expect(() =>
        releaseTarget(configuration, "preview", trackingConfiguration),
      ).toThrow("preview_urls");
    },
  );

  it.each([
    [
      "top-level routes",
      (tracking: Record<string, unknown>) => {
        tracking.routes = [
          { pattern: "app.example.test", custom_domain: true },
        ];
      },
    ],
    [
      "top-level legacy route",
      (tracking: Record<string, unknown>) => {
        tracking.route = "app.example.test/*";
      },
    ],
    [
      "environment routes",
      (tracking: Record<string, unknown>) => {
        (
          tracking as unknown as {
            env: { preview: Record<string, unknown> };
          }
        ).env.preview.routes = [
          { pattern: "app.example.test", custom_domain: true },
        ];
      },
    ],
    [
      "environment legacy route",
      (tracking: Record<string, unknown>) => {
        (
          tracking as unknown as {
            env: { preview: Record<string, unknown> };
          }
        ).env.preview.route = "app.example.test/*";
      },
    ],
  ])("rejects %s in workers.dev tracking mode", (_, mutate) => {
    const { configuration, trackingConfiguration } = workersDevConfiguration();
    mutate(trackingConfiguration as Record<string, unknown>);
    expect(() =>
      releaseTarget(configuration, "preview", trackingConfiguration),
    ).toThrow("routes");
  });

  it("allows empty route arrays to explicitly suppress top-level route inheritance", () => {
    const { configuration, trackingConfiguration } = workersDevConfiguration();
    const tracking = trackingConfiguration as unknown as {
      env: { preview: Record<string, unknown> };
      routes?: unknown;
    };
    tracking.routes = [];
    tracking.env.preview.routes = [];

    expect(
      releaseTarget(configuration, "preview", trackingConfiguration)
        .trackingRoute,
    ).toEqual({ kind: "workers-dev", accountSubdomain: "account" });
  });

  it("keeps the app on one explicit custom domain with workers.dev and preview URLs disabled", () => {
    const { configuration, trackingConfiguration } = workersDevConfiguration();
    expect(
      releaseTarget(configuration, "preview", trackingConfiguration).appOrigin,
    ).toBe("https://app.example.test");
  });

  it.each([
    [
      "workers.dev enabled",
      (config: Record<string, unknown>) => {
        config.workers_dev = true;
      },
    ],
    [
      "workers.dev implicit",
      (config: Record<string, unknown>) => {
        delete config.workers_dev;
      },
    ],
    [
      "preview URLs enabled",
      (config: Record<string, unknown>) => {
        config.preview_urls = true;
      },
    ],
    [
      "preview URLs implicit",
      (config: Record<string, unknown>) => {
        delete config.preview_urls;
      },
    ],
  ])("requires app workers.dev and preview URLs disabled (%s)", (_, mutate) => {
    const { configuration, trackingConfiguration } = workersDevConfiguration();
    mutate(configuration as unknown as Record<string, unknown>);
    expect(() =>
      releaseTarget(configuration, "preview", trackingConfiguration),
    ).toThrow("application Worker");
  });

  it.each([
    [
      "a second custom domain",
      (config: Record<string, unknown>) => {
        (
          config as unknown as {
            env: { preview: Record<string, unknown> };
          }
        ).env.preview.routes = [
          { pattern: "app.example.test", custom_domain: true },
          { pattern: "alias.example.test", custom_domain: true },
        ];
      },
    ],
    [
      "a legacy route",
      (config: Record<string, unknown>) => {
        (
          config as unknown as {
            env: { preview: Record<string, unknown> };
          }
        ).env.preview.route = "alias.example.test/*";
      },
    ],
  ])("requires one exact app custom-domain route without %s", (_, mutate) => {
    const { configuration, trackingConfiguration } = workersDevConfiguration();
    mutate(configuration as unknown as Record<string, unknown>);
    expect(() =>
      releaseTarget(configuration, "preview", trackingConfiguration),
    ).toThrow("application custom-domain route");
  });

  it("rejects an app hostname under workers.dev even when APP_REGISTRABLE_DOMAIN claims otherwise", () => {
    const { configuration, trackingConfiguration } = workersDevConfiguration();
    Object.assign(configuration.env.preview.vars, {
      APP_ORIGIN: "https://app.account.workers.dev",
      APP_REGISTRABLE_DOMAIN: "example.test",
    });
    configuration.env.preview.routes = [
      { pattern: "app.account.workers.dev", custom_domain: true },
    ];

    expect(() =>
      releaseTarget(configuration, "preview", trackingConfiguration),
    ).toThrow("workers.dev");
  });

  it.each([
    [
      "a forged workers.dev app domain",
      "https://app.example.test",
      "account.workers.dev",
    ],
    [
      "an app origin outside its declared domain",
      "https://app.attacker.test",
      "example.test",
    ],
  ])("rejects %s", (_, appOrigin, appDomain) => {
    const { configuration, trackingConfiguration } = workersDevConfiguration();
    const trackingPreview = (
      trackingConfiguration as unknown as {
        env: { preview: Record<string, unknown> };
      }
    ).env.preview;
    Object.assign(configuration.env.preview.vars, {
      APP_ORIGIN: appOrigin,
      APP_REGISTRABLE_DOMAIN: appDomain,
    });
    trackingPreview.vars = {
      ...(trackingPreview.vars as Record<string, unknown>),
      APP_ORIGIN: appOrigin,
    };
    configuration.env.preview.routes = [
      { pattern: new URL(appOrigin).hostname, custom_domain: true },
    ];

    expect(() =>
      releaseTarget(configuration, "preview", trackingConfiguration),
    ).toThrow("APP_ORIGIN must belong to its custom domain");
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
  it("checks the exact account workers.dev subdomain and both live script states with GET only", async () => {
    const { configuration, trackingConfiguration } = workersDevConfiguration();
    const target = releaseTarget(
      configuration,
      "preview",
      trackingConfiguration,
    );
    const { fetcher, seen } = responses();

    await verifyReleaseResources(
      target,
      "synthetic-token",
      migrations,
      fetcher,
    );

    expect(seen).toContain(`/client/v4/accounts/${account}/workers/subdomain`);
    expect(seen).toContain(
      `/client/v4/accounts/${account}/workers/scripts/ages-tracking-preview/subdomain`,
    );
    expect(seen).toContain(
      `/client/v4/accounts/${account}/workers/scripts/ages-preview/subdomain`,
    );
    expect(seen).toContain(
      `/client/v4/accounts/${account}/workers/scripts/ages-tracking-preview/secrets`,
    );
    const workerCalls = fetcher.mock.calls.filter(([input]) =>
      new URL(String(input)).pathname.includes("/workers/"),
    );
    expect(
      workerCalls.every(([, options]) => (options?.method ?? "GET") === "GET"),
    ).toBe(true);
  });

  it.each([
    [
      "mismatched account subdomain",
      "/workers/subdomain",
      { success: true, result: { subdomain: "other" } },
      "workers.dev account subdomain",
    ],
    [
      "missing account subdomain",
      "/workers/subdomain",
      { success: true },
      "workers.dev account subdomain",
    ],
    [
      "malformed account subdomain",
      "/workers/subdomain",
      { success: true, result: { subdomain: "bad..name" } },
      "workers.dev account subdomain",
    ],
    [
      "disabled tracking script",
      "/workers/scripts/ages-tracking-preview/subdomain",
      { success: true, result: { enabled: false, previews_enabled: false } },
      "tracking workers.dev URL",
    ],
    [
      "enabled tracking previews",
      "/workers/scripts/ages-tracking-preview/subdomain",
      { success: true, result: { enabled: true, previews_enabled: true } },
      "tracking workers.dev URL",
    ],
    [
      "missing tracking script settings",
      "/workers/scripts/ages-tracking-preview/subdomain",
      { success: true, result: { enabled: true } },
      "tracking workers.dev URL",
    ],
    [
      "enabled app workers.dev URL",
      "/workers/scripts/ages-preview/subdomain",
      { success: true, result: { enabled: true, previews_enabled: false } },
      "application workers.dev URL",
    ],
    [
      "enabled app preview URLs",
      "/workers/scripts/ages-preview/subdomain",
      { success: true, result: { enabled: false, previews_enabled: true } },
      "application workers.dev URL",
    ],
    [
      "missing tracking secret list",
      "/workers/scripts/ages-tracking-preview/secrets",
      { success: true },
      "tracking Worker secret names",
    ],
    [
      "tracking secret exists",
      "/workers/scripts/ages-tracking-preview/secrets",
      {
        success: true,
        result: [{ name: "APP_SESSION_KEY", type: "secret_text" }],
      },
      "tracking Worker secret names",
    ],
  ])(
    "blocks release when live workers.dev control has %s",
    async (_, suffix, payload, message) => {
      const { configuration, trackingConfiguration } =
        workersDevConfiguration();
      const target = releaseTarget(
        configuration,
        "preview",
        trackingConfiguration,
      );
      const path = `/client/v4/accounts/${account}${suffix}`;
      const { fetcher } = responses({ [path]: payload });

      await expect(
        verifyReleaseResources(target, "synthetic-token", migrations, fetcher),
      ).rejects.toThrow(message);
    },
  );

  it("sanitizes failed workers.dev control GET responses and blocks before later checks", async () => {
    const { configuration, trackingConfiguration } = workersDevConfiguration();
    const target = releaseTarget(
      configuration,
      "preview",
      trackingConfiguration,
    );
    const path = `/client/v4/accounts/${account}/workers/subdomain`;
    const { fetcher, seen } = responses({
      [path]: {
        success: false,
        errors: [{ message: "never-print-this" }],
      },
    });

    await expect(
      verifyReleaseResources(target, "synthetic-token", migrations, fetcher),
    ).rejects.toThrow("Could not verify workers.dev account subdomain");
    expect(seen).toEqual([path]);
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
