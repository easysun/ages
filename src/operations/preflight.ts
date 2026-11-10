type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : {};
}
function entries(value: unknown) {
  return Array.isArray(value) ? value.map(record) : [];
}
function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function binding(value: unknown, name: string) {
  const matches = entries(value).filter((row) => row.binding === name);
  requireValue(matches.length === 1, `Configure exactly one ${name} binding.`);
  return matches[0] ?? {};
}
const hexId = /^(?!0+$)[a-f0-9]{32}$/i;
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const requiredSecrets = [
  "GOOGLE_CLIENT_SECRET",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
];
const dnsName =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])$/;
const dnsLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function exactHttpsOrigin(value: unknown, name: string) {
  let url: URL | undefined;
  try {
    url = new URL(typeof value === "string" ? value : "");
  } catch {}
  requireValue(
    url &&
      url.protocol === "https:" &&
      url.origin === value &&
      url.username === "" &&
      url.password === "",
    `Configure an exact HTTPS ${name}.`,
  );
  return url;
}

function declaredDomain(value: unknown, name: string) {
  requireValue(
    typeof value === "string" &&
      value === value.toLowerCase() &&
      dnsName.test(value) &&
      !/^\d+$/.test(value.split(".").at(-1) ?? ""),
    `Configure ${name} as a canonical DNS domain.`,
  );
  return value;
}

