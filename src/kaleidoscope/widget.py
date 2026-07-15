from __future__ import annotations

from pathlib import Path
from threading import RLock
from typing import TYPE_CHECKING, Any, Literal
from uuid import uuid4

import anywidget
import traitlets

from .protocol import (
    ProtocolError,
    error_message,
    metadata_message,
    parse_frontend_message,
)
from .session import PreviewSession

if TYPE_CHECKING:
    from .protocol import PreviewMetadataPayload, SetViewMessage
    from .sources import PreviewConfig

_STATIC_DIR = Path(__file__).parent / "static"


class PreviewWidget(anywidget.AnyWidget):
    _esm = _STATIC_DIR / "index.js"
    _css = _STATIC_DIR / "index.css"

    session_id = traitlets.Unicode().tag(sync=True)
    status = traitlets.Unicode("initializing", read_only=True).tag(sync=True)
    current_frame = traitlets.Int(0, read_only=True).tag(sync=True)
    playing = traitlets.Bool(False, read_only=True).tag(sync=True)
    mode = traitlets.Unicode("single", read_only=True).tag(sync=True)
    active_clip_ids: traitlets.List[Any] = traitlets.List(read_only=True).tag(sync=True)

    def __init__(
        self,
        *,
        config: PreviewConfig | None = None,
        session_id: str | None = None,
        **kwargs: Any,
    ) -> None:
        super().__init__(session_id=session_id or uuid4().hex, **kwargs)
        self._state_lock = RLock()
        self._config = config
        self._session = (
            PreviewSession(
                session_id=self.session_id,
                config=config,
                send=self._send_session_message,
            )
            if config is not None
            else None
        )
        if config is not None:
            self.set_trait("mode", config.mode)
            self.set_trait("active_clip_ids", list(config.active_clip_ids))
        self._view_generation = 0
        self._latest_generation = 0
        self._view_mode = config.mode if config is not None else "single"
        self._view_active_clip_ids = (
            tuple(config.active_clip_ids) if config is not None else ()
        )
        self._frontend_state: Literal["awaiting_ready", "ready", "terminal"] = (
            "awaiting_ready"
        )
        self._close_completed = False
        self._delivered_frames: dict[tuple[int, int], int] = {}
        self.on_msg(self._handle_custom_message)

    def _reject_frontend_message(self, error: ProtocolError) -> None:
        with self._state_lock:
            if self._close_completed:
                return
            self._frontend_state = "terminal"
            self.set_trait("status", "error")
            self.set_trait("playing", False)
            self._delivered_frames.clear()
        if self._session is not None:
            self._session.close()
        self.send(error_message(self.session_id, error))

    def _metadata_payload(self) -> PreviewMetadataPayload | None:
        if self._config is None:
            return None
        return {
            "num_frames": self._config.num_frames,
            "fps_num": self._config.fps.numerator,
            "fps_den": self._config.fps.denominator,
            "mode": self._config.mode,
            "active_clip_ids": list(self._config.active_clip_ids),
            "overlay_opacity": self._config.overlay_opacity,
            "max_visible_clips": self._config.max_visible_clips,
            "autoplay": self._config.autoplay,
            "clips": [
                {
                    "id": clip.id,
                    "label": clip.label,
                    "source_format": clip.source_format,
                    "source_width": clip.source_width,
                    "source_height": clip.source_height,
                    "output_width": clip.output_width,
                    "output_height": clip.output_height,
                    "warnings": [
                        {
                            "code": warning.code,
                            "message": warning.message,
                        }
                        for warning in clip.warnings
                    ],
                }
                for clip in self._config.clips
            ],
        }

    def _handle_custom_message(
        self,
        _: PreviewWidget,
        content: object,
        buffers: list[memoryview],
    ) -> None:
        del buffers
        if self._frontend_state == "terminal":
            self.send(
                error_message(
                    self.session_id,
                    ProtocolError(
                        "invalid_message",
                        "Preview session is no longer accepting frontend messages.",
                    ),
                )
            )
            return
        try:
            message = parse_frontend_message(content)
            if message["session_id"] != self.session_id:
                raise ProtocolError(
                    "invalid_message",
                    "Frontend message has an unknown session.",
                )
        except ProtocolError as protocol_error:
            self._reject_frontend_message(protocol_error)
            return

        if message["type"] == "ready":
            if self._frontend_state != "awaiting_ready":
                self._reject_frontend_message(
                    ProtocolError(
                        "invalid_message",
                        "The ready handshake has already completed.",
                    )
                )
                return
            if not message["capabilities"]["image_bitmap"]:
                self._reject_frontend_message(
                    ProtocolError(
                        "unsupported_codec",
                        "This browser cannot decode preview images because "
                        "createImageBitmap is unavailable.",
                    )
                )
                return
            if (
                self._config is not None
                and self._config.codec == "webp"
                and not message["capabilities"]["webp"]
            ):
                self._reject_frontend_message(
                    ProtocolError(
                        "unsupported_codec",
                        "This browser cannot decode WebP previews; use codec='jpeg'.",
                    )
                )
                return
            self._frontend_state = "ready"
            self.set_trait("status", "ready")
            self.send(metadata_message(self.session_id, self._metadata_payload()))
            return

        if self._frontend_state != "ready":
            self._reject_frontend_message(
                ProtocolError(
                    "invalid_message",
                    "Frame requests are not accepted before the ready handshake.",
                )
            )
            return

        if self._session is None:
            self._reject_frontend_message(
                ProtocolError(
                    "invalid_message",
                    "Frame requests require an initialized preview session.",
                )
            )
            return

        try:
            if message["type"] == "set_playing":
                self.set_trait("playing", message["playing"])
                return
            if message["type"] == "set_view":
                self._apply_view(message)
                return
            if message["type"] == "ack_frame_set":
                identity = (message["request_id"], message["generation"])
                with self._state_lock:
                    delivered_frame = self._delivered_frames.pop(identity, None)
                    if (
                        message["outcome"] == "painted"
                        and delivered_frame is not None
                        and not self._close_completed
                    ):
                        self.set_trait("current_frame", delivered_frame)
                frame = self._session.ack_frame_set(
                    request_id=message["request_id"],
                    generation=message["generation"],
                    outcome=message["outcome"],
                )
                if message["outcome"] == "painted" and delivered_frame is None:
                    with self._state_lock:
                        if not self._close_completed:
                            self.set_trait("current_frame", frame)
                return
            if (
                self._view_active_clip_ids
                and tuple(message["clip_ids"]) != self._view_active_clip_ids
            ):
                raise ValueError(
                    "Frame-set request clip IDs do not match the active view."
                )
            if message["generation"] < self._view_generation:
                raise ValueError(
                    "Frame-set request generation is older than the active view."
                )
            self._session.request_frame_set(
                request_id=message["request_id"],
                generation=message["generation"],
                frame=message["frame"],
                clip_ids=message["clip_ids"],
            )
            self._latest_generation = max(
                self._latest_generation,
                message["generation"],
            )
        except ValueError as exception:
            self._reject_frontend_message(
                ProtocolError("invalid_message", str(exception))
            )

    def _apply_view(self, message: SetViewMessage) -> None:
        if self._config is None:
            raise ValueError("Comparison views require initialized clip metadata.")
        generation = message["generation"]
        mode = message["mode"]
        clip_ids = tuple(message["clip_ids"])
        clips = {clip.id: clip for clip in self._config.clips}
        if any(clip_id not in clips for clip_id in clip_ids):
            raise ValueError("Comparison view contains an unknown clip ID.")
        if len(clip_ids) > self._config.max_visible_clips:
            raise ValueError(
                "Comparison view exceeds the configured visible-clip limit."
            )
        if mode in {"wipe", "overlay", "difference"}:
            first, second = (clips[clip_id] for clip_id in clip_ids)
            if (
                first.source_width != second.source_width
                or first.source_height != second.source_height
            ):
                raise ValueError(
                    "Aligned comparison clips require matching source dimensions."
                )
        active_changed = clip_ids != self._view_active_clip_ids
        if generation < self._latest_generation:
            raise ValueError(
                "Comparison view generation is older than the latest request."
            )
        if (
            active_changed
            and generation == self._latest_generation
            and generation > self._view_generation
        ):
            raise ValueError(
                "An active comparison view must be announced before its frame request."
            )
        if generation < self._view_generation or (
            active_changed and generation == self._view_generation
        ):
            raise ValueError("Comparison view generation must advance monotonically.")
        if generation > self._latest_generation:
            if self._session is None:
                raise ValueError("Comparison views require an initialized session.")
            self._session.advance_generation(generation)
            self._latest_generation = generation
        self._view_generation = generation
        self._view_mode = mode
        self._view_active_clip_ids = clip_ids
        self.set_trait("mode", mode)
        self.set_trait("active_clip_ids", list(clip_ids))

    def _send_session_message(
        self,
        content: dict[str, object],
        buffers: list[bytes],
    ) -> None:
        with self._state_lock:
            if self._frontend_state == "terminal":
                return
            if content.get("type") == "frame_set":
                request_id = content.get("request_id")
                generation = content.get("generation")
                frame = content.get("frame")
                if (
                    isinstance(request_id, int)
                    and isinstance(generation, int)
                    and isinstance(frame, int)
                ):
                    self._delivered_frames[(request_id, generation)] = frame
            self.send(content, buffers=buffers)

    def close(self) -> None:
        with self._state_lock:
            if self._close_completed:
                return
            self._close_completed = True
            self._frontend_state = "terminal"
            self.set_trait("status", "closed")
            self.set_trait("playing", False)
            self._delivered_frames.clear()
        if self._session is not None:
            self._session.close()
        super().close()
