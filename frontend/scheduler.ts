import { createFrameSetRequest } from "./protocol.js";
import type {
  ClipId,
  RequestFrameSetMessage,
} from "./protocol.js";

interface PlaybackClockOptions {
  numFrames: number;
  fpsNum: number;
  fpsDen: number;
}

export interface PlaybackSample {
  frame: number;
  ended: boolean;
}

const timestampMicros = (milliseconds: number): bigint =>
  BigInt(Math.trunc(milliseconds * 1000));

export class PlaybackClock {
  private readonly numFrames: number;
  private readonly fpsNum: bigint;
  private readonly fpsDen: bigint;
  private anchorFrame = 0;
  private anchorMicros = 0n;
  private currentFrame = 0;
  private active = false;

  constructor(options: PlaybackClockOptions) {
    this.numFrames = options.numFrames;
    this.fpsNum = BigInt(options.fpsNum);
    this.fpsDen = BigInt(options.fpsDen);
  }

  get playing(): boolean {
    return this.active;
  }

  private clamp(frame: number): number {
    return Math.min(this.numFrames - 1, Math.max(0, Math.trunc(frame)));
  }

  play(frame: number, now: number): number {
    const clamped = this.clamp(frame);
    this.currentFrame = clamped === this.numFrames - 1 ? 0 : clamped;
    this.anchorFrame = this.currentFrame;
    this.anchorMicros = timestampMicros(now);
    this.active = true;
    return this.currentFrame;
  }

  pause(now: number): number {
    if (this.active) {
      this.sample(now);
      this.active = false;
    }
    return this.currentFrame;
  }

  sample(now: number): PlaybackSample {
    if (!this.active) {
      return { frame: this.currentFrame, ended: false };
    }
    const elapsed = timestampMicros(now) - this.anchorMicros;
    const elapsedFrames =
      elapsed <= 0n
        ? 0n
        : (elapsed * this.fpsNum) / (1_000_000n * this.fpsDen);
    const desired = Math.max(
      this.currentFrame,
      this.anchorFrame + Number(elapsedFrames),
    );
    if (desired >= this.numFrames - 1) {
      this.currentFrame = this.numFrames - 1;
      this.active = false;
      return { frame: this.currentFrame, ended: true };
    }
    this.currentFrame = desired;
    return { frame: this.currentFrame, ended: false };
  }
}

interface PlaybackControllerOptions extends PlaybackClockOptions {
  scheduler: PausedSeekScheduler;
  onFrame: (frame: number) => void;
  onPlaying: (playing: boolean) => void;
  sendPlaying: (playing: boolean) => void;
  schedule?: (callback: FrameRequestCallback) => number;
  cancel?: (handle: number) => void;
  now?: () => number;
}

export class PlaybackController {
  private readonly clock: PlaybackClock;
  private readonly scheduler: PausedSeekScheduler;
  private readonly onFrame: (frame: number) => void;
  private readonly onPlaying: (playing: boolean) => void;
  private readonly sendPlaying: (playing: boolean) => void;
  private readonly schedule: (callback: FrameRequestCallback) => number;
  private readonly cancel: (handle: number) => void;
  private readonly now: () => number;
  private currentFrame = 0;
  private scheduledHandle: number | undefined;

  constructor(options: PlaybackControllerOptions) {
    this.clock = new PlaybackClock(options);
    this.scheduler = options.scheduler;
    this.onFrame = options.onFrame;
    this.onPlaying = options.onPlaying;
    this.sendPlaying = options.sendPlaying;
    this.schedule = options.schedule ?? scheduleFrame;
    this.cancel = options.cancel ?? cancelFrame;
    this.now = options.now ?? (() => performance.now());
  }

  get playing(): boolean {
    return this.clock.playing;
  }

  setCurrentFrame(frame: number): void {
    this.currentFrame = frame;
  }

  private scheduleTick(): void {
    if (this.scheduledHandle === undefined && this.clock.playing) {
      this.scheduledHandle = this.schedule((timestamp) => {
        this.scheduledHandle = undefined;
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

  play(): void {
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

  pause(requestExact = true): number {
    if (!this.clock.playing) {
      return this.currentFrame;
    }
    this.currentFrame = this.clock.pause(this.now());
    if (this.scheduledHandle !== undefined) {
      this.cancel(this.scheduledHandle);
      this.scheduledHandle = undefined;
    }
    if (requestExact) {
      this.scheduler.requestExact(this.currentFrame);
    }
    this.onFrame(this.currentFrame);
    this.onPlaying(false);
    this.sendPlaying(false);
    return this.currentFrame;
  }

  toggle(): void {
    if (this.clock.playing) {
      this.pause();
    } else {
      this.play();
    }
  }

  close(): void {
    if (this.scheduledHandle !== undefined) {
      this.cancel(this.scheduledHandle);
      this.scheduledHandle = undefined;
    }
  }
}

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
  private clipIds: ClipId[];
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

  get generation(): number {
    return Math.max(0, this.nextGeneration - 1);
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

  private sendRequest(
    frame: number,
    generation: number,
    reason: "seek" | "playback",
  ): FrameRequestIdentity {
    const identity = {
      request_id: this.nextRequestId,
      generation,
      frame: this.clamp(frame),
    };
    if (this.closed) {
      return identity;
    }
    this.nextRequestId += 1;
    this.send(
      createFrameSetRequest(
        this.sessionId,
        identity.request_id,
        identity.generation,
        identity.frame,
        this.clipIds,
        reason,
      ),
    );
    return identity;
  }

  requestExact(frame: number): FrameRequestIdentity {
    this.cancelScheduledScrub();
    const generation = this.nextGeneration;
    this.nextGeneration += 1;
    return this.sendRequest(frame, generation, "seek");
  }

  requestPlayback(frame: number, restart = false): FrameRequestIdentity {
    this.cancelScheduledScrub();
    const generation = restart
      ? this.nextGeneration
      : Math.max(0, this.nextGeneration - 1);
    if (restart) {
      this.nextGeneration += 1;
    }
    return this.sendRequest(frame, generation, "playback");
  }

  requestView(
    frame: number,
    clipIds: ClipId[],
    announce: (generation: number) => void,
  ): FrameRequestIdentity {
    this.cancelScheduledScrub();
    const generation = this.nextGeneration;
    this.nextGeneration += 1;
    this.clipIds = [...clipIds];
    announce(generation);
    return this.sendRequest(frame, generation, "seek");
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