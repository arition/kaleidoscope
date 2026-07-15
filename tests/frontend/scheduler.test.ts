import { describe, expect, it, vi } from "vitest";

import { PausedSeekScheduler } from "../../frontend/scheduler.js";

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