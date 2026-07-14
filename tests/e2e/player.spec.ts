import { expect, test } from "@playwright/test";

test("paints an RGB24 frame", async ({ page }) => {
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      browserErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));

  await page.goto("/tests/e2e/harness/");
  await expect(page.getByRole("status")).toHaveText("Frame 0 ready.");

  const messages = await page.evaluate(() => {
    return (
      window as typeof window & { __kaleidoscopeMessages: unknown[] }
    ).__kaleidoscopeMessages;
  });
  const ready = messages.find(
    (message) =>
      typeof message === "object" &&
      message !== null &&
      "type" in message &&
      message.type === "ready",
  );
  expect(ready).toMatchObject({
    capabilities: {
      webp: true,
    },
  });
  const request = messages.find(
    (message) =>
      typeof message === "object" &&
      message !== null &&
      "type" in message &&
      message.type === "request_frame_set",
  );
  expect(request).toMatchObject({
    request_id: 0,
    generation: 0,
    frame: 0,
    clip_ids: ["Source"],
  });

  const pixel = await page.locator("canvas").evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    const context = canvas.getContext("2d");
    if (context === null) {
      throw new Error("Canvas 2D context is unavailable.");
    }
    return Array.from(context.getImageData(32, 24, 1, 1).data);
  });
  expect(pixel[0]).toBeGreaterThan(200);
  expect(pixel[1]).toBeGreaterThan(20);
  expect(pixel[1]).toBeLessThan(70);
  expect(pixel[2]).toBeLessThan(50);
  expect(pixel[3]).toBe(255);
  expect(browserErrors).toEqual([]);
});

test("paints a WebP frame through the negotiated decoder", async ({ page }) => {
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      browserErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));

  await page.goto("/tests/e2e/harness/?codec=webp");
  await expect(page.getByRole("status")).toHaveText("Frame 0 ready.");

  const pixel = await page.locator("canvas").evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    const context = canvas.getContext("2d");
    if (context === null) {
      throw new Error("Canvas 2D context is unavailable.");
    }
    return Array.from(context.getImageData(32, 24, 1, 1).data);
  });
  expect(pixel[0]).toBeGreaterThan(200);
  expect(pixel[1]).toBeGreaterThan(20);
  expect(pixel[1]).toBeLessThan(70);
  expect(pixel[2]).toBeLessThan(50);
  expect(pixel[3]).toBe(255);
  expect(browserErrors).toEqual([]);
});

test("shows automatic RGB24 conversion warning and paints the frame", async ({
  page,
}) => {
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      browserErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));

  await page.goto("/tests/e2e/harness/?conversion=1");
  await expect(page.getByRole("status").last()).toHaveText("Frame 0 ready.");
  await expect(page.getByLabel("Filtered warnings")).toContainText(
    "YUV420P8 is being converted automatically",
  );
  await expect(page.getByLabel("Filtered warnings")).toContainText(
    "matrix BT.709, transfer BT.709, and range limited",
  );

  const pixel = await page.locator("canvas").evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    const context = canvas.getContext("2d");
    if (context === null) {
      throw new Error("Canvas 2D context is unavailable.");
    }
    return Array.from(context.getImageData(32, 24, 1, 1).data);
  });
  expect(pixel[0]).toBeGreaterThan(180);
  expect(pixel[1]).toBeLessThan(90);
  expect(pixel[2]).toBeLessThan(70);
  expect(pixel[3]).toBe(255);
  expect(browserErrors).toEqual([]);
});

test("atomic side-by-side paints a labeled frame set", async ({ page }) => {
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      browserErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));

  await page.goto("/tests/e2e/harness/?side-by-side=1");
  await expect(page.getByRole("status").last()).toHaveText("Frame 0 ready.");
  await expect(page.getByText("Source", { exact: true })).toBeVisible();
  await expect(page.getByText("Filtered", { exact: true })).toBeVisible();

  const request = await page.evaluate(() => {
    const messages = (
      window as typeof window & { __kaleidoscopeMessages: unknown[] }
    ).__kaleidoscopeMessages;
    return messages.find(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "request_frame_set",
    );
  });
  expect(request).toMatchObject({
    request_id: 0,
    generation: 0,
    frame: 0,
    clip_ids: ["Source", "Filtered"],
  });

  const clipRows = page.locator("[data-clip-id][data-active='true']");
  await expect(clipRows).toHaveCount(2);
  const sourceBox = await clipRows.nth(0).boundingBox();
  const filteredBox = await clipRows.nth(1).boundingBox();
  expect(sourceBox).not.toBeNull();
  expect(filteredBox).not.toBeNull();
  expect(filteredBox!.x).toBeGreaterThan(sourceBox!.x);

  const pixels = await page.locator("canvas").evaluateAll((canvases) =>
    canvases.map((element) => {
      const canvas = element as HTMLCanvasElement;
      const context = canvas.getContext("2d");
      if (context === null) {
        throw new Error("Canvas 2D context is unavailable.");
      }
      return Array.from(context.getImageData(32, 24, 1, 1).data);
    }),
  );
  expect(pixels).toHaveLength(2);
  expect(pixels[0][0]).toBeGreaterThan(200);
  expect(pixels[0][1]).toBeLessThan(70);
  expect(pixels[1][0]).toBeLessThan(60);
  expect(pixels[1][1]).toBeGreaterThan(160);
  expect(pixels[1][2]).toBeGreaterThan(190);
  expect(browserErrors).toEqual([]);
});
