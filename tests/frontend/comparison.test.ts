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
};

const interactiveMetadata: PreviewMetadataMessage = {
  ...metadata,
  num_frames: 10,
  max_visible_clips: 3,
  clips: [
    ...metadata.clips,
    {
      id: "Reference",
      label: "Reference",
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

function selectedFrameSet(
  requestId: number,
  generation: number,
  frame: number,
  clipIds: string[],
): FrameSetMessage {
  return {
    protocol: 1,
    type: "frame_set",
    session_id: "session-1",
    request_id: requestId,
    generation,
    frame,
    frames: clipIds.map((clipId, bufferIndex) => ({
      clip_id: clipId,
      buffer_index: bufferIndex,
      mime: "image/jpeg",
      byte_length: 1,
      render_ms: 1,
      encode_ms: 1,
    })),
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
    compose: () => {},
    getFrame: () => 0,
    prepareComparisonCommit: () => () => {},
    setComparison: () => {},
    setFrame: () => {},
    setPlaying: () => {},
  };
}

function payloads(): DataView[] {
  return [
    new DataView(new Uint8Array([1]).buffer),
    new DataView(new Uint8Array([2]).buffer),
  ];
}

async function setupInteractiveComparison(): Promise<{
  element: HTMLDivElement;
  model: FakeModel;
}> {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    clearRect: vi.fn(),
    drawImage: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    rect: vi.fn(),
    clip: vi.fn(),
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
  } as unknown as CanvasRenderingContext2D);
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn().mockResolvedValue({ close: vi.fn() } as unknown as ImageBitmap),
  );
  const model = new FakeModel();
  const element = document.createElement("div");
  render({ model, el: element, signal: new AbortController().signal });
  await vi.waitFor(() => expect(model.sent).toHaveLength(1));
  model.emit(interactiveMetadata);
  return { element, model };
}

