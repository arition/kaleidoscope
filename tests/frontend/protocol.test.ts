import { describe, expect, it } from "vitest";

import {
  PROTOCOL_VERSION,
  ProtocolError,
  createReadyMessage,
  parseBackendMessage,
  validateFrameSetBuffers,
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

  it("rejects metadata with an unknown warning code", () => {
    expect(() =>
      parseBackendMessage({
        protocol: 1,
        type: "metadata",
        session_id: "session-1",
        status: "initialized",
        num_frames: 1,
        fps_num: 24,
        fps_den: 1,
        mode: "single",
        active_clip_ids: [0],
        max_visible_clips: 4,
        clips: [
          {
            id: 0,
            label: "Clip 0",
            source_format: "YUV420P8",
            source_width: 640,
            source_height: 360,
            output_width: 640,
            output_height: 360,
            warnings: [{ code: "unknown", message: "Unexpected warning." }],
          },
        ],
      }),
    ).toThrowError(ProtocolError);
  });

  it("accepts a bounded single-frame manifest", () => {
    expect(
      parseBackendMessage({
        protocol: 1,
        type: "frame_set",
        session_id: "session-1",
        request_id: 7,
        generation: 0,
        frame: 0,
        frames: [
          {
            clip_id: "Source",
            buffer_index: 0,
            mime: "image/jpeg",
            byte_length: 631,
            render_ms: 1.5,
            encode_ms: 0.8,
          },
        ],
      }),
    ).toMatchObject({ type: "frame_set", frame: 0 });
  });

  it("rejects a frame manifest with an empty payload", () => {
    expect(() =>
      parseBackendMessage({
        protocol: 1,
        type: "frame_set",
        session_id: "session-1",
        request_id: 7,
        generation: 0,
        frame: 0,
        frames: [
          {
            clip_id: "Source",
            buffer_index: 0,
            mime: "image/jpeg",
            byte_length: 0,
            render_ms: 1.5,
            encode_ms: 0.8,
          },
        ],
      }),
    ).toThrowError(ProtocolError);
  });

  it("rejects non-deterministic buffer indices for atomic frame sets", () => {
    expect(() =>
      parseBackendMessage({
        protocol: 1,
        type: "frame_set",
        session_id: "session-1",
        request_id: 7,
        generation: 0,
        frame: 0,
        frames: [
          {
            clip_id: "Source",
            buffer_index: 1,
            mime: "image/jpeg",
            byte_length: 4,
            render_ms: 1.5,
            encode_ms: 0.8,
          },
          {
            clip_id: "Filtered",
            buffer_index: 0,
            mime: "image/jpeg",
            byte_length: 4,
            render_ms: 1.8,
            encode_ms: 0.9,
          },
        ],
      }),
    ).toThrowError(ProtocolError);
  });

  it("preserves validated clip context on a recoverable error", () => {
    expect(
      parseBackendMessage({
        protocol: 1,
        type: "error",
        session_id: "session-1",
        request_id: 7,
        generation: 2,
        clip_id: "Filtered",
        code: "render_failed",
        message: "The preview frame could not be rendered.",
        recoverable: true,
      }),
    ).toMatchObject({
      request_id: 7,
      generation: 2,
      clip_id: "Filtered",
    });
  });

  it("rejects incomplete recoverable error context", () => {
    expect(() =>
      parseBackendMessage({
        protocol: 1,
        type: "error",
        session_id: "session-1",
        request_id: 7,
        code: "render_failed",
        message: "The preview frame could not be rendered.",
        recoverable: true,
      }),
    ).toThrowError(ProtocolError);
  });

  it("rejects binary payloads whose byte length differs from the manifest", () => {
    const message = parseBackendMessage({
      protocol: 1,
      type: "frame_set",
      session_id: "session-1",
      request_id: 7,
      generation: 0,
      frame: 0,
      frames: [
        {
          clip_id: "Source",
          buffer_index: 0,
          mime: "image/jpeg",
          byte_length: 4,
          render_ms: 1.5,
          encode_ms: 0.8,
        },
      ],
    });
    if (message.type !== "frame_set") {
      throw new Error("Expected a frame-set message.");
    }

    expect(() =>
      validateFrameSetBuffers(
        message,
        [new DataView(new Uint8Array([1, 2, 3]).buffer)],
      ),
    ).toThrowError(ProtocolError);
  });
});
