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

export interface MetadataMessage {
  protocol: typeof PROTOCOL_VERSION;
  type: "metadata";
  session_id: string;
  status: "initialized";
}

export type ClipId = number | string;

export type ComparisonMode =
  | "single"
  | "side-by-side"
  | "wipe"
  | "overlay"
  | "difference";

export interface ClipMetadata {
  id: ClipId;
  label: string;
  source_format: string;
  source_width: number;
  source_height: number;
  output_width: number;
  output_height: number;
  warnings: unknown[];
}

export interface PreviewMetadataMessage extends MetadataMessage {
  num_frames: number;
  fps_num: number;
  fps_den: number;
  mode: ComparisonMode;
  active_clip_ids: ClipId[];
  max_visible_clips: number;
  clips: ClipMetadata[];
}

export interface ErrorMessage {
  protocol: typeof PROTOCOL_VERSION;
  type: "error";
  session_id: string;
  code: "invalid_message" | "protocol_mismatch";
  message: string;
  recoverable: boolean;
}

export type BackendMessage =
  | MetadataMessage
  | PreviewMetadataMessage
  | ErrorMessage;

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

function isClipId(value: unknown): value is ClipId {
  return (
    (Number.isInteger(value) && typeof value === "number") ||
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
    Array.isArray(value.warnings)
  );
}

function hasPreviewMetadataFields(value: Record<string, unknown>): boolean {
  return [
    "num_frames",
    "fps_num",
    "fps_den",
    "mode",
    "active_clip_ids",
    "max_visible_clips",
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
    !Array.isArray(value.active_clip_ids) ||
    value.active_clip_ids.length === 0 ||
    !value.active_clip_ids.every(isClipId) ||
    !Array.isArray(value.clips) ||
    value.clips.length === 0 ||
    !value.clips.every(isClipMetadata)
  ) {
    return false;
  }

  const clipIds = value.clips.map((clip) => clip.id);
  const activeIds = value.active_clip_ids;
  return (
    new Set(clipIds).size === clipIds.length &&
    new Set(activeIds).size === activeIds.length &&
    activeIds.length <= value.max_visible_clips &&
    activeIds.every((activeId) => clipIds.some((clipId) => clipId === activeId))
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

  if (
    value.type === "error" &&
    typeof value.session_id === "string" &&
    value.session_id.length > 0 &&
    (value.code === "invalid_message" || value.code === "protocol_mismatch") &&
    typeof value.message === "string" &&
    typeof value.recoverable === "boolean"
  ) {
    return value as unknown as ErrorMessage;
  }

  throw new ProtocolError("invalid_message", "Malformed backend message.");
}
