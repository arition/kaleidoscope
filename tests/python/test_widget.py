from __future__ import annotations

from collections.abc import Callable
from typing import Any

import kaleidoscope
from kaleidoscope import PreviewWidget, preview


def capture_messages(
    monkeypatch: Any,
) -> tuple[list[dict[str, object]], Callable[[], PreviewWidget]]:
    sent: list[dict[str, object]] = []

    def send(
        self: PreviewWidget,
        content: dict[str, object],
        buffers: list[bytes] | None = None,
    ) -> None:
        del self, buffers
        sent.append(content)

    monkeypatch.setattr(PreviewWidget, "send", send)
    return sent, lambda: PreviewWidget(session_id="session-1")


def test_package_exports_widget_and_preview_entry_point() -> None:
    assert kaleidoscope.PreviewWidget is PreviewWidget
    assert kaleidoscope.preview is preview


def test_widget_does_not_send_metadata_before_ready(monkeypatch: Any) -> None:
    sent, make_widget = capture_messages(monkeypatch)

    make_widget()

    assert sent == []


def test_widget_sends_metadata_after_valid_ready(monkeypatch: Any) -> None:
    sent, make_widget = capture_messages(monkeypatch)
    widget = make_widget()

    widget._handle_custom_message(
        widget,
        {
            "protocol": 1,
            "type": "ready",
            "session_id": "session-1",
            "capabilities": {"image_bitmap": True, "webp": True},
        },
        [],
    )

    assert sent == [
        {
            "protocol": 1,
            "type": "metadata",
            "session_id": "session-1",
            "status": "initialized",
        }
    ]
    assert widget.status == "ready"


def test_widget_rejects_incompatible_protocol_without_metadata(
    monkeypatch: Any,
) -> None:
    sent, make_widget = capture_messages(monkeypatch)
    widget = make_widget()

    widget._handle_custom_message(
        widget,
        {
            "protocol": 2,
            "type": "ready",
            "session_id": "session-1",
            "capabilities": {"image_bitmap": True, "webp": True},
        },
        [],
    )

    assert sent == [
        {
            "protocol": 1,
            "type": "error",
            "session_id": "session-1",
            "code": "protocol_mismatch",
            "message": "Unsupported protocol version 2; expected 1.",
            "recoverable": False,
        }
    ]
    assert widget.status == "error"
