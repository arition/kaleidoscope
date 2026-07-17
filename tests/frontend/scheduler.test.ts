import { describe, expect, it, vi } from "vitest";

import {
  FrameRequestSequence,
  PausedSeekScheduler,
  PlaybackClock,
} from "../../frontend/scheduler.js";

describe("PlaybackClock", () => {
  it("derives the desired frame from one rational clock anchor", () => {
    const clock = new PlaybackClock({
      numFrames: 100,
      fpsNum: 24000,
      fpsDen: 1001,
    });

    expect(clock.play(0, 100)).toBe(0);
    expect(clock.sample(142)).toEqual({ frame: 1, ended: false });
    expect(clock.sample(1101)).toEqual({ frame: 24, ended: false });
  });

  it("freezes on pause and restarts from zero after the end", () => {
    const clock = new PlaybackClock({
      numFrames: 10,
      fpsNum: 24,
      fpsDen: 1,
    });

    clock.play(4, 0);
    expect(clock.pause(125)).toBe(7);
    expect(clock.sample(1000)).toEqual({ frame: 7, ended: false });

    clock.play(8, 2000);
    expect(clock.sample(2100)).toEqual({ frame: 9, ended: true });
    expect(clock.play(9, 3000)).toBe(0);
    expect(clock.playing).toBe(true);
  });
});

