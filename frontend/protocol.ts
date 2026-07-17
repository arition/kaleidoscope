export const PROTOCOL_VERSION = 1 as const;

export interface FrontendCapabilities {
  image_bitmap: boolean;
  webp: boolean;
}

export interface ReadyMessage {
  protocol: typeof PROTOCOL_VERSION;
  type: "ready";
  session_id: string;
  capabilities: FrontendCapabilities;
}

export interface CloseMessage {
  protocol: typeof PROTOCOL_VERSION;
  type: "close";
  session_id: string;
}

export type FrameRequestReason = "seek" | "playback" | "prefetch";

export interface RequestFrameSetMessage {
  protocol: typeof PROTOCOL_VERSION;
  type: "request_frame_set";
  session_id: string;
  request_id: number;
  generation: number;
  frame: number;
  clip_ids: ClipId[];
  reason: FrameRequestReason;
}

export type FrameSetAckOutcome = "painted" | "stale" | "decode_error";

export interface AckFrameSetMessage {
  protocol: typeof PROTOCOL_VERSION;
  type: "ack_frame_set";
  session_id: string;
  request_id: number;
  generation: number;
  outcome: FrameSetAckOutcome;
}

export interface SetPlayingMessage {
  protocol: typeof PROTOCOL_VERSION;
  type: "set_playing";
  session_id: string;
  playing: boolean;
}

export interface SetViewMessage {
  protocol: typeof PROTOCOL_VERSION;
  type: "set_view";
  session_id: string;
  generation: number;
  mode: ComparisonMode;
  clip_ids: ClipId[];
  overlay_opacity: number;
}

export interface MetadataMessage {
  protocol: typeof PROTOCOL_VERSION;
  type: "metadata";
  session_id: string;
  status: "initialized";
}

export type ClipId = number | string;

export type ComparisonMode = "single" | "side-by-side" | "wipe" | "overlay" | "difference";

export type ClipWarningCode = "automatic_rgb24_conversion" | "assumed_color_metadata";

export interface ClipWarning {
  code: ClipWarningCode;
  message: string;
}

export interface ClipMetadata {
  id: ClipId;
  label: string;
  source_format: string;
  source_width: number;
  source_height: number;
  output_width: number;
  output_height: number;
  warnings: ClipWarning[];
}

export interface PreviewMetadataMessage extends MetadataMessage {
  num_frames: number;
  fps_num: number;
  fps_den: number;
  mode: ComparisonMode;
  active_clip_ids: ClipId[];
  overlay_opacity: number;
  max_visible_clips: number;
  autoplay: boolean;
  clips: ClipMetadata[];
}

export interface ErrorMessage {
  protocol: typeof PROTOCOL_VERSION;
  type: "error";
  session_id: string;
  code: BackendErrorCode;
  message: string;
  recoverable: boolean;
  request_id?: number;
  generation?: number;
  clip_id?: ClipId;
}

export type BackendErrorCode =
  | "invalid_message"
  | "protocol_mismatch"
  | "unsupported_codec"
  | "invalid_clip"
  | "unsupported_dimensions"
  | "render_failed"
  | "conversion_failed"
  | "encode_failed"
  | "decode_failed"
  | "kernel_disconnected"
  | "session_closed";

export interface FrameManifest {
  clip_id: ClipId;
  buffer_index: number;
  mime: "image/jpeg" | "image/webp";
  byte_length: number;
  render_ms: number;
  encode_ms: number;
}

export interface FrameSetMessage {
  protocol: typeof PROTOCOL_VERSION;
  type: "frame_set";
  session_id: string;
  request_id: number;
  generation: number;
  frame: number;
  frames: FrameManifest[];
}

export type BackendMessage =
  | MetadataMessage
  | PreviewMetadataMessage
  | FrameSetMessage
  | ErrorMessage;

export const MAX_FRAME_BUFFER_BYTES = 16 * 1024 * 1024;
export const MAX_FRAME_SET_BYTES = 64 * 1024 * 1024;

