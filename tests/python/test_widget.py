from __future__ import annotations

from collections.abc import Callable
from fractions import Fraction
from threading import Event, Thread
from typing import Any

import anywidget

import kaleidoscope
from kaleidoscope import PreviewWidget, preview


class FakeSession:
    def __init__(self) -> None:
        self.closed = False
        self.close_calls = 0
        self.requests: list[dict[str, object]] = []
        self.acks: list[dict[str, object]] = []
        self.generations: list[int] = []
        self.resend_calls = 0

    def advance_generation(self, generation: int) -> None:
        self.generations.append(generation)

    def request_frame_set(self, **request: object) -> None:
        self.requests.append(request)

    def ack_frame_set(self, **ack: object) -> int:
        self.acks.append(ack)
        return 12

    def resend_unacknowledged(self) -> None:
        self.resend_calls += 1

    def close(self) -> None:
        self.close_calls += 1
        self.closed = True


class ViewClip:
    def __init__(self, clip_id: str, width: int = 1, height: int = 1) -> None:
        self.id = clip_id
        self.source_width = width
        self.source_height = height


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


def test_closed_widget_ignores_late_malformed_frontend_messages(
    monkeypatch: Any,
) -> None:
    sent, make_widget = capture_messages(monkeypatch)
    widget = make_widget()
    widget.close()

    widget._handle_custom_message(widget, {}, [])

    assert sent == []
    assert widget.status == "closed"


def test_widget_rejects_messages_for_an_unknown_session(monkeypatch: Any) -> None:
    sent, make_widget = capture_messages(monkeypatch)
    widget = make_widget()

    widget._handle_custom_message(
        widget,
        {
            "protocol": 1,
            "type": "ready",
            "session_id": "other-session",
            "capabilities": {"image_bitmap": True, "webp": True},
        },
        [],
    )

    assert widget.status == "error"
    assert sent[-1]["message"] == "Frontend message has an unknown session."


def test_ready_widget_rejects_frame_requests_without_a_session(
    monkeypatch: Any,
) -> None:
    sent, make_widget = capture_messages(monkeypatch)
    widget = make_widget()
    widget._frontend_state = "ready"

    widget._handle_custom_message(
        widget,
        {
            "protocol": 1,
            "type": "request_frame_set",
            "session_id": "session-1",
            "request_id": 0,
            "generation": 0,
            "frame": 0,
            "clip_ids": ["Source"],
            "reason": "seek",
        },
        [],
    )

    assert widget.status == "error"
    assert sent[-1]["message"] == ("Frame requests require an initialized preview session.")


def test_widget_rejects_comparison_views_without_clip_metadata(
    monkeypatch: Any,
) -> None:
    sent, make_widget = capture_messages(monkeypatch)
    widget = make_widget()
    widget._session = FakeSession()
    widget._frontend_state = "ready"

    widget._handle_custom_message(
        widget,
        {
            "protocol": 1,
            "type": "set_view",
            "session_id": "session-1",
            "generation": 1,
            "mode": "single",
            "clip_ids": ["Source"],
            "overlay_opacity": 0.5,
        },
        [],
    )

    assert widget.status == "error"
    assert sent[-1]["message"] == ("Comparison views require initialized clip metadata.")


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
            "overlay_opacity": 0.3,
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
    assert sent[0]["overlay_opacity"] == 0.3


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


def test_widget_applies_view_before_accepting_matching_frame_request() -> None:
    session = FakeSession()
    config = type(
        "Config",
        (),
        {
            "clips": (ViewClip("Source"), ViewClip("Filtered"), ViewClip("Reference")),
            "max_visible_clips": 4,
        },
    )()
    widget = PreviewWidget(session_id="session-1")
    widget._config = config
    widget._session = session
    widget._frontend_state = "ready"

    widget._handle_custom_message(
        widget,
        {
            "protocol": 1,
            "type": "set_view",
            "session_id": "session-1",
            "generation": 1,
            "mode": "wipe",
            "clip_ids": ["Source", "Reference"],
            "overlay_opacity": 0.5,
        },
        [],
    )
    widget._handle_custom_message(
        widget,
        {
            "protocol": 1,
            "type": "request_frame_set",
            "session_id": "session-1",
            "request_id": 1,
            "generation": 1,
            "frame": 7,
            "clip_ids": ["Source", "Reference"],
            "reason": "seek",
        },
        [],
    )

    assert widget.mode == "wipe"
    assert widget.active_clip_ids == ["Source", "Reference"]
    assert session.generations == [1]
    assert session.requests == [
        {
            "request_id": 1,
            "generation": 1,
            "frame": 7,
            "clip_ids": ["Source", "Reference"],
        }
    ]


