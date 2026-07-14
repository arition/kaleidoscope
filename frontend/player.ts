import type {
  ClipId,
  ClipMetadata,
  PreviewMetadataMessage,
} from "./protocol.js";

function idsMatch(left: ClipId, right: ClipId): boolean {
  return left === right;
}

function createClipRow(
  clip: ClipMetadata,
  activeClipIds: ClipId[],
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

  row.append(identity, dimensions);
  return row;
}

export function renderMetadata(
  root: HTMLElement,
  message: PreviewMetadataMessage,
): void {
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
      createClipRow(clip, message.active_clip_ids),
    ),
  );

  const status = document.createElement("div");
  status.className = "kaleidoscope-status kaleidoscope-status--ready";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.textContent = "Kaleidoscope is ready.";

  root.replaceChildren(header, timeline, clips, status);
}
