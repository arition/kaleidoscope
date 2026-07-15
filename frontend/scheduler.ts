import { createFrameSetRequest } from "./protocol.js";
import type {
  ClipId,
  RequestFrameSetMessage,
} from "./protocol.js";

export interface FrameRequestIdentity {
  request_id: number;
  generation: number;
  frame: number;
}

interface PausedSeekSchedulerOptions {
  sessionId: string;
  numFrames: number;
  clipIds: ClipId[];
  send: (message: RequestFrameSetMessage) => void;
  schedule?: (callback: FrameRequestCallback) => number;
  cancel?: (handle: number) => void;
}

const scheduleFrame = (callback: FrameRequestCallback): number => {
  if (typeof globalThis.requestAnimationFrame === "function") {
    return globalThis.requestAnimationFrame(callback);
  }
  return globalThis.setTimeout(() => callback(performance.now()), 0);
};

const cancelFrame = (handle: number): void => {
  if (typeof globalThis.cancelAnimationFrame === "function") {
    globalThis.cancelAnimationFrame(handle);
  } else {
    globalThis.clearTimeout(handle);
  }
};

export class PausedSeekScheduler {
  private readonly sessionId: string;
  private readonly numFrames: number;
  private readonly clipIds: ClipId[];
  private readonly send: (message: RequestFrameSetMessage) => void;
  private readonly schedule: (callback: FrameRequestCallback) => number;
  private readonly cancel: (handle: number) => void;
  private nextRequestId = 0;
  private nextGeneration = 0;
  private scheduledHandle: number | undefined;
  private scheduledToken = 0;
  private pendingFrame = 0;
  private closed = false;

  constructor(options: PausedSeekSchedulerOptions) {
    this.sessionId = options.sessionId;
    this.numFrames = options.numFrames;
    this.clipIds = [...options.clipIds];
    this.send = options.send;
    this.schedule = options.schedule ?? scheduleFrame;
    this.cancel = options.cancel ?? cancelFrame;
  }

  private clamp(frame: number): number {
    if (!Number.isFinite(frame)) {
      return frame < 0 ? 0 : this.numFrames - 1;
    }
    return Math.min(this.numFrames - 1, Math.max(0, Math.trunc(frame)));
  }

  private cancelScheduledScrub(): void {
    this.scheduledToken += 1;
    if (this.scheduledHandle !== undefined) {
      this.cancel(this.scheduledHandle);
      this.scheduledHandle = undefined;
    }
  }

  requestExact(frame: number): FrameRequestIdentity {
    this.cancelScheduledScrub();
    const identity = {
      request_id: this.nextRequestId,
      generation: this.nextGeneration,
      frame: this.clamp(frame),
    };
    if (this.closed) {
      return identity;
    }
    this.nextRequestId += 1;
    this.nextGeneration += 1;
    this.send(
      createFrameSetRequest(
        this.sessionId,
        identity.request_id,
        identity.generation,
        identity.frame,
        this.clipIds,
        "seek",
      ),
    );
    return identity;
  }

  scheduleScrub(frame: number): number {
    this.pendingFrame = this.clamp(frame);
    if (!this.closed && this.scheduledHandle === undefined) {
      const token = this.scheduledToken;
      this.scheduledHandle = this.schedule(() => {
        if (token !== this.scheduledToken) {
          return;
        }
        this.scheduledHandle = undefined;
        this.requestExact(this.pendingFrame);
      });
    }
    return this.pendingFrame;
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.cancelScheduledScrub();
  }
}