def test_widget_rejects_request_older_than_the_accepted_view(
    monkeypatch: Any,
) -> None:
    sent: list[dict[str, object]] = []
    session = FakeSession()
    config = type(
        "Config",
        (),
        {
            "clips": (ViewClip("Source"), ViewClip("Filtered")),
            "max_visible_clips": 2,
        },
    )()
    monkeypatch.setattr(
        PreviewWidget,
        "send",
        lambda self, content, buffers=None: sent.append(content),
    )
    widget = PreviewWidget(session_id="session-1")
    widget._config = config
    widget._session = session
    widget._frontend_state = "ready"

    widget._handle_custom_message(
        widget,
        {
            "protocol": 1,
            "type": "set_view",
            "session_id": "session-1",
            "generation": 2,
            "mode": "single",
            "clip_ids": ["Filtered"],
            "overlay_opacity": 0.5,
        },
        [],
    )
    widget._handle_custom_message(
        widget,
        {
            "protocol": 1,
            "type": "request_frame_set",
            "session_id": "session-1",
            "request_id": 1,
            "generation": 1,
            "frame": 7,
            "clip_ids": ["Filtered"],
            "reason": "seek",
        },
        [],
    )

    assert session.generations == [2]
    assert session.requests == []
    assert widget.status == "error"
    assert sent[-1]["message"] == ("Frame-set request generation is older than the active view.")


def test_widget_rejects_view_older_than_the_latest_request(
    monkeypatch: Any,
) -> None:
    sent: list[dict[str, object]] = []
    session = FakeSession()
    monkeypatch.setattr(
        PreviewWidget,
        "send",
        lambda self, content, buffers=None: sent.append(content),
    )
    widget = PreviewWidget(session_id="session-1")
    widget._session = session
    widget._frontend_state = "ready"
    widget._view_active_clip_ids = ("Source",)

    widget._handle_custom_message(
        widget,
        {
            "protocol": 1,
            "type": "request_frame_set",
            "session_id": "session-1",
            "request_id": 1,
            "generation": 3,
            "frame": 7,
            "clip_ids": ["Source"],
            "reason": "seek",
        },
        [],
    )
    widget._config = type(
        "Config",
        (),
        {
            "clips": (ViewClip("Source"), ViewClip("Filtered")),
            "max_visible_clips": 2,
        },
    )()
    widget._handle_custom_message(
        widget,
        {
            "protocol": 1,
            "type": "set_view",
            "session_id": "session-1",
            "generation": 2,
            "mode": "single",
            "clip_ids": ["Filtered"],
            "overlay_opacity": 0.5,
        },
        [],
    )

    assert session.requests == [
        {
            "request_id": 1,
            "generation": 3,
            "frame": 7,
            "clip_ids": ["Source"],
        }
    ]
    assert widget.active_clip_ids == []
    assert widget.status == "error"
    assert sent[-1]["message"] == ("Comparison view generation is older than the latest request.")


def test_widget_rejects_active_view_after_same_generation_request(
    monkeypatch: Any,
) -> None:
    sent: list[dict[str, object]] = []
    session = FakeSession()
    monkeypatch.setattr(
        PreviewWidget,
        "send",
        lambda self, content, buffers=None: sent.append(content),
    )
    widget = PreviewWidget(session_id="session-1")
    widget._session = session
    widget._frontend_state = "ready"
    widget._view_active_clip_ids = ("Source",)

    widget._handle_custom_message(
        widget,
        {
            "protocol": 1,
            "type": "request_frame_set",
            "session_id": "session-1",
            "request_id": 1,
            "generation": 3,
            "frame": 7,
            "clip_ids": ["Source"],
            "reason": "seek",
        },
        [],
    )
    widget._config = type(
        "Config",
        (),
        {
            "clips": (ViewClip("Source"), ViewClip("Filtered")),
            "max_visible_clips": 2,
        },
    )()
    widget._handle_custom_message(
        widget,
        {
            "protocol": 1,
            "type": "set_view",
            "session_id": "session-1",
            "generation": 3,
            "mode": "single",
            "clip_ids": ["Filtered"],
            "overlay_opacity": 0.5,
        },
        [],
    )

    assert widget.status == "error"
    assert sent[-1]["message"] == (
        "An active comparison view must be announced before its frame request."
    )


