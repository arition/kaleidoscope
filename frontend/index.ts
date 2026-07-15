import type { RenderProps } from "@anywidget/types";

import {
  createFrameSetAck,
  createSetPlayingMessage,
  createReadyMessage,
  parseBackendMessage,
  ProtocolError,
  validateFrameSetBuffers,
} from "./protocol.js";
import type { FrameSetMessage, PreviewMetadataMessage } from "./protocol.js";
import { paintFrameSet, renderMetadata } from "./player.js";
import type { PlayerView } from "./player.js";
import {
  PausedSeekScheduler,
  PlaybackController,
} from "./scheduler.js";
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
  let seekScheduler: PausedSeekScheduler | undefined;
  let playbackController: PlaybackController | undefined;
  let currentRequest:
    | Pick<FrameSetMessage, "request_id" | "generation" | "frame">
    | undefined;
  let resumeAfterPaint:
    | Pick<FrameSetMessage, "request_id" | "generation" | "frame">
    | undefined;
  let resumeAfterScrub = false;
  let autoplayPending = false;
  let resumeAfterVisibility = false;

  const updateStatus = (text: string): void => {
    const liveStatus = el.querySelector<HTMLElement>("[role='status']");
    if (liveStatus !== null) {
      liveStatus.textContent = text;
    }
  };

  const playWhenVisible = (): void => {
    if (document.visibilityState === "hidden") {
      resumeAfterVisibility = true;
      return;
    }
    resumeAfterVisibility = false;
    playbackController?.play();
  };

  const togglePlaying = (): void => {
    autoplayPending = false;
    resumeAfterPaint = undefined;
    resumeAfterScrub = false;
    resumeAfterVisibility = false;
    playbackController?.toggle();
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
          seekScheduler = new PausedSeekScheduler({
            sessionId,
            numFrames: message.num_frames,
            clipIds: message.active_clip_ids,
            send: (request) => {
              currentRequest = request;
              model.send(request);
            },
          });
          playerView = renderMetadata(
            el,
            message,
            {
              requestExact: (frame) => {
                playbackController?.pause(false);
                const request = seekScheduler?.requestExact(frame);
                if (request === undefined) {
                  return 0;
                }
                if (resumeAfterScrub) {
                  resumeAfterPaint = request;
                  resumeAfterScrub = false;
                } else {
                  resumeAfterPaint = undefined;
                }
                return request.frame;
              },
              scheduleScrub: (frame) => {
                if (
                  playbackController?.playing ||
                  resumeAfterPaint !== undefined ||
                  resumeAfterScrub
                ) {
                  resumeAfterScrub = true;
                }
                resumeAfterPaint = undefined;
                playbackController?.pause(false);
                currentRequest = undefined;
                return seekScheduler?.scheduleScrub(frame) ?? 0;
              },
              togglePlaying,
            },
            signal,
          );
          playbackController = new PlaybackController({
            numFrames: message.num_frames,
            fpsNum: message.fps_num,
            fpsDen: message.fps_den,
            scheduler: seekScheduler,
            onFrame: (frame) => playerView?.setFrame(frame),
            onPlaying: (playing) => playerView?.setPlaying(playing),
            sendPlaying: (playing) =>
              model.send(createSetPlayingMessage(sessionId, playing)),
          });
          autoplayPending = message.autoplay;
          seekScheduler.requestExact(0);
          return;
        }
        status.textContent = "Kaleidoscope is ready.";
        return;
      }
      if (message.type === "frame_set") {
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
        const acknowledge = (
          outcome: "painted" | "stale" | "decode_error",
        ): void => {
          model.send(
            createFrameSetAck(
              sessionId,
              message.request_id,
              message.generation,
              outcome,
            ),
          );
        };
        if (!isCurrent()) {
          acknowledge("stale");
          return;
        }
        let painted: boolean;
        try {
          validateFrameSetBuffers(message, buffers);
          painted = await paintFrameSet(
            playerView,
            message,
            buffers,
            isCurrent,
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
          const shouldResume =
            resumeAfterPaint !== undefined &&
            message.request_id === resumeAfterPaint.request_id &&
            message.generation === resumeAfterPaint.generation &&
            message.frame === resumeAfterPaint.frame;
          if (shouldResume) {
            resumeAfterPaint = undefined;
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
  const onVisibilityChange = (): void => {
    if (document.visibilityState === "hidden") {
      if (playbackController?.playing) {
        const pausedFrame = playbackController.pause(false);
        resumeAfterVisibility =
          metadata !== undefined && pausedFrame < metadata.num_frames - 1;
        currentRequest = undefined;
      }
    } else if (resumeAfterVisibility) {
      playWhenVisible();
    }
  };
  document.addEventListener("visibilitychange", onVisibilityChange, {
    signal,
  });
  signal.addEventListener(
    "abort",
    () => {
      playbackController?.close();
      seekScheduler?.close();
      model.off("msg:custom", onMessage);
    },
    { once: true },
  );

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
