from __future__ import annotations

from pathlib import Path
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
    from .sources import PreviewConfig

_STATIC_DIR = Path(__file__).parent / "static"


class PreviewWidget(anywidget.AnyWidget):
    _esm = _STATIC_DIR / "index.js"
    _css = _STATIC_DIR / "index.css"

    session_id = traitlets.Unicode().tag(sync=True)
    status = traitlets.Unicode("initializing", read_only=True).tag(sync=True)
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
        self._frontend_state: Literal["awaiting_ready", "ready", "terminal"] = (
            "awaiting_ready"
        )
        self.on_msg(self._handle_custom_message)

    def _reject_frontend_message(self, error: ProtocolError) -> None:
        self._frontend_state = "terminal"
        self.set_trait("status", "error")
        if self._session is not None:
            self._session.close()
        self.send(error_message(self.session_id, error))

    def _metadata_payload(self) -> dict[str, object] | None:
        if self._config is None:
            return None
        return {
            "num_frames": self._config.num_frames,
            "fps_num": self._config.fps.numerator,
            "fps_den": self._config.fps.denominator,
            "mode": self._config.mode,
            "active_clip_ids": list(self._config.active_clip_ids),
            "max_visible_clips": self._config.max_visible_clips,
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
            self._session.request_frame_set(
                request_id=message["request_id"],
                generation=message["generation"],
                frame=message["frame"],
                clip_ids=message["clip_ids"],
            )
        except ValueError as exception:
            self._reject_frontend_message(
                ProtocolError("invalid_message", str(exception))
            )

    def _send_session_message(
        self,
        content: dict[str, object],
        buffers: list[bytes],
    ) -> None:
        self.send(content, buffers=buffers)

    def close(self) -> None:
        self._frontend_state = "terminal"
        if self._session is not None:
            self._session.close()
        super().close()