def test_widget_accepts_explicit_side_by_side_order() -> None:
    session = FakeSession()
    config = type(
        "Config",
        (),
        {
            "clips": (ViewClip("A"), ViewClip("B"), ViewClip("C")),
            "max_visible_clips": 3,
        },
    )()
    widget = PreviewWidget(session_id="session-1")
    widget._config = config
    widget._session = session
    widget._frontend_state = "ready"

    widget._handle_custom_message(
        widget,
        {
            "protocol": 1,
            "type": "set_view",
            "session_id": "session-1",
            "generation": 1,
            "mode": "side-by-side",
            "clip_ids": ["C", "A"],
            "overlay_opacity": 0.5,
        },
        [],
    )

    assert widget.status != "error"
    assert widget.active_clip_ids == ["C", "A"]


def test_terminal_view_error_clears_playing_state(monkeypatch: Any) -> None:
    sent: list[dict[str, object]] = []
    session = FakeSession()
    monkeypatch.setattr(
        PreviewWidget,
        "send",
        lambda self, content, buffers=None: sent.append(content),
    )
    widget = PreviewWidget(session_id="session-1")
    widget._config = type(
        "Config",
        (),
        {
            "clips": (ViewClip("Source"),),
            "max_visible_clips": 1,
        },
    )()
    widget._session = session
    widget._frontend_state = "ready"
    widget.set_trait("playing", True)

    widget._handle_custom_message(
        widget,
        {
            "protocol": 1,
            "type": "set_view",
            "session_id": "session-1",
            "generation": 1,
            "mode": "single",
            "clip_ids": ["Missing"],
            "overlay_opacity": 0.5,
        },
        [],
    )

    assert widget.status == "error"
    assert widget.playing is False
    assert session.closed is True


def test_explicit_close_clears_playing_and_marks_the_widget_closed() -> None:
    session = FakeSession()
    widget = PreviewWidget(session_id="session-1")
    widget._session = session
    widget._frontend_state = "ready"
    widget.set_trait("status", "ready")
    widget.set_trait("playing", True)

    widget.close()

    assert widget.status == "closed"
    assert widget.playing is False
    assert session.closed is True


def test_frontend_close_closes_session_before_ready() -> None:
    session = FakeSession()
    widget = PreviewWidget(session_id="session-1")
    widget._session = session

    widget._handle_custom_message(
        widget,
        {
            "protocol": 1,
            "type": "close",
            "session_id": "session-1",
        },
        [],
    )

    assert widget.status == "closed"
    assert widget.playing is False
    assert session.close_calls == 1


def test_repeated_ready_resends_current_view_metadata(monkeypatch: Any) -> None:
    sent: list[dict[str, object]] = []
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
    reference = type(
        "Clip",
        (),
        {
            "id": "Reference",
            "label": "Reference",
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
            "overlay_opacity": 0.5,
            "num_frames": 10,
            "fps": Fraction(24, 1),
            "max_visible_clips": 4,
            "clips": (clip, reference),
            "autoplay": True,
        },
    )()
    monkeypatch.setattr(
        "kaleidoscope.widget.PreviewSession",
        lambda **kwargs: FakeSession(),
    )
    monkeypatch.setattr(
        PreviewWidget,
        "send",
        lambda self, content, buffers=None: sent.append(content),
    )
    widget = PreviewWidget(config=config, session_id="session-1")
    ready = {
        "protocol": 1,
        "type": "ready",
        "session_id": "session-1",
        "capabilities": {"image_bitmap": True, "webp": True},
    }

    widget._handle_custom_message(widget, ready, [])
    widget._view_mode = "wipe"
    widget._view_active_clip_ids = ("Source", "Reference")
    widget._view_overlay_opacity = 0.25
    widget._handle_custom_message(widget, ready, [])

    assert [message["type"] for message in sent] == ["metadata", "metadata"]
    assert sent[-1]["mode"] == "wipe"
    assert sent[-1]["active_clip_ids"] == ["Source", "Reference"]
    assert sent[-1]["overlay_opacity"] == 0.25
    assert widget.status == "ready"
    assert widget._session.resend_calls == 1


def test_explicit_close_is_idempotent() -> None:
    session = FakeSession()
    widget = PreviewWidget(session_id="session-1")
    widget._session = session

    widget.close()
    widget.close()

    assert widget.status == "closed"
    assert widget.playing is False
    assert session.close_calls == 1


