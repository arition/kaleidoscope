from __future__ import annotations

import ctypes
from concurrent.futures import Future
from fractions import Fraction
from typing import Any

import kaleidoscope.api as api
from kaleidoscope import PreviewWidget, preview
from kaleidoscope.sources import VapourSynthRuntime


class FakeFormat:
    name = "RGB24"


class FakeVideoNode:
    width = 1920
    height = 1080
    num_frames = 240
    fps = Fraction(24000, 1001)
    format = FakeFormat()


class RenderableVideoNode:
    width = 1
    height = 1
    num_frames = 1
    fps = Fraction(24, 1)
    format = FakeFormat()

    def __init__(self) -> None:
        self.future: Future[RenderableFrame] = Future()

    def get_frame_async(self, frame: int) -> Future[RenderableFrame]:
        assert frame == 0
        return self.future


class RenderableFrame:
    width = 1
    height = 1
    format = type("RenderableFormat", (), {"name": "RGB24", "num_planes": 3})()

    def __init__(self) -> None:
        self.closed = False
        self._planes = [
            ctypes.create_string_buffer(bytes([255])),
            ctypes.create_string_buffer(bytes([0])),
            ctypes.create_string_buffer(bytes([0])),
        ]

    def get_stride(self, plane: int) -> int:
        del plane
        return 1

    def get_read_ptr(self, plane: int) -> ctypes.c_void_p:
        return ctypes.cast(self._planes[plane], ctypes.c_void_p)

    def close(self) -> None:
        self.closed = True


class FakeAudioNode:
    pass


class FakeVideoOutput:
    def __init__(self, clip: FakeVideoNode) -> None:
        self.clip = clip


def test_preview_builds_widget_with_stable_metadata(monkeypatch: Any) -> None:
    runtime = VapourSynthRuntime(
        video_node_type=FakeVideoNode,
        video_output_type=FakeVideoOutput,
        audio_node_type=FakeAudioNode,
        get_outputs=lambda: {},
    )
    monkeypatch.setattr(api, "load_vapoursynth_runtime", lambda: runtime)
    sent: list[dict[str, object]] = []
    monkeypatch.setattr(
        PreviewWidget,
        "send",
        lambda self, content, buffers=None: sent.append(content),
    )

    widget = preview(
        {"Source": FakeVideoNode(), "Filtered": FakeVideoNode()},
        mode="side-by-side",
        height=540,
    )
    widget._handle_custom_message(
        widget,
        {
            "protocol": 1,
            "type": "ready",
            "session_id": widget.session_id,
            "capabilities": {"image_bitmap": True, "webp": False},
        },
        [],
    )

    assert widget.mode == "side-by-side"
    assert widget.active_clip_ids == ["Source", "Filtered"]
    assert sent == [
        {
            "protocol": 1,
            "type": "metadata",
            "session_id": widget.session_id,
            "status": "initialized",
            "num_frames": 240,
            "fps_num": 24000,
            "fps_den": 1001,
            "mode": "side-by-side",
            "active_clip_ids": ["Source", "Filtered"],
            "max_visible_clips": 4,
            "clips": [
                {
                    "id": "Source",
                    "label": "Source",
                    "source_format": "RGB24",
                    "source_width": 1920,
                    "source_height": 1080,
                    "output_width": 960,
                    "output_height": 540,
                    "warnings": [],
                },
                {
                    "id": "Filtered",
                    "label": "Filtered",
                    "source_format": "RGB24",
                    "source_width": 1920,
                    "source_height": 1080,
                    "output_width": 960,
                    "output_height": 540,
                    "warnings": [],
                },
            ],
        }
    ]


def test_preview_routes_frame_request_to_binary_widget_message(
    monkeypatch: Any,
) -> None:
    node = RenderableVideoNode()
    runtime = VapourSynthRuntime(
        video_node_type=RenderableVideoNode,
        video_output_type=FakeVideoOutput,
        audio_node_type=FakeAudioNode,
        get_outputs=lambda: {},
    )
    monkeypatch.setattr(api, "load_vapoursynth_runtime", lambda: runtime)
    sent: list[tuple[dict[str, object], list[bytes] | None]] = []
    monkeypatch.setattr(
        PreviewWidget,
        "send",
        lambda self, content, buffers=None: sent.append((content, buffers)),
    )
    widget = preview(node, height=None)
    widget._handle_custom_message(
        widget,
        {
            "protocol": 1,
            "type": "request_frame_set",
            "session_id": widget.session_id,
            "request_id": 0,
            "generation": 0,
            "frame": 0,
            "clip_ids": [0],
            "reason": "seek",
        },
        [],
    )
    frame = RenderableFrame()

    node.future.set_result(frame)

    assert frame.closed is True
    assert len(sent) == 1
    message, buffers = sent[0]
    assert message["type"] == "frame_set"
    assert message["frame"] == 0
    assert isinstance(buffers, list)
    assert len(buffers) == 1
    assert buffers[0].startswith(b"\xff\xd8")
