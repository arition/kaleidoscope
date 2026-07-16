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
  return Number.isSafeInteger(value) && typeof value === "number" || typeof value === "string" && value.length > 0;
}
function isComparisonMode(value) {
  return value === "single" || value === "side-by-side" || value === "wipe" || value === "overlay" || value === "difference";
}
function isBackendErrorCode(value) {
  return value === "invalid_message" || value === "protocol_mismatch" || value === "unsupported_codec" || value === "invalid_clip" || value === "unsupported_dimensions" || value === "render_failed" || value === "conversion_failed" || value === "encode_failed" || value === "decode_failed" || value === "kernel_disconnected" || value === "session_closed";
}
function isRuntimeClipErrorCode(value) {
  return value === "render_failed" || value === "conversion_failed" || value === "encode_failed";
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
    "overlay_opacity",
    "max_visible_clips",
    "autoplay",
    "clips"
  ].some((key) => key in value);
}
function isPreviewMetadataMessage(value) {
  if (!isPositiveInteger(value.num_frames) || !isPositiveInteger(value.fps_num) || !isPositiveInteger(value.fps_den) || !isComparisonMode(value.mode) || !isPositiveInteger(value.max_visible_clips) || value.max_visible_clips > 4 || typeof value.autoplay !== "boolean" || !Array.isArray(value.active_clip_ids) || value.active_clip_ids.length === 0 || !value.active_clip_ids.every(isClipId) || !isNonnegativeFiniteNumber(value.overlay_opacity) || value.overlay_opacity > 1 || !Array.isArray(value.clips) || value.clips.length === 0 || !value.clips.every(isClipMetadata)) {
    return false;
  }
  const clips = value.clips;
  const clipIds = clips.map((clip) => clip.id);
  const activeIds = value.active_clip_ids;
  const activeClips = activeIds.map(
    (activeId) => clips.find((clip) => clip.id === activeId)
  );
  const validCardinality = value.mode === "single" && activeIds.length === 1 || value.mode === "side-by-side" && activeIds.length >= 1 || (value.mode === "wipe" || value.mode === "overlay" || value.mode === "difference") && activeIds.length === 2;
  const validAlignedGeometry = value.mode === "single" || value.mode === "side-by-side" || activeClips.length === 2 && activeClips[0] !== void 0 && activeClips[1] !== void 0 && activeClips[0].source_width === activeClips[1].source_width && activeClips[0].source_height === activeClips[1].source_height;
  return new Set(clipIds).size === clipIds.length && new Set(activeIds).size === activeIds.length && activeIds.length <= value.max_visible_clips && activeIds.every((activeId) => clipIds.some((clipId) => clipId === activeId)) && validCardinality && validAlignedGeometry;
}
function createReadyMessage(sessionId, capabilities) {
  return {
    protocol: PROTOCOL_VERSION,
    type: "ready",
    session_id: sessionId,
    capabilities
  };
}
function createCloseMessage(sessionId) {
  return {
    protocol: PROTOCOL_VERSION,
    type: "close",
    session_id: sessionId
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
function createSetViewMessage(sessionId, generation, mode, clipIds, overlayOpacity) {
  return {
    protocol: PROTOCOL_VERSION,
    type: "set_view",
    session_id: sessionId,
    generation,
    mode,
    clip_ids: [...clipIds],
    overlay_opacity: overlayOpacity
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
  if (value.type === "error" && typeof value.session_id === "string" && value.session_id.length > 0 && isBackendErrorCode(value.code) && typeof value.message === "string" && typeof value.recoverable === "boolean") {
    const hasRequestContext = "request_id" in value || "generation" in value || "clip_id" in value;
    if (hasRequestContext && (!isNonnegativeInteger(value.request_id) || !isNonnegativeInteger(value.generation) || !isClipId(value.clip_id))) {
      throw new ProtocolError(
        "invalid_message",
        "Malformed backend error context."
      );
    }
    const runtimeClipError = isRuntimeClipErrorCode(value.code);
    if (runtimeClipError && (!value.recoverable || !hasRequestContext) || !runtimeClipError && (value.recoverable || hasRequestContext)) {
      throw new ProtocolError(
        "invalid_message",
        "Backend error semantics do not match the error code."
      );
    }
    return value;
  }
  throw new ProtocolError("invalid_message", "Malformed backend message.");
}

// frontend/comparison.ts
var alignedModes = /* @__PURE__ */ new Set([
  "wipe",
  "overlay",
  "difference"
]);
var idsEqual = (left, right) => left === right;
var activeSetsEqual = (left, right) => left.length === right.length && left.every((clipId, index) => idsEqual(clipId, right[index]));
var clipById = (metadata, clipId) => {
  const clip = metadata.clips.find((candidate) => idsEqual(candidate.id, clipId));
  if (clip === void 0) {
    throw new Error(`Unknown clip ID ${String(clipId)}.`);
  }
  return clip;
};
var normalizeSelection = (metadata, requested) => {
  const selected = new Set(requested);
  const normalized = metadata.clips.map((clip) => clip.id).filter((clipId) => selected.has(clipId));
  if (normalized.length !== selected.size) {
    throw new Error("The comparison selection contains an unknown clip.");
  }
  return normalized;
};
var resolvePair = (metadata, current, primary, secondary) => {
  let first = primary ?? current?.primary ?? metadata.clips[0].id;
  let firstClip = clipById(metadata, first);
  const compatible = (clipId) => {
    if (clipId === void 0 || idsEqual(first, clipId)) {
      return false;
    }
    const clip = clipById(metadata, clipId);
    return firstClip.source_width === clip.source_width && firstClip.source_height === clip.source_height;
  };
  let second = secondary ?? (compatible(current?.secondary) ? current.secondary : metadata.clips.find((clip) => compatible(clip.id))?.id);
  if (second === void 0 && primary === void 0 && secondary === void 0) {
    for (const candidate of metadata.clips) {
      const partner = metadata.clips.find(
        (clip) => !idsEqual(clip.id, candidate.id) && clip.source_width === candidate.source_width && clip.source_height === candidate.source_height
      );
      if (partner !== void 0) {
        first = candidate.id;
        firstClip = candidate;
        second = partner.id;
        break;
      }
    }
  }
  if (second === void 0 || idsEqual(first, second)) {
    throw new Error("Aligned comparison clips must be distinct.");
  }
  const secondClip = clipById(metadata, second);
  if (firstClip.source_width !== secondClip.source_width || firstClip.source_height !== secondClip.source_height) {
    throw new Error("Aligned comparison clips require matching source dimensions.");
  }
  return [first, second];
};
var createComparisonState = (metadata) => {
  const primary = metadata.active_clip_ids[0];
  const secondary = metadata.active_clip_ids[1];
  return {
    mode: metadata.mode,
    activeClipIds: [...metadata.active_clip_ids],
    primary,
    secondary,
    overlayOpacity: metadata.overlay_opacity,
    wipePosition: 0.5
  };
};
var transitionComparisonState = (current, metadata, transition) => {
  const mode = transition.mode ?? current.mode;
  let primary = transition.primary ?? current.primary;
  let secondary = transition.secondary ?? current.secondary;
  let activeClipIds;
  if (mode === "single") {
    primary = transition.primary ?? transition.selectedClipIds?.[0] ?? primary;
    clipById(metadata, primary);
    secondary = void 0;
    activeClipIds = [primary];
  } else if (mode === "side-by-side") {
    const selected = transition.selectedClipIds ?? current.activeClipIds;
    activeClipIds = normalizeSelection(metadata, selected);
    if (activeClipIds.length === 0 || activeClipIds.length > metadata.max_visible_clips) {
      throw new Error(
        `Side-by-side comparison requires 1-${metadata.max_visible_clips} clips.`
      );
    }
    primary = activeClipIds[0];
    secondary = void 0;
  } else if (alignedModes.has(mode)) {
    if (metadata.max_visible_clips < 2) {
      throw new Error(
        "Aligned comparison exceeds the configured visible-clip limit."
      );
    }
    [primary, secondary] = resolvePair(
      metadata,
      current,
      transition.primary,
      transition.secondary
    );
    activeClipIds = [primary, secondary];
  } else {
    throw new Error(`Unsupported comparison mode ${mode}.`);
  }
  const state = {
    mode,
    activeClipIds,
    primary,
    secondary,
    overlayOpacity: Math.min(
      1,
      Math.max(0, transition.overlayOpacity ?? current.overlayOpacity)
    ),
    wipePosition: Math.min(
      1,
      Math.max(0, transition.wipePosition ?? current.wipePosition)
    )
  };
  return {
    state,
    requiresFrameSet: !activeSetsEqual(
      current.activeClipIds,
      state.activeClipIds
    )
  };
};

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

// frontend/comparison-view.ts
var ALIGNED_MODES = /* @__PURE__ */ new Set([
  "wipe",
  "overlay",
  "difference"
]);
var idsMatch = (left, right) => left === right;
function createComparisonView(options) {
  const {
    metadata,
    canvases,
    rows,
    modeLabel,
    clips,
    onChange,
    updateClipRow: updateClipRow2,
    signal
  } = options;
  let state = createComparisonState(metadata);
  let committedState = state;
  let committedFrame = 0;
  const toolbar = document.createElement("div");
  toolbar.className = "kaleidoscope-comparison-toolbar";
  const modeControl = document.createElement("div");
  modeControl.className = "kaleidoscope-mode-control";
  modeControl.setAttribute("role", "group");
  modeControl.setAttribute("aria-label", "Comparison mode");
  const selectionControl = document.createElement("div");
  selectionControl.className = "kaleidoscope-selection-control";
  toolbar.append(modeControl, selectionControl);
  const comparison = document.createElement("figure");
  comparison.className = "kaleidoscope-comparison";
  comparison.hidden = true;
  const comparisonLabels = document.createElement("figcaption");
  comparisonLabels.className = "kaleidoscope-comparison__labels";
  const comparisonStage = document.createElement("div");
  comparisonStage.className = "kaleidoscope-comparison__stage";
  const createComparisonCanvas = () => {
    const canvas = document.createElement("canvas");
    canvas.className = "kaleidoscope-comparison__canvas";
    canvas.setAttribute("role", "img");
    return canvas;
  };
  let comparisonCanvas = createComparisonCanvas();
  let stagingComparisonCanvas = createComparisonCanvas();
  comparisonStage.append(comparisonCanvas);
  const comparisonParameters = document.createElement("div");
  comparisonParameters.className = "kaleidoscope-comparison__parameters";
  comparison.append(comparisonLabels, comparisonStage, comparisonParameters);
  const clipForId = (clipId) => {
    const clip = metadata.clips.find((candidate) => idsMatch(candidate.id, clipId));
    if (clip === void 0) {
      throw new Error(`Unknown clip ID ${String(clipId)}.`);
    }
    return clip;
  };
  const optionValue = (clipId) => String(metadata.clips.findIndex((clip) => idsMatch(clip.id, clipId)));
  const optionClipId = (value) => metadata.clips[Number(value)].id;
  const createClipSelect = (label, selected, onSelect, disabled) => {
    const select = document.createElement("select");
    select.className = "kaleidoscope-clip-select";
    select.setAttribute("aria-label", label);
    select.disabled = onChange === void 0;
    for (const clip of metadata.clips) {
      const option = document.createElement("option");
      option.value = optionValue(clip.id);
      option.textContent = clip.label;
      option.disabled = disabled?.(clip) ?? false;
      option.selected = idsMatch(clip.id, selected);
      select.append(option);
    }
    select.addEventListener("change", () => onSelect(optionClipId(select.value)), {
      signal
    });
    return select;
  };
  const modeButtons = /* @__PURE__ */ new Map();
  if (metadata.clips.length > 1) {
    const modes = [
      ["single", "Single"],
      ["side-by-side", "Side by side"],
      ["wipe", "Wipe"],
      ["overlay", "Overlay"],
      ["difference", "Difference"]
    ];
    const hasAlignedPair = metadata.clips.some(
      (first, firstIndex) => metadata.clips.some(
        (second, secondIndex) => firstIndex !== secondIndex && first.source_width === second.source_width && first.source_height === second.source_height
      )
    );
    for (const [value, label] of modes) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "kaleidoscope-mode-button";
      button.textContent = label;
      button.title = `${label} view`;
      button.setAttribute("aria-label", `${label} view`);
      button.disabled = onChange === void 0 || ALIGNED_MODES.has(value) && (!hasAlignedPair || metadata.max_visible_clips < 2);
      button.addEventListener("click", () => onChange?.({ mode: value }), {
        signal
      });
      modeButtons.set(value, button);
      modeControl.append(button);
    }
  }
  const renderSelectionControls = () => {
    selectionControl.replaceChildren();
    if (state.mode === "single") {
      selectionControl.append(
        createClipSelect(
          "Solo clip",
          state.primary,
          (primary2) => onChange?.({ primary: primary2 })
        )
      );
      return;
    }
    if (state.mode === "side-by-side") {
      const selected = state.activeClipIds;
      for (const clip of metadata.clips) {
        const label = document.createElement("label");
        label.className = "kaleidoscope-clip-toggle";
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = selected.some((clipId) => idsMatch(clipId, clip.id));
        checkbox.disabled = onChange === void 0 || (checkbox.checked ? selected.length === 1 : selected.length >= metadata.max_visible_clips);
        checkbox.setAttribute("aria-label", `Show ${clip.label}`);
        checkbox.addEventListener(
          "change",
          () => {
            const next = checkbox.checked ? [...selected, clip.id] : selected.filter((clipId) => !idsMatch(clipId, clip.id));
            onChange?.({ selectedClipIds: next });
          },
          { signal }
        );
        const text = document.createElement("span");
        text.textContent = clip.label;
        label.append(checkbox, text);
        selectionControl.append(label);
      }
      return;
    }
    const primaryClip = clipForId(state.primary);
    const secondary = state.secondary;
    if (secondary === void 0) {
      return;
    }
    const primary = createClipSelect(
      "Comparison clip A",
      state.primary,
      (primaryId) => onChange?.({ primary: primaryId }),
      (clip) => !metadata.clips.some(
        (candidate) => !idsMatch(candidate.id, clip.id) && candidate.source_width === clip.source_width && candidate.source_height === clip.source_height
      )
    );
    const secondarySelect = createClipSelect(
      "Comparison clip B",
      secondary,
      (secondaryId) => onChange?.({ secondary: secondaryId }),
      (clip) => idsMatch(clip.id, state.primary) || clip.source_width !== primaryClip.source_width || clip.source_height !== primaryClip.source_height
    );
    selectionControl.append(primary, secondarySelect);
  };
  const renderComparisonParameters = () => {
    comparisonParameters.replaceChildren();
    comparisonStage.querySelector(".kaleidoscope-wipe")?.remove();
    if (state.mode === "wipe") {
      const wipe = document.createElement("input");
      wipe.type = "range";
      wipe.className = "kaleidoscope-wipe";
      wipe.min = "0";
      wipe.max = "100";
      wipe.step = "1";
      wipe.value = String(Math.round(state.wipePosition * 100));
      wipe.setAttribute("aria-label", "Wipe position");
      wipe.addEventListener(
        "input",
        () => onChange?.({ wipePosition: Number(wipe.value) / 100 }),
        { signal }
      );
      comparisonStage.append(wipe);
    } else if (state.mode === "overlay") {
      const label = document.createElement("label");
      label.className = "kaleidoscope-parameter";
      const text = document.createElement("span");
      text.textContent = "B opacity";
      const opacity = document.createElement("input");
      opacity.type = "range";
      opacity.min = "0";
      opacity.max = "1";
      opacity.step = "0.01";
      opacity.value = String(state.overlayOpacity);
      opacity.setAttribute("aria-label", "Overlay opacity");
      const output = document.createElement("output");
      output.textContent = `${Math.round(state.overlayOpacity * 100)}%`;
      opacity.addEventListener(
        "input",
        () => onChange?.({ overlayOpacity: Number(opacity.value) }),
        { signal }
      );
      label.append(text, opacity, output);
      comparisonParameters.append(label);
    } else if (state.mode === "difference") {
      const note = document.createElement("span");
      note.className = "kaleidoscope-difference-note";
      note.textContent = "8-bit visual difference (non-reference)";
      comparisonParameters.append(note);
    }
  };
  const prepareCommit = (candidateCanvases, frame) => {
    const next = state;
    const nextFrame = frame ?? committedFrame;
    let stagedComparison;
    let comparisonLabel = "";
    if (ALIGNED_MODES.has(next.mode)) {
      const secondary = next.secondary;
      if (secondary === void 0) {
        throw new Error("Aligned comparison clips are unavailable.");
      }
      const first = candidateCanvases.get(next.primary);
      const second = candidateCanvases.get(secondary);
      if (first === void 0 || second === void 0) {
        throw new Error("Aligned comparison frames are unavailable.");
      }
      stagedComparison = stagingComparisonCanvas;
      stagedComparison.width = first.width;
      stagedComparison.height = first.height;
      const context = stagedComparison.getContext("2d");
      if (context === null) {
        throw new Error("The comparison canvas is unavailable.");
      }
      context.clearRect(0, 0, stagedComparison.width, stagedComparison.height);
      context.drawImage(first, 0, 0, stagedComparison.width, stagedComparison.height);
      if (next.mode === "wipe") {
        context.save();
        context.beginPath();
        context.rect(
          0,
          0,
          stagedComparison.width * next.wipePosition,
          stagedComparison.height
        );
        context.clip();
        context.drawImage(
          second,
          0,
          0,
          stagedComparison.width,
          stagedComparison.height
        );
        context.restore();
      } else if (next.mode === "overlay") {
        context.save();
        context.globalAlpha = next.overlayOpacity;
        context.drawImage(
          second,
          0,
          0,
          stagedComparison.width,
          stagedComparison.height
        );
        context.restore();
      } else {
        context.save();
        context.globalCompositeOperation = "difference";
        context.drawImage(
          second,
          0,
          0,
          stagedComparison.width,
          stagedComparison.height
        );
        context.restore();
      }
      stagedComparison.setAttribute(
        "aria-label",
        `${clipForId(next.primary).label} and ${clipForId(secondary).label}, ${next.mode} comparison, frame ${nextFrame}, time ${formatFrameTime(nextFrame, metadata.fps_num, metadata.fps_den)}`
      );
      comparisonLabel = `${clipForId(next.primary).label} (A) | ${clipForId(secondary).label} (B)`;
    }
    return () => {
      const previousState = committedState;
      const previousFrame = committedFrame;
      const previousModeLabel = modeLabel.textContent;
      const previousMode = clips.dataset.mode;
      const previousHidden = comparison.hidden;
      const previousComparisonLabel = comparisonLabels.textContent;
      const previousCanvases = new Map(canvases);
      const previousRowChildren = new Map(
        Array.from(rows, ([clipId, row]) => [clipId, Array.from(row.childNodes)])
      );
      const previousRowActive = new Map(
        Array.from(rows, ([clipId, row]) => [clipId, row.dataset.active])
      );
      const previousCanvasVisibility = new Map(
        Array.from(canvases, ([clipId, canvas]) => [
          clipId,
          {
            hidden: canvas.hidden,
            ariaHidden: canvas.getAttribute("aria-hidden")
          }
        ])
      );
      try {
        const aligned = ALIGNED_MODES.has(next.mode);
        modeLabel.textContent = next.mode;
        clips.dataset.mode = next.mode;
        comparison.hidden = !aligned;
        comparisonLabels.textContent = aligned ? comparisonLabel : "";
        for (const clip of metadata.clips) {
          const row = rows.get(clip.id);
          if (row !== void 0) {
            updateClipRow2(
              row,
              clip,
              next.activeClipIds.some((clipId) => idsMatch(clipId, clip.id)),
              aligned,
              canvases
            );
          }
        }
        if (stagedComparison !== void 0) {
          comparisonCanvas.replaceWith(stagedComparison);
          stagingComparisonCanvas = comparisonCanvas;
          comparisonCanvas = stagedComparison;
        }
        committedState = next;
        committedFrame = nextFrame;
      } catch (error) {
        committedState = previousState;
        committedFrame = previousFrame;
        modeLabel.textContent = previousModeLabel;
        if (previousMode === void 0) {
          delete clips.dataset.mode;
        } else {
          clips.dataset.mode = previousMode;
        }
        comparison.hidden = previousHidden;
        comparisonLabels.textContent = previousComparisonLabel;
        canvases.clear();
        for (const [clipId, canvas] of previousCanvases) {
          canvases.set(clipId, canvas);
        }
        for (const [clipId, children] of previousRowChildren) {
          const row = rows.get(clipId);
          row?.replaceChildren(...children);
          const active = previousRowActive.get(clipId);
          if (row !== void 0) {
            if (active === void 0) {
              delete row.dataset.active;
            } else {
              row.dataset.active = active;
            }
          }
        }
        for (const [clipId, visibility] of previousCanvasVisibility) {
          const canvas = previousCanvases.get(clipId);
          if (canvas !== void 0) {
            canvas.hidden = visibility.hidden;
            if (visibility.ariaHidden === null) {
              canvas.removeAttribute("aria-hidden");
            } else {
              canvas.setAttribute("aria-hidden", visibility.ariaHidden);
            }
          }
        }
        throw error;
      }
    };
  };
  const compose = () => {
    state = committedState;
    prepareCommit(canvases)();
  };
  const setState = (next, deferComposition = false) => {
    const structuralChange = next.mode !== state.mode || next.activeClipIds.length !== state.activeClipIds.length || next.activeClipIds.some(
      (clipId, index) => !idsMatch(clipId, state.activeClipIds[index])
    );
    state = next;
    for (const [value, button] of modeButtons) {
      button.setAttribute("aria-pressed", String(value === state.mode));
    }
    if (structuralChange) {
      renderSelectionControls();
      renderComparisonParameters();
    } else if (state.mode === "wipe") {
      const wipe = comparisonStage.querySelector(
        "input[aria-label='Wipe position']"
      );
      if (wipe !== null) {
        wipe.value = String(Math.round(state.wipePosition * 100));
      }
    } else if (state.mode === "overlay") {
      const opacity = comparisonParameters.querySelector(
        "input[aria-label='Overlay opacity']"
      );
      const output = comparisonParameters.querySelector("output");
      if (opacity !== null) {
        opacity.value = String(state.overlayOpacity);
      }
      if (output !== null) {
        output.textContent = `${Math.round(state.overlayOpacity * 100)}%`;
      }
    }
    if (!deferComposition) {
      prepareCommit(canvases)();
    }
  };
  renderSelectionControls();
  renderComparisonParameters();
  setState(state);
  return {
    toolbar,
    view: comparison,
    compose,
    prepareCommit,
    setState
  };
}

// frontend/player.ts
function idsMatch2(left, right) {
  return left === right;
}
function describeFrame(label, frame, metadata) {
  return `${label}, frame ${frame}, time ${formatFrameTime(frame, metadata.fps_num, metadata.fps_den)}`;
}
function createClipWarnings(clip) {
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
  return warnings;
}
function createClipCanvas(clip) {
  const canvas = document.createElement("canvas");
  canvas.className = "kaleidoscope-canvas";
  canvas.width = clip.output_width;
  canvas.height = clip.output_height;
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", `${clip.label}, frame 0`);
  return canvas;
}
function updateClipRow(row, clip, active, aligned, canvases) {
  row.dataset.active = String(active);
  row.querySelector(".kaleidoscope-clip__warnings")?.remove();
  if (active && clip.warnings.length > 0) {
    row.append(createClipWarnings(clip));
  }
  let canvas = canvases.get(clip.id);
  if (active && canvas === void 0) {
    canvas = createClipCanvas(clip);
    canvases.set(clip.id, canvas);
    row.append(canvas);
  } else if (active && canvas !== void 0 && canvas.parentNode !== row) {
    row.append(canvas);
  } else if (!active && canvas !== void 0) {
    canvas.remove();
    canvases.delete(clip.id);
    canvas = void 0;
  }
  if (canvas !== void 0) {
    canvas.hidden = aligned;
    canvas.setAttribute("aria-hidden", String(aligned));
  }
}
function createClipRow(clip, activeClipIds, canvases) {
  const row = document.createElement("li");
  const isActive = activeClipIds.some((clipId) => idsMatch2(clipId, clip.id));
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
    row.append(createClipWarnings(clip));
  }
  if (isActive) {
    const canvas = createClipCanvas(clip);
    row.append(canvas);
    canvases.set(clip.id, canvas);
  }
  return row;
}
function renderMetadata(root, message, navigation, signal) {
  const canvases = /* @__PURE__ */ new Map();
  const rows = /* @__PURE__ */ new Map();
  root.setAttribute("role", "region");
  root.setAttribute("aria-label", "Kaleidoscope video preview");
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
  const fullscreen = document.createElement("button");
  fullscreen.type = "button";
  fullscreen.className = "kaleidoscope-control-button";
  const fullscreenSupported = typeof root.requestFullscreen === "function" && typeof document.exitFullscreen === "function";
  fullscreen.disabled = !fullscreenSupported;
  let reportFullscreenError = () => {
  };
  const updateFullscreen = () => {
    const active = document.fullscreenElement === root;
    const label = active ? "Exit fullscreen" : "Enter fullscreen";
    fullscreen.setAttribute("aria-label", label);
    fullscreen.title = fullscreenSupported ? label : "Fullscreen unavailable";
    fullscreen.textContent = active ? "\u2199" : "\u26F6";
    fullscreen.setAttribute("aria-pressed", String(active));
  };
  const toggleFullscreen = () => {
    if (!fullscreenSupported) {
      return;
    }
    if (document.fullscreenElement === root) {
      void document.exitFullscreen().catch(() => {
        updateFullscreen();
        reportFullscreenError();
      });
    } else {
      void root.requestFullscreen().catch(() => {
        updateFullscreen();
        reportFullscreenError();
      });
    }
  };
  updateFullscreen();
  fullscreen.addEventListener("click", toggleFullscreen, { signal });
  document.addEventListener("fullscreenchange", updateFullscreen, { signal });
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
    duration,
    fullscreen
  );
  root.tabIndex = 0;
  root.addEventListener(
    "keydown",
    (event) => {
      const target = event.target;
      const editingText = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target instanceof HTMLElement && target.isContentEditable;
      if (event.ctrlKey || event.metaKey || event.altKey) {
        return;
      }
      if (event.key.toLowerCase() === "f") {
        if (!editingText) {
          event.preventDefault();
          toggleFullscreen();
        }
        return;
      }
      if (editingText || target instanceof HTMLButtonElement) {
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
  for (const clip of message.clips) {
    const row = createClipRow(clip, message.active_clip_ids, canvases);
    rows.set(clip.id, row);
    clips.append(row);
  }
  const status = document.createElement("div");
  status.className = "kaleidoscope-status kaleidoscope-status--ready";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.textContent = "Kaleidoscope is ready.";
  reportFullscreenError = () => {
    status.textContent = "Fullscreen is unavailable in this notebook context.";
  };
  const comparison = createComparisonView({
    metadata: message,
    canvases,
    rows,
    modeLabel: mode,
    clips,
    onChange: navigation?.changeComparison === void 0 ? void 0 : (transition) => navigation.changeComparison?.(transition),
    updateClipRow,
    signal
  });
  root.replaceChildren(
    header,
    timeline,
    comparison.toolbar,
    controls,
    comparison.view,
    clips,
    status
  );
  return {
    metadata: message,
    canvases,
    compose: comparison.compose,
    getFrame: () => currentFrame,
    prepareComparisonCommit: comparison.prepareCommit,
    setComparison: comparison.setState,
    setFrame: updateFrame,
    setPlaying: updatePlaying
  };
}
async function decodeFrames(message, buffers, signal) {
  const decodedFrames = /* @__PURE__ */ new Set();
  const closeFrame = (frame) => {
    if (!frame.closed) {
      frame.closed = true;
      frame.bitmap.close();
    }
  };
  const closeDecoded = () => {
    for (const frame of decodedFrames) {
      closeFrame(frame);
    }
  };
  signal?.addEventListener("abort", closeDecoded, { once: true });
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
      const frame = {
        manifest,
        bitmap: await createImageBitmap(blob),
        closed: false
      };
      decodedFrames.add(frame);
      if (signal?.aborted) {
        closeFrame(frame);
      }
      return frame;
    })
  );
  signal?.removeEventListener("abort", closeDecoded);
  const decoded = results.flatMap(
    (result) => result.status === "fulfilled" ? [result.value] : []
  );
  const rejected = results.find(
    (result) => result.status === "rejected"
  );
  if (rejected !== void 0) {
    for (const frame of decoded) {
      closeFrame(frame);
    }
    throw rejected.reason;
  }
  return decoded;
}
async function paintFrameSet(view, message, buffers, shouldCommit, signal) {
  const decoded = await decodeFrames(message, buffers, signal);
  try {
    if (!shouldCommit()) {
      return false;
    }
    const targets = decoded.map((frame) => {
      const currentCanvas = view.canvases.get(frame.manifest.clip_id);
      const parent = currentCanvas?.parentNode;
      const clip = view.metadata.clips.find(
        (candidate) => idsMatch2(candidate.id, frame.manifest.clip_id)
      );
      if (clip === void 0 || currentCanvas !== void 0 && (parent === null || parent === void 0 || currentCanvas.getContext("2d") === null)) {
        throw new Error("The active preview canvas is unavailable.");
      }
      const stagedCanvas = currentCanvas?.cloneNode(false);
      const candidateCanvas = stagedCanvas ?? createClipCanvas(clip);
      const context = candidateCanvas.getContext("2d");
      if (context === null) {
        throw new Error("The active preview canvas is unavailable.");
      }
      return {
        decoded: frame,
        currentCanvas,
        stagedCanvas: candidateCanvas,
        context,
        parent: parent ?? void 0
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
        describeFrame(
          view.metadata.clips.find(
            (clip) => idsMatch2(clip.id, frame.manifest.clip_id)
          )?.label ?? "Clip",
          message.frame,
          view.metadata
        )
      );
    }
    if (!shouldCommit()) {
      return false;
    }
    const candidateCanvases = new Map(view.canvases);
    for (const target of targets) {
      candidateCanvases.set(
        target.decoded.manifest.clip_id,
        target.stagedCanvas
      );
    }
    const commitComparison = view.prepareComparisonCommit(
      candidateCanvases,
      message.frame
    );
    if (!shouldCommit()) {
      return false;
    }
    const committed = [];
    try {
      for (const target of targets) {
        if (target.parent !== void 0 && target.currentCanvas !== void 0) {
          target.parent.replaceChild(
            target.stagedCanvas,
            target.currentCanvas
          );
        }
        committed.push(target);
      }
      for (const target of targets) {
        view.canvases.set(
          target.decoded.manifest.clip_id,
          target.stagedCanvas
        );
      }
      commitComparison();
    } catch (error) {
      for (const target of committed.reverse()) {
        if (target.parent !== void 0 && target.currentCanvas !== void 0 && target.stagedCanvas.parentNode === target.parent) {
          target.parent.replaceChild(
            target.currentCanvas,
            target.stagedCanvas
          );
        }
        if (target.currentCanvas === void 0) {
          view.canvases.delete(target.decoded.manifest.clip_id);
        } else {
          view.canvases.set(
            target.decoded.manifest.clip_id,
            target.currentCanvas
          );
        }
      }
      throw error;
    }
    return true;
  } finally {
    for (const frame of decoded) {
      if (!frame.closed) {
        frame.closed = true;
        frame.bitmap.close();
      }
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
var FrameRequestSequence = class {
  nextRequestId = 0;
  nextGeneration = 0;
  takeRequestId() {
    const requestId = this.nextRequestId;
    this.nextRequestId += 1;
    return requestId;
  }
  advanceGeneration() {
    const generation = this.nextGeneration;
    this.nextGeneration += 1;
    return generation;
  }
  get generation() {
    return Math.max(0, this.nextGeneration - 1);
  }
  get pendingRequestId() {
    return this.nextRequestId;
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
  sequence;
  schedule;
  cancel;
  scheduledHandle;
  scheduledToken = 0;
  pendingFrame = 0;
  closed = false;
  constructor(options) {
    this.sessionId = options.sessionId;
    this.numFrames = options.numFrames;
    this.clipIds = [...options.clipIds];
    this.send = options.send;
    this.sequence = options.sequence ?? new FrameRequestSequence();
    this.schedule = options.schedule ?? scheduleFrame;
    this.cancel = options.cancel ?? cancelFrame;
  }
  get generation() {
    return this.sequence.generation;
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
      request_id: this.sequence.pendingRequestId,
      generation,
      frame: this.clamp(frame)
    };
    if (this.closed) {
      return identity;
    }
    this.sequence.takeRequestId();
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
    const generation = this.sequence.advanceGeneration();
    return this.sendRequest(frame, generation, "seek");
  }
  requestPlayback(frame, restart = false) {
    this.cancelScheduledScrub();
    const generation = restart ? this.sequence.advanceGeneration() : this.sequence.generation;
    return this.sendRequest(frame, generation, "playback");
  }
  requestView(frame, clipIds, announce) {
    this.cancelScheduledScrub();
    const generation = this.sequence.advanceGeneration();
    this.clipIds = [...clipIds];
    announce(generation);
    return this.sendRequest(frame, generation, "seek");
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
var MAX_ACTIVE_DECODE_SETS = 2;
var modelCoordinators = /* @__PURE__ */ new WeakMap();
function coordinatorFor(model, sessionId) {
  let managerCoordinators = modelCoordinators.get(model.widget_manager);
  if (managerCoordinators === void 0) {
    managerCoordinators = /* @__PURE__ */ new Map();
    modelCoordinators.set(model.widget_manager, managerCoordinators);
  }
  const existing = managerCoordinators.get(sessionId);
  if (existing !== void 0) {
    return existing;
  }
  const modelFrame = model.get("current_frame");
  const coordinator = {
    active: void 0,
    currentFrame: typeof modelFrame === "number" && Number.isSafeInteger(modelFrame) ? Math.max(0, modelFrame) : 0,
    sequence: new FrameRequestSequence(),
    views: /* @__PURE__ */ new Set()
  };
  managerCoordinators.set(sessionId, coordinator);
  return coordinator;
}
function deleteCoordinator(model, sessionId) {
  const managerCoordinators = modelCoordinators.get(model.widget_manager);
  managerCoordinators?.delete(sessionId);
  if (managerCoordinators?.size === 0) {
    modelCoordinators.delete(model.widget_manager);
  }
}
function isCommLive(model) {
  const commLive = model.comm_live;
  return commLive !== void 0 ? commLive !== false : model.get("comm_live") !== false;
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
  const coordinator = coordinatorFor(model, sessionId);
  let metadata;
  let comparisonState;
  let playerView;
  let seekScheduler;
  let playbackController;
  let currentRequest;
  let unacknowledgedDelivery;
  let lastAcknowledgedRequestId = -1;
  let activeDecodeSets = 0;
  let deferredDecodeRetry;
  let resumeAfterPaint;
  let resumeAfterScrub = false;
  let autoplayPending = false;
  let resumeAfterVisibility = false;
  let comparisonFramePending = false;
  let comparisonFrameRequired = false;
  let disconnected = false;
  let terminal = false;
  let terminalStatus = "Preview session is no longer available.";
  let closeSent = false;
  const interactionBlocked = () => disconnected || terminal;
  const blockedStatus = () => disconnected ? "Kernel disconnected. Preview paused." : terminalStatus;
  const requestsMatch = (left, right) => left !== void 0 && right !== void 0 && left.request_id === right.request_id && left.generation === right.generation && left.frame === right.frame;
  const updateStatus = (text) => {
    const liveStatus = el.querySelector("[role='status']");
    if (liveStatus !== null) {
      liveStatus.textContent = text;
    }
  };
  const sendClose = () => {
    if (closeSent || !isCommLive(model)) {
      return;
    }
    closeSent = true;
    model.send(createCloseMessage(sessionId));
  };
  const setCurrentRequest = (request) => {
    if (unacknowledgedDelivery !== void 0 && (request === void 0 || request.request_id !== unacknowledgedDelivery.requestId || request.generation !== unacknowledgedDelivery.generation)) {
      unacknowledgedDelivery.acknowledgeStale();
    }
    if (deferredDecodeRetry !== void 0 && !requestsMatch(request, deferredDecodeRetry.expected)) {
      deferredDecodeRetry = void 0;
    }
    currentRequest = request;
  };
  const retryDeferredDecode = () => {
    const deferred = deferredDecodeRetry;
    if (deferred === void 0 || activeDecodeSets >= MAX_ACTIVE_DECODE_SETS || !requestsMatch(currentRequest, deferred.expected) || seekScheduler === void 0 || signal.aborted) {
      return;
    }
    deferredDecodeRetry = void 0;
    const request = seekScheduler.requestExact(deferred.expected.frame);
    if (deferred.resume) {
      resumeAfterPaint = request;
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
    if (interactionBlocked()) {
      updateStatus(blockedStatus());
      return;
    }
    autoplayPending = false;
    resumeAfterPaint = void 0;
    resumeAfterScrub = false;
    resumeAfterVisibility = false;
    playbackController?.toggle();
  };
  const enterTerminal = (text, closeBackend) => {
    terminal = true;
    terminalStatus = text;
    autoplayPending = false;
    deferredDecodeRetry = void 0;
    resumeAfterPaint = void 0;
    resumeAfterScrub = false;
    resumeAfterVisibility = false;
    comparisonFramePending = false;
    comparisonFrameRequired = false;
    setCurrentRequest(void 0);
    playbackController?.pause(false);
    playbackController?.close();
    seekScheduler?.close();
    if (closeBackend) {
      sendClose();
    }
    updateStatus(text);
  };
  const handleMessage = async (value, buffers) => {
    try {
      const message = parseBackendMessage(value);
      if (message.session_id !== sessionId) {
        throw new ProtocolError("invalid_message", "Backend message has an unknown session.");
      }
      if (message.type === "frame_set" && (metadata === void 0 || playerView === void 0)) {
        lastAcknowledgedRequestId = Math.max(
          lastAcknowledgedRequestId,
          message.request_id
        );
        model.send(
          createFrameSetAck(
            sessionId,
            message.request_id,
            message.generation,
            "stale"
          )
        );
        return;
      }
      if (message.type === "metadata") {
        if ("clips" in message) {
          metadata = message;
          comparisonState = createComparisonState(message);
          seekScheduler = new PausedSeekScheduler({
            sessionId,
            numFrames: message.num_frames,
            clipIds: message.active_clip_ids,
            sequence: coordinator.sequence,
            send: (request) => {
              setCurrentRequest(request);
              if (comparisonFrameRequired) {
                comparisonFramePending = true;
              }
              model.send(request);
            }
          });
          playerView = renderMetadata(
            el,
            message,
            {
              requestExact: (frame) => {
                if (interactionBlocked()) {
                  updateStatus(blockedStatus());
                  return playerView?.getFrame() ?? 0;
                }
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
                if (interactionBlocked()) {
                  updateStatus(blockedStatus());
                  return playerView?.getFrame() ?? 0;
                }
                if (playbackController?.playing || resumeAfterPaint !== void 0 || resumeAfterScrub) {
                  resumeAfterScrub = true;
                }
                resumeAfterPaint = void 0;
                playbackController?.pause(false);
                setCurrentRequest(void 0);
                return seekScheduler?.scheduleScrub(frame) ?? 0;
              },
              changeComparison: (transition) => {
                if (interactionBlocked()) {
                  updateStatus(blockedStatus());
                  return;
                }
                if (metadata === void 0 || comparisonState === void 0 || seekScheduler === void 0) {
                  return;
                }
                const previous = comparisonState;
                let next;
                try {
                  next = transitionComparisonState(
                    previous,
                    metadata,
                    transition
                  );
                } catch (error) {
                  updateStatus(
                    error instanceof Error ? error.message : "Invalid comparison selection."
                  );
                  playerView?.setComparison(previous);
                  return;
                }
                comparisonState = next.state;
                metadata = {
                  ...metadata,
                  mode: next.state.mode,
                  active_clip_ids: [...next.state.activeClipIds]
                };
                const deferComposition = next.requiresFrameSet || comparisonFrameRequired;
                playerView?.setComparison(next.state, deferComposition);
                const needsFrameSet = next.requiresFrameSet || comparisonFrameRequired && !comparisonFramePending;
                const durableViewChanged = previous.mode !== next.state.mode || previous.overlayOpacity !== next.state.overlayOpacity || needsFrameSet;
                if (!durableViewChanged) {
                  return;
                }
                if (!needsFrameSet) {
                  model.send(
                    createSetViewMessage(
                      sessionId,
                      seekScheduler.generation,
                      next.state.mode,
                      next.state.activeClipIds,
                      next.state.overlayOpacity
                    )
                  );
                  return;
                }
                const shouldResume = playbackController?.playing === true || resumeAfterPaint !== void 0 || resumeAfterScrub || deferredDecodeRetry?.resume === true;
                const frame = playbackController?.playing === true ? playbackController.pause(false) : playerView?.getFrame() ?? 0;
                setCurrentRequest(void 0);
                resumeAfterPaint = void 0;
                resumeAfterScrub = false;
                const request = seekScheduler.requestView(
                  frame,
                  next.state.activeClipIds,
                  (generation) => model.send(
                    createSetViewMessage(
                      sessionId,
                      generation,
                      next.state.mode,
                      next.state.activeClipIds,
                      next.state.overlayOpacity
                    )
                  )
                );
                comparisonFrameRequired = true;
                comparisonFramePending = true;
                if (shouldResume) {
                  resumeAfterPaint = request;
                }
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
          seekScheduler.requestExact(
            Math.min(message.num_frames - 1, coordinator.currentFrame)
          );
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
        if (message.request_id <= lastAcknowledgedRequestId) {
          return;
        }
        if (unacknowledgedDelivery !== void 0) {
          if (unacknowledgedDelivery.requestId === message.request_id && unacknowledgedDelivery.generation === message.generation) {
            return;
          }
          throw new ProtocolError(
            "invalid_message",
            "A frame payload arrived before the previous delivery was acknowledged."
          );
        }
        const expected = currentRequest;
        const expectedClipIds = comparisonState?.activeClipIds ?? metadata.active_clip_ids;
        const manifestClipIds = message.frames.map((frame) => frame.clip_id);
        const isCurrent = () => !signal.aborted && expected !== void 0 && requestsMatch(currentRequest, expected) && message.request_id === expected.request_id && message.generation === expected.generation && message.frame === expected.frame && manifestClipIds.length === expectedClipIds.length && manifestClipIds.every(
          (clipId, index) => clipId === expectedClipIds[index]
        );
        const acknowledge = (outcome) => {
          if (acknowledged) {
            return;
          }
          acknowledged = true;
          lastAcknowledgedRequestId = Math.max(
            lastAcknowledgedRequestId,
            message.request_id
          );
          if (outcome !== "painted") {
            deliveryController.abort();
          }
          if (unacknowledgedDelivery?.requestId === message.request_id && unacknowledgedDelivery.generation === message.generation) {
            unacknowledgedDelivery = void 0;
          }
          model.send(
            createFrameSetAck(
              sessionId,
              message.request_id,
              message.generation,
              outcome
            )
          );
        };
        let acknowledged = false;
        const deliveryController = new AbortController();
        unacknowledgedDelivery = {
          requestId: message.request_id,
          generation: message.generation,
          acknowledgeStale: () => acknowledge("stale")
        };
        if (!isCurrent()) {
          acknowledge("stale");
          return;
        }
        if (activeDecodeSets >= MAX_ACTIVE_DECODE_SETS) {
          const resume = resumeAfterPaint !== void 0 && resumeAfterPaint.request_id === message.request_id && resumeAfterPaint.generation === message.generation;
          if (resume) {
            resumeAfterPaint = void 0;
          }
          deferredDecodeRetry = {
            expected: {
              request_id: message.request_id,
              generation: message.generation,
              frame: message.frame
            },
            resume
          };
          comparisonFramePending = false;
          acknowledge("stale");
          return;
        }
        activeDecodeSets += 1;
        let painted;
        try {
          validateFrameSetBuffers(message, buffers);
          painted = await paintFrameSet(
            playerView,
            message,
            buffers,
            isCurrent,
            deliveryController.signal
          );
        } catch (error) {
          if (!isCurrent()) {
            acknowledge("stale");
            return;
          }
          acknowledge("decode_error");
          comparisonFramePending = false;
          resumeAfterPaint = void 0;
          setCurrentRequest(void 0);
          playbackController?.pause(false);
          updateStatus(
            error instanceof Error ? `Frame decode error: ${error.message}` : "Frame decode error."
          );
          return;
        } finally {
          activeDecodeSets -= 1;
          retryDeferredDecode();
        }
        if (painted) {
          comparisonFramePending = false;
          comparisonFrameRequired = false;
          coordinator.currentFrame = message.frame;
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
      if (message.request_id !== void 0) {
        comparisonFramePending = false;
        resumeAfterPaint = void 0;
        setCurrentRequest(void 0);
        playbackController?.pause(false);
      }
      const clip = metadata?.clips.find(
        (candidate) => candidate.id === message.clip_id
      );
      const errorStatus = clip === void 0 ? `Protocol error: ${message.message}` : `${clip.label}: ${message.message}`;
      if (!message.recoverable) {
        enterTerminal(errorStatus, false);
        return;
      }
      updateStatus(errorStatus);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid backend message.";
      enterTerminal(`Protocol error: ${message}`, true);
    }
  };
  const onMessage = (value, buffers) => {
    void handleMessage(value, buffers);
  };
  const onCommLiveUpdate = () => {
    if (isCommLive(model)) {
      return;
    }
    disconnected = true;
    autoplayPending = false;
    deferredDecodeRetry = void 0;
    resumeAfterPaint = void 0;
    resumeAfterScrub = false;
    resumeAfterVisibility = false;
    setCurrentRequest(void 0);
    playbackController?.pause(false);
    updateStatus("Kernel disconnected. Preview paused.");
  };
  const onVisibilityChange = () => {
    if (document.visibilityState === "hidden") {
      if (playbackController?.playing) {
        const pausedFrame = playbackController.pause(false);
        resumeAfterVisibility = metadata !== void 0 && pausedFrame < metadata.num_frames - 1;
        setCurrentRequest(void 0);
      }
    } else if (resumeAfterVisibility) {
      playWhenVisible();
    }
  };
  let active = false;
  const coordinatedView = {
    activate: () => {
      if (active || signal.aborted) {
        return;
      }
      active = true;
      updateStatus("Initializing Kaleidoscope...");
      model.on("msg:custom", onMessage);
      model.on("change:comm_live", onCommLiveUpdate);
      model.on("comm_live_update", onCommLiveUpdate);
      document.addEventListener("visibilitychange", onVisibilityChange, {
        signal
      });
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
        if (!active || signal.aborted) {
          return;
        }
        model.send(
          createReadyMessage(sessionId, {
            image_bitmap: true,
            webp
          })
        );
      });
    },
    deactivate: () => {
      if (!active) {
        return;
      }
      active = false;
      deferredDecodeRetry = void 0;
      setCurrentRequest(void 0);
      playbackController?.pause(false);
      playbackController?.close();
      seekScheduler?.close();
      model.off("msg:custom", onMessage);
      model.off("change:comm_live", onCommLiveUpdate);
      model.off("comm_live_update", onCommLiveUpdate);
    }
  };
  coordinator.views.add(coordinatedView);
  if (coordinator.active === void 0) {
    coordinator.active = coordinatedView;
    coordinatedView.activate();
  } else {
    updateStatus("Preview is active in another view.");
  }
  signal.addEventListener(
    "abort",
    () => {
      const wasActive = coordinator.active === coordinatedView;
      coordinatedView.deactivate();
      coordinator.views.delete(coordinatedView);
      if (wasActive) {
        coordinator.active = void 0;
        const next = coordinator.views.values().next().value;
        if (next !== void 0) {
          coordinator.active = next;
          next.activate();
        }
      }
      if (coordinator.views.size === 0) {
        deleteCoordinator(model, sessionId);
        sendClose();
      }
    },
    { once: true }
  );
}
var index_default = { render };
export {
  index_default as default,
  render
};
