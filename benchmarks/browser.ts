import { paintFrameSet, renderMetadata } from "../frontend/player.js";
import {
  parseBackendMessage,
  validateFrameSetBuffers,
  type ClipId,
  type FrameSetMessage,
  type PreviewMetadataMessage,
} from "../frontend/protocol.js";

interface BrowserFixture {
  name: string;
  width: number;
  height: number;
  source_format: string;
  message: FrameSetMessage;
  buffers_base64: string[];
}

interface DecodeInterval {
  start: number;
  end: number;
}

interface BrowserMeasurement {
  simulated_comm_copy_ms: number;
  protocol_validation_ms: number;
  paint_total_ms: number;
  decode_barrier_ms: number;
  paint_non_decode_ms: number;
  canvas_flush_ms: number;
  simulated_receive_to_paint_ms: number;
}

interface BrowserBenchmarkResult {
  raw: Record<keyof BrowserMeasurement, number[]>;
  committed_frames: number;
  final_labels: string[];
}

declare global {
  interface Window {
    runKaleidoscopeBrowserBenchmark: (
      fixture: BrowserFixture,
      warmup: number,
      samples: number,
    ) => Promise<BrowserBenchmarkResult>;
  }
}

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function createMetadata(fixture: BrowserFixture): PreviewMetadataMessage {
  const clipIds = fixture.message.frames.map((frame) => frame.clip_id);
  return {
    protocol: 1,
    type: "metadata",
    session_id: fixture.message.session_id,
    status: "initialized",
    num_frames: 10_000,
    fps_num: 24,
    fps_den: 1,
    mode: clipIds.length === 1 ? "single" : "side-by-side",
    active_clip_ids: clipIds,
    max_visible_clips: 4,
    autoplay: false,
    clips: clipIds.map((clipId: ClipId) => ({
      id: clipId,
      label: String(clipId),
      source_format: fixture.source_format,
      source_width: fixture.width,
      source_height: fixture.height,
      output_width: fixture.width,
      output_height: fixture.height,
      warnings: [],
    })),
  };
}

function createRawMeasurements(): Record<keyof BrowserMeasurement, number[]> {
  return {
    simulated_comm_copy_ms: [],
    protocol_validation_ms: [],
    paint_total_ms: [],
    decode_barrier_ms: [],
    paint_non_decode_ms: [],
    canvas_flush_ms: [],
    simulated_receive_to_paint_ms: [],
  };
}

async function runFixture(
  fixture: BrowserFixture,
  warmup: number,
  samples: number,
): Promise<BrowserBenchmarkResult> {
  const root = document.createElement("main");
  document.body.replaceChildren(root);
  const view = renderMetadata(root, createMetadata(fixture));
  const sourceBuffers = fixture.buffers_base64.map(decodeBase64);
  const originalCreateImageBitmap = globalThis.createImageBitmap;
  let decodeIntervals: DecodeInterval[] = [];
  globalThis.createImageBitmap = (async (...args: unknown[]) => {
    const start = performance.now();
    try {
      return (await Reflect.apply(originalCreateImageBitmap, globalThis, args)) as ImageBitmap;
    } finally {
      decodeIntervals.push({ start, end: performance.now() });
    }
  }) as typeof createImageBitmap;

  let committedFrames = 0;
  const measure = async (iteration: number): Promise<BrowserMeasurement> => {
    const message: FrameSetMessage = {
      ...fixture.message,
      request_id: iteration,
      generation: 0,
      frame: iteration,
    };
    const commStarted = performance.now();
    const buffers = sourceBuffers.map(
      (source) => new DataView(source.slice().buffer),
    );
    const commEnded = performance.now();

    const protocolStarted = performance.now();
    const parsed = parseBackendMessage(message);
    if (parsed.type !== "frame_set") {
      throw new Error("The browser benchmark requires a frame-set message.");
    }
    validateFrameSetBuffers(parsed, buffers);
    const protocolEnded = performance.now();

    decodeIntervals = [];
    const paintStarted = performance.now();
    const committed = await paintFrameSet(view, parsed, buffers, () => true);
    const paintEnded = performance.now();
    if (!committed) {
      throw new Error("The browser benchmark frame was not committed.");
    }
    committedFrames += 1;

    const flushStarted = performance.now();
    for (const canvas of view.canvases.values()) {
      const context = canvas.getContext("2d");
      if (context === null) {
        throw new Error("The committed benchmark canvas is unavailable.");
      }
      context.getImageData(
        Math.floor(canvas.width / 2),
        Math.floor(canvas.height / 2),
        1,
        1,
      );
    }
    const flushEnded = performance.now();
    const decodeStart = Math.min(...decodeIntervals.map((item) => item.start));
    const decodeEnd = Math.max(...decodeIntervals.map((item) => item.end));
    const decodeBarrierMs = decodeEnd - decodeStart;
    const paintTotalMs = paintEnded - paintStarted;
    return {
      simulated_comm_copy_ms: commEnded - commStarted,
      protocol_validation_ms: protocolEnded - protocolStarted,
      paint_total_ms: paintTotalMs,
      decode_barrier_ms: decodeBarrierMs,
      paint_non_decode_ms: Math.max(0, paintTotalMs - decodeBarrierMs),
      canvas_flush_ms: flushEnded - flushStarted,
      simulated_receive_to_paint_ms:
        flushEnded - commStarted,
    };
  };

  try {
    for (let index = 0; index < warmup; index += 1) {
      await measure(index);
    }
    committedFrames = 0;
    const raw = createRawMeasurements();
    for (let index = 0; index < samples; index += 1) {
      const result = await measure(index);
      for (const key of Object.keys(result) as (keyof BrowserMeasurement)[]) {
        raw[key].push(result[key]);
      }
    }
    const finalLabels = [...view.canvases.values()].map(
      (canvas) => canvas.getAttribute("aria-label") ?? "",
    );
    if (finalLabels.some((label) => !label.endsWith(`frame ${samples - 1}`))) {
      throw new Error("Atomic canvas replacement did not commit the final frame set.");
    }
    return { raw, committed_frames: committedFrames, final_labels: finalLabels };
  } finally {
    globalThis.createImageBitmap = originalCreateImageBitmap;
  }
}

window.runKaleidoscopeBrowserBenchmark = runFixture;