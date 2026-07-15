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
      overlay_opacity: 0.5,
      max_visible_clips: 4,
      autoplay: false,
      clips: [
        {
          id: "Source",
          label: "Source",
          source_format: "RGB24",
          source_width: 1920,
          source_height: 1080,
          output_width: 1920,
          output_height: 1080,
          warnings: [],
        },
        {
          id: "Filtered",
          label: "Filtered",
          source_format: "YUV420P10",
          source_width: 1280,
          source_height: 720,
          output_width: 1280,
          output_height: 720,
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
      overlay_opacity: 0.5,
      max_visible_clips: 4,
      autoplay: false,
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
      overlay_opacity: 0.5,
      max_visible_clips: 4,
      autoplay: false,
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
    const probeClose = vi.fn();
    const frameClose = vi.fn();
    const createImageBitmap = vi
      .fn()
      .mockResolvedValueOnce({ close: probeClose })
      .mockResolvedValueOnce({ close: frameClose });
    vi.stubGlobal("createImageBitmap", createImageBitmap);

    const model = new FakeModel();
    const element = document.createElement("div");
    const controller = new AbortController();

    render({ model, el: element, signal: controller.signal });
  await vi.waitFor(() => expect(model.sent).toHaveLength(1));
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
      overlay_opacity: 0.5,
      max_visible_clips: 4,
      autoplay: false,
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
    expect(probeClose).toHaveBeenCalledOnce();
    expect(frameClose).toHaveBeenCalledOnce();
  });

  it("atomically paints a complete two-clip frame set", async () => {
    const drawOrder: string[] = [];
    const firstClose = vi.fn();
    const secondClose = vi.fn();
    const probeClose = vi.fn();
    const firstBitmap = { close: firstClose } as unknown as ImageBitmap;
    const secondBitmap = { close: secondClose } as unknown as ImageBitmap;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      () => {
        return {
          clearRect: vi.fn(),
          drawImage: vi.fn((bitmap: ImageBitmap) => {
            drawOrder.push(bitmap === firstBitmap ? "Source" : "Filtered");
          }),
        } as unknown as CanvasRenderingContext2D;
      },
    );
    let resolveFirstDecode: (bitmap: ImageBitmap) => void = () => {};
    let resolveSecondDecode: (bitmap: ImageBitmap) => void = () => {};
    const firstDecode = new Promise<ImageBitmap>((resolve) => {
      resolveFirstDecode = resolve;
    });
    const secondDecode = new Promise<ImageBitmap>((resolve) => {
      resolveSecondDecode = resolve;
    });
    const createImageBitmap = vi
      .fn()
      .mockResolvedValueOnce({ close: probeClose } as unknown as ImageBitmap)
      .mockReturnValueOnce(firstDecode)
      .mockReturnValueOnce(secondDecode);
    vi.stubGlobal("createImageBitmap", createImageBitmap);

    const model = new FakeModel();
    const element = document.createElement("div");
    const controller = new AbortController();

    render({ model, el: element, signal: controller.signal });
  await vi.waitFor(() => expect(model.sent).toHaveLength(1));
    model.emit({
      protocol: 1,
      type: "metadata",
      session_id: "session-1",
      status: "initialized",
      num_frames: 10,
      fps_num: 24,
      fps_den: 1,
      mode: "side-by-side",
      active_clip_ids: ["Source", "Filtered"],
      overlay_opacity: 0.5,
      max_visible_clips: 4,
      autoplay: false,
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
        {
          id: "Filtered",
          label: "Filtered",
          source_format: "RGB24",
          source_width: 2,
          source_height: 1,
          output_width: 2,
          output_height: 1,
          warnings: [],
        },
      ],
    });

    const sourcePayload = new Uint8Array([0xff, 0xd8, 0x01, 0xd9]);
    const filteredPayload = new Uint8Array([0xff, 0xd8, 0x02, 0xd9]);
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
            byte_length: sourcePayload.byteLength,
            render_ms: 1,
            encode_ms: 1,
          },
          {
            clip_id: "Filtered",
            buffer_index: 1,
            mime: "image/jpeg",
            byte_length: filteredPayload.byteLength,
            render_ms: 2,
            encode_ms: 1,
          },
        ],
      },
      [
        new DataView(sourcePayload.buffer),
        new DataView(filteredPayload.buffer),
      ],
    );

    resolveFirstDecode(firstBitmap);
    await Promise.resolve();
    expect(drawOrder).toEqual([]);

    resolveSecondDecode(secondBitmap);
    await vi.waitFor(() =>
      expect(drawOrder).toEqual(["Source", "Filtered"]),
    );
    expect(probeClose).toHaveBeenCalledOnce();
    expect(firstClose).toHaveBeenCalledOnce();
    expect(secondClose).toHaveBeenCalledOnce();
  });

  it("does not paint any member when an active canvas is unavailable", async () => {
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      function (this: HTMLCanvasElement) {
        if (this.parentElement?.dataset.clipId === "Filtered") {
          return null;
        }
        return {
          clearRect: vi.fn(),
          drawImage,
        } as unknown as CanvasRenderingContext2D;
      },
    );
    vi.stubGlobal(
      "createImageBitmap",
      vi
        .fn()
        .mockResolvedValue({ close: vi.fn() } as unknown as ImageBitmap),
    );

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
      mode: "side-by-side",
      active_clip_ids: ["Source", "Filtered"],
      overlay_opacity: 0.5,
      max_visible_clips: 4,
      autoplay: false,
      clips: [
        {
          id: "Source",
          label: "Source",
          source_format: "RGB24",
          source_width: 1,
          source_height: 1,
          output_width: 1,
          output_height: 1,
          warnings: [],
        },
        {
          id: "Filtered",
          label: "Filtered",
          source_format: "RGB24",
          source_width: 1,
          source_height: 1,
          output_width: 1,
          output_height: 1,
          warnings: [],
        },
      ],
    });

    const first = new Uint8Array([1]);
    const second = new Uint8Array([2]);
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
            byte_length: first.byteLength,
            render_ms: 1,
            encode_ms: 1,
          },
          {
            clip_id: "Filtered",
            buffer_index: 1,
            mime: "image/jpeg",
            byte_length: second.byteLength,
            render_ms: 1,
            encode_ms: 1,
          },
        ],
      },
      [new DataView(first.buffer), new DataView(second.buffer)],
    );

    await vi.waitFor(() =>
      expect(element.querySelector("[role='status']")?.textContent).toContain(
        "active preview canvas is unavailable",
      ),
    );
    expect(drawImage).not.toHaveBeenCalled();
  });

  it("requests exact paused frames from the visible navigation controls", () => {
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
      mode: "single",
      active_clip_ids: ["Source"],
      overlay_opacity: 0.5,
      max_visible_clips: 4,
      autoplay: false,
      clips: [
        {
          id: "Source",
          label: "Source",
          source_format: "RGB24",
          source_width: 1920,
          source_height: 1080,
          output_width: 1920,
          output_height: 1080,
          warnings: [],
        },
      ],
    });

    const seek = element.querySelector<HTMLInputElement>(
      "input[aria-label='Seek frame']",
    );
    const frame = element.querySelector<HTMLInputElement>(
      "input[aria-label='Current frame']",
    );
    const time = element.querySelector<HTMLInputElement>(
      "input[aria-label='Current time']",
    );
    const next = element.querySelector<HTMLButtonElement>(
      "button[aria-label='Next frame']",
    );
    const last = element.querySelector<HTMLButtonElement>(
      "button[aria-label='Last frame']",
    );

    expect(seek?.max).toBe("239");
    expect(frame?.value).toBe("0");
    expect(time?.value).toBe("00:00:00.000");
    expect(time?.maxLength).toBe(32);
    expect(
      element.querySelector("[role='group'][aria-label='Paused navigation']"),
    ).not.toBeNull();
    expect(element.textContent).toContain("00:00:10.010");
    expect(next).not.toBeNull();
    expect(last).not.toBeNull();

    next?.click();
    expect(frame?.value).toBe("1");
    expect(time?.value).toBe("00:00:00.042");

    if (frame !== null) {
      frame.value = "120";
      frame.dispatchEvent(new Event("change", { bubbles: true }));
    }
    expect(seek?.value).toBe("120");
    expect(time?.value).toBe("00:00:05.005");

    if (time !== null) {
      time.value = "00:00:01.001";
      time.dispatchEvent(new Event("change", { bubbles: true }));
    }
    expect(frame?.value).toBe("24");

    last?.click();
    expect(frame?.value).toBe("239");

    const requests = model.sent.filter(
      (message): message is Record<string, unknown> =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "request_frame_set",
    );
    expect(requests.map(({ request_id, generation, frame: target }) => ({
      request_id,
      generation,
      frame: target,
    }))).toEqual([
      { request_id: 0, generation: 0, frame: 0 },
      { request_id: 1, generation: 1, frame: 1 },
      { request_id: 2, generation: 2, frame: 120 },
      { request_id: 3, generation: 3, frame: 24 },
      { request_id: 4, generation: 4, frame: 239 },
    ]);
  });

  it("scopes paused navigation keys and uses Shift for one-second seeks", () => {
    const model = new FakeModel();
    const element = document.createElement("div");

    render({
      model,
      el: element,
      signal: new AbortController().signal,
    });
    model.emit({
      protocol: 1,
      type: "metadata",
      session_id: "session-1",
      status: "initialized",
      num_frames: 240,
      fps_num: 24000,
      fps_den: 1001,
      mode: "single",
      active_clip_ids: ["Source"],
      overlay_opacity: 0.5,
      max_visible_clips: 4,
      autoplay: false,
      clips: [
        {
          id: "Source",
          label: "Source",
          source_format: "RGB24",
          source_width: 1920,
          source_height: 1080,
          output_width: 1920,
          output_height: 1080,
          warnings: [],
        },
      ],
    });

    const frame = element.querySelector<HTMLInputElement>(
      "input[aria-label='Current frame']",
    );
    expect(frame).not.toBeNull();

    element.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    expect(frame?.value).toBe("1");

    element.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowRight",
        shiftKey: true,
        bubbles: true,
      }),
    );
    expect(frame?.value).toBe("24");

    element.dispatchEvent(
      new KeyboardEvent("keydown", { key: "End", bubbles: true }),
    );
    expect(frame?.value).toBe("239");

    element.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Home", bubbles: true }),
    );
    expect(frame?.value).toBe("0");

    frame?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    expect(frame?.value).toBe("0");

    const next = element.querySelector<HTMLButtonElement>(
      "button[aria-label='Next frame']",
    );
    next?.dispatchEvent(
      new KeyboardEvent("keydown", { key: " ", bubbles: true }),
    );
    expect(
      model.sent.filter(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "set_playing",
      ),
    ).toEqual([]);

    element.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowRight",
        ctrlKey: true,
        bubbles: true,
      }),
    );
    expect(frame?.value).toBe("0");

    const requests = model.sent.filter(
      (message): message is Record<string, unknown> =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "request_frame_set",
    );
    expect(requests.map((request) => request.frame)).toEqual([0, 1, 24, 239, 0]);
  });

  it("plays from a rational clock and pauses from the visible control", () => {
    let scheduled: FrameRequestCallback | undefined;
    const cancel = vi.fn();
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        scheduled = callback;
        return 23;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", cancel);
    vi.spyOn(performance, "now").mockReturnValue(100);

    const model = new FakeModel();
    const element = document.createElement("div");
    render({ model, el: element, signal: new AbortController().signal });
    model.emit({
      protocol: 1,
      type: "metadata",
      session_id: "session-1",
      status: "initialized",
      num_frames: 100,
      fps_num: 24000,
      fps_den: 1001,
      mode: "single",
      active_clip_ids: ["Source"],
      overlay_opacity: 0.5,
      max_visible_clips: 4,
      autoplay: false,
      clips: [
        {
          id: "Source",
          label: "Source",
          source_format: "RGB24",
          source_width: 64,
          source_height: 48,
          output_width: 64,
          output_height: 48,
          warnings: [],
        },
      ],
    });

    const play = element.querySelector<HTMLButtonElement>(
      "button[aria-label='Play']",
    );
    expect(play).not.toBeNull();
    play?.click();
    expect(
      element.querySelector("button[aria-label='Pause']"),
    ).not.toBeNull();

    scheduled?.(1101);

    const requests = model.sent.filter(
      (message): message is Record<string, unknown> =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "request_frame_set",
    );
    expect(requests).toMatchObject([
      { request_id: 0, generation: 0, frame: 0, reason: "seek" },
      { request_id: 1, generation: 0, frame: 24, reason: "playback" },
    ]);
    expect(model.sent).toContainEqual({
      protocol: 1,
      type: "set_playing",
      session_id: "session-1",
      playing: true,
    });

    element
      .querySelector<HTMLButtonElement>("button[aria-label='Pause']")
      ?.click();
    expect(cancel).toHaveBeenCalledWith(23);
    expect(model.sent.at(-1)).toEqual({
      protocol: 1,
      type: "set_playing",
      session_id: "session-1",
      playing: false,
    });
  });
});
