import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

test("the OKE simulator accepts a signed photo over HTTP and serves the completed bytes", {
  timeout: 60_000,
}, async (t) => {
  const root = resolve(import.meta.dirname, "../..");
  const work = mkdtempSync(join(tmpdir(), "ages-oke-upload-"));
  let worker;
  t.after(async () => {
    if (worker && worker.exitCode === null && worker.signalCode === null) {
      const exited = once(worker, "close");
      worker.kill("SIGTERM");
      await exited;
    }
    rmSync(work, { recursive: true, force: true });
  });
  const probe = createServer();
  await new Promise((done) => probe.listen(0, "127.0.0.1", done));
  const port = String(probe.address().port);
  await new Promise((done) => probe.close(done));
  const origin = `http://127.0.0.1:${port}`;
  const options = {
    cwd: work,
    stdio: "ignore",
    env: {
      ...process.env,
      WRANGLER_LOG_PATH: join(work, "logs"),
      WRANGLER_REGISTRY_PATH: join(work, "registry"),
    },
  };
  delete options.env.GOOGLE_CLIENT_ID;
  delete options.env.GOOGLE_CLIENT_SECRET;
  execFileSync(
    process.execPath,
    [join(root, "deploy/oke-dev/configure-runtime.mjs"), work, port],
    options,
  );
  appendFileSync(join(work, ".dev.vars"), "LOCAL_LOGIN_ENABLED=true\n");
  const cli = join(root, "node_modules/wrangler/bin/wrangler.js");
  const flags = [
    "--config",
    join(work, "wrangler.json"),
    "--local",
    "--env",
    "",
    "--persist-to",
    join(work, "state"),
  ];
  execFileSync(
    process.execPath,
    [cli, "d1", "migrations", "apply", "DB", ...flags],
    options,
  );
  worker = spawn(
    process.execPath,
    [
      cli,
      "dev",
      "--ip",
      "127.0.0.1",
      "--port",
      port,
      "--log-level",
      "warn",
      ...flags,
    ],
    options,
  );

  let ready = false;
  for (let attempt = 0; attempt < 120 && !ready; attempt++) {
    assert.equal(
      worker.exitCode,
      null,
      "Wrangler exited before serving local bindings",
    );
    ready = await fetch(`${origin}/health/ready`).then(
      (r) => r.ok,
      () => false,
    );
    if (!ready) await delay(100);
  }
  assert.ok(ready, "Local bindings did not become ready");
  const login = await fetch(`${origin}/auth/local`, {
    method: "POST",
    headers: { Origin: origin },
    redirect: "manual",
  });
  assert.equal(login.status, 303);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const json = {
    Origin: origin,
    Cookie: cookie,
    "Content-Type": "application/json",
  };
  const photo = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
    "base64",
  );
  const intent = await fetch(`${origin}/api/assets/upload-intent`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({
      filename: "test.png",
      mime_type: "image/png",
      size_bytes: photo.length,
    }),
  });
  assert.equal(intent.status, 201);
  const { upload, asset } = await intent.json();
  const url = new URL(upload.url);
  assert.equal(url.origin, origin);
  assert.ok(url.pathname.startsWith("/cdn-cgi/local/r2/s3/ages-media-local/"));
  const put = { method: "PUT", headers: upload.headers, body: photo };
  assert.equal(
    (
      await fetch(upload.url, {
        ...put,
        headers: { ...upload.headers, "Content-Type": "image/gif" },
      })
    ).status,
    403,
  );
  assert.equal((await fetch(upload.url, put)).status, 200);
  assert.equal((await fetch(upload.url, put)).status, 412);
  const complete = await fetch(`${origin}/api/assets/${asset.id}/complete`, {
    method: "POST",
    headers: json,
    body: "{}",
  });
  assert.equal(complete.status, 200);
  const result = await complete.json();
  assert.equal(result.asset.status, "ready");
  assert.equal(result.asset.width, 1);
  const media = await fetch(`${origin}/api/assets/${asset.id}/media`, {
    headers: { Cookie: cookie },
  });
  assert.equal(media.status, 200);
  assert.equal(media.headers.get("Content-Type"), "image/png");
  assert.deepEqual(Buffer.from(await media.arrayBuffer()), photo);
});
