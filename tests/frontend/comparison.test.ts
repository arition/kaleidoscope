import { afterEach, describe, expect, it, vi } from "vitest";

import { render } from "../../frontend/index.js";
import { paintFrameSet } from "../../frontend/player.js";
import type { PlayerView } from "../../frontend/player.js";
import type {
  FrameSetMessage,
  PreviewMetadataMessage,
} from "../../frontend/protocol.js";
import { FakeModel } from "./support/fake-model.js";

const metadata: PreviewMetadataMessage = {
  protocol: 1,
  type: "metadata",
  session_id: "session-1",
  status: "initialized",
  num_frames: 2,
  fps_num: 24,
  fps_den: 1,
  mode: "side-by-side",
  active_clip_ids: ["Source", "Filtered"],
  max_visible_clips: 4,
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
};

function frameSet(frame: number): FrameSetMessage {
  return {
    protocol: 1,
    type: "frame_set",
    session_id: "session-1",
    request_id: frame,
    generation: 0,
    frame,
    frames: [
      {
        clip_id: "Source",
        buffer_index: 0,
        mime: "image/jpeg",
        byte_length: 1,
        render_ms: 1,
        encode_ms: 1,
      },
      {
        clip_id: "Filtered",
        buffer_index: 1,
        mime: "image/jpeg",
        byte_length: 1,
        render_ms: 1,
        encode_ms: 1,
      },
    ],
  };
}

function createView(drawImage: ReturnType<typeof vi.fn>): PlayerView {
  const container = document.createElement("div");
  const source = document.createElement("canvas");
  const filtered = document.createElement("canvas");
  container.append(source, filtered);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    clearRect: vi.fn(),
    drawImage,
  } as unknown as CanvasRenderingContext2D);
  return {
    metadata,
    canvases: new Map([
      ["Source", source],
      ["Filtered", filtered],
    ]),
  };
}

function payloads(): DataView[] {
  return [
    new DataView(new Uint8Array([1]).buffer),
    new DataView(new Uint8Array([2]).buffer),
  ];
}

