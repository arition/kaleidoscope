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
function isClipWarning(value) {
  return isRecord(value) && (value.code === "automatic_rgb24_conversion" || value.code === "assumed_color_metadata") && typeof value.message === "string" && value.message.length > 0;
}
function isClipMetadata(value) {
  return isRecord(value) && isClipId(value.id) && typeof value.label === "string" && value.label.length > 0 && typeof value.source_format === "string" && value.source_format.length > 0 && isPositiveInteger(value.source_width) && isPositiveInteger(value.source_height) && isPositiveInteger(value.output_width) && isPositiveInteger(value.output_height) && value.output_width === value.source_width && value.output_height === value.source_height && Array.isArray(value.warnings) && value.warnings.every(isClipWarning);
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
  return new Set(bufferIndices).size === bufferIndices.length && bufferIndices.every((bufferIndex, index) => bufferIndex === index) && new Set(clipIds).size === clipIds.length && totalBytes <= MAX_FRAME_SET_BYTES;
}
function hasPreviewMetadataFields(value) {
  return [
    "num_frames",
    "fps_num",
    "fps_den",
    "mode",
    "active_clip_ids",
    "max_visible_clips",
    "autoplay",
    "clips"
  ].some((key) => key in value);
}
function isPreviewMetadataMessage(value) {
  if (!isPositiveInteger(value.num_frames) || !isPositiveInteger(value.fps_num) || !isPositiveInteger(value.fps_den) || !isComparisonMode(value.mode) || !isPositiveInteger(value.max_visible_clips) || value.max_visible_clips > 4 || typeof value.autoplay !== "boolean" || !Array.isArray(value.active_clip_ids) || value.active_clip_ids.length === 0 || !value.active_clip_ids.every(isClipId) || !Array.isArray(value.clips) || value.clips.length === 0 || !value.clips.every(isClipMetadata)) {
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
function createFrameSetAck(sessionId, requestId, generation, outcome) {
  return {
    protocol: PROTOCOL_VERSION,
    type: "ack_frame_set",
    session_id: sessionId,
    request_id: requestId,
    generation,
    outcome
  };
}
function createSetPlayingMessage(sessionId, playing) {
  return {
    protocol: PROTOCOL_VERSION,
    type: "set_playing",
    session_id: sessionId,
    playing
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
    const hasRequestContext = "request_id" in value || "generation" in value || "clip_id" in value;
    if (hasRequestContext && (!isNonnegativeInteger(value.request_id) || !isNonnegativeInteger(value.generation) || !isClipId(value.clip_id))) {
      throw new ProtocolError(
        "invalid_message",
        "Malformed backend error context."
      );
    }
    return value;
  }
  throw new ProtocolError("invalid_message", "Malformed backend message.");
}

// frontend/time.ts
var MAX_TIME_INPUT_LENGTH = 32;
function clampFrame(frame, numFrames) {
  if (frame <= 0n) {
    return 0;
  }
  const lastFrame = BigInt(numFrames - 1);
  return Number(frame >= lastFrame ? lastFrame : frame);
}
function floorDivide(numerator, denominator) {
  const quotient = numerator / denominator;
  return numerator < 0n && numerator % denominator !== 0n ? quotient - 1n : quotient;
}
function frameFromScaledSeconds(numerator, denominator, fpsNum, fpsDen, numFrames) {
  const frame = floorDivide(
    numerator * BigInt(fpsNum),
    denominator * BigInt(fpsDen)
  );
  return clampFrame(frame, numFrames);
}
function decimalScale(fraction) {
  return 10n ** BigInt(fraction.length);
}
function parseScaledSeconds(value) {
  if (value.length > MAX_TIME_INPUT_LENGTH) {
    return void 0;
  }
  const trimmed = value.trim();
  const clockMatch = /^(\d+):(\d{2}):(\d{2})(?:\.(\d+))?$/.exec(trimmed);
  if (clockMatch !== null) {
    const [, hoursText, minutesText, secondsText, fractionText2 = ""] = clockMatch;
    const minutes = Number(minutesText);
    const seconds = Number(secondsText);
    if (minutes >= 60 || seconds >= 60) {
      return void 0;
    }
    const denominator2 = decimalScale(fractionText2);
    const wholeSeconds = (BigInt(hoursText) * 60n + BigInt(minutes)) * 60n + BigInt(seconds);
    return {
      numerator: wholeSeconds * denominator2 + BigInt(fractionText2 === "" ? "0" : fractionText2),
      denominator: denominator2
    };
  }
  const decimalMatch = /^(-?)(\d+)(?:\.(\d+))?$/.exec(trimmed);
  if (decimalMatch === null) {
    return void 0;
  }
  const [, sign, wholeText, fractionText = ""] = decimalMatch;
  const denominator = decimalScale(fractionText);
  const magnitude = BigInt(wholeText) * denominator + BigInt(fractionText === "" ? "0" : fractionText);
  return {
    numerator: sign === "-" ? -magnitude : magnitude,
    denominator
  };
}
function parseTimeToFrame(value, fpsNum, fpsDen, numFrames) {
  const time = parseScaledSeconds(value);
  return time === void 0 ? void 0 : frameFromScaledSeconds(
    time.numerator,
    time.denominator,
    fpsNum,
    fpsDen,
    numFrames
  );
}
function offsetFrameBySeconds(frame, seconds, fpsNum, fpsDen, numFrames) {
  const frameOffset = floorDivide(
    BigInt(Math.trunc(seconds)) * BigInt(fpsNum),
    BigInt(fpsDen)
  );
  return clampFrame(BigInt(frame) + frameOffset, numFrames);
}
function formatFrameTime(frame, fpsNum, fpsDen) {
  let precision = 3;
  let scale = 1000n;
  while (scale * BigInt(fpsDen) < BigInt(fpsNum)) {
    precision += 1;
    scale *= 10n;
  }
  const numerator = BigInt(frame) * BigInt(fpsDen) * scale;
  const denominator = BigInt(fpsNum);
  const ticks = (numerator + denominator - 1n) / denominator;
  const totalSeconds = ticks / scale;
  const hours = totalSeconds / 3600n;
  const minutes = totalSeconds % 3600n / 60n;
  const seconds = totalSeconds % 60n;
  const fraction = ticks % scale;
  return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}.${fraction.toString().padStart(precision, "0")}`;
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
function renderMetadata(root, message, navigation, signal) {
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
  const controls = document.createElement("div");
  controls.className = "kaleidoscope-controls";
  controls.setAttribute("role", "group");
  controls.setAttribute("aria-label", "Paused navigation");
  const createNavigationButton = (label, text, target) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "kaleidoscope-control-button";
    button.setAttribute("aria-label", label);
    button.title = label;
    button.textContent = text;
    button.disabled = navigation === void 0;
    button.addEventListener("click", () => requestExact(target()), { signal });
    return button;
  };
  const play = document.createElement("button");
  play.type = "button";
  play.className = "kaleidoscope-control-button";
  play.disabled = navigation === void 0;
  let playing = false;
  const updatePlaying = (active) => {
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
  seek.disabled = navigation === void 0;
  const frame = document.createElement("input");
  frame.type = "number";
  frame.className = "kaleidoscope-frame-input";
  frame.min = "0";
  frame.max = String(message.num_frames - 1);
  frame.step = "1";
  frame.value = "0";
  frame.setAttribute("aria-label", "Current frame");
  frame.disabled = navigation === void 0;
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
  time.disabled = navigation === void 0;
  const duration = document.createElement("span");
  duration.className = "kaleidoscope-duration";
  duration.textContent = `/ ${formatFrameTime(
    message.num_frames,
    message.fps_num,
    message.fps_den
  )}`;
  let currentFrame = 0;
  const updateFrame = (target) => {
    currentFrame = target;
    seek.value = String(target);
    frame.value = String(target);
    time.value = formatFrameTime(target, message.fps_num, message.fps_den);
  };
  const requestExact = (target) => {
    if (navigation !== void 0) {
      updateFrame(navigation.requestExact(target));
    }
  };
  const first = createNavigationButton("First frame", "|<", () => 0);
  const previous = createNavigationButton(
    "Previous frame",
    "<",
    () => currentFrame - 1
  );
  const next = createNavigationButton(
    "Next frame",
    ">",
    () => currentFrame + 1
  );
  const last = createNavigationButton(
    "Last frame",
    ">|",
    () => message.num_frames - 1
  );
  seek.addEventListener(
    "input",
    () => {
      if (navigation !== void 0) {
        updateFrame(navigation.scheduleScrub(Number(seek.value)));
      }
    },
    { signal }
  );
  seek.addEventListener("change", () => requestExact(Number(seek.value)), {
    signal
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
    { signal }
  );
  time.addEventListener(
    "change",
    () => {
      const target = parseTimeToFrame(
        time.value,
        message.fps_num,
        message.fps_den,
        message.num_frames
      );
      if (target === void 0) {
        updateFrame(currentFrame);
        return;
      }
      requestExact(target);
    },
    { signal }
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
    duration
  );
  root.tabIndex = 0;
  root.addEventListener(
    "keydown",
    (event) => {
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target instanceof HTMLElement && target.isContentEditable) {
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
          event.shiftKey ? offsetFrameBySeconds(
            currentFrame,
            -1,
            message.fps_num,
            message.fps_den,
            message.num_frames
          ) : currentFrame - 1
        );
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        requestExact(
          event.shiftKey ? offsetFrameBySeconds(
            currentFrame,
            1,
            message.fps_num,
            message.fps_den,
            message.num_frames
          ) : currentFrame + 1
        );
      } else if (event.key === "Home") {
        event.preventDefault();
        requestExact(0);
      } else if (event.key === "End") {
        event.preventDefault();
        requestExact(message.num_frames - 1);
      }
    },
    { signal }
  );
  const clips = document.createElement("ul");
  clips.className = "kaleidoscope-clips";
  clips.dataset.mode = message.mode;
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
  root.replaceChildren(header, timeline, controls, clips, status);
  return {
    metadata: message,
    canvases,
    setFrame: updateFrame,
    setPlaying: updatePlaying
  };
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
    const targets = decoded.map((frame) => {
      const currentCanvas = view.canvases.get(frame.manifest.clip_id);
      const parent = currentCanvas?.parentNode;
      if (currentCanvas === void 0 || parent === null || parent === void 0 || currentCanvas.getContext("2d") === null) {
        throw new Error("The active preview canvas is unavailable.");
      }
      const stagedCanvas = currentCanvas.cloneNode(false);
      const context = stagedCanvas.getContext("2d");
      if (context === null) {
        throw new Error("The active preview canvas is unavailable.");
      }
      return {
        decoded: frame,
        currentCanvas,
        stagedCanvas,
        context,
        parent
      };
    });
    for (const { decoded: frame, stagedCanvas, context } of targets) {
      context.drawImage(
        frame.bitmap,
        0,
        0,
        stagedCanvas.width,
        stagedCanvas.height
      );
      stagedCanvas.setAttribute(
        "aria-label",
        `${view.metadata.clips.find((clip) => idsMatch(clip.id, frame.manifest.clip_id))?.label ?? "Clip"}, frame ${message.frame}`
      );
    }
    if (!shouldCommit()) {
      return false;
    }
    const committed = [];
    try {
      for (const target of targets) {
        target.parent.replaceChild(
          target.stagedCanvas,
          target.currentCanvas
        );
        committed.push(target);
      }
    } catch (error) {
      for (const target of committed.reverse()) {
        if (target.stagedCanvas.parentNode === target.parent) {
          target.parent.replaceChild(
            target.currentCanvas,
            target.stagedCanvas
          );
        }
      }
      throw error;
    }
    for (const target of targets) {
      view.canvases.set(
        target.decoded.manifest.clip_id,
        target.stagedCanvas
      );
    }
    return true;
  } finally {
    for (const frame of decoded) {
      frame.bitmap.close();
    }
  }
}

// frontend/scheduler.ts
var timestampMicros = (milliseconds) => BigInt(Math.trunc(milliseconds * 1e3));
var PlaybackClock = class {
  numFrames;
  fpsNum;
  fpsDen;
  anchorFrame = 0;
  anchorMicros = 0n;
  currentFrame = 0;
  active = false;
  constructor(options) {
    this.numFrames = options.numFrames;
    this.fpsNum = BigInt(options.fpsNum);
    this.fpsDen = BigInt(options.fpsDen);
  }
  get playing() {
    return this.active;
  }
  clamp(frame) {
    return Math.min(this.numFrames - 1, Math.max(0, Math.trunc(frame)));
  }
  play(frame, now) {
    const clamped = this.clamp(frame);
    this.currentFrame = clamped === this.numFrames - 1 ? 0 : clamped;
    this.anchorFrame = this.currentFrame;
    this.anchorMicros = timestampMicros(now);
    this.active = true;
    return this.currentFrame;
  }
  pause(now) {
    if (this.active) {
      this.sample(now);
      this.active = false;
    }
    return this.currentFrame;
  }
  sample(now) {
    if (!this.active) {
      return { frame: this.currentFrame, ended: false };
    }
    const elapsed = timestampMicros(now) - this.anchorMicros;
    const elapsedFrames = elapsed <= 0n ? 0n : elapsed * this.fpsNum / (1000000n * this.fpsDen);
    const desired = Math.max(
      this.currentFrame,
      this.anchorFrame + Number(elapsedFrames)
    );
    if (desired >= this.numFrames - 1) {
      this.currentFrame = this.numFrames - 1;
      this.active = false;
      return { frame: this.currentFrame, ended: true };
    }
    this.currentFrame = desired;
    return { frame: this.currentFrame, ended: false };
  }
};
var PlaybackController = class {
  clock;
  scheduler;
  onFrame;
  onPlaying;
  sendPlaying;
  schedule;
  cancel;
  now;
  currentFrame = 0;
  scheduledHandle;
  constructor(options) {
    this.clock = new PlaybackClock(options);
    this.scheduler = options.scheduler;
    this.onFrame = options.onFrame;
    this.onPlaying = options.onPlaying;
    this.sendPlaying = options.sendPlaying;
    this.schedule = options.schedule ?? scheduleFrame;
    this.cancel = options.cancel ?? cancelFrame;
    this.now = options.now ?? (() => performance.now());
  }
  get playing() {
    return this.clock.playing;
  }
  setCurrentFrame(frame) {
    this.currentFrame = frame;
  }
  scheduleTick() {
    if (this.scheduledHandle === void 0 && this.clock.playing) {
      this.scheduledHandle = this.schedule((timestamp) => {
        this.scheduledHandle = void 0;
        const sample = this.clock.sample(timestamp);
        if (sample.frame !== this.currentFrame) {
          this.currentFrame = sample.frame;
          this.onFrame(sample.frame);
          this.scheduler.requestPlayback(sample.frame);
        }
        if (sample.ended) {
          this.onPlaying(false);
          this.sendPlaying(false);
          return;
        }
        this.scheduleTick();
      });
    }
  }
  play() {
    if (this.clock.playing) {
      return;
    }
    const previousFrame = this.currentFrame;
    const frame = this.clock.play(previousFrame, this.now());
    if (frame !== previousFrame) {
      this.currentFrame = frame;
      this.onFrame(frame);
      this.scheduler.requestPlayback(frame, true);
    }
    this.onPlaying(true);
    this.sendPlaying(true);
    this.scheduleTick();
  }
  pause(requestExact = true) {
    if (!this.clock.playing) {
      return this.currentFrame;
    }
    this.currentFrame = this.clock.pause(this.now());
    if (this.scheduledHandle !== void 0) {
      this.cancel(this.scheduledHandle);
      this.scheduledHandle = void 0;
    }
    if (requestExact) {
      this.scheduler.requestExact(this.currentFrame);
    }
    this.onFrame(this.currentFrame);
    this.onPlaying(false);
    this.sendPlaying(false);
    return this.currentFrame;
  }
  toggle() {
    if (this.clock.playing) {
      this.pause();
    } else {
      this.play();
    }
  }
  close() {
    if (this.scheduledHandle !== void 0) {
      this.cancel(this.scheduledHandle);
      this.scheduledHandle = void 0;
    }
  }
};
var scheduleFrame = (callback) => {
  if (typeof globalThis.requestAnimationFrame === "function") {
    return globalThis.requestAnimationFrame(callback);
  }
  return globalThis.setTimeout(() => callback(performance.now()), 0);
};
var cancelFrame = (handle) => {
  if (typeof globalThis.cancelAnimationFrame === "function") {
    globalThis.cancelAnimationFrame(handle);
  } else {
    globalThis.clearTimeout(handle);
  }
};
var PausedSeekScheduler = class {
  sessionId;
  numFrames;
  clipIds;
  send;
  schedule;
  cancel;
  nextRequestId = 0;
  nextGeneration = 0;
  scheduledHandle;
  scheduledToken = 0;
  pendingFrame = 0;
  closed = false;
  constructor(options) {
    this.sessionId = options.sessionId;
    this.numFrames = options.numFrames;
    this.clipIds = [...options.clipIds];
    this.send = options.send;
    this.schedule = options.schedule ?? scheduleFrame;
    this.cancel = options.cancel ?? cancelFrame;
  }
  clamp(frame) {
    if (!Number.isFinite(frame)) {
      return frame < 0 ? 0 : this.numFrames - 1;
    }
    return Math.min(this.numFrames - 1, Math.max(0, Math.trunc(frame)));
  }
  cancelScheduledScrub() {
    this.scheduledToken += 1;
    if (this.scheduledHandle !== void 0) {
      this.cancel(this.scheduledHandle);
      this.scheduledHandle = void 0;
    }
  }
  sendRequest(frame, generation, reason) {
    const identity = {
      request_id: this.nextRequestId,
      generation,
      frame: this.clamp(frame)
    };
    if (this.closed) {
      return identity;
    }
    this.nextRequestId += 1;
    this.send(
      createFrameSetRequest(
        this.sessionId,
        identity.request_id,
        identity.generation,
        identity.frame,
        this.clipIds,
        reason
      )
    );
    return identity;
  }
  requestExact(frame) {
    this.cancelScheduledScrub();
    const generation = this.nextGeneration;
    this.nextGeneration += 1;
    return this.sendRequest(frame, generation, "seek");
  }
  requestPlayback(frame, restart = false) {
    this.cancelScheduledScrub();
    const generation = restart ? this.nextGeneration : Math.max(0, this.nextGeneration - 1);
    if (restart) {
      this.nextGeneration += 1;
    }
    return this.sendRequest(frame, generation, "playback");
  }
  scheduleScrub(frame) {
    this.pendingFrame = this.clamp(frame);
    if (!this.closed && this.scheduledHandle === void 0) {
      const token = this.scheduledToken;
      this.scheduledHandle = this.schedule(() => {
        if (token !== this.scheduledToken) {
          return;
        }
        this.scheduledHandle = void 0;
        this.requestExact(this.pendingFrame);
      });
    }
    return this.pendingFrame;
  }
  close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.cancelScheduledScrub();
  }
};

// frontend/index.ts
function createStatus(text) {
  const status = document.createElement("div");
  status.className = "kaleidoscope-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.textContent = text;
  return status;
}
var WEBP_DECODE_PROBE = new Uint8Array([
  82,
  73,
  70,
  70,
  28,
  0,
  0,
  0,
  87,
  69,
  66,
  80,
  86,
  80,
  56,
  76,
  15,
  0,
  0,
  0,
  47,
  0,
  0,
  0,
  0,
  7,
  16,
  253,
  143,
  254,
  7,
  34,
  162,
  255,
  1,
  0
]);
async function supportsWebp() {
  if (typeof globalThis.createImageBitmap !== "function") {
    return false;
  }
  try {
    const bitmap = await globalThis.createImageBitmap(
      new Blob([WEBP_DECODE_PROBE], { type: "image/webp" })
    );
    bitmap.close();
    return true;
  } catch {
    return false;
  }
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
  let seekScheduler;
  let playbackController;
  let currentRequest;
  let resumeAfterPaint;
  let resumeAfterScrub = false;
  let autoplayPending = false;
  let resumeAfterVisibility = false;
  const updateStatus = (text) => {
    const liveStatus = el.querySelector("[role='status']");
    if (liveStatus !== null) {
      liveStatus.textContent = text;
    }
  };
  const playWhenVisible = () => {
    if (document.visibilityState === "hidden") {
      resumeAfterVisibility = true;
      return;
    }
    resumeAfterVisibility = false;
    playbackController?.play();
  };
  const togglePlaying = () => {
    autoplayPending = false;
    resumeAfterPaint = void 0;
    resumeAfterScrub = false;
    resumeAfterVisibility = false;
    playbackController?.toggle();
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
          seekScheduler = new PausedSeekScheduler({
            sessionId,
            numFrames: message.num_frames,
            clipIds: message.active_clip_ids,
            send: (request) => {
              currentRequest = request;
              model.send(request);
            }
          });
          playerView = renderMetadata(
            el,
            message,
            {
              requestExact: (frame) => {
                playbackController?.pause(false);
                const request = seekScheduler?.requestExact(frame);
                if (request === void 0) {
                  return 0;
                }
                if (resumeAfterScrub) {
                  resumeAfterPaint = request;
                  resumeAfterScrub = false;
                } else {
                  resumeAfterPaint = void 0;
                }
                return request.frame;
              },
              scheduleScrub: (frame) => {
                if (playbackController?.playing || resumeAfterPaint !== void 0 || resumeAfterScrub) {
                  resumeAfterScrub = true;
                }
                resumeAfterPaint = void 0;
                playbackController?.pause(false);
                currentRequest = void 0;
                return seekScheduler?.scheduleScrub(frame) ?? 0;
              },
              togglePlaying
            },
            signal
          );
          playbackController = new PlaybackController({
            numFrames: message.num_frames,
            fpsNum: message.fps_num,
            fpsDen: message.fps_den,
            scheduler: seekScheduler,
            onFrame: (frame) => playerView?.setFrame(frame),
            onPlaying: (playing) => playerView?.setPlaying(playing),
            sendPlaying: (playing) => model.send(createSetPlayingMessage(sessionId, playing))
          });
          autoplayPending = message.autoplay;
          seekScheduler.requestExact(0);
          return;
        }
        status.textContent = "Kaleidoscope is ready.";
        return;
      }
      if (message.type === "frame_set") {
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
        const acknowledge = (outcome) => {
          model.send(
            createFrameSetAck(
              sessionId,
              message.request_id,
              message.generation,
              outcome
            )
          );
        };
        if (!isCurrent()) {
          acknowledge("stale");
          return;
        }
        let painted;
        try {
          validateFrameSetBuffers(message, buffers);
          painted = await paintFrameSet(
            playerView,
            message,
            buffers,
            isCurrent
          );
        } catch (error) {
          if (!isCurrent()) {
            acknowledge("stale");
            return;
          }
          acknowledge("decode_error");
          playbackController?.pause(false);
          throw error;
        }
        if (painted) {
          playbackController?.setCurrentFrame(message.frame);
          updateStatus(`Frame ${message.frame} ready.`);
          acknowledge("painted");
          const shouldResume = resumeAfterPaint !== void 0 && message.request_id === resumeAfterPaint.request_id && message.generation === resumeAfterPaint.generation && message.frame === resumeAfterPaint.frame;
          if (shouldResume) {
            resumeAfterPaint = void 0;
            if (message.frame < metadata.num_frames - 1) {
              playWhenVisible();
            }
          } else if (autoplayPending) {
            autoplayPending = false;
            if (message.frame < metadata.num_frames - 1) {
              playWhenVisible();
            }
          }
        } else {
          acknowledge("stale");
        }
        return;
      }
      if (message.request_id !== void 0 && (currentRequest === void 0 || message.request_id !== currentRequest.request_id || message.generation !== currentRequest.generation)) {
        return;
      }
      const clip = metadata?.clips.find(
        (candidate) => candidate.id === message.clip_id
      );
      updateStatus(
        clip === void 0 ? `Protocol error: ${message.message}` : `${clip.label}: ${message.message}`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid backend message.";
      updateStatus(`Protocol error: ${message}`);
    }
  };
  const onMessage = (value, buffers) => {
    void handleMessage(value, buffers);
  };
  model.on("msg:custom", onMessage);
  const onVisibilityChange = () => {
    if (document.visibilityState === "hidden") {
      if (playbackController?.playing) {
        const pausedFrame = playbackController.pause(false);
        resumeAfterVisibility = metadata !== void 0 && pausedFrame < metadata.num_frames - 1;
        currentRequest = void 0;
      }
    } else if (resumeAfterVisibility) {
      playWhenVisible();
    }
  };
  document.addEventListener("visibilitychange", onVisibilityChange, {
    signal
  });
  signal.addEventListener(
    "abort",
    () => {
      playbackController?.close();
      seekScheduler?.close();
      model.off("msg:custom", onMessage);
    },
    { once: true }
  );
  const imageBitmap = typeof globalThis.createImageBitmap === "function";
  if (!imageBitmap) {
    model.send(
      createReadyMessage(sessionId, {
        image_bitmap: false,
        webp: false
      })
    );
    return;
  }
  void supportsWebp().then((webp) => {
    if (!signal.aborted) {
      model.send(
        createReadyMessage(sessionId, {
          image_bitmap: true,
          webp
        })
      );
    }
  });
}
var index_default = { render };
export {
  index_default as default,
  render
};
