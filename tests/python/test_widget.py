from __future__ import annotations

from collections.abc import Callable
from fractions import Fraction
from typing import Any

import kaleidoscope
from kaleidoscope import PreviewWidget, preview


class FakeSession:
    def __init__(self) -> None:
        self.closed = False
        self.requests: list[dict[str, object]] = []
        self.acks: list[dict[str, object]] = []

    def request_frame_set(self, **request: object) -> None:
        self.requests.append(request)

    def ack_frame_set(self, **ack: object) -> int:
        self.acks.append(ack)
        return 12

    def close(self) -> None:
        self.closed = True


def make_config(codec: str = "jpeg") -> object:
    return type(
        "Config",
        (),
        {
            "codec": codec,
            "mode": "single",
            "active_clip_ids": (),
        },
    )()


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


def test_widget_metadata_includes_autoplay(monkeypatch: Any) -> None:
    sent: list[dict[str, object]] = []
    session = FakeSession()
    clip = type(
        "Clip",
        (),
        {
            "id": "Source",
            "label": "Source",
            "source_format": "RGB24",
            "source_width": 1,
            "source_height": 1,
            "output_width": 1,
            "output_height": 1,
            "warnings": (),
        },
    )()
    config = type(
        "Config",
        (),
        {
            "codec": "jpeg",
            "mode": "single",
            "active_clip_ids": ("Source",),
            "num_frames": 10,
            "fps": Fraction(24, 1),
            "max_visible_clips": 4,
            "clips": (clip,),
            "autoplay": True,
        },
    )()
    monkeypatch.setattr("kaleidoscope.widget.PreviewSession", lambda **kwargs: session)
    monkeypatch.setattr(
        PreviewWidget,
        "send",
        lambda self, content, buffers=None: sent.append(content),
    )
    widget = PreviewWidget(config=config, session_id="session-1")

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

    assert sent[0]["autoplay"] is True


def test_widget_routes_ack_and_updates_durable_playback_traits(
    monkeypatch: Any,
) -> None:
    sent, make_widget = capture_messages(monkeypatch)
    session = FakeSession()
    widget = make_widget()
    widget._session = session
    widget._frontend_state = "ready"

    widget._handle_custom_message(
        widget,
        {
            "protocol": 1,
            "type": "set_playing",
            "session_id": "session-1",
            "playing": True,
        },
        [],
    )
    widget._handle_custom_message(
        widget,
        {
            "protocol": 1,
            "type": "ack_frame_set",
            "session_id": "session-1",
            "request_id": 7,
            "generation": 2,
            "outcome": "painted",
        },
        [],
    )

    assert sent == []
    assert widget.playing is True
    assert widget.current_frame == 12
    assert session.acks == [
        {
            "request_id": 7,
            "generation": 2,
            "outcome": "painted",
        }
    ]


def test_widget_commits_painted_frame_before_reentrant_delivery(
    monkeypatch: Any,
) -> None:
    auto_ack = False

    class ReentrantSession:
        def ack_frame_set(self, **ack: object) -> int:
            if ack["request_id"] == 0:
                widget._send_session_message(
                    {
                        "protocol": 1,
                        "type": "frame_set",
                        "session_id": "session-1",
                        "request_id": 1,
                        "generation": 0,
                        "frame": 2,
                        "frames": [],
                    },
                    [],
                )
                return 1
            return 2

        def close(self) -> None:
            pass

    def send(
        self: PreviewWidget,
        content: dict[str, object],
        buffers: list[bytes] | None = None,
    ) -> None:
        del self, buffers
        if auto_ack and content.get("type") == "frame_set":
            widget._handle_custom_message(
                widget,
                {
                    "protocol": 1,
                    "type": "ack_frame_set",
                    "session_id": "session-1",
                    "request_id": content["request_id"],
                    "generation": content["generation"],
                    "outcome": "painted",
                },
                [],
            )

    monkeypatch.setattr(PreviewWidget, "send", send)
    widget = PreviewWidget(session_id="session-1")
    widget._session = ReentrantSession()  # type: ignore[assignment]
    widget._frontend_state = "ready"
    widget._send_session_message(
        {
            "protocol": 1,
            "type": "frame_set",
            "session_id": "session-1",
            "request_id": 0,
            "generation": 0,
            "frame": 1,
            "frames": [],
        },
        [],
    )
    auto_ack = True

    widget._handle_custom_message(
        widget,
        {
            "protocol": 1,
            "type": "ack_frame_set",
            "session_id": "session-1",
            "request_id": 0,
            "generation": 0,
            "outcome": "painted",
        },
        [],
    )

    assert widget.current_frame == 2


