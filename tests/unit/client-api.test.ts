import { afterEach, describe, expect, it, vi } from "vitest";
import { api, RequestError } from "../../src/client/api";

afterEach(() => vi.unstubAllGlobals());

describe("Client API responses", () => {
  it("returns undefined for 204 without attempting to parse JSON", async () => {
    const json = vi
      .fn()
      .mockRejectedValue(new SyntaxError("Unexpected end of JSON input"));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 204, json }),
    );

    await expect(api<void>("/api/timelines/tl_1/items")).resolves.toBe(
      undefined,
    );
    expect(json).not.toHaveBeenCalled();
  });

  it("continues to decode successful JSON responses", async () => {
    const payload = { timeline: { id: "tl_1", version: 2 } };
    const json = vi.fn().mockResolvedValue(payload);
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json });
    vi.stubGlobal("fetch", fetch);

    await expect(
      api<typeof payload>("/api/timelines/tl_1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Updated" }),
      }),
    ).resolves.toEqual(payload);
    expect(fetch).toHaveBeenCalledWith("/api/timelines/tl_1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Updated" }),
      credentials: "same-origin",
    });
    expect(json).toHaveBeenCalledOnce();
  });

  it("continues to decode JSON error envelopes and preserve status", async () => {
    const json = vi.fn().mockResolvedValue({
      error: { code: "CONFLICT", message: "Timeline changed." },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 409, json }),
    );

    const request = api("/api/timelines/tl_1/items");
    await expect(request).rejects.toBeInstanceOf(RequestError);
    const error = await request.catch((reason: unknown) => reason);
    expect(error).toMatchObject({
      code: "CONFLICT",
      message: "Timeline changed.",
      status: 409,
    });
    expect(json).toHaveBeenCalledOnce();
  });
});
