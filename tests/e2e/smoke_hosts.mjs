import { chromium } from "@playwright/test";

const [, , host, hostVersion, baseUrl, notebook] = process.argv;
const token = process.env.KALEIDOSCOPE_JUPYTER_TOKEN;
if (!host || !hostVersion || !baseUrl || !token || !notebook) {
  throw new Error(
    "Expected host, host version, base URL, notebook, and runtime token.",
  );
}

const redact = (value) => value.split(token).join("<redacted>");

const route = host === "jupyterlab" ? "lab/tree" : "tree";
const url = new URL(`${route}/${notebook}`, `${baseUrl}/`);
url.searchParams.set("token", token);

const browser = await chromium.launch();
let page;
try {
  page = await browser.newPage();
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      const location = message.location();
      errors.push(
        `${message.text()} @ ${location.url || "<unknown>"}:${location.lineNumber}:${location.columnNumber}`,
      );
    }
  });
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message));

  await page.goto(url.href);
  const cell = page.locator(".jp-CodeCell").first();
  await cell.waitFor({ timeout: 60_000 });
  await page
    .locator('.jp-Notebook-ExecutionIndicator[data-status="idle"]')
    .waitFor({ timeout: 60_000 });
  await cell.click();
  await page
    .locator('[data-command="notebook:run-cell-and-select-next"]')
    .getByRole("button")
    .click();

  await page
    .getByRole("status")
    .filter({ hasText: "Frame 0 ready." })
    .waitFor({ timeout: 60_000 });
  const pixel = await page.locator(".kaleidoscope-canvas").evaluate((element) => {
    const context = element.getContext("2d");
    if (context === null) {
      throw new Error("Canvas 2D context is unavailable.");
    }
    return Array.from(context.getImageData(32, 24, 1, 1).data);
  });
  if (pixel[0] < 180 || pixel[1] > 100 || pixel[2] > 80 || pixel[3] !== 255) {
    throw new Error(`Unexpected host-smoke pixel: ${JSON.stringify(pixel)}`);
  }
  const unexpectedErrors = errors.filter((error) => {
    return !(
      host === "notebook" &&
      hostVersion === "7.6.0" &&
      error.includes("Cannot read properties of undefined (reading 'schema')") &&
      error.includes("/static/notebook/notebook_core.")
    );
  });
  if (unexpectedErrors.length !== 0) {
    throw new Error(`Host browser errors:\n${unexpectedErrors.join("\n")}`);
  }
} catch (error) {
  const cellText = page
    ? await page.locator(".jp-CodeCell").first().innerText().catch(() => "<missing>")
    : "<page unavailable>";
  const outputText = page
    ? await page.locator(".jp-Cell-outputArea").first().innerText().catch(() => "<missing>")
    : "<page unavailable>";
  const diagnostic = `${String(error)}\nURL: ${page?.url() ?? "<page unavailable>"}\nCell: ${cellText}\nOutput: ${outputText}`;
  throw new Error(redact(diagnostic).slice(0, 32_000));
} finally {
  await browser.close();
}