def test_widget_rejects_webp_when_browser_lacks_support(monkeypatch: Any) -> None:
    sent: list[dict[str, object]] = []
    session = FakeSession()
    monkeypatch.setattr(
        "kaleidoscope.widget.PreviewSession",
        lambda **kwargs: session,
    )
    monkeypatch.setattr(
        PreviewWidget,
        "send",
        lambda self, content, buffers=None: sent.append(content),
    )
    widget = PreviewWidget(config=make_config("webp"), session_id="session-1")

    widget._handle_custom_message(
        widget,
        {
            "protocol": 1,
            "type": "ready",
            "session_id": "session-1",
            "capabilities": {"image_bitmap": True, "webp": False},
        },
        [],
    )

    assert sent == [
        {
            "protocol": 1,
            "type": "error",
            "session_id": "session-1",
            "code": "unsupported_codec",
            "message": "This browser cannot decode WebP previews; use codec='jpeg'.",
            "recoverable": False,
        }
    ]
    assert widget.status == "error"
    assert session.closed is True

    widget._handle_custom_message(
        widget,
        {
            "protocol": 1,
            "type": "request_frame_set",
            "session_id": "session-1",
            "request_id": 0,
            "generation": 0,
            "frame": 0,
            "clip_ids": [0],
            "reason": "seek",
        },
        [],
    )

    assert session.requests == []
    assert sent[-1] == {
        "protocol": 1,
        "type": "error",
        "session_id": "session-1",
        "code": "invalid_message",
        "message": "Preview session is no longer accepting frontend messages.",
        "recoverable": False,
    }


def test_widget_rejects_browser_without_image_bitmap(monkeypatch: Any) -> None:
    sent: list[dict[str, object]] = []
    session = FakeSession()
    monkeypatch.setattr(
        "kaleidoscope.widget.PreviewSession",
        lambda **kwargs: session,
    )
    monkeypatch.setattr(
        PreviewWidget,
        "send",
        lambda self, content, buffers=None: sent.append(content),
    )
    widget = PreviewWidget(config=make_config(), session_id="session-1")

    widget._handle_custom_message(
        widget,
        {
            "protocol": 1,
            "type": "ready",
            "session_id": "session-1",
            "capabilities": {"image_bitmap": False, "webp": False},
        },
        [],
    )

    assert sent == [
        {
            "protocol": 1,
            "type": "error",
            "session_id": "session-1",
            "code": "unsupported_codec",
            "message": (
                "This browser cannot decode preview images because "
                "createImageBitmap is unavailable."
            ),
            "recoverable": False,
        }
    ]
    assert widget.status == "error"
    assert session.closed is True


def test_widget_rejects_frame_request_before_ready(monkeypatch: Any) -> None:
    sent: list[dict[str, object]] = []
    session = FakeSession()
    monkeypatch.setattr(
        "kaleidoscope.widget.PreviewSession",
        lambda **kwargs: session,
    )
    monkeypatch.setattr(
        PreviewWidget,
        "send",
        lambda self, content, buffers=None: sent.append(content),
    )
    widget = PreviewWidget(config=make_config(), session_id="session-1")

    widget._handle_custom_message(
        widget,
        {
            "protocol": 1,
            "type": "request_frame_set",
            "session_id": "session-1",
            "request_id": 0,
            "generation": 0,
            "frame": 0,
            "clip_ids": [0],
            "reason": "seek",
        },
        [],
    )

    assert sent == [
        {
            "protocol": 1,
            "type": "error",
            "session_id": "session-1",
            "code": "invalid_message",
            "message": "Frame requests are not accepted before the ready handshake.",
            "recoverable": False,
        }
    ]
    assert widget.status == "error"
    assert session.closed is True
    assert session.requests == []


def test_widget_rejects_incompatible_protocol_without_metadata(
    monkeypatch: Any,
) -> None:
    sent: list[dict[str, object]] = []
    session = FakeSession()
    monkeypatch.setattr(
        "kaleidoscope.widget.PreviewSession",
        lambda **kwargs: session,
    )
    monkeypatch.setattr(
        PreviewWidget,
        "send",
        lambda self, content, buffers=None: sent.append(content),
    )
    widget = PreviewWidget(config=make_config(), session_id="session-1")

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
    assert session.closed is True

    widget._handle_custom_message(
        widget,
        {
            "protocol": 1,
            "type": "request_frame_set",
            "session_id": "session-1",
            "request_id": 0,
            "generation": 0,
            "frame": 0,
            "clip_ids": [0],
            "reason": "seek",
        },
        [],
    )

    assert session.requests == []
    assert sent[-1]["message"] == (
        "Preview session is no longer accepting frontend messages."
    )
