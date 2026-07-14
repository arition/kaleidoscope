import { readFile } from "node:fs/promises";
import process from "node:process";

import { chromium } from "playwright";

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index === -1 || index + 1 >= process.argv.length) {
    throw new Error(`Missing ${name} argument.`);
  }
  return process.argv[index + 1];
}

function metricsByName(metrics) {
  return Object.fromEntries(metrics.map((metric) => [metric.name, metric.value]));
}

const fixturePath = argument("--fixtures");
const bundlePath = argument("--bundle");
const warmup = Number(argument("--warmup"));
const samples = Number(argument("--samples"));
const fixtures = JSON.parse(await readFile(fixturePath, "utf8"));
const browser = await chromium.launch({ headless: true });

try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await page.setContent("<!doctype html><html><body></body></html>");
  await page.addScriptTag({ path: bundlePath });
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");
  await cdp.send("HeapProfiler.enable");
  const results = {};

  for (const fixture of fixtures) {
    await cdp.send("HeapProfiler.collectGarbage");
    const before = metricsByName((await cdp.send("Performance.getMetrics")).metrics);
    const result = await page.evaluate(
      async ({ currentFixture, currentWarmup, currentSamples }) =>
        window.runKaleidoscopeBrowserBenchmark(
          currentFixture,
          currentWarmup,
          currentSamples,
        ),
      {
        currentFixture: fixture,
        currentWarmup: warmup,
        currentSamples: samples,
      },
    );
    await cdp.send("HeapProfiler.collectGarbage");
    const after = metricsByName((await cdp.send("Performance.getMetrics")).metrics);
    result.cdp = {
      task_duration_ms: ((after.TaskDuration ?? 0) - (before.TaskDuration ?? 0)) * 1000,
      script_duration_ms:
        ((after.ScriptDuration ?? 0) - (before.ScriptDuration ?? 0)) * 1000,
      js_heap_used_before_bytes: before.JSHeapUsedSize ?? null,
      js_heap_used_after_bytes: after.JSHeapUsedSize ?? null,
    };
    results[fixture.name] = result;
  }

  console.log(
    JSON.stringify({
      chromium_version: browser.version(),
      user_agent: await page.evaluate(() => navigator.userAgent),
      warmup,
      samples,
      fixtures: results,
    }),
  );
} finally {
  await browser.close();
}