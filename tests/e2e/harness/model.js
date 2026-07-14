import { render } from "/src/kaleidoscope/static/index.js";

const sessionId = "browser-session";
const messages = [];
let messageHandler;
const showConversionWarning = new URLSearchParams(window.location.search).has(
  "conversion",
);
const clipId = showConversionWarning ? "Filtered" : "Source";

const emit = (message, buffers = []) => {
  messageHandler?.(message, buffers);
};

const model = {
  get(key) {
    return key === "session_id" ? sessionId : undefined;
  },
  on(eventName, callback) {
    if (eventName === "msg:custom") {
      messageHandler = callback;
    }
  },
  off(eventName, callback) {
    if (eventName === "msg:custom" && messageHandler === callback) {
      messageHandler = undefined;
    }
  },
  send(message) {
    messages.push(message);
    if (message.type === "ready") {
      queueMicrotask(() => {
        emit({
          protocol: 1,
          type: "metadata",
          session_id: sessionId,
          status: "initialized",
          num_frames: 1,
          fps_num: 24,
          fps_den: 1,
          mode: "single",
          active_clip_ids: [clipId],
          max_visible_clips: 4,
          clips: [
            {
              id: clipId,
              label: clipId,
              source_format: showConversionWarning ? "YUV420P8" : "RGB24",
              source_width: 64,
              source_height: 48,
              output_width: 64,
              output_height: 48,
              warnings: showConversionWarning
                ? [
                    {
                      code: "automatic_rgb24_conversion",
                      message:
                        "YUV420P8 is being converted automatically for preview; convert to RGB24 explicitly upstream for controlled color handling.",
                    },
                    {
                      code: "assumed_color_metadata",
                      message:
                        "Source color metadata is incomplete; preview assumes matrix BT.709, transfer BT.709, and range limited.",
                    },
                  ]
                : [],
            },
          ],
        });
      });
      return;
    }
    if (message.type === "request_frame_set") {
      void fetch("./frame.jpg")
        .then((response) => response.arrayBuffer())
        .then((buffer) => {
          emit(
            {
              protocol: 1,
              type: "frame_set",
              session_id: sessionId,
              request_id: message.request_id,
              generation: message.generation,
              frame: message.frame,
              frames: [
                {
                  clip_id: clipId,
                  buffer_index: 0,
                  mime: "image/jpeg",
                  byte_length: buffer.byteLength,
                  render_ms: 0,
                  encode_ms: 0,
                },
              ],
            },
            [new DataView(buffer)],
          );
        });
    }
  },
};

window.__kaleidoscopeMessages = messages;
render({
  model,
  el: document.querySelector("#widget"),
  signal: new AbortController().signal,
});
