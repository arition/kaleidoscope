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

test("rapid seek keeps the latest exact paused frame", async ({ page }) => {
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      browserErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));

  await page.goto("/tests/e2e/harness/?rapid-seek=1");
  await expect(page.getByRole("status").last()).toHaveText("Frame 0 ready.");

  const frameInput = page.getByLabel("Current frame");
  await frameInput.fill("2");
  await frameInput.press("Enter");
  await frameInput.fill("7");
  await frameInput.press("Enter");

  await expect(page.getByRole("status").last()).toHaveText("Frame 7 ready.");
  await expect(page.getByRole("img", { name: "Source, frame 7" })).toBeVisible();

  await page.waitForTimeout(180);
  await expect(page.getByRole("status").last()).toHaveText("Frame 7 ready.");
  await expect(page.getByRole("img", { name: "Source, frame 7" })).toBeVisible();

  const requests = await page.evaluate(() => {
    return (
      window as typeof window & { __kaleidoscopeMessages: unknown[] }
    ).__kaleidoscopeMessages.filter(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "request_frame_set",
    );
  });
  expect(requests).toMatchObject([
    { request_id: 0, generation: 0, frame: 0 },
    { request_id: 1, generation: 1, frame: 2 },
    { request_id: 2, generation: 2, frame: 7 },
  ]);
  expect(browserErrors).toEqual([]);
});

test("paused navigation reaches exact first middle and last frames", async ({
  page,
}) => {
  await page.goto("/tests/e2e/harness/?rapid-seek=1");
  await expect(page.getByRole("status").last()).toHaveText("Frame 0 ready.");

  const frameInput = page.getByLabel("Current frame");
  await frameInput.fill("5");
  await frameInput.press("Enter");
  await expect(page.getByRole("status").last()).toHaveText("Frame 5 ready.");
  await expect(page.getByRole("img", { name: "Source, frame 5" })).toBeVisible();

  await page.getByRole("button", { name: "Last frame" }).click();
  await expect(page.getByRole("status").last()).toHaveText("Frame 9 ready.");
  await expect(page.getByRole("img", { name: "Source, frame 9" })).toBeVisible();

  await page.getByRole("button", { name: "First frame" }).click();
  await expect(page.getByRole("status").last()).toHaveText("Frame 0 ready.");
  await expect(page.getByRole("img", { name: "Source, frame 0" })).toBeVisible();

  const requestFrames = await page.evaluate(() => {
    return (
      window as typeof window & { __kaleidoscopeMessages: unknown[] }
    ).__kaleidoscopeMessages
      .filter(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "request_frame_set",
      )
      .map((message) => (message as { frame: number }).frame);
  });
  expect(requestFrames).toEqual([0, 5, 9, 0]);
});

test("paused navigation controls fit a narrow notebook", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto("/tests/e2e/harness/?rapid-seek=1");
  await expect(page.getByRole("status").last()).toHaveText("Frame 0 ready.");

  const geometry = await page.evaluate(() => {
    const widget = document.querySelector<HTMLElement>(".kaleidoscope-widget");
    const seek = document.querySelector<HTMLInputElement>(".kaleidoscope-seek");
    const frame = document.querySelector<HTMLInputElement>(
      ".kaleidoscope-frame-input",
    );
    const time = document.querySelector<HTMLInputElement>(
      ".kaleidoscope-time-input",
    );
    if (widget === null || seek === null || frame === null || time === null) {
      throw new Error("Paused navigation controls are unavailable.");
    }
    return {
      overflow: widget.scrollWidth - widget.clientWidth,
      seekWidth: seek.getBoundingClientRect().width,
      frameWidth: frame.getBoundingClientRect().width,
      timeWidth: time.getBoundingClientRect().width,
    };
  });

  expect(geometry.overflow).toBeLessThanOrEqual(0);
  expect(geometry.seekWidth).toBeGreaterThanOrEqual(96);
  expect(geometry.frameWidth).toBeGreaterThanOrEqual(72);
  expect(geometry.timeWidth).toBeGreaterThanOrEqual(112);
});

test("playback pauses at the final frame and restarts from zero", async ({
  page,
}) => {
  await page.goto("/tests/e2e/harness/?playback=1");
  await expect(page.getByRole("status").last()).toHaveText("Frame 0 ready.");

  await page.getByRole("button", { name: "Play" }).click();
  await expect(page.getByRole("status").last()).toHaveText("Frame 3 ready.");
  await expect(page.getByRole("button", { name: "Play" })).toBeVisible();

  await page.getByRole("button", { name: "Play" }).click();
  await expect
    .poll(async () => {
      return page.evaluate(() => {
        const messages = (
          window as typeof window & { __kaleidoscopeMessages: unknown[] }
        ).__kaleidoscopeMessages;
        return messages.filter(
          (message) =>
            typeof message === "object" &&
            message !== null &&
            "type" in message &&
            message.type === "request_frame_set" &&
            "reason" in message &&
            message.reason === "playback",
        );
      });
    })
    .toContainEqual(
      expect.objectContaining({ frame: 0, generation: 1, reason: "playback" }),
    );
});

test("slow playback completion cannot replace the latest frame", async ({
  page,
}) => {
  await page.goto("/tests/e2e/harness/?slow-playback=1");
  await expect(page.getByRole("status").last()).toHaveText("Frame 0 ready.");

  await page.getByRole("button", { name: "Play" }).click();
  await expect(page.getByRole("status").last()).toHaveText("Frame 5 ready.");
  await page.waitForTimeout(800);
  await expect(page.getByRole("status").last()).toHaveText("Frame 5 ready.");
  await expect(page.getByRole("img", { name: "Source, frame 5" })).toBeVisible();

  const staleAckFrames = await page.evaluate(() => {
    return (
      window as typeof window & { __kaleidoscopeMessages: unknown[] }
    ).__kaleidoscopeMessages
      .filter(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "ack_frame_set" &&
          "outcome" in message &&
          message.outcome === "stale",
      )
      .map((message) => (message as { request_id: number }).request_id);
  });
  expect(staleAckFrames.length).toBeGreaterThan(0);
});

test("visibility resumes only playback that was active before hiding", async ({
  page,
}) => {
  await page.goto("/tests/e2e/harness/?playback=1");
  await expect(page.getByRole("status").last()).toHaveText("Frame 0 ready.");

  await page.getByRole("button", { name: "Play" }).click();
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect
    .poll(async () => {
      return page.evaluate(() =>
        (
          window as typeof window & { __kaleidoscopeMessages: unknown[] }
        ).__kaleidoscopeMessages
          .filter(
            (message) =>
              typeof message === "object" &&
              message !== null &&
              "type" in message &&
              message.type === "set_playing",
          )
          .map((message) => (message as { playing: boolean }).playing),
      );
    })
    .toEqual([true, false, true]);

  await page.getByRole("button", { name: "Pause" }).click();
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });

  const playingStates = await page.evaluate(() =>
    (
      window as typeof window & { __kaleidoscopeMessages: unknown[] }
    ).__kaleidoscopeMessages
      .filter(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "set_playing",
      )
      .map((message) => (message as { playing: boolean }).playing),
  );
  expect(playingStates).toEqual([true, false, true, false]);
});