describe("atomic comparison painting", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps the last complete set visible while one replacement decode is slow", async () => {
    const drawImage = vi.fn();
    const view = createView(drawImage);
    const initialClose = vi.fn();
    vi.stubGlobal(
      "createImageBitmap",
      vi
        .fn()
        .mockResolvedValue({ close: initialClose } as unknown as ImageBitmap),
    );

    await paintFrameSet(view, frameSet(0), payloads(), () => true);
    expect(drawImage).toHaveBeenCalledTimes(2);

    let resolveSlowDecode: (bitmap: ImageBitmap) => void = () => {};
    const slowDecode = new Promise<ImageBitmap>((resolve) => {
      resolveSlowDecode = resolve;
    });
    const replacementClose = vi.fn();
    vi.stubGlobal(
      "createImageBitmap",
      vi
        .fn()
        .mockResolvedValueOnce({
          close: replacementClose,
        } as unknown as ImageBitmap)
        .mockReturnValueOnce(slowDecode),
    );

    const replacement = paintFrameSet(
      view,
      frameSet(1),
      payloads(),
      () => true,
    );
    await Promise.resolve();
    expect(drawImage).toHaveBeenCalledTimes(2);

    resolveSlowDecode({ close: replacementClose } as unknown as ImageBitmap);
    await replacement;
    expect(drawImage).toHaveBeenCalledTimes(4);
  });

  it("rejects one undecodable member without partially painting the set", async () => {
    const drawImage = vi.fn();
    const view = createView(drawImage);
    const decodedClose = vi.fn();
    vi.stubGlobal(
      "createImageBitmap",
      vi
        .fn()
        .mockResolvedValueOnce({ close: decodedClose } as unknown as ImageBitmap)
        .mockRejectedValueOnce(new Error("decode failed")),
    );

    await expect(
      paintFrameSet(view, frameSet(0), payloads(), () => true),
    ).rejects.toThrow("decode failed");
    expect(drawImage).not.toHaveBeenCalled();
    expect(decodedClose).toHaveBeenCalledOnce();
  });

  it("atomically rejects a staged draw failure before replacing canvases", async () => {
    const drawImage = vi
      .fn()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error("draw failed");
      });
    const view = createView(drawImage);
    const source = view.canvases.get("Source");
    const filtered = view.canvases.get("Filtered");
    vi.stubGlobal(
      "createImageBitmap",
      vi
        .fn()
        .mockResolvedValue({ close: vi.fn() } as unknown as ImageBitmap),
    );

    await expect(
      paintFrameSet(view, frameSet(0), payloads(), () => true),
    ).rejects.toThrow("draw failed");

    expect(view.canvases.get("Source")).toBe(source);
    expect(view.canvases.get("Filtered")).toBe(filtered);
    expect(source?.parentNode).toBe(filtered?.parentNode);
  });

  it("atomically ignores incomplete and stale sets after a complete commit", async () => {
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      clearRect: vi.fn(),
      drawImage,
    } as unknown as CanvasRenderingContext2D);
    const probeClose = vi.fn();
    const close = vi.fn();
    const createImageBitmap = vi
      .fn()
      .mockResolvedValueOnce({ close: probeClose } as unknown as ImageBitmap)
      .mockResolvedValue({ close } as unknown as ImageBitmap);
    vi.stubGlobal("createImageBitmap", createImageBitmap);

    const model = new FakeModel();
    const element = document.createElement("div");
    const controller = new AbortController();
    render({ model, el: element, signal: controller.signal });
    await vi.waitFor(() => expect(model.sent).toHaveLength(1));
    expect(probeClose).toHaveBeenCalledOnce();
    createImageBitmap.mockClear();
    model.emit(metadata);
    model.emit(frameSet(0), payloads());

    await vi.waitFor(() => expect(drawImage).toHaveBeenCalledTimes(2));
    expect(element.querySelector("[role='status']")?.textContent).toBe(
      "Frame 0 ready.",
    );

    const incomplete = frameSet(0);
    incomplete.frames = incomplete.frames.slice(0, 1);
    model.emit(incomplete, payloads().slice(0, 1));
    model.emit({ ...frameSet(0), request_id: 1 }, payloads());
    await Promise.resolve();

    expect(createImageBitmap).toHaveBeenCalledTimes(2);
    expect(drawImage).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(2);
    expect(element.querySelector("[role='status']")?.textContent).toBe(
      "Frame 0 ready.",
    );
  });

  it("invalidates the current paint as soon as the scrub target changes", async () => {
    let scheduled: FrameRequestCallback | undefined;
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        scheduled = callback;
        return 17;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      clearRect: vi.fn(),
      drawImage,
    } as unknown as CanvasRenderingContext2D);
    const createImageBitmap = vi
      .fn()
      .mockResolvedValue({ close: vi.fn() } as unknown as ImageBitmap);
    vi.stubGlobal("createImageBitmap", createImageBitmap);

    const model = new FakeModel();
    const element = document.createElement("div");
    render({ model, el: element, signal: new AbortController().signal });
    await vi.waitFor(() => expect(model.sent).toHaveLength(1));
    createImageBitmap.mockClear();
    model.emit(metadata);

    const seek = element.querySelector<HTMLInputElement>(
      "input[aria-label='Seek frame']",
    );
    expect(seek).not.toBeNull();
    if (seek !== null) {
      seek.value = "1";
      seek.dispatchEvent(new Event("input", { bubbles: true }));
    }

    model.emit(frameSet(0), payloads());
    await Promise.resolve();

    expect(createImageBitmap).not.toHaveBeenCalled();
    expect(drawImage).not.toHaveBeenCalled();

    scheduled?.(0);
    const requests = model.sent.filter(
      (message): message is Record<string, unknown> =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "request_frame_set",
    );
    expect(requests.map(({ frame, generation }) => ({ frame, generation }))).toEqual([
      { frame: 0, generation: 0 },
      { frame: 1, generation: 1 },
    ]);
  });

  it("ignores a stale decode failure after a newer frame paints", async () => {
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      clearRect: vi.fn(),
      drawImage,
    } as unknown as CanvasRenderingContext2D);

    let rejectStaleDecode: (error: Error) => void = () => {};
    const staleDecode = new Promise<ImageBitmap>((_resolve, reject) => {
      rejectStaleDecode = reject;
    });
    const staleClose = vi.fn();
    const currentClose = vi.fn();
    vi.stubGlobal(
      "createImageBitmap",
      vi
        .fn()
        .mockResolvedValueOnce({ close: vi.fn() } as unknown as ImageBitmap)
        .mockReturnValueOnce(staleDecode)
        .mockResolvedValueOnce({ close: staleClose } as unknown as ImageBitmap)
        .mockResolvedValue({ close: currentClose } as unknown as ImageBitmap),
    );

    const model = new FakeModel();
    const element = document.createElement("div");
    render({ model, el: element, signal: new AbortController().signal });
    await vi.waitFor(() => expect(model.sent).toHaveLength(1));
    model.emit(metadata);
    model.emit(frameSet(0), payloads());

    const frame = element.querySelector<HTMLInputElement>(
      "input[aria-label='Current frame']",
    );
    expect(frame).not.toBeNull();
    if (frame !== null) {
      frame.value = "1";
      frame.dispatchEvent(new Event("change", { bubbles: true }));
    }
    model.emit({ ...frameSet(1), generation: 1 }, payloads());

    await vi.waitFor(() =>
      expect(element.querySelector("[role='status']")?.textContent).toBe(
        "Frame 1 ready.",
      ),
    );
    rejectStaleDecode(new Error("stale decode failed"));
    await vi.waitFor(() => expect(staleClose).toHaveBeenCalledOnce());

    expect(element.querySelector("[role='status']")?.textContent).toBe(
      "Frame 1 ready.",
    );
    expect(drawImage).toHaveBeenCalledTimes(2);
    expect(currentClose).toHaveBeenCalledTimes(2);
  });

  it("identifies the failed clip without replacing the complete set", async () => {
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
    render({ model, el: element, signal: new AbortController().signal });
    model.emit(metadata);
    model.emit(frameSet(0), payloads());
    await vi.waitFor(() => expect(drawImage).toHaveBeenCalledTimes(2));

    model.emit({
      protocol: 1,
      type: "error",
      session_id: "session-1",
      request_id: 0,
      generation: 0,
      clip_id: "Filtered",
      code: "render_failed",
      message: "The preview frame could not be rendered.",
      recoverable: true,
    });

    expect(element.querySelector("[role='status']")?.textContent).toBe(
      "Filtered: The preview frame could not be rendered.",
    );
    expect(drawImage).toHaveBeenCalledTimes(2);
  });

  it("ignores a clip-specific error from a stale request", async () => {
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
    render({ model, el: element, signal: new AbortController().signal });
    model.emit(metadata);
    model.emit(frameSet(0), payloads());
    await vi.waitFor(() => expect(drawImage).toHaveBeenCalledTimes(2));

    model.emit({
      protocol: 1,
      type: "error",
      session_id: "session-1",
      request_id: 1,
      generation: 0,
      clip_id: "Filtered",
      code: "render_failed",
      message: "The preview frame could not be rendered.",
      recoverable: true,
    });

    expect(element.querySelector("[role='status']")?.textContent).toBe(
      "Frame 0 ready.",
    );
    expect(drawImage).toHaveBeenCalledTimes(2);
  });
});