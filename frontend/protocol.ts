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

export interface ErrorMessage {
  protocol: typeof PROTOCOL_VERSION;
  type: "error";
  session_id: string;
  code: "invalid_message" | "protocol_mismatch";
  message: string;
  recoverable: boolean;
}

export type BackendMessage = MetadataMessage | ErrorMessage;

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
