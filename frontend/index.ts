import type { RenderProps } from "@anywidget/types";

import {
  createCloseMessage,
  createFrameSetAck,
  createReadyMessage,
  createSetPlayingMessage,
  createSetViewMessage,
  parseBackendMessage,
  ProtocolError,
  validateFrameSetBuffers,
} from "./protocol.js";
import type { FrameSetMessage, PreviewMetadataMessage } from "./protocol.js";
import {
  createComparisonState,
  transitionComparisonState,
} from "./comparison.js";
import type { ComparisonState } from "./comparison.js";
import { paintFrameSet, renderMetadata } from "./player.js";
import type { PlayerView } from "./player.js";
import {
  FrameRequestSequence,
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

const MAX_ACTIVE_DECODE_SETS = 2;

interface CoordinatedView {
  activate(): void;
  deactivate(): void;
}

interface ModelCoordinator {
  active: CoordinatedView | undefined;
  currentFrame: number;
  sequence: FrameRequestSequence;
  views: Set<CoordinatedView>;
}

const modelCoordinators = new WeakMap<object, Map<string, ModelCoordinator>>();

function coordinatorFor(
  model: KaleidoscopeRenderProps["model"],
  sessionId: string,
): ModelCoordinator {
  let managerCoordinators = modelCoordinators.get(model.widget_manager);
  if (managerCoordinators === undefined) {
    managerCoordinators = new Map();
    modelCoordinators.set(model.widget_manager, managerCoordinators);
  }
  const existing = managerCoordinators.get(sessionId);
  if (existing !== undefined) {
    return existing;
  }
  const modelFrame = model.get("current_frame");
  const coordinator: ModelCoordinator = {
    active: undefined,
    currentFrame:
      typeof modelFrame === "number" && Number.isSafeInteger(modelFrame)
        ? Math.max(0, modelFrame)
        : 0,
    sequence: new FrameRequestSequence(),
    views: new Set(),
  };
  managerCoordinators.set(sessionId, coordinator);
  return coordinator;
}

function deleteCoordinator(
  model: KaleidoscopeRenderProps["model"],
  sessionId: string,
): void {
  const managerCoordinators = modelCoordinators.get(model.widget_manager);
  managerCoordinators?.delete(sessionId);
  if (managerCoordinators?.size === 0) {
    modelCoordinators.delete(model.widget_manager);
  }
}

function isCommLive(model: KaleidoscopeRenderProps["model"]): boolean {
  const commLive = (
    model as KaleidoscopeRenderProps["model"] & { comm_live?: unknown }
  ).comm_live;
  return commLive !== undefined
    ? commLive !== false
    : model.get("comm_live") !== false;
}

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
  const coordinator = coordinatorFor(model, sessionId);

  let metadata: PreviewMetadataMessage | undefined;
  let comparisonState: ComparisonState | undefined;
  let playerView: PlayerView | undefined;
  let seekScheduler: PausedSeekScheduler | undefined;
  let playbackController: PlaybackController | undefined;
  let currentRequest:
    | Pick<FrameSetMessage, "request_id" | "generation" | "frame">
    | undefined;
  let unacknowledgedDelivery:
    | {
        requestId: number;
        generation: number;
        acknowledgeStale(): void;
      }
    | undefined;
  let lastAcknowledgedRequestId = -1;
  let activeDecodeSets = 0;
  let deferredDecodeRetry:
    | {
        expected: Pick<FrameSetMessage, "request_id" | "generation" | "frame">;
        resume: boolean;
      }
    | undefined;
  let resumeAfterPaint:
    | Pick<FrameSetMessage, "request_id" | "generation" | "frame">
    | undefined;
  let resumeAfterScrub = false;
  let autoplayPending = false;
  let resumeAfterVisibility = false;
  let comparisonFramePending = false;
  let comparisonFrameRequired = false;
  let disconnected = false;
  let terminal = false;
  let terminalStatus = "Preview session is no longer available.";
  let closeSent = false;

  const interactionBlocked = (): boolean => disconnected || terminal;

  const blockedStatus = (): string =>
    disconnected
      ? "Kernel disconnected. Preview paused."
      : terminalStatus;

  const requestsMatch = (
    left: Pick<FrameSetMessage, "request_id" | "generation" | "frame"> | undefined,
    right: Pick<FrameSetMessage, "request_id" | "generation" | "frame"> | undefined,
  ): boolean =>
    left !== undefined &&
    right !== undefined &&
    left.request_id === right.request_id &&
    left.generation === right.generation &&
    left.frame === right.frame;

  const updateStatus = (text: string): void => {
    const liveStatus = el.querySelector<HTMLElement>("[role='status']");
    if (liveStatus !== null) {
      liveStatus.textContent = text;
    }
  };

  const sendClose = (): void => {
    if (closeSent || !isCommLive(model)) {
      return;
    }
    closeSent = true;
    model.send(createCloseMessage(sessionId));
  };

  const setCurrentRequest = (
    request:
      | Pick<FrameSetMessage, "request_id" | "generation" | "frame">
      | undefined,
  ): void => {
    if (
      unacknowledgedDelivery !== undefined &&
      (request === undefined ||
        request.request_id !== unacknowledgedDelivery.requestId ||
        request.generation !== unacknowledgedDelivery.generation)
    ) {
      unacknowledgedDelivery.acknowledgeStale();
    }
    if (
      deferredDecodeRetry !== undefined &&
      !requestsMatch(request, deferredDecodeRetry.expected)
    ) {
      deferredDecodeRetry = undefined;
    }
    currentRequest = request;
  };

  const retryDeferredDecode = (): void => {
    const deferred = deferredDecodeRetry;
    if (
      deferred === undefined ||
      activeDecodeSets >= MAX_ACTIVE_DECODE_SETS ||
      !requestsMatch(currentRequest, deferred.expected) ||
      seekScheduler === undefined ||
      signal.aborted
    ) {
      return;
    }
    deferredDecodeRetry = undefined;
    const request = seekScheduler.requestExact(deferred.expected.frame);
    if (deferred.resume) {
      resumeAfterPaint = request;
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
    if (interactionBlocked()) {
      updateStatus(blockedStatus());
      return;
    }
    autoplayPending = false;
    resumeAfterPaint = undefined;
    resumeAfterScrub = false;
    resumeAfterVisibility = false;
    playbackController?.toggle();
  };

  const enterTerminal = (text: string, closeBackend: boolean): void => {
    terminal = true;
    terminalStatus = text;
    autoplayPending = false;
    deferredDecodeRetry = undefined;
    resumeAfterPaint = undefined;
    resumeAfterScrub = false;
    resumeAfterVisibility = false;
    comparisonFramePending = false;
    comparisonFrameRequired = false;
    setCurrentRequest(undefined);
    playbackController?.pause(false);
    playbackController?.close();
    seekScheduler?.close();
    if (closeBackend) {
      sendClose();
    }
    updateStatus(text);
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
      if (
        message.type === "frame_set" &&
        (metadata === undefined || playerView === undefined)
      ) {
        lastAcknowledgedRequestId = Math.max(
          lastAcknowledgedRequestId,
          message.request_id,
        );
        model.send(
          createFrameSetAck(
            sessionId,
            message.request_id,
            message.generation,
            "stale",
          ),
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
            },
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
                if (interactionBlocked()) {
                  updateStatus(blockedStatus());
                  return playerView?.getFrame() ?? 0;
                }
                if (
                  playbackController?.playing ||
                  resumeAfterPaint !== undefined ||
                  resumeAfterScrub
                ) {
                  resumeAfterScrub = true;
                }
                resumeAfterPaint = undefined;
                playbackController?.pause(false);
                setCurrentRequest(undefined);
                return seekScheduler?.scheduleScrub(frame) ?? 0;
              },
              changeComparison: (transition) => {
                if (interactionBlocked()) {
                  updateStatus(blockedStatus());
                  return;
                }
                if (
                  metadata === undefined ||
                  comparisonState === undefined ||
                  seekScheduler === undefined
                ) {
                  return;
                }
                const previous = comparisonState;
                let next;
                try {
                  next = transitionComparisonState(
                    previous,
                    metadata,
                    transition,
                  );
                } catch (error) {
                  updateStatus(
                    error instanceof Error
                      ? error.message
                      : "Invalid comparison selection.",
                  );
                  playerView?.setComparison(previous);
                  return;
                }

                comparisonState = next.state;
                metadata = {
                  ...metadata,
                  mode: next.state.mode,
                  active_clip_ids: [...next.state.activeClipIds],
                };
                const deferComposition =
                  next.requiresFrameSet || comparisonFrameRequired;
                playerView?.setComparison(next.state, deferComposition);

                const needsFrameSet =
                  next.requiresFrameSet ||
                  (comparisonFrameRequired && !comparisonFramePending);

                const durableViewChanged =
                  previous.mode !== next.state.mode ||
                  previous.overlayOpacity !== next.state.overlayOpacity ||
                  needsFrameSet;
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
                      next.state.overlayOpacity,
                    ),
                  );
                  return;
                }

                const shouldResume =
                  playbackController?.playing === true ||
                  resumeAfterPaint !== undefined ||
                  resumeAfterScrub ||
                  deferredDecodeRetry?.resume === true;
                const frame =
                  playbackController?.playing === true
                    ? playbackController.pause(false)
                    : playerView?.getFrame() ?? 0;
                setCurrentRequest(undefined);
                resumeAfterPaint = undefined;
                resumeAfterScrub = false;
                const request = seekScheduler.requestView(
                  frame,
                  next.state.activeClipIds,
                  (generation) =>
                    model.send(
                      createSetViewMessage(
                        sessionId,
                        generation,
                        next.state.mode,
                        next.state.activeClipIds,
                        next.state.overlayOpacity,
                      ),
                    ),
                );
                comparisonFrameRequired = true;
                comparisonFramePending = true;
                if (shouldResume) {
                  resumeAfterPaint = request;
                }
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
          seekScheduler.requestExact(
            Math.min(message.num_frames - 1, coordinator.currentFrame),
          );
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
        if (message.request_id <= lastAcknowledgedRequestId) {
          return;
        }
        if (unacknowledgedDelivery !== undefined) {
          if (
            unacknowledgedDelivery.requestId === message.request_id &&
            unacknowledgedDelivery.generation === message.generation
          ) {
            return;
          }
          throw new ProtocolError(
            "invalid_message",
            "A frame payload arrived before the previous delivery was acknowledged.",
          );
        }
        const expected = currentRequest;
        const expectedClipIds =
          comparisonState?.activeClipIds ?? metadata.active_clip_ids;
        const manifestClipIds = message.frames.map((frame) => frame.clip_id);
        const isCurrent = (): boolean =>
          !signal.aborted &&
          expected !== undefined &&
          requestsMatch(currentRequest, expected) &&
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
          if (acknowledged) {
            return;
          }
          acknowledged = true;
          lastAcknowledgedRequestId = Math.max(
            lastAcknowledgedRequestId,
            message.request_id,
          );
          if (outcome !== "painted") {
            deliveryController.abort();
          }
          if (
            unacknowledgedDelivery?.requestId === message.request_id &&
            unacknowledgedDelivery.generation === message.generation
          ) {
            unacknowledgedDelivery = undefined;
          }
          model.send(
            createFrameSetAck(
              sessionId,
              message.request_id,
              message.generation,
              outcome,
            ),
          );
        };
        let acknowledged = false;
        const deliveryController = new AbortController();
        unacknowledgedDelivery = {
          requestId: message.request_id,
          generation: message.generation,
          acknowledgeStale: () => acknowledge("stale"),
        };
        if (!isCurrent()) {
          acknowledge("stale");
          return;
        }
        if (activeDecodeSets >= MAX_ACTIVE_DECODE_SETS) {
          const resume =
            resumeAfterPaint !== undefined &&
            resumeAfterPaint.request_id === message.request_id &&
            resumeAfterPaint.generation === message.generation;
          if (resume) {
            resumeAfterPaint = undefined;
          }
          deferredDecodeRetry = {
            expected: {
              request_id: message.request_id,
              generation: message.generation,
              frame: message.frame,
            },
            resume,
          };
          comparisonFramePending = false;
          acknowledge("stale");
          return;
        }
        activeDecodeSets += 1;
        let painted: boolean;
        try {
          validateFrameSetBuffers(message, buffers);
          painted = await paintFrameSet(
            playerView,
            message,
            buffers,
            isCurrent,
            deliveryController.signal,
          );
        } catch (error) {
          if (!isCurrent()) {
            acknowledge("stale");
            return;
          }
          acknowledge("decode_error");
          comparisonFramePending = false;
          resumeAfterPaint = undefined;
          setCurrentRequest(undefined);
          playbackController?.pause(false);
          updateStatus(
            error instanceof Error
              ? `Frame decode error: ${error.message}`
              : "Frame decode error.",
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
      if (message.request_id !== undefined) {
        comparisonFramePending = false;
        resumeAfterPaint = undefined;
        setCurrentRequest(undefined);
        playbackController?.pause(false);
      }
      const clip = metadata?.clips.find(
        (candidate) => candidate.id === message.clip_id,
      );
      const errorStatus =
        clip === undefined
          ? `Protocol error: ${message.message}`
          : `${clip.label}: ${message.message}`;
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

  const onMessage = (value: unknown, buffers: DataView[]): void => {
    void handleMessage(value, buffers);
  };

  const onCommLiveUpdate = (): void => {
    if (isCommLive(model)) {
      return;
    }
    disconnected = true;
    autoplayPending = false;
    deferredDecodeRetry = undefined;
    resumeAfterPaint = undefined;
    resumeAfterScrub = false;
    resumeAfterVisibility = false;
    setCurrentRequest(undefined);
    playbackController?.pause(false);
    updateStatus("Kernel disconnected. Preview paused.");
  };
  const onVisibilityChange = (): void => {
    if (document.visibilityState === "hidden") {
      if (playbackController?.playing) {
        const pausedFrame = playbackController.pause(false);
        resumeAfterVisibility =
          metadata !== undefined && pausedFrame < metadata.num_frames - 1;
        setCurrentRequest(undefined);
      }
    } else if (resumeAfterVisibility) {
      playWhenVisible();
    }
  };
  let active = false;
  const coordinatedView: CoordinatedView = {
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
        signal,
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
        if (!active || signal.aborted) {
          return;
        }
        model.send(
          createReadyMessage(sessionId, {
            image_bitmap: true,
            webp,
          }),
        );
      });
    },
    deactivate: () => {
      if (!active) {
        return;
      }
      active = false;
      deferredDecodeRetry = undefined;
      setCurrentRequest(undefined);
      playbackController?.pause(false);
      playbackController?.close();
      seekScheduler?.close();
      model.off("msg:custom", onMessage);
      model.off("change:comm_live", onCommLiveUpdate);
      model.off("comm_live_update", onCommLiveUpdate);
    },
  };

  coordinator.views.add(coordinatedView);
  if (coordinator.active === undefined) {
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
        coordinator.active = undefined;
        const next = coordinator.views.values().next().value as
          | CoordinatedView
          | undefined;
        if (next !== undefined) {
          coordinator.active = next;
          next.activate();
        }
      }
      if (coordinator.views.size === 0) {
        deleteCoordinator(model, sessionId);
        sendClose();
      }
    },
    { once: true },
  );
}

export default { render };