export class ProtocolError extends Error {
  constructor(
    readonly code: "invalid_message" | "protocol_mismatch",
    message: string,
  ) {
    super(message);
    this.name = "ProtocolError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

function isNonnegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function isNonnegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isClipId(value: unknown): value is ClipId {
  return (
    (Number.isSafeInteger(value) && typeof value === "number") ||
    (typeof value === "string" && value.length > 0)
  );
}

function isComparisonMode(value: unknown): value is ComparisonMode {
  return (
    value === "single" ||
    value === "side-by-side" ||
    value === "wipe" ||
    value === "overlay" ||
    value === "difference"
  );
}

function isBackendErrorCode(value: unknown): value is BackendErrorCode {
  return (
    value === "invalid_message" ||
    value === "protocol_mismatch" ||
    value === "unsupported_codec" ||
    value === "invalid_clip" ||
    value === "unsupported_dimensions" ||
    value === "render_failed" ||
    value === "conversion_failed" ||
    value === "encode_failed" ||
    value === "decode_failed" ||
    value === "kernel_disconnected" ||
    value === "session_closed"
  );
}

function isRuntimeClipErrorCode(
  value: BackendErrorCode,
): value is "render_failed" | "conversion_failed" | "encode_failed" {
  return value === "render_failed" || value === "conversion_failed" || value === "encode_failed";
}

function isClipWarning(value: unknown): value is ClipWarning {
  return (
    isRecord(value) &&
    (value.code === "automatic_rgb24_conversion" || value.code === "assumed_color_metadata") &&
    typeof value.message === "string" &&
    value.message.length > 0
  );
}

function isClipMetadata(value: unknown): value is ClipMetadata {
  return (
    isRecord(value) &&
    isClipId(value.id) &&
    typeof value.label === "string" &&
    value.label.length > 0 &&
    typeof value.source_format === "string" &&
    value.source_format.length > 0 &&
    isPositiveInteger(value.source_width) &&
    isPositiveInteger(value.source_height) &&
    isPositiveInteger(value.output_width) &&
    isPositiveInteger(value.output_height) &&
    value.output_width === value.source_width &&
    value.output_height === value.source_height &&
    Array.isArray(value.warnings) &&
    value.warnings.every(isClipWarning)
  );
}

function isFrameManifest(value: unknown): value is FrameManifest {
  return (
    isRecord(value) &&
    isClipId(value.clip_id) &&
    isNonnegativeInteger(value.buffer_index) &&
    (value.mime === "image/jpeg" || value.mime === "image/webp") &&
    isPositiveInteger(value.byte_length) &&
    value.byte_length <= MAX_FRAME_BUFFER_BYTES &&
    isNonnegativeFiniteNumber(value.render_ms) &&
    isNonnegativeFiniteNumber(value.encode_ms)
  );
}

function isFrameSetMessage(
  value: Record<string, unknown>,
): value is Record<string, unknown> & FrameSetMessage {
  const frames = value.frames;
  if (
    typeof value.session_id !== "string" ||
    value.session_id.length === 0 ||
    !isNonnegativeInteger(value.request_id) ||
    !isNonnegativeInteger(value.generation) ||
    !isNonnegativeInteger(value.frame) ||
    !Array.isArray(frames) ||
    !frames.length ||
    frames.length > 4 ||
    !frames.every(isFrameManifest)
  ) {
    return false;
  }

  const bufferIndices = frames.map((frame) => frame.buffer_index);
  const clipIds = frames.map((frame) => frame.clip_id);
  const totalBytes = frames.reduce((total, frame) => total + frame.byte_length, 0);
  return (
    new Set(bufferIndices).size === bufferIndices.length &&
    bufferIndices.every((bufferIndex, index) => bufferIndex === index) &&
    new Set(clipIds).size === clipIds.length &&
    totalBytes <= MAX_FRAME_SET_BYTES
  );
}

function hasPreviewMetadataFields(value: Record<string, unknown>): boolean {
  return [
    "num_frames",
    "fps_num",
    "fps_den",
    "mode",
    "active_clip_ids",
    "overlay_opacity",
    "max_visible_clips",
    "autoplay",
    "clips",
  ].some((key) => key in value);
}

function isPreviewMetadataMessage(
  value: Record<string, unknown>,
): value is Record<string, unknown> & PreviewMetadataMessage {
  if (
    !isPositiveInteger(value.num_frames) ||
    !isPositiveInteger(value.fps_num) ||
    !isPositiveInteger(value.fps_den) ||
    !isComparisonMode(value.mode) ||
    !isPositiveInteger(value.max_visible_clips) ||
    value.max_visible_clips > 4 ||
    typeof value.autoplay !== "boolean" ||
    !Array.isArray(value.active_clip_ids) ||
    value.active_clip_ids.length === 0 ||
    !value.active_clip_ids.every(isClipId) ||
    !isNonnegativeFiniteNumber(value.overlay_opacity) ||
    value.overlay_opacity > 1 ||
    !Array.isArray(value.clips) ||
    value.clips.length === 0 ||
    !value.clips.every(isClipMetadata)
  ) {
    return false;
  }

  const clips = value.clips as ClipMetadata[];
  const clipIds = clips.map((clip) => clip.id);
  const activeIds = value.active_clip_ids;
  const activeClips = activeIds.map((activeId) => clips.find((clip) => clip.id === activeId));
  const validCardinality =
    (value.mode === "single" && activeIds.length === 1) ||
    (value.mode === "side-by-side" && activeIds.length >= 1) ||
    ((value.mode === "wipe" || value.mode === "overlay" || value.mode === "difference") &&
      activeIds.length === 2);
  const validAlignedGeometry =
    value.mode === "single" ||
    value.mode === "side-by-side" ||
    (activeClips.length === 2 &&
      activeClips[0] !== undefined &&
      activeClips[1] !== undefined &&
      activeClips[0].source_width === activeClips[1].source_width &&
      activeClips[0].source_height === activeClips[1].source_height);
  return (
    new Set(clipIds).size === clipIds.length &&
    new Set(activeIds).size === activeIds.length &&
    activeIds.length <= value.max_visible_clips &&
    activeIds.every((activeId) => clipIds.some((clipId) => clipId === activeId)) &&
    validCardinality &&
    validAlignedGeometry
  );
}

export function createReadyMessage(
  sessionId: string,
  capabilities: FrontendCapabilities,
): ReadyMessage {
  return {
    protocol: PROTOCOL_VERSION,
    type: "ready",
    session_id: sessionId,
    capabilities,
  };
}

export function createCloseMessage(sessionId: string): CloseMessage {
  return {
    protocol: PROTOCOL_VERSION,
    type: "close",
    session_id: sessionId,
  };
}

export function createFrameSetRequest(
  sessionId: string,
  requestId: number,
  generation: number,
  frame: number,
  clipIds: ClipId[],
  reason: FrameRequestReason,
): RequestFrameSetMessage {
  return {
    protocol: PROTOCOL_VERSION,
    type: "request_frame_set",
    session_id: sessionId,
    request_id: requestId,
    generation,
    frame,
    clip_ids: [...clipIds],
    reason,
  };
}

export function createFrameSetAck(
  sessionId: string,
  requestId: number,
  generation: number,
  outcome: FrameSetAckOutcome,
): AckFrameSetMessage {
  return {
    protocol: PROTOCOL_VERSION,
    type: "ack_frame_set",
    session_id: sessionId,
    request_id: requestId,
    generation,
    outcome,
  };
}

export function createSetViewMessage(
  sessionId: string,
  generation: number,
  mode: ComparisonMode,
  clipIds: ClipId[],
  overlayOpacity: number,
): SetViewMessage {
  return {
    protocol: PROTOCOL_VERSION,
    type: "set_view",
    session_id: sessionId,
    generation,
    mode,
    clip_ids: [...clipIds],
    overlay_opacity: overlayOpacity,
  };
}

export function createSetPlayingMessage(sessionId: string, playing: boolean): SetPlayingMessage {
  return {
    protocol: PROTOCOL_VERSION,
    type: "set_playing",
    session_id: sessionId,
    playing,
  };
}

export function validateFrameSetBuffers(message: FrameSetMessage, buffers: DataView[]): void {
  if (buffers.length !== message.frames.length) {
    throw new ProtocolError("invalid_message", "Frame payload count does not match its manifest.");
  }
  for (const frame of message.frames) {
    const buffer = buffers[frame.buffer_index];
    if (buffer === undefined || buffer.byteLength !== frame.byte_length) {
      throw new ProtocolError(
        "invalid_message",
        "Frame payload length does not match its manifest.",
      );
    }
  }
}

export function parseBackendMessage(value: unknown): BackendMessage {
  if (!isRecord(value)) {
    throw new ProtocolError("invalid_message", "Backend message must be an object.");
  }

  const protocol = value.protocol;
  if (protocol !== PROTOCOL_VERSION) {
    if (typeof protocol === "number") {
      throw new ProtocolError(
        "protocol_mismatch",
        `Unsupported protocol version ${protocol}; expected ${PROTOCOL_VERSION}.`,
      );
    }
    throw new ProtocolError("invalid_message", "Backend message is missing protocol version 1.");
  }

  if (
    value.type === "metadata" &&
    typeof value.session_id === "string" &&
    value.session_id.length > 0 &&
    value.status === "initialized"
  ) {
    if (hasPreviewMetadataFields(value)) {
      if (!isPreviewMetadataMessage(value)) {
        throw new ProtocolError("invalid_message", "Malformed preview metadata.");
      }
      return value;
    }
    return value as unknown as MetadataMessage;
  }

  if (value.type === "frame_set" && isFrameSetMessage(value)) {
    return value;
  }

  if (
    value.type === "error" &&
    typeof value.session_id === "string" &&
    value.session_id.length > 0 &&
    isBackendErrorCode(value.code) &&
    typeof value.message === "string" &&
    typeof value.recoverable === "boolean"
  ) {
    const hasRequestContext = "request_id" in value || "generation" in value || "clip_id" in value;
    if (
      hasRequestContext &&
      (!isNonnegativeInteger(value.request_id) ||
        !isNonnegativeInteger(value.generation) ||
        !isClipId(value.clip_id))
    ) {
      throw new ProtocolError("invalid_message", "Malformed backend error context.");
    }
    const runtimeClipError = isRuntimeClipErrorCode(value.code);
    if (
      (runtimeClipError && (!value.recoverable || !hasRequestContext)) ||
      (!runtimeClipError && (value.recoverable || hasRequestContext))
    ) {
      throw new ProtocolError(
        "invalid_message",
        "Backend error semantics do not match the error code.",
      );
    }
    return value as unknown as ErrorMessage;
  }

  throw new ProtocolError("invalid_message", "Malformed backend message.");
}
