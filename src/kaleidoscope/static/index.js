// frontend/protocol.ts
var PROTOCOL_VERSION = 1;
var ProtocolError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "ProtocolError";
  }
  code;
};
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}
function isClipId(value) {
  return Number.isInteger(value) && typeof value === "number" || typeof value === "string" && value.length > 0;
}
function isComparisonMode(value) {
  return value === "single" || value === "side-by-side" || value === "wipe" || value === "overlay" || value === "difference";
}
function isClipMetadata(value) {
  return isRecord(value) && isClipId(value.id) && typeof value.label === "string" && value.label.length > 0 && typeof value.source_format === "string" && value.source_format.length > 0 && isPositiveInteger(value.source_width) && isPositiveInteger(value.source_height) && isPositiveInteger(value.output_width) && isPositiveInteger(value.output_height) && Array.isArray(value.warnings);
}
function hasPreviewMetadataFields(value) {
  return [
    "num_frames",
    "fps_num",
    "fps_den",
    "mode",
    "active_clip_ids",
    "max_visible_clips",
    "clips"
  ].some((key) => key in value);
}
function isPreviewMetadataMessage(value) {
  if (!isPositiveInteger(value.num_frames) || !isPositiveInteger(value.fps_num) || !isPositiveInteger(value.fps_den) || !isComparisonMode(value.mode) || !isPositiveInteger(value.max_visible_clips) || value.max_visible_clips > 4 || !Array.isArray(value.active_clip_ids) || value.active_clip_ids.length === 0 || !value.active_clip_ids.every(isClipId) || !Array.isArray(value.clips) || value.clips.length === 0 || !value.clips.every(isClipMetadata)) {
    return false;
  }
  const clipIds = value.clips.map((clip) => clip.id);
  const activeIds = value.active_clip_ids;
  return new Set(clipIds).size === clipIds.length && new Set(activeIds).size === activeIds.length && activeIds.length <= value.max_visible_clips && activeIds.every((activeId) => clipIds.some((clipId) => clipId === activeId));
}
function createReadyMessage(sessionId, capabilities) {
  return {
    protocol: PROTOCOL_VERSION,
    type: "ready",
    session_id: sessionId,
    capabilities
  };
}
function parseBackendMessage(value) {
  if (!isRecord(value)) {
    throw new ProtocolError("invalid_message", "Backend message must be an object.");
  }
  const protocol = value.protocol;
  if (protocol !== PROTOCOL_VERSION) {
    if (typeof protocol === "number") {
      throw new ProtocolError(
        "protocol_mismatch",
        `Unsupported protocol version ${protocol}; expected ${PROTOCOL_VERSION}.`
      );
    }
    throw new ProtocolError("invalid_message", "Backend message is missing protocol version 1.");
  }
  if (value.type === "metadata" && typeof value.session_id === "string" && value.session_id.length > 0 && value.status === "initialized") {
    if (hasPreviewMetadataFields(value)) {
      if (!isPreviewMetadataMessage(value)) {
        throw new ProtocolError("invalid_message", "Malformed preview metadata.");
      }
      return value;
    }
    return value;
  }
  if (value.type === "error" && typeof value.session_id === "string" && value.session_id.length > 0 && (value.code === "invalid_message" || value.code === "protocol_mismatch") && typeof value.message === "string" && typeof value.recoverable === "boolean") {
    return value;
  }
  throw new ProtocolError("invalid_message", "Malformed backend message.");
}

// frontend/player.ts
function idsMatch(left, right) {
  return left === right;
}
function createClipRow(clip, activeClipIds) {
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
function renderMetadata(root, message) {
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
    ...message.clips.map(
      (clip) => createClipRow(clip, message.active_clip_ids)
    )
  );
  const status = document.createElement("div");
  status.className = "kaleidoscope-status kaleidoscope-status--ready";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.textContent = "Kaleidoscope is ready.";
  root.replaceChildren(header, timeline, clips, status);
}

// frontend/index.ts
function createStatus(text) {
  const status = document.createElement("div");
  status.className = "kaleidoscope-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.textContent = text;
  return status;
}
function render({ model, el, signal }) {
  const status = createStatus("Initializing Kaleidoscope...");
  el.classList.add("kaleidoscope-widget");
  el.replaceChildren(status);
  const sessionId = model.get("session_id");
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    status.textContent = "Protocol error: missing session identifier.";
    return;
  }
  const onMessage = (value) => {
    try {
      const message = parseBackendMessage(value);
      if (message.session_id !== sessionId) {
        throw new ProtocolError("invalid_message", "Backend message has an unknown session.");
      }
      if (message.type === "metadata") {
        if ("clips" in message) {
          renderMetadata(el, message);
          return;
        }
        status.textContent = "Kaleidoscope is ready.";
        return;
      }
      status.textContent = `Protocol error: ${message.message}`;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid backend message.";
      status.textContent = `Protocol error: ${message}`;
    }
  };
  model.on("msg:custom", onMessage);
  signal.addEventListener("abort", () => model.off("msg:custom", onMessage), {
    once: true
  });
  model.send(
    createReadyMessage(sessionId, {
      image_bitmap: typeof globalThis.createImageBitmap === "function",
      webp: false
    })
  );
}
var index_default = { render };
export {
  index_default as default,
  render
};
