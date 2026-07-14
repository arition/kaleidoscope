from __future__ import annotations

import logging
from collections.abc import Callable, Sequence
from time import perf_counter
from typing import Any, cast

from .encoding import EncodedImage, encode_jpeg
from .frame_adapter import RGB24Frame, interleave_rgb24
from .protocol import frame_set_message, runtime_error_message
from .sources import ClipId, NormalizedClip, PreviewConfig

_LOGGER = logging.getLogger(__name__)

type SendMessage = Callable[[dict[str, object], list[bytes]], None]
type Encoder = Callable[[bytes, int, int, int], EncodedImage]
type Clock = Callable[[], float]


class ClosableRGB24Frame(RGB24Frame):
    def close(self) -> None: ...


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
        self._current_request: tuple[int, int] | None = None
        self._closed = False

    def close(self) -> None:
        self._closed = True
        self._current_request = None

    def _is_current(self, generation: int, request_id: int) -> bool:
        return not self._closed and self._current_request == (generation, request_id)

    def _send_error(
        self,
        *,
        request_id: int,
        generation: int,
        clip_id: ClipId,
        code: str,
        message: str,
    ) -> None:
        if not self._is_current(generation, request_id):
            return
        self._send(
            runtime_error_message(
                self._session_id,
                request_id=request_id,
                generation=generation,
                clip_id=clip_id,
                code=code,
                message=message,
            ),
            [],
        )

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
        if self._closed:
            return
        if not 0 <= frame < self._config.num_frames:
            raise ValueError("Requested frame is outside the clip timeline.")
        if len(clip_ids) != 1:
            raise ValueError("The single-frame path requires exactly one clip.")

        clip_id = clip_ids[0]
        try:
            clip = self._clips[clip_id]
        except KeyError as error:
            raise ValueError(f"Unknown clip ID {clip_id!r}.") from error
        if clip.preview_format != "RGB24":
            raise ValueError("The preview clip must be prepared as RGB24.")

        self._current_request = (generation, request_id)
        render_started = self._clock()
        try:
            node = cast(Any, clip.node)
            future: Any = node.get_frame_async(frame)
        except Exception:
            _LOGGER.exception("Failed to submit frame %s for clip %r", frame, clip_id)
            code, user_message = self._render_error(clip)
            self._send_error(
                request_id=request_id,
                generation=generation,
                clip_id=clip_id,
                code=code,
                message=user_message,
            )
            return

        def completed(completed_future: Any) -> None:
            self._complete_frame(
                completed_future,
                request_id=request_id,
                generation=generation,
                frame_number=frame,
                clip=clip,
                render_started=render_started,
            )

        future.add_done_callback(completed)

    def _complete_frame(
        self,
        future: Any,
        *,
        request_id: int,
        generation: int,
        frame_number: int,
        clip: NormalizedClip,
        render_started: float,
    ) -> None:
        try:
            frame = cast(ClosableRGB24Frame, future.result())
        except Exception:
            _LOGGER.exception(
                "Failed to render frame %s for clip %r",
                frame_number,
                clip.id,
            )
            code, user_message = self._render_error(clip)
            self._send_error(
                request_id=request_id,
                generation=generation,
                clip_id=clip.id,
                code=code,
                message=user_message,
            )
            return

        encoded: EncodedImage | None = None
        render_ms = max(0.0, (self._clock() - render_started) * 1000)
        try:
            if not self._is_current(generation, request_id):
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
            encode_ms = max(0.0, (self._clock() - encode_started) * 1000)
        except Exception:
            _LOGGER.exception(
                "Failed to encode frame %s for clip %r",
                frame_number,
                clip.id,
            )
            self._send_error(
                request_id=request_id,
                generation=generation,
                clip_id=clip.id,
                code="encode_failed",
                message="The preview frame could not be encoded.",
            )
            return
        finally:
            frame.close()

        if not self._is_current(generation, request_id):
            return
        message = frame_set_message(
            self._session_id,
            request_id=request_id,
            generation=generation,
            frame=frame_number,
            clip_id=clip.id,
            mime=encoded.mime,
            byte_length=len(encoded.data),
            render_ms=render_ms,
            encode_ms=encode_ms,
        )
        self._send(message, [encoded.data])
