import type { RenderProps } from "@anywidget/types";

import {
  createFrameSetRequest,
  createReadyMessage,
  parseBackendMessage,
  ProtocolError,
  validateFrameSetBuffers,
} from "./protocol.js";
import type { FrameSetMessage, PreviewMetadataMessage } from "./protocol.js";
import { paintFrameSet, renderMetadata } from "./player.js";
import type { PlayerView } from "./player.js";
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

const WEBP_DECODE_PROBE = new Uint8Array([
  82, 73, 70, 70, 28, 0, 0, 0, 87, 69, 66, 80, 86, 80, 56, 76, 15, 0, 0,
  0, 47, 0, 0, 0, 0, 7, 16, 253, 143, 254, 7, 34, 162, 255, 1, 0,
]);

async function supportsWebp(): Promise<boolean> {
  if (typeof globalThis.createImageBitmap !== "function") {
    return false;
  }
  try {
    const bitmap = await globalThis.createImageBitmap(
      new Blob([WEBP_DECODE_PROBE], { type: "image/webp" }),
    );
    bitmap.close();
    return true;
  } catch {
    return false;
  }
}

export function render({ model, el, signal }: KaleidoscopeRenderProps): void {
  const status = createStatus("Initializing Kaleidoscope...");
  el.classList.add("kaleidoscope-widget");
  el.replaceChildren(status);

  const sessionId = model.get("session_id");
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    status.textContent = "Protocol error: missing session identifier.";
    return;
  }

  let metadata: PreviewMetadataMessage | undefined;
  let playerView: PlayerView | undefined;
  let currentRequest:
    | Pick<FrameSetMessage, "request_id" | "generation" | "frame">
    | undefined;

  const updateStatus = (text: string): void => {
    const liveStatus = el.querySelector<HTMLElement>("[role='status']");
    if (liveStatus !== null) {
      liveStatus.textContent = text;
    }
  };

  const handleMessage = async (
    value: unknown,
    buffers: DataView[],
  ): Promise<void> => {
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
              "seek",
            ),
          );
          return;
        }
        status.textContent = "Kaleidoscope is ready.";
        return;
      }
      if (message.type === "frame_set") {
        validateFrameSetBuffers(message, buffers);
        if (metadata === undefined || playerView === undefined) {
          throw new ProtocolError(
            "invalid_message",
            "Frame payload arrived before preview metadata.",
          );
        }
        const expected = currentRequest;
        const expectedClipIds = metadata.active_clip_ids;
        const manifestClipIds = message.frames.map((frame) => frame.clip_id);
        const isCurrent = (): boolean =>
          !signal.aborted &&
          expected !== undefined &&
          currentRequest === expected &&
          message.request_id === expected.request_id &&
          message.generation === expected.generation &&
          message.frame === expected.frame &&
          manifestClipIds.length === expectedClipIds.length &&
          manifestClipIds.every(
            (clipId, index) => clipId === expectedClipIds[index],
          );
        if (!isCurrent()) {
          return;
        }
        const painted = await paintFrameSet(
          playerView,
          message,
          buffers,
          isCurrent,
        );
        if (painted) {
          updateStatus(`Frame ${message.frame} ready.`);
        }
        return;
      }
      if (
        message.request_id !== undefined &&
        (currentRequest === undefined ||
          message.request_id !== currentRequest.request_id ||
          message.generation !== currentRequest.generation)
      ) {
        return;
      }
      const clip = metadata?.clips.find(
        (candidate) => candidate.id === message.clip_id,
      );
      updateStatus(
        clip === undefined
          ? `Protocol error: ${message.message}`
          : `${clip.label}: ${message.message}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid backend message.";
      updateStatus(`Protocol error: ${message}`);
    }
  };

  const onMessage = (value: unknown, buffers: DataView[]): void => {
    void handleMessage(value, buffers);
  };

  model.on("msg:custom", onMessage);
  signal.addEventListener("abort", () => model.off("msg:custom", onMessage), {
    once: true,
  });

  const imageBitmap = typeof globalThis.createImageBitmap === "function";
  if (!imageBitmap) {
    model.send(
      createReadyMessage(sessionId, {
        image_bitmap: false,
        webp: false,
      }),
    );
    return;
  }
  void supportsWebp().then((webp) => {
    if (!signal.aborted) {
      model.send(
        createReadyMessage(sessionId, {
          image_bitmap: true,
          webp,
        }),
      );
    }
  });
}

export default { render };
