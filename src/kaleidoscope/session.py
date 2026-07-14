from __future__ import annotations

import logging
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from threading import Lock, RLock
from time import perf_counter
from typing import Any, cast

from .encoding import MAX_ENCODED_FRAME_BYTES, EncodedImage, encode_jpeg
from .frame_adapter import RGB24Frame, interleave_rgb24
from .protocol import FrameManifest, frame_set_message, runtime_error_message
from .scheduler import FrameSetScheduler, ScheduledFrame
from .sources import ClipId, NormalizedClip, PreviewConfig

_LOGGER = logging.getLogger(__name__)

type SendMessage = Callable[[dict[str, object], list[bytes]], None]
type Encoder = Callable[[bytes, int, int, int], EncodedImage]
type Clock = Callable[[], float]


class ClosableRGB24Frame(RGB24Frame):
    def close(self) -> None: ...


@dataclass(frozen=True, slots=True)
class _CompletedFrame:
    encoded: EncodedImage
    render_ms: float
    encode_ms: float


@dataclass(slots=True)
class _FrameSetRequest:
    request_id: int
    generation: int
    frame: int
    clip_ids: tuple[ClipId, ...]
    completed: dict[ClipId, _CompletedFrame] = field(default_factory=dict)


@dataclass(slots=True)
class _SubmissionState:
    render_started: float = 0.0


