# Architecture

Kaleidoscope is a Python-owned VapourSynth session paired with a framework-free
TypeScript anywidget view. It transports bounded, independently encoded images
rather than exposing native frame memory to the browser.

## Ownership

`preview()` is the public facade. It snapshots and validates sources into an
immutable `PreviewConfig`, then constructs one `PreviewWidget`. The widget owns
one `PreviewSession`, scheduler, encoded-frame cache, protocol state, and close
lifecycle. Sessions and widgets do not share mutable preview state.

One widget model may have multiple frontend views. Views sharing a
`widget_manager` and `session_id` use one coordinator with a shared request
sequence and current frame. Exactly one view is active. If it is removed, a
surviving view becomes active and resynchronizes with the same backend session;
removing one view does not by itself close that session.

VapourSynth owns source graphs. Kaleidoscope acquires `VideoFrame` objects with
`get_frame_async()`, copies their planes into encoder input, and closes every
acquired frame on success, stale completion, error, and shutdown paths. The
cache stores encoded immutable bytes, never open `VideoFrame` objects.

## RGB24 Boundary

Caller-supplied RGB24 nodes pass through unchanged. Other formats are adapted by
preparing one RGB24 conversion node per clip. That fallback is visible in clip
metadata because automatic color assumptions form part of the security and
correctness boundary: untrusted script metadata is validated and displayed as
text, while conversion stays inside VapourSynth.

## Protocol and Atomic Frame Sets

Custom anywidget messages use protocol version 1 and a per-widget `session_id`.
High-rate frame requests carry a request ID, generation, exact frame, ordered
clip IDs, and reason. A delivered `frame_set` contains one manifest entry and
binary buffer per requested clip.

The backend sends a set only after all requested clips encode successfully. The
browser validates message shape, identity, clip order, MIME, byte lengths, and
payload bounds, decodes into staged canvases, and commits the synchronized set
atomically. Stale, incomplete, failed, or undecodable sets never partially
replace the last complete presentation.

## Backpressure and Scheduling

The Python scheduler bounds submitted clip-frame futures and distributes work
fairly across active clips. Exact paused seeks outrank speculative playback;
queued obsolete playback requests are replaced as a set. The browser permits
exactly one unacknowledged delivery and ACKs it as `painted`, `stale`, or
`decode_error`. The ACK must match that delivery's request ID and generation.
`painted` and `stale` release the window and promote the latest pending
delivery; `decode_error` releases the window and discards the pending delivery.
The backend retains the current delivery until a matching ACK and can replay it
without advancing the window when a replacement view sends `ready`.

The frontend ACKs obsolete new deliveries as `stale`. It ignores a replay of
the delivery it is already processing, and ignores request IDs it has already
ACKed, so handoff cannot acknowledge the same delivery twice. A different new
delivery arriving before the current ACK is a protocol error. Decode work is
also bounded, and only the latest deferred identity is retried.

This is logical cancellation: VapourSynth work already running may finish, but
generation checks suppress obsolete delivery and painting.

## Cache

Each session has an LRU constrained by both entry count and bytes. Its key is
`(clip_id, frame)` because dimensions, codec, quality, lossless mode, and
prepared conversion nodes are immutable for that session. Closing the session
clears the cache. There is no global cache.

## Browser Composition

Single and side-by-side modes present decoded clip canvases. Wipe, overlay, and
difference compose an aligned A/B pair locally, so switching among those modes
does not rerender VapourSynth frames. Canvas swaps and comparison composition
share one commit boundary.

## Lifecycle and Security Boundary

The frontend and backend implement explicit ready, live, disconnected,
terminal, and closed states. The first valid `ready` initializes the session and
may carry configured autoplay. A later valid `ready` is an active-view resync:
the backend sends current metadata with autoplay disabled and replays the one
unacknowledged delivery, if present. Terminal protocol failures and disconnects
gate later controls.

Aborting one frontend view removes only that view's listeners, controllers, and
decode work. A surviving view is activated without a backend `close`. When the
final view is removed while the comm is live, the frontend sends protocol-v1
`close`. Backend close is idempotent, suppresses late sends and trait updates,
closes acquired frames, clears cached bytes, sets the synchronized status trait
to `closed`, and closes the widget/comm. There is no backend `closed` custom
message.

Kaleidoscope shares the notebook kernel's trust boundary. VapourSynth scripts,
native plugins, and frame callbacks execute with the permissions of the kernel
user; only load scripts and plugins you trust.

All external message fields, IDs, dimensions, buffer indices, byte counts, MIME
types, and state transitions are validated. Error text and clip labels are
rendered through text properties rather than HTML. The wheel embeds all browser
code and CSS; runtime operation needs no CDN, analytics endpoint, server
listener, or external HTTP request.

## Benchmark Decisions

The T6 pipeline benchmark retained image-per-frame transport. JPEG 4:2:0 quality
80 is the default because it offered the best measured latency/size balance.
WebP remains selectable, including lossless mode. Original resolution is
preserved and resizing remains an upstream responsibility. NumPy remains a
runtime dependency for efficient planar-to-interleaved conversion. Detailed
measurements are recorded in `tasks/benchmark-report.md` in source distributions.