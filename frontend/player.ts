import type {
  ClipId,
  ClipMetadata,
  FrameSetMessage,
  PreviewMetadataMessage,
} from "./protocol.js";
import {
  formatFrameTime,
  MAX_TIME_INPUT_LENGTH,
  offsetFrameBySeconds,
  parseTimeToFrame,
} from "./time.js";

export interface PlayerView {
  readonly metadata: PreviewMetadataMessage;
  readonly canvases: Map<ClipId, HTMLCanvasElement>;
  setFrame(frame: number): void;
  setPlaying(playing: boolean): void;
}

export interface PlayerNavigation {
  requestExact(frame: number): number;
  scheduleScrub(frame: number): number;
  togglePlaying(): void;
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
  navigation?: PlayerNavigation,
  signal?: AbortSignal,
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

  const controls = document.createElement("div");
  controls.className = "kaleidoscope-controls";
  controls.setAttribute("role", "group");
  controls.setAttribute("aria-label", "Paused navigation");

  const createNavigationButton = (
    label: string,
    text: string,
    target: () => number,
  ): HTMLButtonElement => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "kaleidoscope-control-button";
    button.setAttribute("aria-label", label);
    button.title = label;
    button.textContent = text;
    button.disabled = navigation === undefined;
    button.addEventListener("click", () => requestExact(target()), { signal });
    return button;
  };

  const play = document.createElement("button");
  play.type = "button";
  play.className = "kaleidoscope-control-button";
  play.disabled = navigation === undefined;
  let playing = false;
  const updatePlaying = (active: boolean): void => {
    playing = active;
    play.setAttribute("aria-label", active ? "Pause" : "Play");
    play.title = active ? "Pause" : "Play";
    play.textContent = active ? "||" : ">";
    play.setAttribute("aria-pressed", String(active));
  };
  updatePlaying(false);
  play.addEventListener("click", () => navigation?.togglePlaying(), { signal });

  const seek = document.createElement("input");
  seek.type = "range";
  seek.className = "kaleidoscope-seek";
  seek.min = "0";
  seek.max = String(message.num_frames - 1);
  seek.step = "1";
  seek.value = "0";
  seek.setAttribute("aria-label", "Seek frame");
  seek.disabled = navigation === undefined;

  const frame = document.createElement("input");
  frame.type = "number";
  frame.className = "kaleidoscope-frame-input";
  frame.min = "0";
  frame.max = String(message.num_frames - 1);
  frame.step = "1";
  frame.value = "0";
  frame.setAttribute("aria-label", "Current frame");
  frame.disabled = navigation === undefined;

  const totalFrames = document.createElement("span");
  totalFrames.className = "kaleidoscope-frame-total";
  totalFrames.textContent = `/ ${message.num_frames - 1}`;

  const time = document.createElement("input");
  time.type = "text";
  time.className = "kaleidoscope-time-input";
  time.inputMode = "decimal";
  time.maxLength = MAX_TIME_INPUT_LENGTH;
  time.value = formatFrameTime(0, message.fps_num, message.fps_den);
  time.setAttribute("aria-label", "Current time");
  time.disabled = navigation === undefined;

  const duration = document.createElement("span");
  duration.className = "kaleidoscope-duration";
  duration.textContent = `/ ${formatFrameTime(
    message.num_frames,
    message.fps_num,
    message.fps_den,
  )}`;

  let currentFrame = 0;
  const updateFrame = (target: number): void => {
    currentFrame = target;
    seek.value = String(target);
    frame.value = String(target);
    time.value = formatFrameTime(target, message.fps_num, message.fps_den);
  };
  const requestExact = (target: number): void => {
    if (navigation !== undefined) {
      updateFrame(navigation.requestExact(target));
    }
  };

  const first = createNavigationButton("First frame", "|<", () => 0);
  const previous = createNavigationButton(
    "Previous frame",
    "<",
    () => currentFrame - 1,
  );
  const next = createNavigationButton(
    "Next frame",
    ">",
    () => currentFrame + 1,
  );
  const last = createNavigationButton(
    "Last frame",
    ">|",
    () => message.num_frames - 1,
  );

  seek.addEventListener(
    "input",
    () => {
      if (navigation !== undefined) {
        updateFrame(navigation.scheduleScrub(Number(seek.value)));
      }
    },
    { signal },
  );
  seek.addEventListener("change", () => requestExact(Number(seek.value)), {
    signal,
  });
  frame.addEventListener(
    "change",
    () => {
      if (frame.value.trim() === "") {
        updateFrame(currentFrame);
        return;
      }
      requestExact(Number(frame.value));
    },
    { signal },
  );
  time.addEventListener(
    "change",
    () => {
      const target = parseTimeToFrame(
        time.value,
        message.fps_num,
        message.fps_den,
        message.num_frames,
      );
      if (target === undefined) {
        updateFrame(currentFrame);
        return;
      }
      requestExact(target);
    },
    { signal },
  );

  controls.append(
    play,
    first,
    previous,
    seek,
    next,
    last,
    frame,
    totalFrames,
    time,
    duration,
  );

  root.tabIndex = 0;
  root.addEventListener(
    "keydown",
    (event) => {
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey) {
        return;
      }
      if (event.key === " ") {
        event.preventDefault();
        navigation?.togglePlaying();
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        requestExact(
          event.shiftKey
            ? offsetFrameBySeconds(
                currentFrame,
                -1,
                message.fps_num,
                message.fps_den,
                message.num_frames,
              )
            : currentFrame - 1,
        );
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        requestExact(
          event.shiftKey
            ? offsetFrameBySeconds(
                currentFrame,
                1,
                message.fps_num,
                message.fps_den,
                message.num_frames,
              )
            : currentFrame + 1,
        );
      } else if (event.key === "Home") {
        event.preventDefault();
        requestExact(0);
      } else if (event.key === "End") {
        event.preventDefault();
        requestExact(message.num_frames - 1);
      }
    },
    { signal },
  );

  const clips = document.createElement("ul");
  clips.className = "kaleidoscope-clips";
  clips.dataset.mode = message.mode;
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

  root.replaceChildren(header, timeline, controls, clips, status);
  return {
    metadata: message,
    canvases,
    setFrame: updateFrame,
    setPlaying: updatePlaying,
  };
}

