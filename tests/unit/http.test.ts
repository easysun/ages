import { env } from "cloudflare:workers";
import { HTTPException } from "hono/http-exception";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createApp } from "../../src/app";
import { ApiError } from "../../src/http/errors";
import { parseJson } from "../../src/http/json";

const infoLog = vi.fn();
const errorLog = vi.fn();

function validationApp() {
  const app = createApp();
  app.post("/api/test-validation", async (context) => {
    const data = await parseJson(
      context,
      z.strictObject({ name: z.string().min(1) }),
    );
    return context.json(data);
  });
  return app;
}

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(infoLog);
  vi.spyOn(console, "error").mockImplementation(errorLog);
});

describe("HTTP contracts", () => {
  it("correlates a response with its log without accepting a client-forged ID", async () => {
    const app = createApp();
    const response = await app.request(
      "/health?token=private-value",
      {
        headers: {
          "X-Request-ID": "client-forged",
          Cookie: "session=private-value",
        },
      },
      env,
    );
    expect(response.status).toBe(200);
    const requestId = response.headers.get("X-Request-ID");
    expect(requestId).toMatch(/^req_[a-f0-9-]{36}$/);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const logs = infoLog.mock.calls.flat().join("\n");
    expect(logs).toContain(requestId);
    expect(logs).not.toContain("private-value");
    expect(logs).not.toContain("client-forged");
  });

  it("gives separate requests different correlation IDs", async () => {
    const app = createApp();
    const first = await app.request("/health", {}, env);
    const second = await app.request("/health", {}, env);
    expect(first.headers.get("X-Request-ID")).not.toBe(
      second.headers.get("X-Request-ID"),
    );
  });

  it("returns a standard 404 without reflecting the requested URL", async () => {
    const response = await createApp().request(
      "/missing/private-value",
      {},
      env,
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: {
        code: "NOT_FOUND",
        message: "Resource not found.",
        request_id: response.headers.get("X-Request-ID"),
      },
    });
    expect(JSON.stringify(infoLog.mock.calls)).not.toContain("private-value");
  });

  it("does not expose unexpected error messages or stacks in responses or logs", async () => {
    const app = createApp();
    app.get("/test-failure", () => {
      throw new Error("secret-database-connection");
    });
    const response = await app.request("/test-failure", {}, env);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: {
        code: "INTERNAL_ERROR",
        message: "An unexpected error occurred.",
        request_id: response.headers.get("X-Request-ID"),
      },
    });
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(
      "secret-database-connection",
    );
    expect(JSON.stringify(errorLog.mock.calls)).toContain(
      response.headers.get("X-Request-ID"),
    );
  });

  it("preserves intentional client errors", async () => {
    const app = createApp();
    app.get("/test-conflict", () => {
      throw new ApiError("CONFLICT");
    });
    const response = await app.request("/test-conflict", {}, env);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "CONFLICT" },
    });
  });

  it("normalizes framework parse errors without exposing their cause", async () => {
    const app = createApp();
    app.post("/api/test-parser", () => {
      throw new HTTPException(400, { message: "private-value" });
    });
    const response = await app.request(
      "/api/test-parser",
      { method: "POST" },
      env,
    );
    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).toContain("INVALID_REQUEST");
    expect(body).not.toContain("private-value");
  });
});

describe("JSON validation", () => {
  it("parses validated JSON with a charset", async () => {
    const response = await validationApp().request(
      "/api/test-validation",
      {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ name: "A memory" }),
      },
      env,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ name: "A memory" });
  });

  it.each([
    "{",
    "",
    "null",
    "[]",
    '{"name":1}',
    '{"name":""}',
    '{"name":"valid","owner_id":"other"}',
  ])("rejects malformed or schema-invalid input: %s", async (body) => {
    const response = await validationApp().request(
      "/api/test-validation",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      },
      env,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "INVALID_REQUEST",
        message: "Invalid request.",
        request_id: response.headers.get("X-Request-ID"),
      },
    });
  });

  it("rejects non-JSON request bodies", async () => {
    const response = await validationApp().request(
      "/api/test-validation",
      {
        method: "POST",
        headers: { "Content-Type": "image/jpeg" },
        body: "binary",
      },
      env,
    );
    expect(response.status).toBe(400);
  });

  it("rejects oversized metadata before it reaches a route", async () => {
    const response = await validationApp().request(
      "/api/test-validation",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "a".repeat(64 * 1024) }),
      },
      env,
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      error: { code: "PAYLOAD_TOO_LARGE" },
    });
  });
});
