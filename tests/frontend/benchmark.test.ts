import { describe, expect, it } from "vitest";

import { assertFinalFrameLabels, labelDescribesFrame } from "../../benchmarks/browser.js";

describe("browser benchmark assertions", () => {
  it("accepts accessible frame labels with or without additional details", () => {
    expect(labelDescribesFrame("Source, frame 7", 7)).toBe(true);
    expect(labelDescribesFrame("Source, frame 7, time 00:00:00.292", 7)).toBe(true);
    expect(labelDescribesFrame("Source, frame 70, time 00:00:02.917", 7)).toBe(false);
    expect(labelDescribesFrame("Source, keyframe 7, time 00:00:00.292", 7)).toBe(false);
    expect(labelDescribesFrame("frame 7", 7)).toBe(true);
  });

  it("requires one unique final-frame label for every expected clip", () => {
    expect(() =>
      assertFinalFrameLabels(["Source, frame 7", "Filtered, frame 7, time 00:00:00.292"], 7, [
        "Source",
        "Filtered",
      ]),
    ).not.toThrow();
    expect(() => assertFinalFrameLabels([], 7, ["Source", "Filtered"])).toThrow(/expected 2/i);
    expect(() => assertFinalFrameLabels(["Source, frame 7"], 7, ["Source", "Filtered"])).toThrow(
      /expected 2/i,
    );
    expect(() =>
      assertFinalFrameLabels(["Source, frame 7", "Source, frame 7"], 7, ["Source", "Filtered"]),
    ).toThrow(/unique/i);
    expect(() =>
      assertFinalFrameLabels(["Source, frame 7", "Filtered, frame 6"], 7, ["Source", "Filtered"]),
    ).toThrow(/final frame/i);
    expect(() =>
      assertFinalFrameLabels(["Input, frame 7", "Output, frame 7"], 7, ["Source", "Filtered"]),
    ).toThrow(/clip labels/i);
  });
});
