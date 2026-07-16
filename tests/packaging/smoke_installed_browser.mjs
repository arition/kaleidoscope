import { chromium } from "@playwright/test";
import { pathToFileURL } from "node:url";
import path from "node:path";

const root = path.resolve(process.argv[2]);
const browser = await chromium.launch({
  args: ["--allow-file-access-from-files"],
});

try {
  for (const testCase of ["single", "side-by-side"]) {
    const page = await browser.newPage();
    const errors = [];
    const requests = [];
    page.on("console", (message) => {
      if (message.type() === "error") {
        errors.push(message.text());
      }
    });
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => requests.push(request.url()));

    const url = new URL(pathToFileURL(path.join(root, "index.html")));
    url.searchParams.set("case", testCase);
    await page.goto(url.href);
    await page.getByRole("status").filter({ hasText: "Frame 0 ready." }).waitFor();

    const pixels = await page.locator(".kaleidoscope-canvas").evaluateAll((canvases) =>
      canvases.map((canvas) => {
        const context = canvas.getContext("2d");
        if (context === null) {
          throw new Error("Canvas 2D context is unavailable.");
        }
        return Array.from(context.getImageData(32, 24, 1, 1).data);
      }),
    );
    if (testCase === "single") {
      if (pixels.length !== 1 || pixels[0][0] < 200 || pixels[0][2] > 80) {
        throw new Error(`Installed single-frame pixels were unexpected: ${JSON.stringify(pixels)}`);
      }
    } else if (
      pixels.length !== 2 ||
      pixels[0][0] < 200 ||
      pixels[0][2] > 80 ||
      pixels[1][2] < 200 ||
      pixels[1][0] > 80
    ) {
      throw new Error(`Installed comparison pixels were unexpected: ${JSON.stringify(pixels)}`);
    }
    if (errors.length !== 0) {
      throw new Error(`Installed browser console errors: ${errors.join("\n")}`);
    }
    if (requests.some((request) => !request.startsWith("file:"))) {
      throw new Error(`Installed browser made a non-file request: ${requests.join("\n")}`);
    }
    await page.close();
  }
} finally {
  await browser.close();
}