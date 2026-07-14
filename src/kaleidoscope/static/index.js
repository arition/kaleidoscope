// frontend/protocol.ts
var PROTOCOL_VERSION = 1;
var MAX_FRAME_BUFFER_BYTES = 16 * 1024 * 1024;
var MAX_FRAME_SET_BYTES = 64 * 1024 * 1024;
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
function isNonnegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}
function isNonnegativeFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
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
function isFrameManifest(value) {
  return isRecord(value) && isClipId(value.clip_id) && isNonnegativeInteger(value.buffer_index) && (value.mime === "image/jpeg" || value.mime === "image/webp") && isPositiveInteger(value.byte_length) && value.byte_length <= MAX_FRAME_BUFFER_BYTES && isNonnegativeFiniteNumber(value.render_ms) && isNonnegativeFiniteNumber(value.encode_ms);
}
function isFrameSetMessage(value) {
  const frames = value.frames;
  if (typeof value.session_id !== "string" || value.session_id.length === 0 || !isNonnegativeInteger(value.request_id) || !isNonnegativeInteger(value.generation) || !isNonnegativeInteger(value.frame) || !Array.isArray(frames) || !frames.length || frames.length > 4 || !frames.every(isFrameManifest)) {
    return false;
  }
  const bufferIndices = frames.map((frame) => frame.buffer_index);
  const clipIds = frames.map((frame) => frame.clip_id);
  const totalBytes = frames.reduce(
    (total, frame) => total + frame.byte_length,
    0
  );
  return new Set(bufferIndices).size === bufferIndices.length && bufferIndices.every((bufferIndex) => bufferIndex < frames.length) && new Set(clipIds).size === clipIds.length && totalBytes <= MAX_FRAME_SET_BYTES;
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
function createFrameSetRequest(sessionId, requestId, generation, frame, clipIds, reason) {
  return {
    protocol: PROTOCOL_VERSION,
    type: "request_frame_set",
    session_id: sessionId,
    request_id: requestId,
    generation,
    frame,
    clip_ids: [...clipIds],
    reason
  };
}
function validateFrameSetBuffers(message, buffers) {
  if (buffers.length !== message.frames.length) {
    throw new ProtocolError(
      "invalid_message",
      "Frame payload count does not match its manifest."
    );
  }
  for (const frame of message.frames) {
    const buffer = buffers[frame.buffer_index];
    if (buffer === void 0 || buffer.byteLength !== frame.byte_length) {
      throw new ProtocolError(
        "invalid_message",
        "Frame payload length does not match its manifest."
      );
    }
  }
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
  if (value.type === "frame_set" && isFrameSetMessage(value)) {
    return value;
  }
  if (value.type === "error" && typeof value.session_id === "string" && value.session_id.length > 0 && typeof value.code === "string" && value.code.length > 0 && typeof value.message === "string" && typeof value.recoverable === "boolean") {
    return value;
  }
  throw new ProtocolError("invalid_message", "Malformed backend message.");
}

// frontend/player.ts
function idsMatch(left, right) {
  return left === right;
}
function createClipRow(clip, activeClipIds, canvases) {
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
function renderMetadata(root, message) {
  const canvases = /* @__PURE__ */ new Map();
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
      (clip) => createClipRow(clip, message.active_clip_ids, canvases)
    )
  );
  const status = document.createElement("div");
  status.className = "kaleidoscope-status kaleidoscope-status--ready";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.textContent = "Kaleidoscope is ready.";
  root.replaceChildren(header, timeline, clips, status);
  return { metadata: message, canvases };
}
async function decodeFrames(message, buffers) {
  const results = await Promise.allSettled(
    message.frames.map(async (manifest) => {
      const buffer = buffers[manifest.buffer_index];
      const payload = new Uint8Array(buffer.byteLength);
      payload.set(
        new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
      );
      const blob = new Blob([payload], {
        type: manifest.mime
      });
      const bitmap = await createImageBitmap(blob);
      return { manifest, bitmap };
    })
  );
  const decoded = results.flatMap(
    (result) => result.status === "fulfilled" ? [result.value] : []
  );
  const rejected = results.find(
    (result) => result.status === "rejected"
  );
  if (rejected !== void 0) {
    for (const frame of decoded) {
      frame.bitmap.close();
    }
    throw rejected.reason;
  }
  return decoded;
}
async function paintFrameSet(view, message, buffers, shouldCommit) {
  const decoded = await decodeFrames(message, buffers);
  try {
    if (!shouldCommit()) {
      return false;
    }
    for (const frame of decoded) {
      const canvas = view.canvases.get(frame.manifest.clip_id);
      const context = canvas?.getContext("2d");
      if (canvas === void 0 || context === null || context === void 0) {
        throw new Error("The active preview canvas is unavailable.");
      }
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(frame.bitmap, 0, 0, canvas.width, canvas.height);
      canvas.setAttribute(
        "aria-label",
        `${view.metadata.clips.find((clip) => idsMatch(clip.id, frame.manifest.clip_id))?.label ?? "Clip"}, frame ${message.frame}`
      );
    }
    return true;
  } finally {
    for (const frame of decoded) {
      frame.bitmap.close();
    }
  }
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
  let metadata;
  let playerView;
  let currentRequest;
  const updateStatus = (text) => {
    const liveStatus = el.querySelector("[role='status']");
    if (liveStatus !== null) {
      liveStatus.textContent = text;
    }
  };
  const handleMessage = async (value, buffers) => {
    try {
      const message = parseBackendMessage(value);
      if (message.session_id !== sessionId) {
        throw new ProtocolError("invalid_message", "Backend message has an unknown session.");
      }
      if (message.type === "metadata") {
        if ("clips" in message) {
          metadata = message;
          playerView = renderMetadata(el, message);
          currentRequest = { request_id: 0, generation: 0, frame: 0 };
          model.send(
            createFrameSetRequest(
              sessionId,
              currentRequest.request_id,
              currentRequest.generation,
              currentRequest.frame,
              message.active_clip_ids,
              "seek"
            )
          );
          return;
        }
        status.textContent = "Kaleidoscope is ready.";
        return;
      }
      if (message.type === "frame_set") {
        validateFrameSetBuffers(message, buffers);
        if (metadata === void 0 || playerView === void 0) {
          throw new ProtocolError(
            "invalid_message",
            "Frame payload arrived before preview metadata."
          );
        }
        const expected = currentRequest;
        const expectedClipIds = metadata.active_clip_ids;
        const manifestClipIds = message.frames.map((frame) => frame.clip_id);
        const isCurrent = () => !signal.aborted && expected !== void 0 && currentRequest === expected && message.request_id === expected.request_id && message.generation === expected.generation && message.frame === expected.frame && manifestClipIds.length === expectedClipIds.length && manifestClipIds.every(
          (clipId, index) => clipId === expectedClipIds[index]
        );
        if (!isCurrent()) {
          return;
        }
        const painted = await paintFrameSet(
          playerView,
          message,
          buffers,
          isCurrent
        );
        if (painted) {
          updateStatus(`Frame ${message.frame} ready.`);
        }
        return;
      }
      updateStatus(`Protocol error: ${message.message}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid backend message.";
      updateStatus(`Protocol error: ${message}`);
    }
  };
  const onMessage = (value, buffers) => {
    void handleMessage(value, buffers);
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