interface DecodedFrame {
  manifest: FrameSetMessage["frames"][number];
  bitmap: ImageBitmap;
}

interface StagedFrame {
  decoded: DecodedFrame;
  currentCanvas: HTMLCanvasElement;
  stagedCanvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  parent: Node;
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
    const targets: StagedFrame[] = decoded.map((frame) => {
      const currentCanvas = view.canvases.get(frame.manifest.clip_id);
      const parent = currentCanvas?.parentNode;
      if (
        currentCanvas === undefined ||
        parent === null ||
        parent === undefined ||
        currentCanvas.getContext("2d") === null
      ) {
        throw new Error("The active preview canvas is unavailable.");
      }
      const stagedCanvas = currentCanvas.cloneNode(false) as HTMLCanvasElement;
      const context = stagedCanvas.getContext("2d");
      if (context === null) {
        throw new Error("The active preview canvas is unavailable.");
      }
      return {
        decoded: frame,
        currentCanvas,
        stagedCanvas,
        context,
        parent,
      };
    });
    for (const { decoded: frame, stagedCanvas, context } of targets) {
      context.drawImage(
        frame.bitmap,
        0,
        0,
        stagedCanvas.width,
        stagedCanvas.height,
      );
      stagedCanvas.setAttribute(
        "aria-label",
        `${view.metadata.clips.find((clip) => idsMatch(clip.id, frame.manifest.clip_id))?.label ?? "Clip"}, frame ${message.frame}`,
      );
    }
    if (!shouldCommit()) {
      return false;
    }

    const committed: StagedFrame[] = [];
    try {
      for (const target of targets) {
        target.parent.replaceChild(
          target.stagedCanvas,
          target.currentCanvas,
        );
        committed.push(target);
      }
    } catch (error) {
      for (const target of committed.reverse()) {
        if (target.stagedCanvas.parentNode === target.parent) {
          target.parent.replaceChild(
            target.currentCanvas,
            target.stagedCanvas,
          );
        }
      }
      throw error;
    }
    for (const target of targets) {
      view.canvases.set(
        target.decoded.manifest.clip_id,
        target.stagedCanvas,
      );
    }
    return true;
  } finally {
    for (const frame of decoded) {
      frame.bitmap.close();
    }
  }
}
