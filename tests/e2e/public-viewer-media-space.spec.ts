import { createHash, randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import {
  e2eOrigin,
  executeFixtureSql,
  photo,
  putFixture,
  seedLibrary,
  seedTimeline,
} from "./fixtures";

function insertImage(
  owner: string,
  width: number,
  height: number,
  storedWidth: number | null,
  storedHeight: number | null,
) {
  const id = `as_${randomUUID()}`;
  const key = `originals/${owner}/${id}/fixture`;
  const bytes = photo(width, height);
  const now = new Date().toISOString();
  const expiry = new Date(Date.now() + 3_600_000).toISOString();
  putFixture(key, bytes);
  const dimensionSql = (value: number | null) =>
    value === null ? "NULL" : String(value);
  executeFixtureSql(
    `INSERT INTO assets (id,owner_id,kind,status,original_name,mime_type,size_bytes,r2_key,etag,width,height,upload_expires_at,created_at,updated_at) VALUES ('${id}','${owner}','image','ready','Synthetic image.png','image/png',${bytes.length},'${key}','${createHash("md5").update(bytes).digest("hex")}',${dimensionSql(storedWidth)},${dimensionSql(storedHeight)},'${expiry}','${now}','${now}');`,
  );
  return id;
}

test("public viewer reserves cover and story image space until delayed bytes decode", async ({
  page,
  context,
}) => {
  // Fixture setup and three image-decoding scenarios share this test's budget.
  test.setTimeout(60_000);
  const { owner, ids } = await seedLibrary(context);
  const landscape = ids[0];
  if (!landscape) throw new Error("Missing seeded image IDs.");

  const portrait = insertImage(owner, 400, 800, 400, 800);
  const square = insertImage(owner, 800, 800, 800, 800);
  const unknown = insertImage(owner, 400, 800, null, null);
  const cover = insertImage(owner, 400, 800, 400, 800);
  const { id } = seedTimeline(
    owner,
    [landscape, portrait, square, unknown],
    4,
    "Reserved media geometry",
  );
  executeFixtureSql(
    `UPDATE timelines SET visibility='public',cover_asset_id='${cover}' WHERE id='${id}';`,
  );

  const blockedMedia = new Set<string>();
  let releaseImages = () => {};
  const imageGate = new Promise<void>((resolve) => {
    releaseImages = resolve;
  });
  const mediaPattern = `**/t/${id}/media/**`;
  const pendingRoutes: Promise<void>[] = [];
  await page.route(mediaPattern, async (route) => {
    blockedMedia.add(new URL(route.request().url()).pathname);
    const pending = (async () => {
      await imageGate;
      await route.continue();
    })();
    pendingRoutes.push(pending);
    await pending;
  });

  try {
    await page.goto(`${e2eOrigin}/t/${id}`);
    const images = page.locator("header .cover img, main ol img");
    await expect(images).toHaveCount(5);
    for (const image of await images.all())
      await image.scrollIntoViewIfNeeded();
    await expect.poll(() => blockedMedia.size).toBe(5);

    const before = await page.evaluate(() => {
      const geometry = (image: HTMLImageElement) => {
        const rect = image.getBoundingClientRect();
        return {
          top: rect.top + window.scrollY,
          width: rect.width,
          height: rect.height,
          maxHeight: Number.parseFloat(getComputedStyle(image).maxHeight),
          complete: image.complete,
          naturalWidth: image.naturalWidth,
        };
      };
      const items = Array.from(document.querySelectorAll("main ol > li"));
      const documentTop = (element: Element | null) => {
        if (!element) return null;
        return element.getBoundingClientRect().top + window.scrollY;
      };
      const coverImage = document.querySelector(
        "header .cover img",
      ) as HTMLImageElement;
      return {
        cover: geometry(coverImage),
        firstStoryTop: documentTop(items[0] ?? null),
        items: items.map((item) => {
          const image = item.querySelector("img") as HTMLImageElement;
          return {
            image: geometry(image),
            widthAttribute: image.getAttribute("width"),
            heightAttribute: image.getAttribute("height"),
            captionTop: documentTop(item.querySelector("figcaption")),
            followingTop: documentTop(item.nextElementSibling),
          };
        }),
      };
    });

    expect(before.cover.complete).toBe(false);
    expect(before.cover.naturalWidth).toBe(0);
    expect(before.cover.width).toBeGreaterThan(0);
    expect(before.cover.height).toBeGreaterThan(0);
    expect(before.firstStoryTop).not.toBeNull();
    const maxCoverHeight = 34 * 16;
    expect(Math.abs(before.cover.height - maxCoverHeight)).toBeLessThanOrEqual(
      1,
    );

    const expectedItems = [
      { width: 600, height: 400 },
      { width: 400, height: 800 },
      { width: 800, height: 800 },
    ];
    for (const [index, expected] of expectedItems.entries()) {
      const item = before.items[index];
      if (!item) throw new Error(`Missing story image ${index}.`);
      expect(item.image.complete).toBe(false);
      expect(item.image.naturalWidth).toBe(0);
      expect(item.widthAttribute).toBe(String(expected.width));
      expect(item.heightAttribute).toBe(String(expected.height));
      expect(item.image.height).toBeGreaterThan(0);
      const reservedHeight = Math.min(
        item.image.width * (expected.height / expected.width),
        item.image.maxHeight,
      );
      expect(Math.abs(item.image.height - reservedHeight)).toBeLessThanOrEqual(
        1,
      );
    }
    expect(before.items[3]?.widthAttribute).toBeNull();
    expect(before.items[3]?.heightAttribute).toBeNull();

    releaseImages();
    await page.evaluate(async () => {
      await Promise.all(Array.from(document.images, (image) => image.decode()));
    });
    const after = await page.evaluate(() => {
      const geometry = (image: HTMLImageElement) => {
        const rect = image.getBoundingClientRect();
        return {
          top: rect.top + window.scrollY,
          width: rect.width,
          height: rect.height,
          naturalWidth: image.naturalWidth,
          naturalHeight: image.naturalHeight,
        };
      };
      const items = Array.from(document.querySelectorAll("main ol > li"));
      const documentTop = (element: Element | null) => {
        if (!element) return null;
        return element.getBoundingClientRect().top + window.scrollY;
      };
      const coverImage = document.querySelector(
        "header .cover img",
      ) as HTMLImageElement;
      return {
        cover: geometry(coverImage),
        firstStoryTop: documentTop(items[0] ?? null),
        items: items.map((item) => {
          const image = item.querySelector("img") as HTMLImageElement;
          return {
            image: geometry(image),
            captionTop: documentTop(item.querySelector("figcaption")),
            followingTop: documentTop(item.nextElementSibling),
          };
        }),
      };
    });

    expect(after.cover.naturalWidth).toBe(400);
    expect(after.cover.naturalHeight).toBe(800);
    expect(after.cover.width).toBeCloseTo(before.cover.width, 0);
    expect(
      Math.abs(after.cover.height - before.cover.height),
    ).toBeLessThanOrEqual(1);
    expect(after.firstStoryTop).not.toBeNull();
    expect(
      Math.abs((after.firstStoryTop ?? 0) - (before.firstStoryTop ?? 0)),
    ).toBeLessThanOrEqual(1);

    for (const [index, expected] of expectedItems.entries()) {
      const beforeItem = before.items[index];
      const afterItem = after.items[index];
      if (!beforeItem || !afterItem)
        throw new Error(`Missing story geometry ${index}.`);
      expect(afterItem.image.naturalWidth).toBe(expected.width);
      expect(afterItem.image.naturalHeight).toBe(expected.height);
      expect(
        Math.abs(afterItem.image.height - beforeItem.image.height),
      ).toBeLessThanOrEqual(1);
      expect(
        Math.abs((afterItem.captionTop ?? 0) - (beforeItem.captionTop ?? 0)),
      ).toBeLessThanOrEqual(1);
      expect(
        Math.abs(
          (afterItem.followingTop ?? 0) - (beforeItem.followingTop ?? 0),
        ),
      ).toBeLessThanOrEqual(1);
    }
    const fallback = after.items[3];
    expect(fallback?.image.naturalWidth).toBe(400);
    expect(fallback?.image.naturalHeight).toBe(800);
    await page.screenshot({
      path: `test-results/public-viewer-media-space-${test.info().project.name}.png`,
      fullPage: true,
    });
  } finally {
    releaseImages();
    await Promise.allSettled(pendingRoutes);
    await page.unroute(mediaPattern);
  }

  await page.setViewportSize({ width: 390, height: 844 });
  for (const coverCase of [
    { name: "landscape", width: 1600, height: 900 },
    { name: "square", width: 800, height: 800 },
  ]) {
    const coverId = insertImage(
      owner,
      coverCase.width,
      coverCase.height,
      coverCase.width,
      coverCase.height,
    );
    const coverStory = seedTimeline(
      owner,
      [landscape],
      1,
      `${coverCase.name} cover geometry`,
    );
    executeFixtureSql(
      `UPDATE timelines SET visibility='public',cover_asset_id='${coverId}' WHERE id='${coverStory.id}';`,
    );

    let releaseCover = () => {};
    const coverGate = new Promise<void>((resolve) => {
      releaseCover = resolve;
    });
    let coverRequestStarted = false;
    const coverRoute = `**/t/${coverStory.id}/media/${coverId}`;
    const pendingCoverRoutes: Promise<void>[] = [];
    await page.route(coverRoute, async (route) => {
      coverRequestStarted = true;
      const pending = (async () => {
        await coverGate;
        await route.continue();
      })();
      pendingCoverRoutes.push(pending);
      await pending;
    });

    try {
      await page.goto(`${e2eOrigin}/t/${coverStory.id}`);
      const image = page.locator("header .cover img");
      await expect(image).toHaveCount(1);
      await image.scrollIntoViewIfNeeded();
      await expect.poll(() => coverRequestStarted).toBe(true);

      const before = await image.evaluate((element) => {
        const imageElement = element as HTMLImageElement;
        const rect = imageElement.getBoundingClientRect();
        const firstStory = document.querySelector("main ol > li");
        return {
          top: rect.top + window.scrollY,
          width: rect.width,
          height: rect.height,
          maxHeight: Number.parseFloat(
            getComputedStyle(imageElement).maxHeight,
          ),
          complete: imageElement.complete,
          naturalWidth: imageElement.naturalWidth,
          firstStoryTop: firstStory
            ? firstStory.getBoundingClientRect().top + window.scrollY
            : null,
        };
      });
      expect(before.complete).toBe(false);
      expect(before.naturalWidth).toBe(0);
      const expectedHeight = Math.min(
        before.width * (coverCase.height / coverCase.width),
        before.maxHeight,
      );
      expect(Math.abs(before.height - expectedHeight)).toBeLessThanOrEqual(1);

      releaseCover();
      await image.evaluate(async (element) => {
        await (element as HTMLImageElement).decode();
      });
      const after = await image.evaluate((element) => {
        const imageElement = element as HTMLImageElement;
        const rect = imageElement.getBoundingClientRect();
        const firstStory = document.querySelector("main ol > li");
        return {
          top: rect.top + window.scrollY,
          width: rect.width,
          height: rect.height,
          naturalWidth: imageElement.naturalWidth,
          naturalHeight: imageElement.naturalHeight,
          firstStoryTop: firstStory
            ? firstStory.getBoundingClientRect().top + window.scrollY
            : null,
        };
      });
      expect(after.naturalWidth).toBe(coverCase.width);
      expect(after.naturalHeight).toBe(coverCase.height);
      expect(Math.abs(after.height - expectedHeight)).toBeLessThanOrEqual(1);
      expect(Math.abs(after.height - before.height)).toBeLessThanOrEqual(1);
      expect(after.firstStoryTop).not.toBeNull();
      expect(
        Math.abs((after.firstStoryTop ?? 0) - (before.firstStoryTop ?? 0)),
      ).toBeLessThanOrEqual(1);
      await page.screenshot({
        path: `test-results/public-viewer-${coverCase.name}-cover-${test.info().project.name}.png`,
        fullPage: true,
      });
    } finally {
      releaseCover();
      await Promise.allSettled(pendingCoverRoutes);
      await page.unroute(coverRoute);
    }
  }
});
