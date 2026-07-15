import { afterEach, describe, expect, it, vi } from "vitest";

import { render } from "../../frontend/index.js";
import { FakeModel } from "./support/fake-model.js";

const metadata = (autoplay: boolean) => ({
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
  autoplay,
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

const frameSet = (requestId: number, generation: number, frame: number) => ({
  protocol: 1,
  type: "frame_set",
  session_id: "session-1",
  request_id: requestId,
  generation,
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
  ],
});

const setup = async (): Promise<{
  model: FakeModel;
  element: HTMLElement;
}> => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    clearRect: vi.fn(),
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn().mockResolvedValue({ close: vi.fn() } as unknown as ImageBitmap),
  );
  const model = new FakeModel();
  const element = document.createElement("div");
  render({ model, el: element, signal: new AbortController().signal });
  await vi.waitFor(() => expect(model.sent).toHaveLength(1));
  return { model, element };
};

const playingStates = (model: FakeModel): boolean[] =>
  model.sent
    .filter(
      (message): message is { type: "set_playing"; playing: boolean } =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "set_playing",
    )
    .map((message) => message.playing);

describe("playback lifecycle", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("starts autoplay only after the initial frame paints", async () => {
    const { model, element } = await setup();
    model.emit(metadata(true));

    expect(playingStates(model)).toEqual([]);

    model.emit(frameSet(0, 0, 0), [new DataView(new Uint8Array([1]).buffer)]);
    await vi.waitFor(() => expect(playingStates(model)).toEqual([true]));

    const paintedAck = model.sent.findIndex(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "ack_frame_set" &&
        "outcome" in message &&
        message.outcome === "painted",
    );
    const started = model.sent.findIndex(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "set_playing" &&
        "playing" in message &&
        message.playing === true,
    );
    expect(started).toBeGreaterThan(paintedAck);
    expect(element.querySelector("button[aria-label='Pause']")).not.toBeNull();
  });

  it("does not let pending autoplay override an explicit pause", async () => {
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const { model, element } = await setup();
    model.emit(metadata(true));

    element.querySelector<HTMLButtonElement>("button[aria-label='Play']")?.click();
    element.querySelector<HTMLButtonElement>("button[aria-label='Pause']")?.click();

    const requests = model.sent.filter(
      (message): message is Record<string, unknown> =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "request_frame_set",
    );
    expect(requests).toMatchObject([
      { request_id: 0, generation: 0, frame: 0 },
      { request_id: 1, generation: 1, frame: 0 },
    ]);

    model.emit(frameSet(1, 1, 0), [new DataView(new Uint8Array([1]).buffer)]);
    await vi.waitFor(() =>
      expect(model.sent).toContainEqual(
        expect.objectContaining({
          type: "ack_frame_set",
          request_id: 1,
          outcome: "painted",
        }),
      ),
    );

    expect(playingStates(model)).toEqual([true, false]);
    expect(element.querySelector("button[aria-label='Play']")).not.toBeNull();
  });

  it("temporarily pauses scrubbing and resumes after the exact target paints", async () => {
    let nextHandle = 1;
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => nextHandle++),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const { model, element } = await setup();
    model.emit(metadata(false));
    model.emit(frameSet(0, 0, 0), [new DataView(new Uint8Array([1]).buffer)]);
    await vi.waitFor(() =>
      expect(model.sent).toContainEqual(
        expect.objectContaining({ type: "ack_frame_set", outcome: "painted" }),
      ),
    );

    element.querySelector<HTMLButtonElement>("button[aria-label='Play']")?.click();
    const seek = element.querySelector<HTMLInputElement>(
      "input[aria-label='Seek frame']",
    );
    if (seek === null) {
      throw new Error("Missing seek control.");
    }
    seek.value = "5";
    seek.dispatchEvent(new Event("input", { bubbles: true }));
    seek.dispatchEvent(new Event("change", { bubbles: true }));

    const requests = model.sent.filter(
      (message): message is Record<string, unknown> =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "request_frame_set",
    );
    expect(requests.map(({ request_id, generation, frame }) => ({
      request_id,
      generation,
      frame,
    }))).toEqual([
      { request_id: 0, generation: 0, frame: 0 },
      { request_id: 1, generation: 1, frame: 5 },
    ]);
    expect(playingStates(model)).toEqual([true, false]);

    model.emit(frameSet(1, 1, 5), [new DataView(new Uint8Array([1]).buffer)]);
    await vi.waitFor(() =>
      expect(playingStates(model)).toEqual([true, false, true]),
    );
    expect(element.querySelector("button[aria-label='Pause']")).not.toBeNull();
  });

  it("resumes from visibility only when playback was active before hiding", async () => {
    let visibility: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(
      () => visibility,
    );
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const { model, element } = await setup();
    model.emit(metadata(false));

    element.querySelector<HTMLButtonElement>("button[aria-label='Play']")?.click();
    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));

    expect(playingStates(model)).toEqual([true, false, true]);

    element.querySelector<HTMLButtonElement>("button[aria-label='Pause']")?.click();
    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));

    expect(playingStates(model)).toEqual([true, false, true, false]);
  });

  it("does not restart from zero when visibility pause samples the final frame", async () => {
    let visibility: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(
      () => visibility,
    );
    vi.spyOn(performance, "now").mockReturnValue(0);
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const { model, element } = await setup();
    model.emit(metadata(false));
    model.emit(frameSet(0, 0, 0), [new DataView(new Uint8Array([1]).buffer)]);
    await vi.waitFor(() =>
      expect(model.sent).toContainEqual(
        expect.objectContaining({ type: "ack_frame_set", outcome: "painted" }),
      ),
    );

    element.querySelector<HTMLButtonElement>("button[aria-label='Play']")?.click();
    vi.spyOn(performance, "now").mockReturnValue(1000);
    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));

    expect(playingStates(model)).toEqual([true, false]);
    expect(
      element.querySelector<HTMLInputElement>("input[aria-label='Current frame']")
        ?.value,
    ).toBe("9");
    expect(element.querySelector("button[aria-label='Play']")).not.toBeNull();
    const restart = model.sent.find(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "request_frame_set" &&
        "reason" in message &&
        message.reason === "playback" &&
        "frame" in message &&
        message.frame === 0,
    );
    expect(restart).toBeUndefined();
  });

  it("invalidates an older playback response when the document hides", async () => {
    let scheduled: FrameRequestCallback | undefined;
    let visibility: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(
      () => visibility,
    );
    vi.spyOn(performance, "now").mockReturnValue(0);
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        scheduled = callback;
        return 1;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const { model, element } = await setup();
    model.emit(metadata(false));
    model.emit(frameSet(0, 0, 0), [new DataView(new Uint8Array([1]).buffer)]);
    await vi.waitFor(() =>
      expect(model.sent).toContainEqual(
        expect.objectContaining({ type: "ack_frame_set", outcome: "painted" }),
      ),
    );

    element.querySelector<HTMLButtonElement>("button[aria-label='Play']")?.click();
    scheduled?.(100);
    vi.spyOn(performance, "now").mockReturnValue(200);
    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    model.emit(frameSet(1, 0, 2), [new DataView(new Uint8Array([1]).buffer)]);

    await vi.waitFor(() =>
      expect(model.sent).toContainEqual({
        protocol: 1,
        type: "ack_frame_set",
        session_id: "session-1",
        request_id: 1,
        generation: 0,
        outcome: "stale",
      }),
    );
    expect(
      element.querySelector<HTMLInputElement>("input[aria-label='Current frame']")
        ?.value,
    ).toBe("4");
    expect(element.querySelector("[role='status']")?.textContent).toBe(
      "Frame 0 ready.",
    );
  });

  it("defers autoplay until a hidden document becomes visible", async () => {
    let visibility: DocumentVisibilityState = "hidden";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(
      () => visibility,
    );
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
    const { model } = await setup();
    model.emit(metadata(true));
    model.emit(frameSet(0, 0, 0), [new DataView(new Uint8Array([1]).buffer)]);

    await vi.waitFor(() =>
      expect(model.sent).toContainEqual(
        expect.objectContaining({ type: "ack_frame_set", outcome: "painted" }),
      ),
    );
    expect(playingStates(model)).toEqual([]);

    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));

    expect(playingStates(model)).toEqual([true]);
  });

  it("defers scrub resume until a hidden document becomes visible", async () => {
    let visibility: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(
      () => visibility,
    );
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const { model, element } = await setup();
    model.emit(metadata(false));
    model.emit(frameSet(0, 0, 0), [new DataView(new Uint8Array([1]).buffer)]);
    await vi.waitFor(() =>
      expect(model.sent).toContainEqual(
        expect.objectContaining({ type: "ack_frame_set", outcome: "painted" }),
      ),
    );
    element.querySelector<HTMLButtonElement>("button[aria-label='Play']")?.click();

    const seek = element.querySelector<HTMLInputElement>(
      "input[aria-label='Seek frame']",
    );
    if (seek === null) {
      throw new Error("Missing seek control.");
    }
    seek.value = "5";
    seek.dispatchEvent(new Event("input", { bubbles: true }));
    seek.dispatchEvent(new Event("change", { bubbles: true }));
    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    model.emit(frameSet(1, 1, 5), [new DataView(new Uint8Array([1]).buffer)]);

    await vi.waitFor(() =>
      expect(model.sent).toContainEqual(
        expect.objectContaining({
          type: "ack_frame_set",
          request_id: 1,
          outcome: "painted",
        }),
      ),
    );
    expect(playingStates(model)).toEqual([true, false]);

    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));

    expect(playingStates(model)).toEqual([true, false, true]);
  });
});