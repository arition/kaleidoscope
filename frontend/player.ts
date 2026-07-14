import type {
  ClipId,
  ClipMetadata,
  FrameSetMessage,
  PreviewMetadataMessage,
} from "./protocol.js";

export interface PlayerView {
  readonly metadata: PreviewMetadataMessage;
  readonly canvases: Map<ClipId, HTMLCanvasElement>;
}

function idsMatch(left: ClipId, right: ClipId): boolean {
  return left === right;
}

function createClipRow(
  clip: ClipMetadata,
  activeClipIds: ClipId[],
  canvases: Map<ClipId, HTMLCanvasElement>,
): HTMLElement {
  const row = document.createElement("li");
  const isActive = activeClipIds.some((clipId) => idsMatch(clipId, clip.id));
  row.className = "kaleidoscope-clip";
  row.dataset.clipId = String(clip.id);
  row.dataset.active = String(isActive);

  const identity = document.createElement("div");
  identity.className = "kaleidoscope-clip__identity";

  const indicator = document.createElement("span");
  indicator.className = "kaleidoscope-clip__indicator";
  indicator.setAttribute("aria-hidden", "true");

  const label = document.createElement("strong");
  label.textContent = clip.label;

  const format = document.createElement("span");
  format.className = "kaleidoscope-clip__format";
  format.textContent = clip.source_format;

  identity.append(indicator, label, format);

  const dimensions = document.createElement("span");
  dimensions.className = "kaleidoscope-clip__dimensions";
  dimensions.textContent = `${clip.source_width} x ${clip.source_height}`;

  const details = document.createElement("div");
  details.className = "kaleidoscope-clip__details";
  details.append(identity, dimensions);
  row.append(details);

  if (isActive && clip.warnings.length > 0) {
    const warnings = document.createElement("ul");
    warnings.className = "kaleidoscope-clip__warnings";
    warnings.setAttribute("aria-label", `${clip.label} warnings`);
    warnings.setAttribute("aria-live", "polite");
    for (const warning of clip.warnings) {
      const item = document.createElement("li");
      item.dataset.warningCode = warning.code;
      item.textContent = warning.message;
      warnings.append(item);
    }
    row.append(warnings);
  }

  if (isActive) {
    const canvas = document.createElement("canvas");
    canvas.className = "kaleidoscope-canvas";
    canvas.width = clip.output_width;
    canvas.height = clip.output_height;
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", `${clip.label}, frame 0`);
    row.append(canvas);
    canvases.set(clip.id, canvas);
  }
  return row;
}

export function renderMetadata(
  root: HTMLElement,
  message: PreviewMetadataMessage,
): PlayerView {
  const canvases = new Map<ClipId, HTMLCanvasElement>();
  const header = document.createElement("header");
  header.className = "kaleidoscope-header";

  const title = document.createElement("strong");
  title.className = "kaleidoscope-title";
  title.textContent = "Kaleidoscope";

  const mode = document.createElement("span");
  mode.className = "kaleidoscope-mode";
  mode.textContent = message.mode;

  header.append(title, mode);

  const timeline = document.createElement("div");
  timeline.className = "kaleidoscope-timeline";
  timeline.setAttribute("aria-label", "Shared clip timeline");
  timeline.textContent = `${message.num_frames} frames | ${message.fps_num}/${message.fps_den} fps`;

  const clips = document.createElement("ul");
  clips.className = "kaleidoscope-clips";
  clips.setAttribute("aria-label", "Preview clips");
  clips.append(
    ...message.clips.map((clip) =>
      createClipRow(clip, message.active_clip_ids, canvases),
    ),
  );

  const status = document.createElement("div");
  status.className = "kaleidoscope-status kaleidoscope-status--ready";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.textContent = "Kaleidoscope is ready.";

  root.replaceChildren(header, timeline, clips, status);
  return { metadata: message, canvases };
}

interface DecodedFrame {
  manifest: FrameSetMessage["frames"][number];
  bitmap: ImageBitmap;
}

async function decodeFrames(
  message: FrameSetMessage,
  buffers: DataView[],
): Promise<DecodedFrame[]> {
  const results = await Promise.allSettled(
    message.frames.map(async (manifest) => {
      const buffer = buffers[manifest.buffer_index];
      const payload = new Uint8Array(buffer.byteLength);
      payload.set(
        new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength),
      );
      const blob = new Blob([payload], {
        type: manifest.mime,
      });
      const bitmap = await createImageBitmap(blob);
      return { manifest, bitmap };
    }),
  );
  const decoded = results.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );
  const rejected = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (rejected !== undefined) {
    for (const frame of decoded) {
      frame.bitmap.close();
    }
    throw rejected.reason;
  }
  return decoded;
}

export async function paintFrameSet(
  view: PlayerView,
  message: FrameSetMessage,
  buffers: DataView[],
  shouldCommit: () => boolean,
): Promise<boolean> {
  const decoded = await decodeFrames(message, buffers);
  try {
    if (!shouldCommit()) {
      return false;
    }
    for (const frame of decoded) {
      const canvas = view.canvases.get(frame.manifest.clip_id);
      const context = canvas?.getContext("2d");
      if (canvas === undefined || context === null || context === undefined) {
        throw new Error("The active preview canvas is unavailable.");
      }
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(frame.bitmap, 0, 0, canvas.width, canvas.height);
      canvas.setAttribute(
        "aria-label",
        `${view.metadata.clips.find((clip) => idsMatch(clip.id, frame.manifest.clip_id))?.label ?? "Clip"}, frame ${message.frame}`,
      );
    }
    return true;
  } finally {
    for (const frame of decoded) {
      frame.bitmap.close();
    }
  }
}
