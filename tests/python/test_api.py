from __future__ import annotations

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
