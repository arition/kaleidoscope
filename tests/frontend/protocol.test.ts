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
      }),
    ).toEqual({
      protocol: 1,
      type: "metadata",
      session_id: "session-1",
      status: "initialized",
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
});
