import type { RenderProps } from "@anywidget/types";

import {
  createReadyMessage,
  parseBackendMessage,
  ProtocolError,
} from "./protocol.js";
import "./styles.css";

function createStatus(text: string): HTMLElement {
  const status = document.createElement("div");
  status.className = "kaleidoscope-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.textContent = text;
  return status;
}

type KaleidoscopeRenderProps = Pick<RenderProps, "model" | "el" | "signal">;

export function render({ model, el, signal }: KaleidoscopeRenderProps): void {
  const status = createStatus("Initializing Kaleidoscope...");
  el.classList.add("kaleidoscope-widget");
  el.replaceChildren(status);

  const sessionId = model.get("session_id");
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    status.textContent = "Protocol error: missing session identifier.";
    return;
  }

  const onMessage = (value: unknown): void => {
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
    once: true,
  });

  model.send(
    createReadyMessage(sessionId, {
      image_bitmap: typeof globalThis.createImageBitmap === "function",
      webp: false,
    }),
  );
}

export default { render };
