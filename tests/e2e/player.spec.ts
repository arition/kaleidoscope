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
