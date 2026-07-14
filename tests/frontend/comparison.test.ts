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
    const close = vi.fn();
    const createImageBitmap = vi
      .fn()
      .mockResolvedValue({ close } as unknown as ImageBitmap);
    vi.stubGlobal("createImageBitmap", createImageBitmap);

    const model = new FakeModel();
    const element = document.createElement("div");
    const controller = new AbortController();
    render({ model, el: element, signal: controller.signal });
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