const frameRequests = (model: FakeModel): Record<string, unknown>[] =>
  model.sent.filter(
    (message): message is Record<string, unknown> =>
      typeof message === "object" &&
      message !== null &&
      "type" in message &&
      message.type === "request_frame_set",
  );

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

  it("rejects a composition failure before replacing source canvases", async () => {
    const drawImage = vi.fn();
    const view = createView(drawImage);
    const source = view.canvases.get("Source");
    const filtered = view.canvases.get("Filtered");
    view.prepareComparisonCommit = () => {
      throw new Error("composition failed");
    };
    vi.stubGlobal(
      "createImageBitmap",
      vi
        .fn()
        .mockResolvedValue({ close: vi.fn() } as unknown as ImageBitmap),
    );

    await expect(
      paintFrameSet(view, frameSet(0), payloads(), () => true),
    ).rejects.toThrow("composition failed");

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
    expect(model.sent).toContainEqual({
      protocol: 1,
      type: "ack_frame_set",
      session_id: "session-1",
      request_id: 0,
      generation: 0,
      outcome: "painted",
    });

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

  it("ignores a duplicate delivery after acknowledging its identity", async () => {
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
    await vi.waitFor(() => expect(model.sent).toHaveLength(1));
    model.emit(metadata);
    model.emit(frameSet(0), payloads());
    await vi.waitFor(() =>
      expect(model.sent).toContainEqual(
        expect.objectContaining({
          type: "ack_frame_set",
          request_id: 0,
          outcome: "painted",
        }),
      ),
    );

    model.emit(frameSet(0), payloads());
    await Promise.resolve();

    expect(drawImage).toHaveBeenCalledTimes(2);
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
    expect(model.sent).toContainEqual({
      protocol: 1,
      type: "ack_frame_set",
      session_id: "session-1",
      request_id: 0,
      generation: 0,
      outcome: "stale",
    });

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

  it("releases a stale delivery before its decode settles", async () => {
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

    await vi.waitFor(() =>
      expect(model.sent).toContainEqual({
        protocol: 1,
        type: "ack_frame_set",
        session_id: "session-1",
        request_id: 0,
        generation: 0,
        outcome: "stale",
      }),
    );
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
    expect(drawImage).toHaveBeenCalledTimes(2);
    expect(currentClose).toHaveBeenCalledTimes(2);
  });

  it("bounds stale decodes and retries the latest frame when a slot opens", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      clearRect: vi.fn(),
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    let resolveFirst: (bitmap: ImageBitmap) => void = () => {};
    let resolveSecond: (bitmap: ImageBitmap) => void = () => {};
    const firstDecode = new Promise<ImageBitmap>((resolve) => {
      resolveFirst = resolve;
    });
    const secondDecode = new Promise<ImageBitmap>((resolve) => {
      resolveSecond = resolve;
    });
    const createImageBitmap = vi
      .fn()
      .mockResolvedValueOnce({ close: vi.fn() } as unknown as ImageBitmap)
      .mockReturnValueOnce(firstDecode)
      .mockResolvedValueOnce({ close: vi.fn() } as unknown as ImageBitmap)
      .mockReturnValueOnce(secondDecode)
      .mockResolvedValue({ close: vi.fn() } as unknown as ImageBitmap);
    vi.stubGlobal("createImageBitmap", createImageBitmap);

    const model = new FakeModel();
    const element = document.createElement("div");
    render({ model, el: element, signal: new AbortController().signal });
    await vi.waitFor(() => expect(model.sent).toHaveLength(1));
    createImageBitmap.mockClear();
    model.emit(metadata);
    model.emit(frameSet(0), payloads());

    const frame = element.querySelector<HTMLInputElement>(
      "input[aria-label='Current frame']",
    );
    if (frame === null) {
      throw new Error("Missing frame input.");
    }
    frame.value = "1";
    frame.dispatchEvent(new Event("change", { bubbles: true }));
    model.emit({ ...frameSet(1), generation: 1 }, payloads());
    frame.value = "0";
    frame.dispatchEvent(new Event("change", { bubbles: true }));
    model.emit(
      { ...frameSet(0), request_id: 2, generation: 2 },
      payloads(),
    );

    expect(createImageBitmap).toHaveBeenCalledTimes(4);
    expect(model.sent).toContainEqual({
      protocol: 1,
      type: "ack_frame_set",
      session_id: "session-1",
      request_id: 2,
      generation: 2,
      outcome: "stale",
    });

    resolveFirst({ close: vi.fn() } as unknown as ImageBitmap);
    await vi.waitFor(() =>
      expect(frameRequests(model).at(-1)).toMatchObject({
        request_id: 3,
        generation: 3,
        frame: 0,
      }),
    );
    resolveSecond({ close: vi.fn() } as unknown as ImageBitmap);
  });

  it("preserves deferred playback resume across a newer comparison change", async () => {
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 41));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      clearRect: vi.fn(),
      drawImage: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      rect: vi.fn(),
      clip: vi.fn(),
      globalAlpha: 1,
      globalCompositeOperation: "source-over",
    } as unknown as CanvasRenderingContext2D);
    let resolveFirst: (bitmap: ImageBitmap) => void = () => {};
    let resolveSecond: (bitmap: ImageBitmap) => void = () => {};
    const createImageBitmap = vi
      .fn()
      .mockResolvedValueOnce({ close: vi.fn() } as unknown as ImageBitmap)
      .mockReturnValueOnce(
        new Promise<ImageBitmap>((resolve) => {
          resolveFirst = resolve;
        }),
      )
      .mockResolvedValueOnce({ close: vi.fn() } as unknown as ImageBitmap)
      .mockReturnValueOnce(
        new Promise<ImageBitmap>((resolve) => {
          resolveSecond = resolve;
        }),
      )
      .mockResolvedValue({ close: vi.fn() } as unknown as ImageBitmap);
    vi.stubGlobal("createImageBitmap", createImageBitmap);
    const model = new FakeModel();
    const element = document.createElement("div");
    render({ model, el: element, signal: new AbortController().signal });
    await vi.waitFor(() => expect(model.sent).toHaveLength(1));
    model.emit(interactiveMetadata);
    model.emit(frameSet(0), payloads());

    const frame = element.querySelector<HTMLInputElement>(
      "input[aria-label='Current frame']",
    );
    if (frame === null) {
      throw new Error("Missing frame input.");
    }
    frame.value = "1";
    frame.dispatchEvent(new Event("change", { bubbles: true }));
    model.emit({ ...frameSet(1), generation: 1 }, payloads());
    element.querySelector<HTMLButtonElement>("button[aria-label='Play']")?.click();
    element
      .querySelector<HTMLButtonElement>("button[aria-label='Single view']")
      ?.click();
    model.emit(selectedFrameSet(2, 2, 0, ["Source"]), payloads().slice(0, 1));

    const solo = element.querySelector<HTMLSelectElement>(
      "select[aria-label='Solo clip']",
    );
    if (solo === null) {
      throw new Error("Missing solo selector.");
    }
    solo.value =
      Array.from(solo.options).find(
        (option) => option.textContent === "Reference",
      )?.value ?? "";
    solo.dispatchEvent(new Event("change", { bubbles: true }));

    const firstClose = vi.fn();
    const secondClose = vi.fn();
    resolveFirst({ close: firstClose } as unknown as ImageBitmap);
    resolveSecond({ close: secondClose } as unknown as ImageBitmap);
    await vi.waitFor(() => {
      expect(firstClose).toHaveBeenCalledOnce();
      expect(secondClose).toHaveBeenCalledOnce();
    });
    const latest = frameRequests(model).at(-1);
    expect(latest).toMatchObject({
      request_id: 3,
      generation: 3,
      clip_ids: ["Reference"],
    });
    model.emit(
      selectedFrameSet(3, 3, 0, ["Reference"]),
      payloads().slice(0, 1),
    );

    await vi.waitFor(() =>
      expect(
        model.sent.filter(
          (message): message is Record<string, unknown> =>
            typeof message === "object" &&
            message !== null &&
            "type" in message &&
            message.type === "set_playing",
        ),
      ).toMatchObject([
        { playing: true },
        { playing: false },
        { playing: true },
      ]),
    );
  });

  it("acks a current decode failure and pauses playback intent", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      clearRect: vi.fn(),
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.stubGlobal(
      "createImageBitmap",
      vi
        .fn()
        .mockResolvedValueOnce({ close: vi.fn() } as unknown as ImageBitmap)
        .mockRejectedValueOnce(new Error("decode failed"))
        .mockResolvedValueOnce({ close: vi.fn() } as unknown as ImageBitmap),
    );

    const model = new FakeModel();
    const element = document.createElement("div");
    render({ model, el: element, signal: new AbortController().signal });
    await vi.waitFor(() => expect(model.sent).toHaveLength(1));
    model.emit(metadata);
    element.querySelector<HTMLButtonElement>("button[aria-label='Play']")?.click();
    model.emit(frameSet(0), payloads());

    await vi.waitFor(() =>
      expect(model.sent).toContainEqual({
        protocol: 1,
        type: "ack_frame_set",
        session_id: "session-1",
        request_id: 0,
        generation: 0,
        outcome: "decode_error",
      }),
    );
    expect(model.sent).toContainEqual({
      protocol: 1,
      type: "set_playing",
      session_id: "session-1",
      playing: false,
    });
    expect(element.querySelector("button[aria-label='Play']")).not.toBeNull();
  });

  it("keeps the committed view and allows an active-set retry after decode failure", async () => {
    const { element, model } = await setupInteractiveComparison();
    model.emit(frameSet(0), payloads());
    await vi.waitFor(() =>
      expect(model.sent).toContainEqual(
        expect.objectContaining({ type: "ack_frame_set", outcome: "painted" }),
      ),
    );
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn().mockRejectedValue(new Error("decode failed")),
    );

    element
      .querySelector<HTMLButtonElement>("button[aria-label='Single view']")
      ?.click();
    model.emit(selectedFrameSet(1, 1, 0, ["Source"]), payloads().slice(0, 1));
    await vi.waitFor(() =>
      expect(model.sent).toContainEqual(
        expect.objectContaining({
          type: "ack_frame_set",
          request_id: 1,
          outcome: "decode_error",
        }),
      ),
    );

    expect(element.querySelector(".kaleidoscope-mode")?.textContent).toBe(
      "side-by-side",
    );
    expect(
      element
        .querySelector("button[aria-label='Single view']")
        ?.getAttribute("aria-pressed"),
    ).toBe("true");

    element
      .querySelector<HTMLButtonElement>("button[aria-label='Single view']")
      ?.click();
    expect(frameRequests(model)).toHaveLength(3);
    expect(frameRequests(model).at(-1)).toMatchObject({
      clip_ids: ["Source"],
    });
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

  it("pauses playback after a recoverable clip error and allows a seek retry", async () => {
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

    element.querySelector<HTMLButtonElement>("button[aria-label='Play']")?.click();
    const activeRequest = frameRequests(model).at(-1);
    if (activeRequest === undefined) {
      throw new Error("Missing active playback request.");
    }
    model.emit({
      protocol: 1,
      type: "error",
      session_id: "session-1",
      request_id: activeRequest.request_id,
      generation: activeRequest.generation,
      clip_id: "Filtered",
      code: "render_failed",
      message: "The preview frame could not be rendered.",
      recoverable: true,
    });

    expect(model.sent).toContainEqual({
      protocol: 1,
      type: "set_playing",
      session_id: "session-1",
      playing: false,
    });
    expect(element.querySelector("button[aria-label='Play']")).not.toBeNull();
    expect(element.querySelector("[role='status']")?.textContent).toBe(
      "Filtered: The preview frame could not be rendered.",
    );
    expect(drawImage).toHaveBeenCalledTimes(2);

    const seek = element.querySelector<HTMLInputElement>(
      "input[aria-label='Seek frame']",
    );
    if (seek === null) {
      throw new Error("Missing seek control.");
    }
    seek.value = "1";
    seek.dispatchEvent(new Event("change", { bubbles: true }));
    expect(frameRequests(model).at(-1)).toMatchObject({ frame: 1 });
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

  it("switches aligned modes locally with accessible composition controls", async () => {
    const { element, model } = await setupInteractiveComparison();

    element.querySelector<HTMLButtonElement>("button[aria-label='Wipe view']")?.click();
    const wipe = element.querySelector<HTMLInputElement>(
      "input[aria-label='Wipe position']",
    );
    expect(wipe?.type).toBe("range");
    expect(wipe?.min).toBe("0");
    expect(wipe?.max).toBe("100");

    element
      .querySelector<HTMLButtonElement>("button[aria-label='Overlay view']")
      ?.click();
    const opacity = element.querySelector<HTMLInputElement>(
      "input[aria-label='Overlay opacity']",
    );
    expect(opacity?.min).toBe("0");
    expect(opacity?.max).toBe("1");

    element
      .querySelector<HTMLButtonElement>("button[aria-label='Difference view']")
      ?.click();
    expect(element.textContent).toContain("8-bit visual difference (non-reference)");
    expect(frameRequests(model)).toHaveLength(1);
    expect(model.sent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "set_view",
          generation: 0,
          mode: "wipe",
          clip_ids: ["Source", "Filtered"],
        }),
        expect.objectContaining({
          type: "set_view",
          generation: 0,
          mode: "overlay",
          clip_ids: ["Source", "Filtered"],
        }),
        expect.objectContaining({
          type: "set_view",
          generation: 0,
          mode: "difference",
          clip_ids: ["Source", "Filtered"],
        }),
      ]),
    );
  });

  it("announces a changed aligned pair without changing committed rows", async () => {
    const { element, model } = await setupInteractiveComparison();
    element.querySelector<HTMLButtonElement>("button[aria-label='Wipe view']")?.click();

    const secondary = element.querySelector<HTMLSelectElement>(
      "select[aria-label='Comparison clip B']",
    );
    expect(secondary).not.toBeNull();
    if (secondary !== null) {
      secondary.value =
        Array.from(secondary.options).find(
          (option) => option.textContent === "Reference",
        )?.value ?? "";
      secondary.dispatchEvent(new Event("change", { bubbles: true }));
    }

    const changedView = model.sent.findIndex(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "set_view" &&
        "clip_ids" in message &&
        Array.isArray(message.clip_ids) &&
        message.clip_ids.includes("Reference"),
    );
    const changedRequest = model.sent.findIndex(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "request_frame_set" &&
        "clip_ids" in message &&
        Array.isArray(message.clip_ids) &&
        message.clip_ids.includes("Reference"),
    );
    expect(changedView).toBeGreaterThan(-1);
    expect(changedRequest).toBeGreaterThan(changedView);
    expect(model.sent[changedView]).toMatchObject({
      generation: 1,
      mode: "wipe",
      clip_ids: ["Source", "Reference"],
    });
    expect(model.sent[changedRequest]).toMatchObject({
      generation: 1,
      frame: 0,
      clip_ids: ["Source", "Reference"],
    });
    expect(
      element.querySelector("[data-clip-id='Reference']")?.getAttribute("data-active"),
    ).toBe("false");
  });

  it("keeps the committed active rows visible until a new active set paints", async () => {
    const { element, model } = await setupInteractiveComparison();
    model.emit(frameSet(0), payloads());
    await vi.waitFor(() =>
      expect(model.sent).toContainEqual(
        expect.objectContaining({ type: "ack_frame_set", outcome: "painted" }),
      ),
    );

    const sourceCanvas = element.querySelector(
      "[data-clip-id='Source'] .kaleidoscope-canvas",
    );
    const filteredCanvas = element.querySelector(
      "[data-clip-id='Filtered'] .kaleidoscope-canvas",
    );
    element
      .querySelector<HTMLButtonElement>("button[aria-label='Single view']")
      ?.click();

    expect(element.querySelector(".kaleidoscope-mode")?.textContent).toBe(
      "side-by-side",
    );
    expect(
      element.querySelector("[data-clip-id='Source']")?.getAttribute("data-active"),
    ).toBe("true");
    expect(
      element
        .querySelector("[data-clip-id='Filtered']")
        ?.getAttribute("data-active"),
    ).toBe("true");
    expect(
      element.querySelector("[data-clip-id='Source'] .kaleidoscope-canvas"),
    ).toBe(sourceCanvas);
    expect(
      element.querySelector("[data-clip-id='Filtered'] .kaleidoscope-canvas"),
    ).toBe(filteredCanvas);

    model.emit(selectedFrameSet(1, 1, 0, ["Source"]), payloads().slice(0, 1));
    await vi.waitFor(() =>
      expect(element.querySelector(".kaleidoscope-mode")?.textContent).toBe(
        "single",
      ),
    );
    expect(
      element
        .querySelector("[data-clip-id='Filtered']")
        ?.getAttribute("data-active"),
    ).toBe("false");
  });

  it("pauses and resumes playback around an active-set commit", async () => {
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 41));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const { element, model } = await setupInteractiveComparison();
    model.emit(frameSet(0), payloads());
    await vi.waitFor(() =>
      expect(model.sent).toContainEqual(
        expect.objectContaining({ type: "ack_frame_set", outcome: "painted" }),
      ),
    );

    element.querySelector<HTMLButtonElement>("button[aria-label='Play']")?.click();
    element
      .querySelector<HTMLButtonElement>("button[aria-label='Single view']")
      ?.click();

    expect(
      model.sent.filter(
        (message): message is Record<string, unknown> =>
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "set_playing",
      ),
    ).toMatchObject([{ playing: true }, { playing: false }]);
    expect(frameRequests(model).at(-1)).toMatchObject({
      request_id: 1,
      generation: 1,
      frame: 0,
      clip_ids: ["Source"],
    });
    expect(element.querySelector(".kaleidoscope-mode")?.textContent).toBe(
      "side-by-side",
    );

    model.emit(selectedFrameSet(1, 1, 0, ["Source"]), payloads().slice(0, 1));
    await vi.waitFor(() =>
      expect(element.querySelector(".kaleidoscope-mode")?.textContent).toBe(
        "single",
      ),
    );
    expect(
      model.sent.filter(
        (message): message is Record<string, unknown> =>
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "set_playing",
      ),
    ).toMatchObject([
      { playing: true },
      { playing: false },
      { playing: true },
    ]);
  });

  it("retains the last complete composition until a changed pair commits", async () => {
    const { element, model } = await setupInteractiveComparison();
    model.emit(frameSet(0), payloads());
    await vi.waitFor(() =>
      expect(model.sent).toContainEqual(
        expect.objectContaining({ type: "ack_frame_set", outcome: "painted" }),
      ),
    );
    element.querySelector<HTMLButtonElement>("button[aria-label='Wipe view']")?.click();

    const complete = element.querySelector<HTMLCanvasElement>(
      ".kaleidoscope-comparison__canvas",
    );
    expect(complete?.getAttribute("aria-label")).toContain("Filtered");

    const secondary = element.querySelector<HTMLSelectElement>(
      "select[aria-label='Comparison clip B']",
    );
    if (secondary !== null) {
      secondary.value =
        Array.from(secondary.options).find(
          (option) => option.textContent === "Reference",
        )?.value ?? "";
      secondary.dispatchEvent(new Event("change", { bubbles: true }));
    }

    expect(
      element.querySelector(".kaleidoscope-comparison__canvas"),
    ).toBe(complete);
    expect(complete?.getAttribute("aria-label")).toContain("Filtered");

    model.emit(
      selectedFrameSet(1, 1, 0, ["Source", "Reference"]),
      payloads(),
    );
    await vi.waitFor(() =>
      expect(
        element
          .querySelector(".kaleidoscope-comparison__canvas")
          ?.getAttribute("aria-label"),
      ).toContain("Reference"),
    );
    expect(
      element.querySelector(".kaleidoscope-comparison__canvas"),
    ).not.toBe(complete);
  });
});