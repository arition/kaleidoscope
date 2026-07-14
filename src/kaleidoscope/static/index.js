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
    return value;
  }
  if (value.type === "error" && typeof value.session_id === "string" && value.session_id.length > 0 && (value.code === "invalid_message" || value.code === "protocol_mismatch") && typeof value.message === "string" && typeof value.recoverable === "boolean") {
    return value;
  }
  throw new ProtocolError("invalid_message", "Malformed backend message.");
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