function withinDomain(hostname: string, domain: string) {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function isWorkersDevHostname(hostname: string) {
  return hostname === "workers.dev" || hostname.endsWith(".workers.dev");
}

export type TrackingRoute =
  | { kind: "custom-domain" }
  | { kind: "workers-dev"; accountSubdomain: string };

export type ReleaseTarget = {
  environment: string;
  accountId: string;
  workerName: string;
  databaseId: string;
  bucketName: string;
  namespaceId: string;
  appOrigin: string;
  trackingOrigin: string;
  appRegistrableDomain: string;
  trackingRegistrableDomain: string;
  trackingRoute: TrackingRoute;
  trackingWorkerName: string;
  trackingDatabaseId: string;
  googleClientIdConfigured: boolean;
};

function validateTrackingRoute(
  target: Pick<
    ReleaseTarget,
    | "environment"
    | "workerName"
    | "trackingOrigin"
    | "trackingRegistrableDomain"
  >,
  configuration: unknown,
) {
  const config = record(configuration);
  const selected = record(record(config.env)[target.environment]);
  const workerName = selected.name;
  requireValue(
    typeof workerName === "string" &&
      /^[a-z0-9][a-z0-9-]{1,62}$/.test(workerName),
    "Configure a named tracking Worker.",
  );
  requireValue(
    workerName !== target.workerName,
    "The tracking Worker must have a different name from the application Worker.",
  );

  const routeSources = [config, selected];
  const workersDev = selected.workers_dev ?? config.workers_dev;
  if (workersDev === true) {
    requireValue(
      selected.workers_dev === true || config.workers_dev === true,
      "Set workers_dev:true explicitly for workers.dev tracking mode.",
    );
    requireValue(
      (selected.preview_urls ?? config.preview_urls) === false &&
        (selected.preview_urls === false || config.preview_urls === false),
      "Set preview_urls:false explicitly for workers.dev tracking mode.",
    );
    requireValue(
      routeSources.every(
        (source) =>
          !Object.hasOwn(source, "route") &&
          (!Object.hasOwn(source, "routes") ||
            (Array.isArray(source.routes) && source.routes.length === 0)),
      ),
      "The workers.dev tracking Worker must not declare custom or legacy routes.",
    );
    const trackingUrl = exactHttpsOrigin(
      target.trackingOrigin,
      "TRACKING_ORIGIN",
    );
    const labels = trackingUrl.hostname.split(".");
    const accountSubdomain = labels[1] ?? "";
    requireValue(
      trackingUrl.port === "" &&
        labels.length === 4 &&
        labels[0] === workerName &&
        dnsLabel.test(accountSubdomain) &&
        labels[2] === "workers" &&
        labels[3] === "dev",
      "TRACKING_ORIGIN must be exactly <tracking-worker>.<account>.workers.dev.",
    );
    requireValue(
      target.trackingRegistrableDomain === `${accountSubdomain}.workers.dev`,
      "TRACKING_REGISTRABLE_DOMAIN must exactly match the workers.dev account subdomain.",
    );
    return {
      trackingWorkerName: workerName,
      trackingRoute: { kind: "workers-dev", accountSubdomain } as const,
    };
  }

  requireValue(
    !isWorkersDevHostname(new URL(target.trackingOrigin).hostname),
    "Set workers_dev:true explicitly for workers.dev tracking mode.",
  );
  return {
    trackingWorkerName: workerName,
    trackingRoute: { kind: "custom-domain" } as const,
  };
}

function validateTrackingWorkerTarget(
  target: Pick<
    ReleaseTarget,
    | "environment"
    | "accountId"
    | "workerName"
    | "databaseId"
    | "appOrigin"
    | "trackingOrigin"
  >,
  configuration: unknown,
  routeTarget: Pick<ReleaseTarget, "trackingWorkerName" | "trackingRoute">,
) {
  const config = record(configuration);
  const selected = record(record(config.env)[target.environment]);
  requireValue(
    (selected.main ?? config.main) === "src/tracking/index.ts",
    "Preserve the tracking Worker entry point src/tracking/index.ts.",
  );
  requireValue(
    (selected.account_id ?? config.account_id) === undefined ||
      (selected.account_id ?? config.account_id) === target.accountId,
    "The tracking Worker must use the application Cloudflare account.",
  );
  const vars = record(selected.vars);
  const allowedVars = new Set(["APP_ENV", "APP_ORIGIN", "TRACKING_ORIGIN"]);
  for (const source of [record(config.vars), vars])
    requireValue(
      Object.keys(source).every((name) => allowedVars.has(name)),
      "The tracking Worker may contain only its origin and environment variables.",
    );
  requireValue(
    vars.APP_ENV === target.environment &&
      vars.APP_ORIGIN === target.appOrigin &&
      vars.TRACKING_ORIGIN === target.trackingOrigin,
    "The tracking Worker origins must match the named application environment.",
  );

  const forbiddenBindingFields = [
    "r2_buckets",
    "kv_namespaces",
    "assets",
    "services",
    "durable_objects",
    "queues",
    "analytics_engine_datasets",
    "send_email",
    "dispatch_namespaces",
    "hyperdrive",
    "vectorize",
    "ai",
    "browser",
    "images",
    "pipelines",
    "mtls_certificates",
    "secrets_store_secrets",
    "ratelimits",
    "workflows",
    "unsafe",
  ];
  requireValue(
    [config, selected].every((source) =>
      forbiddenBindingFields.every((name) => !(name in source)),
    ),
    "The tracking Worker must have only its ticket D1 binding and no app bindings or assets.",
  );
  const databases = entries(selected.d1_databases ?? config.d1_databases);
  requireValue(
    databases.length === 1 && databases[0]?.binding === "DB",
    "The tracking Worker must have only its ticket D1 binding and no app bindings or assets.",
  );
  const trackingDatabaseId = databases[0]?.database_id;
  requireValue(
    trackingDatabaseId === target.databaseId,
    "The tracking Worker D1 binding must match the ticket database.",
  );
  if (routeTarget.trackingRoute.kind === "custom-domain") {
    requireValue(
      (selected.workers_dev ?? config.workers_dev) === false,
      "Set workers_dev:false for custom-domain tracking mode or workers_dev:true for workers.dev tracking mode.",
    );
    const routeSources = [config, selected];
    const hasLegacyRoute = routeSources.some((source) =>
      Object.hasOwn(source, "route"),
    );
    const routes = entries(selected.routes ?? config.routes);
    const routed =
      !hasLegacyRoute &&
      routes.length === 1 &&
      routes[0]?.custom_domain === true &&
      routes[0]?.pattern === new URL(target.trackingOrigin).hostname;
    requireValue(
      routed,
      "The tracking Worker must declare only the exact tracking custom-domain route or use an explicit workers_dev:true origin.",
    );
  }
  return {
    trackingDatabaseId,
    ...routeTarget,
  };
}

function validateWorkersDevAppTarget(
  configuration: RecordValue,
  selected: RecordValue,
  appUrl: URL,
  appRegistrableDomain: string,
  accountSubdomain: string,
) {
  const sources = [configuration, selected];
  const accountDomain = `${accountSubdomain}.workers.dev`;
  requireValue(
    withinDomain(appUrl.hostname, appRegistrableDomain) &&
      !isWorkersDevHostname(appUrl.hostname) &&
      !isWorkersDevHostname(appRegistrableDomain) &&
      !withinDomain(appUrl.hostname, accountDomain) &&
      !withinDomain(appRegistrableDomain, accountDomain),
    "APP_ORIGIN must belong to its custom domain outside workers.dev.",
  );

  const workersDev = selected.workers_dev ?? configuration.workers_dev;
  const previewUrls = selected.preview_urls ?? configuration.preview_urls;
  requireValue(
    workersDev === false &&
      (selected.workers_dev === false || configuration.workers_dev === false) &&
      previewUrls === false &&
      (selected.preview_urls === false || configuration.preview_urls === false),
    "The application Worker must explicitly set workers_dev:false and preview_urls:false.",
  );

  const expectedRoute = (value: unknown) => {
    const route = record(value);
    return route.custom_domain === true && route.pattern === appUrl.hostname;
  };
  requireValue(
    sources.every(
      (source) =>
        !Object.hasOwn(source, "route") &&
        (!Object.hasOwn(source, "routes") ||
          (Array.isArray(source.routes) &&
            (source.routes.length === 0 ||
              (source.routes.length === 1 &&
                expectedRoute(source.routes[0]))))),
    ),
    "Use only the exact application custom-domain route in workers.dev tracking mode.",
  );
  const effectiveRoutes = selected.routes ?? configuration.routes;
  requireValue(
    Array.isArray(effectiveRoutes) &&
      effectiveRoutes.length === 1 &&
      expectedRoute(effectiveRoutes[0]),
    "Use only the exact application custom-domain route in workers.dev tracking mode.",
  );
}

export function validateReleaseTarget(
  configuration: unknown,
  environment: string,
  trackingConfiguration: unknown,
): ReleaseTarget {
  requireValue(
    ["development", "preview", "production"].includes(environment),
    "Select an explicit named environment: development, preview or production.",
  );
  const config = record(configuration);
  const environments = record(config.env);
  const selected = record(environments[environment]);
  const vars = record(selected.vars);
  const accountId = config.account_id;
  requireValue(
    typeof accountId === "string" && hexId.test(accountId),
    "Configure the Cloudflare account_id.",
  );
  requireValue(
    selected.account_id === undefined || selected.account_id === accountId,
    "The environment account_id must match the declared Cloudflare account.",
  );
  requireValue(
    vars.APP_ENV === environment,
    "APP_ENV must match the selected environment.",
  );
  const workerName = selected.name;
  requireValue(
    typeof workerName === "string" &&
      /^[a-z0-9][a-z0-9-]{1,62}$/.test(workerName),
    "Configure a named Worker.",
  );
  requireValue(
    (selected.main ?? config.main) === "src/index.ts",
    "Preserve the expected Worker entry point src/index.ts.",
  );
  const databaseId = binding(selected.d1_databases, "DB").database_id;
  requireValue(
    typeof databaseId === "string" && uuid.test(databaseId),
    "Configure a real DB database_id.",
  );
  const bucketName = binding(selected.r2_buckets, "MEDIA").bucket_name;
  requireValue(
    typeof bucketName === "string" &&
      /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucketName) &&
      !bucketName.startsWith("ages-media-local"),
    "Configure a real MEDIA bucket.",
  );
  const namespaceId = binding(selected.kv_namespaces, "LINK_CACHE").id;
  requireValue(
    typeof namespaceId === "string" && hexId.test(namespaceId),
    "Configure a real LINK_CACHE namespace.",
  );
  requireValue(
    vars.R2_ACCOUNT_ID === accountId,
    "R2_ACCOUNT_ID must match the selected Cloudflare account.",
  );
  requireValue(
    vars.R2_BUCKET_NAME === bucketName,
    "R2_BUCKET_NAME must match MEDIA.",
  );
  for (const name of requiredSecrets) {
    requireValue(
      !(name in vars) && !(name in record(config.vars)),
      `${name} belongs in platform secret storage.`,
    );
  }
  const url = exactHttpsOrigin(vars.APP_ORIGIN, "APP_ORIGIN");
  const trackingUrl = exactHttpsOrigin(vars.TRACKING_ORIGIN, "TRACKING_ORIGIN");
  const appRegistrableDomain = declaredDomain(
    vars.APP_REGISTRABLE_DOMAIN,
    "APP_REGISTRABLE_DOMAIN",
  );
  const trackingRegistrableDomain = declaredDomain(
    vars.TRACKING_REGISTRABLE_DOMAIN,
    "TRACKING_REGISTRABLE_DOMAIN",
  );
  requireValue(
    url.origin !== trackingUrl.origin,
    "APP_ORIGIN and TRACKING_ORIGIN must use different origins.",
  );
  const target = {
    environment,
    accountId,
    workerName,
    databaseId,
    bucketName,
    namespaceId,
    appOrigin: url.origin,
    trackingOrigin: trackingUrl.origin,
    appRegistrableDomain,
    trackingRegistrableDomain,
    googleClientIdConfigured:
      typeof vars.GOOGLE_CLIENT_ID === "string" &&
      vars.GOOGLE_CLIENT_ID.trim().length > 0,
  };
  const routeTarget = validateTrackingRoute(target, trackingConfiguration);
  if (routeTarget.trackingRoute.kind === "workers-dev") {
    validateWorkersDevAppTarget(
      config,
      selected,
      url,
      appRegistrableDomain,
      routeTarget.trackingRoute.accountSubdomain,
    );
  } else {
    requireValue(
      !withinDomain(appRegistrableDomain, trackingRegistrableDomain) &&
        !withinDomain(trackingRegistrableDomain, appRegistrableDomain),
      "Use separate registrable domains for APP and tracking.",
    );
    requireValue(
      withinDomain(url.hostname, appRegistrableDomain),
      "APP_ORIGIN must belong to APP_REGISTRABLE_DOMAIN.",
    );
    requireValue(
      withinDomain(trackingUrl.hostname, trackingRegistrableDomain),
      "TRACKING_ORIGIN must belong to TRACKING_REGISTRABLE_DOMAIN.",
    );
    const workersDev = selected.workers_dev ?? config.workers_dev;
    const routed = entries(selected.routes ?? config.routes).some(
      (route) => route.custom_domain === true && route.pattern === url.hostname,
    );
    requireValue(
      routed ||
        (workersDev === true &&
          url.hostname.startsWith(`${workerName}.`) &&
          url.hostname.endsWith(".workers.dev")),
      "APP_ORIGIN needs an exact custom domain route or matching workers.dev route.",
    );
  }
  const assets = record(selected.assets ?? config.assets);
  requireValue(
    assets.directory === "./dist/client",
    "Configure the expected static assets directory ./dist/client.",
  );
  const precedence = assets.run_worker_first;
  requireValue(
    Array.isArray(precedence) &&
      ["api", "auth", "health", "t", "c", "s"].every(
        (prefix) =>
          precedence.includes(`/${prefix}`) &&
          precedence.includes(`/${prefix}/*`),
      ),
    "Preserve every Worker route before the SPA fallback.",
  );
  const crons = record(selected.triggers ?? config.triggers).crons;
  requireValue(
    Array.isArray(crons) && crons.includes("*/15 * * * *"),
    "Preserve the 15-minute cleanup schedule before deployment.",
  );
  for (const [name, value] of Object.entries(environments)) {
    if (name === environment) continue;
    const other = record(value);
    requireValue(
      other.name !== workerName &&
        record(other.vars).APP_ORIGIN !== url.origin &&
        record(other.vars).TRACKING_ORIGIN !== trackingUrl.origin &&
        !entries(other.d1_databases).some(
          (row) => row.database_id === databaseId,
        ) &&
        !entries(other.r2_buckets).some(
          (row) => row.bucket_name === bucketName,
        ) &&
        !entries(other.kv_namespaces).some((row) => row.id === namespaceId),
      "Environment isolation requires separate Workers, origins, D1, R2 and KV resources.",
    );
  }
  requireValue(
    !entries(config.d1_databases).some(
      (row) => row.database_id === databaseId,
    ) &&
      !entries(config.r2_buckets).some(
        (row) => row.bucket_name === bucketName,
      ) &&
      !entries(config.kv_namespaces).some((row) => row.id === namespaceId),
    "Environment isolation must exclude local bindings.",
  );
  const trackingTarget = validateTrackingWorkerTarget(
    target,
    trackingConfiguration,
    routeTarget,
  );
  return {
    ...target,
    ...trackingTarget,
  };
}