class PreviewSession:
    def __init__(
        self,
        *,
        session_id: str,
        config: PreviewConfig,
        send: SendMessage,
        encoder: Encoder = encode_jpeg,
        clock: Clock = perf_counter,
    ) -> None:
        self._session_id = session_id
        self._config = config
        self._send = send
        self._encoder = encoder
        self._clock = clock
        self._clips = {clip.id: clip for clip in config.clips}
        self._lock = Lock()
        self._delivery_lock = RLock()
        self._current_request: _FrameSetRequest | None = None
        self._scheduler = FrameSetScheduler(config.max_in_flight)
        self._closed = False

    def close(self) -> None:
        with self._delivery_lock:
            with self._lock:
                self._closed = True
                if self._current_request is not None:
                    self._current_request.completed.clear()
                self._current_request = None
            self._scheduler.close()

    def _is_current(self, request: _FrameSetRequest) -> bool:
        with self._lock:
            return not self._closed and self._current_request is request

    def _send_error(
        self,
        *,
        request: _FrameSetRequest,
        clip_id: ClipId,
        code: str,
        message: str,
    ) -> None:
        with self._delivery_lock:
            with self._lock:
                if self._closed or self._current_request is not request:
                    return
                request.completed.clear()
                self._current_request = None
                outbound = runtime_error_message(
                    self._session_id,
                    request_id=request.request_id,
                    generation=request.generation,
                    clip_id=clip_id,
                    code=code,
                    message=message,
                )
            self._send(outbound, [])

    @staticmethod
    def _render_error(clip: NormalizedClip) -> tuple[str, str]:
        if clip.source_format != "RGB24":
            return (
                "conversion_failed",
                "The preview frame could not be converted to RGB24.",
            )
        return "render_failed", "The preview frame could not be rendered."

    def request_frame_set(
        self,
        *,
        request_id: int,
        generation: int,
        frame: int,
        clip_ids: Sequence[ClipId],
    ) -> None:
        if not 0 <= frame < self._config.num_frames:
            raise ValueError("Requested frame is outside the clip timeline.")
        ordered_clip_ids = tuple(clip_ids)
        if not 1 <= len(ordered_clip_ids) <= 4:
            raise ValueError("A frame set requires between one and four clips.")
        if len(set(ordered_clip_ids)) != len(ordered_clip_ids):
            raise ValueError("A frame set cannot contain duplicate clip IDs.")

        clips: list[NormalizedClip] = []
        for clip_id in ordered_clip_ids:
            try:
                clip = self._clips[clip_id]
            except KeyError as error:
                raise ValueError(f"Unknown clip ID {clip_id!r}.") from error
            if clip.preview_format != "RGB24":
                raise ValueError("The preview clip must be prepared as RGB24.")
            clips.append(clip)

        request = _FrameSetRequest(
            request_id=request_id,
            generation=generation,
            frame=frame,
            clip_ids=ordered_clip_ids,
        )
        scheduled_frames: list[ScheduledFrame] = []
        for clip in clips:
            submission_state = _SubmissionState()

            def submit(
                *,
                submitted_clip: NormalizedClip = clip,
                state: _SubmissionState = submission_state,
            ) -> Any | None:
                if not self._is_current(request):
                    return None
                state.render_started = self._clock()
                node = cast(Any, submitted_clip.node)
                return node.get_frame_async(frame)

            def submission_failed(
                error: Exception,
                *,
                submitted_clip: NormalizedClip = clip,
            ) -> None:
                _LOGGER.exception(
                    "Failed to submit frame %s for clip %r",
                    frame,
                    submitted_clip.id,
                    exc_info=error,
                )
                code, user_message = self._render_error(submitted_clip)
                self._send_error(
                    request=request,
                    clip_id=submitted_clip.id,
                    code=code,
                    message=user_message,
                )

            def completed(
                completed_future: Any,
                *,
                completed_clip: NormalizedClip = clip,
                state: _SubmissionState = submission_state,
            ) -> None:
                self._complete_frame(
                    completed_future,
                    request=request,
                    clip=completed_clip,
                    render_started=state.render_started,
                )

            scheduled_frames.append(
                ScheduledFrame(
                    fairness_key=clip.id,
                    submit=submit,
                    completed=completed,
                    submission_failed=submission_failed,
                )
            )
        with self._delivery_lock:
            with self._lock:
                if self._closed:
                    return
                if self._current_request is not None:
                    self._current_request.completed.clear()
                self._current_request = request
            self._scheduler.replace_pending(scheduled_frames)

    def _complete_frame(
        self,
        future: Any,
        *,
        request: _FrameSetRequest,
        clip: NormalizedClip,
        render_started: float,
    ) -> None:
        try:
            frame = cast(ClosableRGB24Frame, future.result())
        except Exception:
            _LOGGER.exception(
                "Failed to render frame %s for clip %r",
                request.frame,
                clip.id,
            )
            code, user_message = self._render_error(clip)
            self._send_error(
                request=request,
                clip_id=clip.id,
                code=code,
                message=user_message,
            )
            return

        encoded: EncodedImage | None = None
        render_ms = max(0.0, (self._clock() - render_started) * 1000)
        try:
            if not self._is_current(request):
                return
            if frame.width != clip.output_width or frame.height != clip.output_height:
                raise ValueError("Rendered frame dimensions do not match the preview.")
            pixels = interleave_rgb24(frame)
            encode_started = self._clock()
            encoded = self._encoder(
                pixels,
                frame.width,
                frame.height,
                self._config.quality,
            )
            if (
                encoded.mime not in {"image/jpeg", "image/webp"}
                or not encoded.data
                or len(encoded.data) > MAX_ENCODED_FRAME_BYTES
            ):
                raise ValueError("Encoded frame is outside the transport bounds.")
            encode_ms = max(0.0, (self._clock() - encode_started) * 1000)
        except Exception:
            _LOGGER.exception(
                "Failed to encode frame %s for clip %r",
                request.frame,
                clip.id,
            )
            self._send_error(
                request=request,
                clip_id=clip.id,
                code="encode_failed",
                message="The preview frame could not be encoded.",
            )
            return
        finally:
            frame.close()

        with self._delivery_lock:
            with self._lock:
                if self._closed or self._current_request is not request:
                    return
                request.completed[clip.id] = _CompletedFrame(
                    encoded=encoded,
                    render_ms=render_ms,
                    encode_ms=encode_ms,
                )
                if len(request.completed) != len(request.clip_ids):
                    return
                completed_frames = [
                    request.completed[clip_id] for clip_id in request.clip_ids
                ]
                manifests: list[FrameManifest] = []
                buffers: list[bytes] = []
                for buffer_index, (clip_id, completed_frame) in enumerate(
                    zip(request.clip_ids, completed_frames, strict=True)
                ):
                    manifests.append(
                        {
                            "clip_id": clip_id,
                            "buffer_index": buffer_index,
                            "mime": completed_frame.encoded.mime,
                            "byte_length": len(completed_frame.encoded.data),
                            "render_ms": completed_frame.render_ms,
                            "encode_ms": completed_frame.encode_ms,
                        }
                    )
                    buffers.append(completed_frame.encoded.data)
                outbound = frame_set_message(
                    self._session_id,
                    request_id=request.request_id,
                    generation=request.generation,
                    frame=request.frame,
                    frames=manifests,
                )
                self._current_request = None
            self._send(outbound, buffers)
