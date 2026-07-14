from __future__ import annotations

from pathlib import Path
from typing import Any
from uuid import uuid4

import anywidget
import traitlets

from .protocol import (
    ProtocolError,
    error_message,
    metadata_message,
    parse_frontend_message,
)

_STATIC_DIR = Path(__file__).parent / "static"


class PreviewWidget(anywidget.AnyWidget):
    _esm = _STATIC_DIR / "index.js"
    _css = _STATIC_DIR / "index.css"

    session_id = traitlets.Unicode().tag(sync=True)
    status = traitlets.Unicode("initializing", read_only=True).tag(sync=True)

    def __init__(self, *, session_id: str | None = None, **kwargs: Any) -> None:
        super().__init__(session_id=session_id or uuid4().hex, **kwargs)
        self.on_msg(self._handle_custom_message)

    def _handle_custom_message(
        self,
        _: PreviewWidget,
        content: object,
        buffers: list[memoryview],
    ) -> None:
        del buffers
        try:
            message = parse_frontend_message(content)
            if message["session_id"] != self.session_id:
                raise ProtocolError(
                    "invalid_message",
                    "Ready message has an unknown session.",
                )
        except ProtocolError as error:
            self.set_trait("status", "error")
            self.send(error_message(self.session_id, error))
            return

        self.set_trait("status", "ready")
        self.send(metadata_message(self.session_id))


def preview() -> PreviewWidget:
    return PreviewWidget()
