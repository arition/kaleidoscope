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

  const pixel = await page.locator(".kaleidoscope-canvas").evaluate((element) => {
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

  const pixel = await page.locator(".kaleidoscope-canvas").evaluate((element) => {
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

  const pixel = await page.locator(".kaleidoscope-canvas").evaluate((element) => {
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
  const previewClips = page.getByLabel("Preview clips");
  await expect(previewClips.getByText("Source", { exact: true })).toBeVisible();
  await expect(previewClips.getByText("Filtered", { exact: true })).toBeVisible();

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

  const pixels = await clipRows.locator("canvas").evaluateAll((canvases) =>
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

test("wipe is keyboard-operable and reuses the synchronized pair", async ({
  page,
}) => {
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      browserErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));

  await page.goto("/tests/e2e/harness/?comparison=1");
  await expect(page.getByRole("status").last()).toHaveText("Frame 0 ready.");
  await page.getByRole("button", { name: "Wipe view" }).click();

  const wipe = page.getByLabel("Wipe position");
  await expect(wipe).toHaveValue("50");
  await wipe.focus();
  await wipe.press("ArrowRight");
  await expect(wipe).toHaveValue("51");

  const pixels = await page
    .locator(".kaleidoscope-comparison__canvas")
    .evaluate((element) => {
      const canvas = element as HTMLCanvasElement;
      const context = canvas.getContext("2d");
      if (context === null) {
        throw new Error("Canvas 2D context is unavailable.");
      }
      return {
        left: Array.from(context.getImageData(16, 24, 1, 1).data),
        right: Array.from(context.getImageData(48, 24, 1, 1).data),
      };
    });
  expect(pixels.left[0]).toBeLessThan(60);
  expect(pixels.left[1]).toBeGreaterThan(160);
  expect(pixels.right[0]).toBeGreaterThan(200);
  expect(pixels.right[1]).toBeLessThan(70);

  const requests = await page.evaluate(() =>
    (
      window as typeof window & { __kaleidoscopeMessages: unknown[] }
    ).__kaleidoscopeMessages.filter(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "request_frame_set",
    ),
  );
  expect(requests).toHaveLength(1);
  expect(browserErrors).toEqual([]);
});

test("overlay and difference compose locally without rerendering", async ({
  page,
}) => {
  await page.goto("/tests/e2e/harness/?comparison=1");
  await expect(page.getByRole("status").last()).toHaveText("Frame 0 ready.");

  await page.getByRole("button", { name: "Overlay view" }).click();
  const opacity = page.getByLabel("Overlay opacity");
  await opacity.fill("0.25");
  await opacity.dispatchEvent("input");
  await expect(page.locator(".kaleidoscope-parameter output")).toHaveText("25%");

  const overlayPixel = await page
    .locator(".kaleidoscope-comparison__canvas")
    .evaluate((element) => {
      const context = (element as HTMLCanvasElement).getContext("2d");
      if (context === null) {
        throw new Error("Canvas 2D context is unavailable.");
      }
      return Array.from(context.getImageData(32, 24, 1, 1).data);
    });
  expect(overlayPixel[0]).toBeGreaterThan(160);
  expect(overlayPixel[1]).toBeGreaterThan(70);
  expect(overlayPixel[2]).toBeGreaterThan(60);

  await page.getByRole("button", { name: "Difference view" }).click();
  await expect(page.getByText("8-bit visual difference (non-reference)")).toBeVisible();
  const differencePixel = await page
    .locator(".kaleidoscope-comparison__canvas")
    .evaluate((element) => {
      const context = (element as HTMLCanvasElement).getContext("2d");
      if (context === null) {
        throw new Error("Canvas 2D context is unavailable.");
      }
      return Array.from(context.getImageData(32, 24, 1, 1).data);
    });
  expect(differencePixel[0]).toBeGreaterThan(180);
  expect(differencePixel[1]).toBeGreaterThan(130);
  expect(differencePixel[2]).toBeGreaterThan(180);

  const requests = await page.evaluate(() =>
    (
      window as typeof window & { __kaleidoscopeMessages: unknown[] }
    ).__kaleidoscopeMessages.filter(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "request_frame_set",
    ),
  );
  expect(requests).toHaveLength(1);
});

test("single pair and grid selectors update ordered active clips", async ({
  page,
}) => {
  await page.goto("/tests/e2e/harness/?comparison=1");
  await expect(page.getByRole("status").last()).toHaveText("Frame 0 ready.");

  await page.getByRole("button", { name: "Single view" }).click();
  await expect(page.getByRole("status").last()).toHaveText("Frame 0 ready.");
  await page.getByLabel("Solo clip").selectOption({ label: "Reference" });
  await expect(page.getByRole("img", { name: "Reference, frame 0" })).toBeVisible();

  await page.getByRole("button", { name: "Wipe view" }).click();
  await expect(page.getByLabel("Comparison clip A")).toHaveValue("2");
  await page.getByLabel("Comparison clip B").selectOption({ label: "Filtered" });
  await expect(
    page.getByRole("img", { name: "Reference and Filtered, wipe comparison" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Side by side view" }).click();
  await expect(page.getByLabel("Show Reference")).toBeChecked();
  await expect(page.getByLabel("Show Filtered")).toBeChecked();
  await expect(page.getByLabel("Show Source")).toBeDisabled();

  const messages = await page.evaluate(() =>
    (
      window as typeof window & { __kaleidoscopeMessages: unknown[] }
    ).__kaleidoscopeMessages,
  );
  const changedViews = messages.filter(
    (message) =>
      typeof message === "object" &&
      message !== null &&
      "type" in message &&
      message.type === "set_view",
  );
  const requests = messages.filter(
    (message) =>
      typeof message === "object" &&
      message !== null &&
      "type" in message &&
      message.type === "request_frame_set",
  );
  expect(changedViews).toMatchObject([
    { generation: 1, mode: "single", clip_ids: ["Source"] },
    { generation: 2, mode: "single", clip_ids: ["Reference"] },
    { generation: 3, mode: "wipe", clip_ids: ["Reference", "Source"] },
    { generation: 4, mode: "wipe", clip_ids: ["Reference", "Filtered"] },
    { generation: 5, mode: "side-by-side", clip_ids: ["Filtered", "Reference"] },
  ]);
  expect(requests.map((message) => (message as { generation: number }).generation)).toEqual([
    0,
    1,
    2,
    3,
    4,
    5,
  ]);
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

test("slow playback completion cannot replace or re-ack the latest frame", async ({
  page,
}) => {
  await page.goto("/tests/e2e/harness/?slow-playback=1");
  await expect(page.getByRole("status").last()).toHaveText("Frame 0 ready.");

  await page.getByRole("button", { name: "Play" }).click();
  await expect(page.getByRole("status").last()).toHaveText("Frame 5 ready.");
  await page.waitForTimeout(800);
  await expect(page.getByRole("status").last()).toHaveText("Frame 5 ready.");
  await expect(page.getByRole("img", { name: "Source, frame 5" })).toBeVisible();

  const delayedDelivery = await page.evaluate(() => {
    const messages = (
      window as typeof window & { __kaleidoscopeMessages: unknown[] }
    ).__kaleidoscopeMessages;
    const request = messages.find(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "request_frame_set" &&
        "frame" in message &&
        message.frame === 1,
    ) as { request_id: number } | undefined;
    return {
      requestId: request?.request_id,
      ackCount:
        request === undefined
          ? -1
          : messages.filter(
              (message) =>
                typeof message === "object" &&
                message !== null &&
                "type" in message &&
                message.type === "ack_frame_set" &&
                "request_id" in message &&
                message.request_id === request.request_id,
            ).length,
    };
  });
  expect(delayedDelivery.requestId).toBeDefined();
  expect(delayedDelivery.ackCount).toBe(0);
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