// Only GETs and a fixed read-only SQL query are issued. Provider bodies/errors never enter logs.
export async function verifyReleaseResources(
  target: ReleaseTarget,
  token: string,
  migrations: string[],
  fetcher: typeof fetch = fetch,
) {
  requireValue(
    token.trim().length > 0,
    "Set CLOUDFLARE_API_TOKEN in the process environment.",
  );
  requireValue(
    migrations.length > 0 && new Set(migrations).size === migrations.length,
    "Provide the complete local migration ledger.",
  );
  const base = `https://api.cloudflare.com/client/v4/accounts/${target.accountId}`;
  async function read(path: string, label: string, sql?: string) {
    try {
      const response = await fetcher(`${base}${path}`, {
        method: sql ? "POST" : "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          ...(sql ? { "Content-Type": "application/json" } : {}),
        },
        ...(sql ? { body: JSON.stringify({ sql }) } : {}),
        signal: AbortSignal.timeout(15_000),
      });
      const payload = record(await response.json());
      if (!response.ok || payload.success !== true) throw new Error();
      return payload;
    } catch {
      throw new Error(`Could not verify ${label}; deployment is blocked.`);
    }
  }
  if (target.trackingRoute.kind === "workers-dev") {
    const accountSubdomain = await read(
      "/workers/subdomain",
      "workers.dev account subdomain",
    );
    const liveSubdomain = record(accountSubdomain.result).subdomain;
    requireValue(
      typeof liveSubdomain === "string" &&
        dnsLabel.test(liveSubdomain) &&
        liveSubdomain === target.trackingRoute.accountSubdomain,
      "The live workers.dev account subdomain does not match TRACKING_ORIGIN; deployment is blocked.",
    );

    const trackingSubdomain = await read(
      `/workers/scripts/${encodeURIComponent(target.trackingWorkerName)}/subdomain`,
      "tracking workers.dev URL",
    );
    const trackingSettings = record(trackingSubdomain.result);
    requireValue(
      trackingSettings.enabled === true &&
        trackingSettings.previews_enabled === false,
      "The tracking workers.dev URL must be enabled with Preview URLs disabled.",
    );

    const appSubdomain = await read(
      `/workers/scripts/${encodeURIComponent(target.workerName)}/subdomain`,
      "application workers.dev URL",
    );
    const appSettings = record(appSubdomain.result);
    requireValue(
      appSettings.enabled === false && appSettings.previews_enabled === false,
      "The application workers.dev URL and Preview URLs must both be disabled.",
    );

    const trackingSecrets = await read(
      `/workers/scripts/${encodeURIComponent(target.trackingWorkerName)}/secrets`,
      "tracking Worker secret names",
    );
    requireValue(
      Array.isArray(trackingSecrets.result) &&
        trackingSecrets.result.length === 0,
      "The tracking Worker secret names must be empty; deployment is blocked.",
    );
  }
  const database = await read(
    `/d1/database/${target.databaseId}`,
    "D1 database",
  );
  requireValue(
    record(database.result).uuid === target.databaseId,
    "D1 database identity does not match DB.",
  );
  const bucket = await read(
    `/r2/buckets/${encodeURIComponent(target.bucketName)}`,
    "R2 bucket",
  );
  requireValue(
    record(bucket.result).name === target.bucketName,
    "R2 bucket identity does not match MEDIA.",
  );
  let namespaceFound = false;
  for (let page = 1; page <= 20; page++) {
    const payload = await read(
      `/storage/kv/namespaces?per_page=1000&page=${page}`,
      "KV namespace",
    );
    const rows = entries(payload.result);
    namespaceFound = rows.some((row) => row.id === target.namespaceId);
    if (namespaceFound || rows.length < 1000) break;
  }
  requireValue(
    namespaceFound,
    "LINK_CACHE could not be verified within 20 namespace pages.",
  );
  const secrets = await read(
    `/workers/scripts/${encodeURIComponent(target.workerName)}/secrets`,
    "Worker secret names",
  );
  const names = new Set(
    entries(secrets.result)
      .filter((row) => row.type === "secret_text")
      .map((row) => row.name),
  );
  for (const name of [
    ...requiredSecrets,
    ...(target.googleClientIdConfigured ? [] : ["GOOGLE_CLIENT_ID"]),
  ]) {
    requireValue(
      names.has(name),
      `Missing platform secret ${name}; deployment is blocked.`,
    );
  }
  const schedules = await read(
    `/workers/scripts/${encodeURIComponent(target.workerName)}/schedules`,
    "Worker cleanup schedule",
  );
  requireValue(
    entries(record(schedules.result).schedules).some(
      (schedule) => schedule.cron === "*/15 * * * *",
    ),
    "The live Worker is missing the 15-minute cleanup schedule.",
  );
  const ledger = await read(
    `/d1/database/${target.databaseId}/query`,
    "D1 migration ledger",
    "SELECT name FROM d1_migrations ORDER BY name",
  );
  const query = entries(ledger.result);
  requireValue(
    query.length === 1 &&
      query[0]?.success === true &&
      Array.isArray(query[0]?.results),
    "Could not verify the D1 migration ledger.",
  );
  const applied = entries(query[0].results).map((row) => row.name);
  requireValue(
    applied.length === migrations.length &&
      migrations.every((name) => applied.includes(name)),
    "The remote migration ledger differs from local code; deployment is blocked.",
  );
}
