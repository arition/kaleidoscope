import { render } from "/src/kaleidoscope/static/index.js";

const sessionId = "browser-session";
const messages = [];
let messageHandler;
const showConversionWarning = new URLSearchParams(window.location.search).has(
  "conversion",
);
const showSideBySide = new URLSearchParams(window.location.search).has(
  "side-by-side",
);
const testComparison = new URLSearchParams(window.location.search).has(
  "comparison",
);
const showWebp = new URLSearchParams(window.location.search).get("codec") === "webp";
const testRapidSeek = new URLSearchParams(window.location.search).has(
  "rapid-seek",
);
const testPlayback = new URLSearchParams(window.location.search).has(
  "playback",
);
const testSlowPlayback = new URLSearchParams(window.location.search).has(
  "slow-playback",
);
const clipId = showConversionWarning ? "Filtered" : "Source";
let activeClipIds =
  showSideBySide || testComparison ? ["Source", "Filtered"] : [clipId];

const clip = (id, sourceFormat = "RGB24", warnings = []) => ({
  id,
  label: id,
  source_format: sourceFormat,
  source_width: 64,
  source_height: 48,
  output_width: 64,
  output_height: 48,
  warnings,
});

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
          num_frames: testRapidSeek ? 10 : testPlayback ? 4 : testSlowPlayback ? 6 : 1,
          fps_num: testSlowPlayback ? 8 : 24,
          fps_den: 1,
          mode: showSideBySide || testComparison ? "side-by-side" : "single",
          active_clip_ids: activeClipIds,
          overlay_opacity: 0.5,
          max_visible_clips: testComparison ? 2 : 4,
          autoplay: false,
          clips: showSideBySide || testComparison
            ? [clip("Source"), clip("Filtered"), ...(testComparison ? [clip("Reference")] : [])]
            : [
                clip(
                  clipId,
                  showConversionWarning ? "YUV420P8" : "RGB24",
                  showConversionWarning
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
                ),
              ],
        });
      });
      return;
    }
    if (message.type === "set_view") {
      activeClipIds = [...message.clip_ids];
      return;
    }
    if (message.type === "request_frame_set") {
      const responseClipIds = [...message.clip_ids];
      const fixtureNames = responseClipIds.map((id) =>
        showConversionWarning
          ? "frame.jpg"
          : id === "Source"
          ? showWebp
            ? "frame.webp"
            : "frame.jpg"
          : id === "Filtered"
            ? "filtered.jpg"
            : "reference.jpg",
      );
      const responseDelay =
        testRapidSeek && message.frame === 2
          ? 120
          : testSlowPlayback && message.frame === 1
            ? 800
            : 0;
      void Promise.all(
        fixtureNames.map((name) =>
          fetch(`./${name}`).then((response) => response.arrayBuffer()),
        ),
      ).then((buffers) => {
        setTimeout(() => {
          emit(
            {
              protocol: 1,
              type: "frame_set",
              session_id: sessionId,
              request_id: message.request_id,
              generation: message.generation,
              frame: message.frame,
                frames: responseClipIds.map((activeClipId, bufferIndex) => ({
                  clip_id: activeClipId,
                  buffer_index: bufferIndex,
                  mime: showWebp ? "image/webp" : "image/jpeg",
                  byte_length: buffers[bufferIndex].byteLength,
                  render_ms: 0,
                  encode_ms: 0,
                })),
            },
            buffers.map((buffer) => new DataView(buffer)),
          );
        }, responseDelay);
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
