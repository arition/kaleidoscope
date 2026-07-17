import { describe, expect, it } from "vitest";

import { createComparisonState, transitionComparisonState } from "../../frontend/comparison.js";
import type { PreviewMetadataMessage } from "../../frontend/protocol.js";

const metadata: PreviewMetadataMessage = {
  protocol: 1,
  type: "metadata",
  session_id: "session-1",
  status: "initialized",
  num_frames: 10,
  fps_num: 24,
  fps_den: 1,
  mode: "side-by-side",
  active_clip_ids: ["Source", "Filtered"],
  overlay_opacity: 0.35,
  max_visible_clips: 4,
  autoplay: false,
  clips: [
    {
      id: "Source",
      label: "Source",
      source_format: "RGB24",
      source_width: 1920,
      source_height: 1080,
      output_width: 1920,
      output_height: 1080,
      warnings: [],
    },
    {
      id: "Filtered",
      label: "Filtered",
      source_format: "RGB24",
      source_width: 1920,
      source_height: 1080,
      output_width: 1920,
      output_height: 1080,
      warnings: [],
    },
    {
      id: "Reference",
      label: "Reference",
      source_format: "RGB24",
      source_width: 1920,
      source_height: 1080,
      output_width: 1920,
      output_height: 1080,
      warnings: [],
    },
  ],
};

describe("comparison state", () => {
  it("preserves the configured initial overlay opacity", () => {
    expect(createComparisonState(metadata).overlayOpacity).toBe(0.35);
  });

  it("switches aligned modes for the same pair without requesting frames", () => {
    const initial = createComparisonState(metadata);
    const wipe = transitionComparisonState(initial, metadata, {
      mode: "wipe",
    });
    const overlay = transitionComparisonState(wipe.state, metadata, {
      mode: "overlay",
    });
    const difference = transitionComparisonState(overlay.state, metadata, {
      mode: "difference",
    });

    expect(wipe.state.activeClipIds).toEqual(["Source", "Filtered"]);
    expect(wipe.requiresFrameSet).toBe(false);
    expect(overlay.requiresFrameSet).toBe(false);
    expect(difference.requiresFrameSet).toBe(false);
  });

  it("normalizes side-by-side selections and flags active-set changes", () => {
    const initial = createComparisonState(metadata);
    const next = transitionComparisonState(initial, metadata, {
      mode: "side-by-side",
      selectedClipIds: ["Reference", "Source"],
    });

    expect(next.state.activeClipIds).toEqual(["Source", "Reference"]);
    expect(next.requiresFrameSet).toBe(true);
  });

  it("enforces distinct aligned clips with matching geometry", () => {
    const initial = createComparisonState(metadata);

    expect(() =>
      transitionComparisonState(initial, metadata, {
        mode: "wipe",
        primary: "Source",
        secondary: "Source",
      }),
    ).toThrow("distinct");

    const mismatched: PreviewMetadataMessage = {
      ...metadata,
      clips: metadata.clips.map((clip) =>
        clip.id === "Reference" ? { ...clip, source_width: 1280, output_width: 1280 } : clip,
      ),
    };
    expect(() =>
      transitionComparisonState(initial, mismatched, {
        mode: "difference",
        primary: "Source",
        secondary: "Reference",
      }),
    ).toThrow("matching source dimensions");
  });

  it("selects the first compatible pair when the current primary cannot align", () => {
    const mixedGeometry: PreviewMetadataMessage = {
      ...metadata,
      active_clip_ids: ["Source", "Filtered"],
      clips: metadata.clips.map((clip) =>
        clip.id === "Source"
          ? {
              ...clip,
              source_width: 640,
              source_height: 480,
              output_width: 640,
              output_height: 480,
            }
          : clip,
      ),
    };

    const next = transitionComparisonState(createComparisonState(mixedGeometry), mixedGeometry, {
      mode: "wipe",
    });

    expect(next.state.activeClipIds).toEqual(["Filtered", "Reference"]);
    expect(next.requiresFrameSet).toBe(true);
  });

  it("rejects aligned comparisons when only one clip may be visible", () => {
    const singleVisible = { ...metadata, max_visible_clips: 1 };

    expect(() =>
      transitionComparisonState(createComparisonState(singleVisible), singleVisible, {
        mode: "wipe",
      }),
    ).toThrow("visible-clip limit");
  });
});
