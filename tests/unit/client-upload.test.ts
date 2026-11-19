import { afterEach, expect, it, vi } from "vitest";
import { uploadFile } from "../../src/client/upload";

afterEach(() => vi.unstubAllGlobals());

it("stops a timeline upload before sending private file bytes if its editor closes", async () => {
  const controller = new AbortController();
  const requests: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    requests.push(url);
    if (url.endsWith("/upload-intent")) {
      controller.abort();
      return Response.json({
        asset: { id: "as_photo" },
        upload: {
          url: "https://storage.example/photo",
          method: "PUT",
          headers: {},
        },
      });
    }
    return Response.json({ asset: { id: "as_photo" } });
  });
  const job = {
    id: "job-photo",
    phase: "waiting" as const,
    file: new File(["photo"], "photo.png", { type: "image/png" }),
  };

  await expect(uploadFile(job, () => {}, controller.signal)).rejects.toThrow();
  expect(requests).toEqual(["/api/assets/upload-intent"]);
});
