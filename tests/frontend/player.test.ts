import { afterEach, describe, expect, it, vi } from "vitest";

import { render } from "../../frontend/index.js";
import { FakeModel } from "./support/fake-model.js";

describe("metadata presentation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

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
          source_format: "YUV420P8",
          source_width: 640,
          source_height: 360,
          output_width: 640,
          output_height: 360,
          warnings: [
            {
              code: "automatic_rgb24_conversion",
              message: "Inactive conversion warning.",
            },
          ],
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
    expect(element.textContent).not.toContain("Inactive conversion warning.");
  });

  it("renders an active conversion warning as safe accessible text", () => {
    const model = new FakeModel();
    const element = document.createElement("div");
    const controller = new AbortController();

    render({ model, el: element, signal: controller.signal });
    model.emit({
      protocol: 1,
      type: "metadata",
      session_id: "session-1",
      status: "initialized",
      num_frames: 1,
      fps_num: 24,
      fps_den: 1,
      mode: "single",
      active_clip_ids: ["Filtered"],
      max_visible_clips: 4,
      clips: [
        {
          id: "Filtered",
          label: "Filtered",
          source_format: "YUV420P8",
          source_width: 640,
          source_height: 360,
          output_width: 640,
          output_height: 360,
          warnings: [
            {
              code: "automatic_rgb24_conversion",
              message:
                "YUV420P8 is being converted automatically for preview; convert to RGB24 explicitly upstream for controlled color handling.",
            },
            {
              code: "assumed_color_metadata",
              message:
                "Source color metadata is incomplete; preview assumes matrix BT.709, transfer BT.709, and range limited.",
            },
            {
              code: "automatic_rgb24_conversion",
              message: "<img src=x onerror=alert(1)>",
            },
          ],
        },
      ],
    });

    const warnings = element.querySelector("[aria-label='Filtered warnings']");
    expect(warnings?.getAttribute("aria-live")).toBe("polite");
    expect(warnings?.textContent).toContain("YUV420P8 is being converted");
    expect(warnings?.textContent).toContain("matrix BT.709");
    expect(warnings?.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(warnings?.querySelector("img")).toBeNull();
  });

  it("requests and paints frame zero from a validated binary payload", async () => {
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      clearRect: vi.fn(),
      drawImage,
    } as unknown as CanvasRenderingContext2D);
    const close = vi.fn();
    const createImageBitmap = vi.fn().mockResolvedValue({ close });
    vi.stubGlobal("createImageBitmap", createImageBitmap);

    const model = new FakeModel();
    const element = document.createElement("div");
    const controller = new AbortController();

    render({ model, el: element, signal: controller.signal });
    model.emit({
      protocol: 1,
      type: "metadata",
      session_id: "session-1",
      status: "initialized",
      num_frames: 10,
      fps_num: 24,
      fps_den: 1,
      mode: "single",
      active_clip_ids: ["Source"],
      max_visible_clips: 4,
      clips: [
        {
          id: "Source",
          label: "Source",
          source_format: "RGB24",
          source_width: 2,
          source_height: 1,
          output_width: 2,
          output_height: 1,
          warnings: [],
        },
      ],
    });

    expect(model.sent.at(-1)).toEqual({
      protocol: 1,
      type: "request_frame_set",
      session_id: "session-1",
      request_id: 0,
      generation: 0,
      frame: 0,
      clip_ids: ["Source"],
      reason: "seek",
    });

    const payload = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    model.emit(
      {
        protocol: 1,
        type: "frame_set",
        session_id: "session-1",
        request_id: 0,
        generation: 0,
        frame: 0,
        frames: [
          {
            clip_id: "Source",
            buffer_index: 0,
            mime: "image/jpeg",
            byte_length: payload.byteLength,
            render_ms: 1,
            encode_ms: 1,
          },
        ],
      },
      [new DataView(payload.buffer)],
    );

    await vi.waitFor(() => expect(drawImage).toHaveBeenCalledOnce());

    const canvas = element.querySelector<HTMLCanvasElement>(
      "[data-clip-id='Source'] canvas",
    );
    expect(canvas?.width).toBe(2);
    expect(canvas?.height).toBe(1);
    expect(createImageBitmap).toHaveBeenCalledWith(
      expect.objectContaining({ size: payload.byteLength, type: "image/jpeg" }),
    );
    expect(close).toHaveBeenCalledOnce();
  });
});
