import { describe, expect, it } from "vitest";

import {
  PROTOCOL_VERSION,
  ProtocolError,
  createReadyMessage,
  parseBackendMessage,
} from "../../frontend/protocol.js";

describe("protocol v1", () => {
  it("creates a ready message with required capabilities", () => {
    expect(
      createReadyMessage("session-1", { image_bitmap: true, webp: false }),
    ).toEqual({
      protocol: PROTOCOL_VERSION,
      type: "ready",
      session_id: "session-1",
      capabilities: { image_bitmap: true, webp: false },
    });
  });

  it("accepts initialized metadata", () => {
    expect(
      parseBackendMessage({
        protocol: 1,
        type: "metadata",
        session_id: "session-1",
        status: "initialized",
        num_frames: 240,
        fps_num: 24000,
        fps_den: 1001,
        mode: "side-by-side",
        active_clip_ids: ["Source", "Filtered"],
        max_visible_clips: 4,
        clips: [
          {
            id: "Source",
            label: "Source",
            source_format: "RGB24",
            source_width: 1920,
            source_height: 1080,
            output_width: 960,
            output_height: 540,
            warnings: [],
          },
          {
            id: "Filtered",
            label: "Filtered",
            source_format: "RGB24",
            source_width: 1280,
            source_height: 720,
            output_width: 960,
            output_height: 540,
            warnings: [],
          },
        ],
      }),
    ).toEqual({
      protocol: 1,
      type: "metadata",
      session_id: "session-1",
      status: "initialized",
      num_frames: 240,
      fps_num: 24000,
      fps_den: 1001,
      mode: "side-by-side",
      active_clip_ids: ["Source", "Filtered"],
      max_visible_clips: 4,
      clips: [
        {
          id: "Source",
          label: "Source",
          source_format: "RGB24",
          source_width: 1920,
          source_height: 1080,
          output_width: 960,
          output_height: 540,
          warnings: [],
        },
        {
          id: "Filtered",
          label: "Filtered",
          source_format: "RGB24",
          source_width: 1280,
          source_height: 720,
          output_width: 960,
          output_height: 540,
          warnings: [],
        },
      ],
    });
  });

  it("rejects an incompatible protocol version", () => {
    expect(() =>
      parseBackendMessage({
        protocol: 2,
        type: "metadata",
        session_id: "session-1",
        status: "initialized",
      }),
    ).toThrowError(new ProtocolError("protocol_mismatch", "Unsupported protocol version 2; expected 1."));
  });

  it("rejects malformed metadata", () => {
    expect(() =>
      parseBackendMessage({
        protocol: 1,
        type: "metadata",
        session_id: "session-1",
      }),
    ).toThrowError(ProtocolError);
  });

  it("rejects metadata with invalid clip dimensions", () => {
    expect(() =>
      parseBackendMessage({
        protocol: 1,
        type: "metadata",
        session_id: "session-1",
        status: "initialized",
        num_frames: 240,
        fps_num: 24,
        fps_den: 1,
        mode: "single",
        active_clip_ids: [0],
        max_visible_clips: 4,
        clips: [
          {
            id: 0,
            label: "Clip 0",
            source_format: "RGB24",
            source_width: 0,
            source_height: 1080,
            output_width: 960,
            output_height: 540,
            warnings: [],
          },
        ],
      }),
    ).toThrowError(ProtocolError);
  });
});