describe("PausedSeekScheduler", () => {
  it("clamps exact seeks and assigns monotonic request identities", () => {
    const sent: unknown[] = [];
    const scheduler = new PausedSeekScheduler({
      sessionId: "session-1",
      numFrames: 10,
      clipIds: ["Source", "Filtered"],
      send: (message) => sent.push(message),
    });

    expect(scheduler.requestExact(-10)).toEqual({
      request_id: 0,
      generation: 0,
      frame: 0,
    });
    expect(scheduler.requestExact(999)).toEqual({
      request_id: 1,
      generation: 1,
      frame: 9,
    });
    expect(sent).toEqual([
      expect.objectContaining({
        request_id: 0,
        generation: 0,
        frame: 0,
        clip_ids: ["Source", "Filtered"],
        reason: "seek",
      }),
      expect.objectContaining({
        request_id: 1,
        generation: 1,
        frame: 9,
        clip_ids: ["Source", "Filtered"],
        reason: "seek",
      }),
    ]);
  });

  it("clamps non-finite exact seeks to timeline boundaries", () => {
    const sent: unknown[] = [];
    const scheduler = new PausedSeekScheduler({
      sessionId: "session-1",
      numFrames: 10,
      clipIds: ["Source"],
      send: (message) => sent.push(message),
    });

    expect(scheduler.requestExact(Number.NEGATIVE_INFINITY).frame).toBe(0);
    expect(scheduler.requestExact(Number.POSITIVE_INFINITY).frame).toBe(9);
    expect(sent).toMatchObject([{ frame: 0 }, { frame: 9 }]);
  });

  it("coalesces scrub requests to the latest target", () => {
    let scheduled: FrameRequestCallback | undefined;
    const sent: unknown[] = [];
    const scheduler = new PausedSeekScheduler({
      sessionId: "session-1",
      numFrames: 100,
      clipIds: ["Source"],
      send: (message) => sent.push(message),
      schedule: (callback) => {
        scheduled = callback;
        return 7;
      },
      cancel: vi.fn(),
    });

    expect(scheduler.scheduleScrub(20)).toBe(20);
    expect(scheduler.scheduleScrub(40)).toBe(40);
    expect(sent).toEqual([]);

    scheduled?.(0);

    expect(sent).toEqual([
      expect.objectContaining({
        request_id: 0,
        generation: 0,
        frame: 40,
      }),
    ]);
  });

  it("cancels a queued scrub when release requests an exact target", () => {
    let scheduled: FrameRequestCallback | undefined;
    const cancel = vi.fn();
    const sent: unknown[] = [];
    const scheduler = new PausedSeekScheduler({
      sessionId: "session-1",
      numFrames: 100,
      clipIds: ["Source"],
      send: (message) => sent.push(message),
      schedule: (callback) => {
        scheduled = callback;
        return 9;
      },
      cancel,
    });

    scheduler.scheduleScrub(30);
    const exact = scheduler.requestExact(31);
    scheduled?.(0);

    expect(cancel).toHaveBeenCalledWith(9);
    expect(exact).toEqual({ request_id: 0, generation: 0, frame: 31 });
    expect(sent).toEqual([
      expect.objectContaining({
        request_id: 0,
        generation: 0,
        frame: 31,
      }),
    ]);
  });

  it("shares one generation across playback and advances on discontinuities", () => {
    const sent: unknown[] = [];
    const scheduler = new PausedSeekScheduler({
      sessionId: "session-1",
      numFrames: 100,
      clipIds: ["Source"],
      send: (message) => sent.push(message),
    });

    scheduler.requestExact(0);
    scheduler.requestPlayback(1);
    scheduler.requestPlayback(8);
    scheduler.requestExact(4);
    scheduler.requestPlayback(5);
    scheduler.requestPlayback(0, true);

    expect(sent).toMatchObject([
      { request_id: 0, generation: 0, frame: 0, reason: "seek" },
      { request_id: 1, generation: 0, frame: 1, reason: "playback" },
      { request_id: 2, generation: 0, frame: 8, reason: "playback" },
      { request_id: 3, generation: 1, frame: 4, reason: "seek" },
      { request_id: 4, generation: 1, frame: 5, reason: "playback" },
      { request_id: 5, generation: 2, frame: 0, reason: "playback" },
    ]);
  });

  it("continues request identities when an active view hands off", () => {
    const sequence = new FrameRequestSequence();
    const firstViewMessages: unknown[] = [];
    const secondViewMessages: unknown[] = [];
    const firstView = new PausedSeekScheduler({
      sessionId: "session-1",
      numFrames: 100,
      clipIds: ["Source"],
      sequence,
      send: (message) => firstViewMessages.push(message),
    });

    firstView.requestExact(2);
    firstView.requestPlayback(3);
    firstView.close();

    const secondView = new PausedSeekScheduler({
      sessionId: "session-1",
      numFrames: 100,
      clipIds: ["Source"],
      sequence,
      send: (message) => secondViewMessages.push(message),
    });
    secondView.requestExact(8);
    secondView.requestPlayback(9);

    expect(firstViewMessages).toMatchObject([
      { request_id: 0, generation: 0, frame: 2 },
      { request_id: 1, generation: 0, frame: 3 },
    ]);
    expect(secondViewMessages).toMatchObject([
      { request_id: 2, generation: 1, frame: 8 },
      { request_id: 3, generation: 1, frame: 9 },
    ]);
  });

  it("announces a new active clip set before requesting its current frame", () => {
    const order: unknown[] = [];
    const scheduler = new PausedSeekScheduler({
      sessionId: "session-1",
      numFrames: 100,
      clipIds: ["Source", "Filtered"],
      send: (message) => order.push(message),
    });

    scheduler.requestExact(0);
    const request = scheduler.requestView(7, ["Source", "Reference"], (generation) =>
      order.push({ type: "set_view", generation }),
    );

    expect(request).toEqual({ request_id: 1, generation: 1, frame: 7 });
    expect(order).toMatchObject([
      { type: "request_frame_set", generation: 0, clip_ids: ["Source", "Filtered"] },
      { type: "set_view", generation: 1 },
      {
        type: "request_frame_set",
        generation: 1,
        frame: 7,
        clip_ids: ["Source", "Reference"],
      },
    ]);
  });

  it("cancels queued and future requests when the view closes", () => {
    let scheduled: FrameRequestCallback | undefined;
    const cancel = vi.fn();
    const sent: unknown[] = [];
    const scheduler = new PausedSeekScheduler({
      sessionId: "session-1",
      numFrames: 100,
      clipIds: ["Source"],
      send: (message) => sent.push(message),
      schedule: (callback) => {
        scheduled = callback;
        return 11;
      },
      cancel,
    });

    scheduler.scheduleScrub(40);
    scheduler.close();
    scheduled?.(0);
    scheduler.requestExact(50);

    expect(cancel).toHaveBeenCalledWith(11);
    expect(sent).toEqual([]);
  });
});
