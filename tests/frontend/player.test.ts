import { describe, expect, it } from "vitest";

import { render } from "../../frontend/index.js";
import { FakeModel } from "./support/fake-model.js";

describe("metadata presentation", () => {
  it("renders stable clip labels and shared timeline metadata", () => {
    const model = new FakeModel();
    const element = document.createElement("div");
    const controller = new AbortController();

    render({ model, el: element, signal: controller.signal });
    model.emit({
      protocol: 1,
      type: "metadata",
      session_id: "session-1",
      status: "initialized",
      num_frames: 240,
      fps_num: 24000,
      fps_den: 1001,
      mode: "side-by-side",
      active_clip_ids: ["Source", "Filtered"],
      max_visible_clips: 4,
      clips: [
        {
          id: "Source",
          label: "Source",
          source_format: "RGB24",
          source_width: 1920,
          source_height: 1080,
          output_width: 960,
          output_height: 540,
          warnings: [],
        },
        {
          id: "Filtered",
          label: "Filtered",
          source_format: "YUV420P10",
          source_width: 1280,
          source_height: 720,
          output_width: 960,
          output_height: 540,
          warnings: [],
        },
      ],
    });

    expect(element.textContent).toContain("Source");
    expect(element.textContent).toContain("Filtered");
    expect(element.textContent).toContain("240 frames");
    expect(element.textContent).toContain("24000/1001 fps");
    expect(element.textContent).toContain("1920 x 1080");
    expect(element.textContent).toContain("1280 x 720");
    expect(element.querySelectorAll("[data-clip-id]")).toHaveLength(2);
  });

  it("marks only the active clips", () => {
    const model = new FakeModel();
    const element = document.createElement("div");
    const controller = new AbortController();

    render({ model, el: element, signal: controller.signal });
    model.emit({
      protocol: 1,
      type: "metadata",
      session_id: "session-1",
      status: "initialized",
      num_frames: 120,
      fps_num: 24,
      fps_den: 1,
      mode: "single",
      active_clip_ids: ["B"],
      max_visible_clips: 4,
      clips: [
        {
          id: "A",
          label: "A",
          source_format: "RGB24",
          source_width: 640,
          source_height: 360,
          output_width: 640,
          output_height: 360,
          warnings: [],
        },
        {
          id: "B",
          label: "B",
          source_format: "RGB24",
          source_width: 640,
          source_height: 360,
          output_width: 640,
          output_height: 360,
          warnings: [],
        },
      ],
    });

    expect(element.querySelector("[data-clip-id='A']")?.getAttribute("data-active")).toBe(
      "false",
    );
    expect(element.querySelector("[data-clip-id='B']")?.getAttribute("data-active")).toBe(
      "true",
    );
  });
});
