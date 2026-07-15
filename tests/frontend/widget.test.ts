import { afterEach, describe, expect, it, vi } from "vitest";

import { render } from "../../frontend/index.js";
import { FakeModel } from "./support/fake-model.js";

describe("widget render", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("registers the custom message listener before sending ready", async () => {
    const model = new FakeModel();
    const element = document.createElement("div");
    const controller = new AbortController();

    render({ model, el: element, signal: controller.signal });

    await vi.waitFor(() => expect(model.sent).toHaveLength(1));
    expect(model.order.indexOf("on:msg:custom")).toBeLessThan(
      model.order.indexOf("send:ready"),
    );
    expect(model.sent).toEqual([
      {
        protocol: 1,
        type: "ready",
        session_id: "session-1",
        capabilities: {
          image_bitmap: false,
          webp: false,
        },
      },
    ]);
  });

  it("reports WebP support after decoding through createImageBitmap", async () => {
    const close = vi.fn();
    const createImageBitmap = vi.fn().mockResolvedValue({ close });
    vi.stubGlobal("createImageBitmap", createImageBitmap);
    const model = new FakeModel();
    const element = document.createElement("div");
    const controller = new AbortController();

    render({ model, el: element, signal: controller.signal });

    await vi.waitFor(() => expect(model.sent).toHaveLength(1));
    expect(model.sent).toEqual([
      {
        protocol: 1,
        type: "ready",
        session_id: "session-1",
        capabilities: {
          image_bitmap: true,
          webp: true,
        },
      },
    ]);
    expect(createImageBitmap).toHaveBeenCalledWith(
      expect.objectContaining({ size: 36, type: "image/webp" }),
    );
    expect(close).toHaveBeenCalledOnce();
  });

  it("does not report WebP when the production decode path rejects it", async () => {
    const createImageBitmap = vi.fn().mockRejectedValue(new Error("unsupported"));
    vi.stubGlobal("createImageBitmap", createImageBitmap);
    const model = new FakeModel();
    const element = document.createElement("div");
    const controller = new AbortController();

    render({ model, el: element, signal: controller.signal });

    await vi.waitFor(() => expect(model.sent).toHaveLength(1));
    expect(model.sent).toEqual([
      {
        protocol: 1,
        type: "ready",
        session_id: "session-1",
        capabilities: {
          image_bitmap: true,
          webp: false,
        },
      },
    ]);
  });

  it("renders an initialized placeholder after metadata", () => {
    const model = new FakeModel();
    const element = document.createElement("div");
    const controller = new AbortController();

    render({ model, el: element, signal: controller.signal });
    expect(element.textContent).toContain("Initializing Kaleidoscope");

    model.emit({
      protocol: 1,
      type: "metadata",
      session_id: "session-1",
      status: "initialized",
    });

    expect(element.textContent).toContain("Kaleidoscope is ready");
    expect(element.querySelector("[role='status']")).not.toBeNull();
  });

  it("renders a terminal protocol error for invalid metadata", () => {
    const model = new FakeModel();
    const element = document.createElement("div");
    const controller = new AbortController();

    render({ model, el: element, signal: controller.signal });
    model.emit({
      protocol: 2,
      type: "metadata",
      session_id: "session-1",
      status: "initialized",
    });

    expect(element.textContent).toContain("Protocol error");
  });

  it("renders backend error text literally", () => {
    const model = new FakeModel();
    const element = document.createElement("div");
    const controller = new AbortController();

    render({ model, el: element, signal: controller.signal });
    model.emit({
      protocol: 1,
      type: "error",
      session_id: "session-1",
      code: "invalid_message",
      message: "<img src=x onerror=alert(1)>",
      recoverable: false,
    });

    expect(element.querySelector("img")).toBeNull();
    expect(element.querySelector("[role='status']")?.textContent).toBe(
      "Protocol error: <img src=x onerror=alert(1)>",
    );
  });

  it("blocks interaction after a terminal backend error", () => {
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
      overlay_opacity: 0.5,
      max_visible_clips: 1,
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
      ],
    });
    model.emit({
      protocol: 1,
      type: "error",
      session_id: "session-1",
      code: "session_closed",
      message: "The preview session is closed.",
      recoverable: false,
    });
    const sentAfterError = model.sent.length;

    element.querySelector<HTMLButtonElement>("button[aria-label='Play']")?.click();
    const seek = element.querySelector<HTMLInputElement>(
      "input[aria-label='Seek frame']",
    );
    if (seek === null) {
      throw new Error("Missing seek control.");
    }
    seek.value = "1";
    seek.dispatchEvent(new Event("change", { bubbles: true }));

    expect(model.sent).toHaveLength(sentAfterError);
    expect(element.querySelector("[role='status']")?.textContent).toBe(
      "Protocol error: The preview session is closed.",
    );
  });

  it("pauses and retains the last frame when the kernel disconnects", async () => {
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      clearRect: vi.fn(),
      drawImage,
    } as unknown as CanvasRenderingContext2D);
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
      num_frames: 10,
      fps_num: 24,
      fps_den: 1,
      mode: "single",
      active_clip_ids: ["Source"],
      overlay_opacity: 0.5,
      max_visible_clips: 1,
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
      ],
    });
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
            byte_length: 1,
            render_ms: 1,
            encode_ms: 1,
          },
        ],
      },
      [new DataView(new Uint8Array([1]).buffer)],
    );
    await vi.waitFor(() => expect(drawImage).toHaveBeenCalledOnce());
    element.querySelector<HTMLButtonElement>("button[aria-label='Play']")?.click();

    model.comm_live = false;
    model.emitEvent("comm_live_update");

    expect(model.sent).toContainEqual({
      protocol: 1,
      type: "set_playing",
      session_id: "session-1",
      playing: false,
    });
    expect(element.querySelector("[role='status']")?.textContent).toBe(
      "Kernel disconnected. Preview paused.",
    );
    expect(element.querySelector("button[aria-label='Play']")).not.toBeNull();
    expect(drawImage).toHaveBeenCalledOnce();

    const sentAfterDisconnect = model.sent.length;
    element.querySelector<HTMLButtonElement>("button[aria-label='Play']")?.click();
    const seek = element.querySelector<HTMLInputElement>(
      "input[aria-label='Seek frame']",
    );
    if (seek === null) {
      throw new Error("Missing seek control.");
    }
    seek.value = "1";
    seek.dispatchEvent(new Event("change", { bubbles: true }));

    expect(model.sent).toHaveLength(sentAfterDisconnect);
    expect(element.querySelector("button[aria-label='Play']")).not.toBeNull();
    expect(element.querySelector("[role='status']")?.textContent).toBe(
      "Kernel disconnected. Preview paused.",
    );
  });

  it("removes the model listener when the view is aborted", () => {
    const model = new FakeModel();
    const element = document.createElement("div");
    const controller = new AbortController();

    render({ model, el: element, signal: controller.signal });
    controller.abort();

    expect(model.order).toContain("off:msg:custom");
    expect(model.order).toContain("off:change:comm_live");
    expect(model.order).toContain("off:comm_live_update");
    const sentBeforeDisconnect = model.sent.length;
    model.setCommLive(false);
    expect(model.sent).toHaveLength(sentBeforeDisconnect);
  });

  it("stops paused navigation when the view is aborted", () => {
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
    controller.abort();

    element.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );

    const requests = model.sent.filter(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "request_frame_set",
    );
    expect(requests).toHaveLength(1);
  });

  it("stale-acks an in-flight decode when the view is aborted", async () => {
    let resolveDecode: (bitmap: ImageBitmap) => void = () => {};
    const close = vi.fn();
    vi.stubGlobal(
      "createImageBitmap",
      vi
        .fn()
        .mockResolvedValueOnce({ close: vi.fn() } as unknown as ImageBitmap)
        .mockReturnValueOnce(
          new Promise<ImageBitmap>((resolve) => {
            resolveDecode = resolve;
          }),
        ),
    );
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      clearRect: vi.fn(),
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
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
      num_frames: 1,
      fps_num: 24,
      fps_den: 1,
      mode: "single",
      active_clip_ids: ["Source"],
      overlay_opacity: 0.5,
      max_visible_clips: 1,
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
      ],
    });
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
            byte_length: 1,
            render_ms: 1,
            encode_ms: 1,
          },
        ],
      },
      [new DataView(new Uint8Array([1]).buffer)],
    );

    controller.abort();

    expect(model.sent).toContainEqual({
      protocol: 1,
      type: "ack_frame_set",
      session_id: "session-1",
      request_id: 0,
      generation: 0,
      outcome: "stale",
    });
    resolveDecode({ close } as unknown as ImageBitmap);
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(
      model.sent.filter(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "ack_frame_set" &&
          "request_id" in message &&
          message.request_id === 0,
      ),
    ).toHaveLength(1);
  });

  it("keeps two rendered widgets independent", async () => {
    vi.stubGlobal(
      "createImageBitmap",
      vi
        .fn()
        .mockResolvedValue({ close: vi.fn() } as unknown as ImageBitmap),
    );
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      clearRect: vi.fn(),
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    const firstModel = new FakeModel("session-1");
    const secondModel = new FakeModel("session-2");
    const firstElement = document.createElement("div");
    const secondElement = document.createElement("div");

    render({
      model: firstModel,
      el: firstElement,
      signal: new AbortController().signal,
    });
    render({
      model: secondModel,
      el: secondElement,
      signal: new AbortController().signal,
    });
    const createMetadata = (sessionId: string) => ({
      protocol: 1,
      type: "metadata",
      session_id: sessionId,
      status: "initialized",
      num_frames: 10,
      fps_num: 24,
      fps_den: 1,
      mode: "single",
      active_clip_ids: ["Source"],
      overlay_opacity: 0.5,
      max_visible_clips: 1,
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
      ],
    });
    firstModel.emit(createMetadata("session-1"));
    secondModel.emit(createMetadata("session-2"));

    firstElement
      .querySelector<HTMLButtonElement>("button[aria-label='Play']")
      ?.click();

    expect(firstModel.sent).toContainEqual({
      protocol: 1,
      type: "set_playing",
      session_id: "session-1",
      playing: true,
    });
    expect(secondModel.sent).not.toContainEqual(
      expect.objectContaining({ type: "set_playing" }),
    );
    expect(secondElement.querySelector("button[aria-label='Play']")).not.toBeNull();

    firstModel.comm_live = false;
    firstModel.emitEvent("comm_live_update");

    expect(firstElement.querySelector("[role='status']")?.textContent).toBe(
      "Kernel disconnected. Preview paused.",
    );
    expect(secondElement.querySelector("[role='status']")?.textContent).not.toBe(
      "Kernel disconnected. Preview paused.",
    );
  });
});