def test_close_after_terminal_error_still_closes_the_base_widget(
    monkeypatch: Any,
) -> None:
    session = FakeSession()
    widget = PreviewWidget(session_id="session-1")
    widget._session = session
    widget._frontend_state = "terminal"
    widget.set_trait("status", "error")
    base_close_calls = 0

    def base_close(self: anywidget.AnyWidget) -> None:
        del self
        nonlocal base_close_calls
        base_close_calls += 1

    monkeypatch.setattr(anywidget.AnyWidget, "close", base_close)

    widget.close()
    widget.close()

    assert base_close_calls == 1
    assert session.close_calls == 1
    assert widget.status == "closed"


def test_close_wins_over_an_in_progress_frame_ack() -> None:
    ack_entered = Event()
    release_ack = Event()

    class BlockingAckSession(FakeSession):
        def ack_frame_set(self, **ack: object) -> int:
            self.acks.append(ack)
            ack_entered.set()
            release_ack.wait(timeout=1)
            raise ValueError("Frame-set ACK arrived after close.")

    session = BlockingAckSession()
    widget = PreviewWidget(session_id="session-1")
    widget._session = session
    widget._frontend_state = "ready"
    widget._delivered_frames[(1, 0)] = 0
    content = {
        "protocol": 1,
        "type": "ack_frame_set",
        "session_id": "session-1",
        "request_id": 1,
        "generation": 0,
        "outcome": "painted",
    }

    handler = Thread(
        target=lambda: widget._handle_custom_message(widget, content, []),
        daemon=True,
    )
    handler.start()
    assert ack_entered.wait(timeout=1)
    widget.close()
    release_ack.set()
    handler.join(timeout=1)

    assert handler.is_alive() is False
    assert widget.status == "closed"
    assert widget.playing is False


def test_successful_frame_ack_cannot_update_current_frame_after_close() -> None:
    ack_entered = Event()
    release_ack = Event()

    class BlockingAckSession(FakeSession):
        def ack_frame_set(self, **ack: object) -> int:
            self.acks.append(ack)
            ack_entered.set()
            release_ack.wait(timeout=1)
            return 7

    session = BlockingAckSession()
    widget = PreviewWidget(session_id="session-1")
    widget._session = session
    widget._frontend_state = "ready"
    widget.set_trait("current_frame", 0)
    content = {
        "protocol": 1,
        "type": "ack_frame_set",
        "session_id": "session-1",
        "request_id": 1,
        "generation": 0,
        "outcome": "painted",
    }

    handler = Thread(
        target=lambda: widget._handle_custom_message(widget, content, []),
        daemon=True,
    )
    handler.start()
    assert ack_entered.wait(timeout=1)
    widget.close()
    release_ack.set()
    handler.join(timeout=1)

    assert handler.is_alive() is False
    assert widget.status == "closed"
    assert widget.current_frame == 0


def test_terminal_widget_suppresses_late_session_delivery(monkeypatch: Any) -> None:
    sent: list[dict[str, object]] = []
    monkeypatch.setattr(
        PreviewWidget,
        "send",
        lambda self, content, buffers=None: sent.append(content),
    )
    widget = PreviewWidget(session_id="session-1")
    widget.close()

    widget._send_session_message(
        {
            "protocol": 1,
            "type": "frame_set",
            "session_id": "session-1",
            "request_id": 7,
            "generation": 2,
            "frame": 3,
            "frames": [],
        },
        [],
    )

    assert sent == []
    assert widget._delivered_frames == {}


def test_widget_rejects_view_above_configured_visible_limit(
    monkeypatch: Any,
) -> None:
    sent: list[dict[str, object]] = []
    session = FakeSession()
    config = type(
        "Config",
        (),
        {
            "clips": (ViewClip("A"), ViewClip("B"), ViewClip("C")),
            "max_visible_clips": 2,
        },
    )()
    monkeypatch.setattr(
        PreviewWidget,
        "send",
        lambda self, content, buffers=None: sent.append(content),
    )
    widget = PreviewWidget(session_id="session-1")
    widget._config = config
    widget._session = session
    widget._frontend_state = "ready"

    widget._handle_custom_message(
        widget,
        {
            "protocol": 1,
            "type": "set_view",
            "session_id": "session-1",
            "generation": 1,
            "mode": "side-by-side",
            "clip_ids": ["A", "B", "C"],
            "overlay_opacity": 0.5,
        },
        [],
    )

    assert widget.status == "error"
    assert session.closed is True
    assert sent[-1]["code"] == "invalid_message"


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
    assert sent[-1]["message"] == ("Preview session is no longer accepting frontend messages.")
