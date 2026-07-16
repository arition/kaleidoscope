import { render } from "./index.js";
import payload from "./cases.js";

const selectedName = new URLSearchParams(location.search).get("case") ?? "single";
const selected = payload.cases.find((candidate) => candidate.name === selectedName);
if (selected === undefined) {
  throw new Error(`Unknown installed-browser case ${selectedName}.`);
}

const sessionId = `installed-${selected.name}`;
const messages = [];
let messageHandler;

const decode = (value) => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
};

const emit = (message, buffers = []) => {
  messageHandler?.(message, buffers);
};

const model = {
  widget_manager: {},
  get(key) {
    if (key === "session_id") {
      return sessionId;
    }
    if (key === "current_frame") {
      return 0;
    }
    if (key === "comm_live") {
      return true;
    }
    return undefined;
  },
  set() {},
  save_changes() {},
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
          mode: selected.mode,
          active_clip_ids: selected.clip_ids,
          overlay_opacity: 0.5,
          max_visible_clips: 4,
          autoplay: false,
          clips: selected.clip_ids.map((clipId) => ({
            id: clipId,
            label: String(clipId),
            source_format: "RGB24",
            source_width: 64,
            source_height: 48,
            output_width: 64,
            output_height: 48,
            warnings: [],
          })),
        });
      });
      return;
    }
    if (message.type === "request_frame_set") {
      const buffers = selected.buffers.map(decode);
      queueMicrotask(() => {
        emit(
          {
            ...selected.frame_set,
            session_id: sessionId,
            request_id: message.request_id,
            generation: message.generation,
            frame: message.frame,
          },
          buffers.map((buffer) => new DataView(buffer)),
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