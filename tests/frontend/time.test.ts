import { describe, expect, it } from "vitest";

import {
  formatFrameTime,
  frameFromTime,
  parseTimeToFrame,
} from "../../frontend/time.js";

describe("rational frame time conversion", () => {
  it("round-trips exact frame boundaries at 24000/1001 fps", () => {
    expect(frameFromTime(1001, 24000, 1001, 240)).toBe(24);
    expect(parseTimeToFrame("00:00:01.001", 24000, 1001, 240)).toBe(24);
    expect(parseTimeToFrame("1.001", 24000, 1001, 240)).toBe(24);
    expect(formatFrameTime(24, 24000, 1001)).toBe("00:00:01.001");
  });

  it("formats fractional-rate frames inside their own time interval", () => {
    for (const frame of [0, 1, 2, 3, 23, 24, 239]) {
      expect(
        parseTimeToFrame(
          formatFrameTime(frame, 24000, 1001),
          24000,
          1001,
          240,
        ),
      ).toBe(frame);
    }
  });

  it("clamps negative and beyond-end times to the shared timeline", () => {
    expect(parseTimeToFrame("-1", 24, 1, 240)).toBe(0);
    expect(parseTimeToFrame("99:00:00", 24, 1, 240)).toBe(239);
  });

  it("uses enough decimal precision to distinguish sub-millisecond frames", () => {
    const formatted = formatFrameTime(1, 2000, 1);

    expect(formatted).toBe("00:00:00.0005");
    expect(parseTimeToFrame(formatted, 2000, 1, 10)).toBe(1);
  });

  it("rejects malformed time entry instead of silently seeking", () => {
    expect(parseTimeToFrame("not-a-time", 24, 1, 240)).toBeUndefined();
    expect(parseTimeToFrame("00:61:00", 24, 1, 240)).toBeUndefined();
    expect(parseTimeToFrame(`0.${"1".repeat(31)}`, 24, 1, 240)).toBeUndefined();
  });
});