from __future__ import annotations

import ctypes
from concurrent.futures import Future
from fractions import Fraction
from io import BytesIO
from threading import Event

import pytest
from PIL import Image

from kaleidoscope.encoding import EncodedImage
from kaleidoscope.session import PreviewSession
from kaleidoscope.sources import (
    NormalizedClip,
    PreviewConfig,
    build_preview_config,
    load_vapoursynth_runtime,
)


class FakeFormat:
    name = "RGB24"
    num_planes = 3


class FakeFrame:
    width = 1
    height = 1
    format = FakeFormat()

    def __init__(self) -> None:
        self.closed = False
        self._planes = [
            ctypes.create_string_buffer(bytes([12])),
            ctypes.create_string_buffer(bytes([34])),
            ctypes.create_string_buffer(bytes([56])),
        ]

    def get_stride(self, plane: int) -> int:
        del plane
        return 1

    def get_read_ptr(self, plane: int) -> ctypes.c_void_p:
        return ctypes.cast(self._planes[plane], ctypes.c_void_p)

    def close(self) -> None:
        self.closed = True


class FakeVideoNode:
    def __init__(self) -> None:
        self.requested: list[int] = []
        self.future: Future[FakeFrame] = Future()

    def get_frame_async(self, frame: int) -> Future[FakeFrame]:
        self.requested.append(frame)
        return self.future


def make_config(node: FakeVideoNode) -> PreviewConfig:
    return PreviewConfig(
        clips=(
            NormalizedClip(
                id="Source",
                label="Source",
                node=node,
                source_format="RGB24",
                source_width=1,
                source_height=1,
                output_width=1,
                output_height=1,
            ),
        ),
        num_frames=10,
        fps=Fraction(24, 1),
        mode="single",
        primary="Source",
        secondary=None,
        active_clip_ids=("Source",),
        overlay_opacity=0.5,
        max_visible_clips=4,
        quality=80,
        cache_size=32,
        max_in_flight=4,
        autoplay=False,
    )


def test_single_frame_request_is_async_encoded_and_releases_the_frame() -> None:
    node = FakeVideoNode()
    frame = FakeFrame()
    sent: list[tuple[dict[str, object], list[bytes]]] = []
    session = PreviewSession(
        session_id="session-1",
        config=make_config(node),
        send=lambda message, buffers: sent.append((message, buffers)),
        encoder=lambda pixels, width, height, quality: EncodedImage(
            mime="image/jpeg",
            data=b"encoded:" + pixels,
        ),
        clock=lambda: 0.0,
    )

    session.request_frame_set(
        request_id=7,
        generation=0,
        frame=0,
        clip_ids=("Source",),
    )

    assert node.requested == [0]
    assert sent == []

    node.future.set_result(frame)

    assert frame.closed is True
    assert sent == [
        (
            {
                "protocol": 1,
                "type": "frame_set",
                "session_id": "session-1",
                "request_id": 7,
                "generation": 0,
                "frame": 0,
                "frames": [
                    {
                        "clip_id": "Source",
                        "buffer_index": 0,
                        "mime": "image/jpeg",
                        "byte_length": 11,
                        "render_ms": 0.0,
                        "encode_ms": 0.0,
                    }
                ],
            },
            [b"encoded:\x0c\x228"],
        )
    ]


def test_real_vapoursynth_rgb24_frame_is_encoded_with_expected_color() -> None:
    vapoursynth = pytest.importorskip("vapoursynth")
    clip = vapoursynth.core.std.BlankClip(
        width=64,
        height=48,
        length=1,
        format=vapoursynth.RGB24,
        color=[220, 40, 20],
    )
    config = build_preview_config(
        clip,
        quality=95,
        runtime=load_vapoursynth_runtime(),
    )
    completed = Event()
    sent: list[tuple[dict[str, object], list[bytes]]] = []

    def send(message: dict[str, object], buffers: list[bytes]) -> None:
        sent.append((message, buffers))
        completed.set()

    session = PreviewSession(
        session_id="real-session",
        config=config,
        send=send,
    )

    assert config.clips[0].node is clip
    session.request_frame_set(
        request_id=0,
        generation=0,
        frame=0,
        clip_ids=(0,),
    )

    assert completed.wait(timeout=5)
    assert len(sent) == 1
    message, buffers = sent[0]
    assert message["type"] == "frame_set"
    assert message["frame"] == 0
    assert len(buffers) == 1
    with Image.open(BytesIO(buffers[0])) as image:
        red, green, blue = image.convert("RGB").getpixel((32, 24))

    assert red > 200
    assert 20 < green < 70
    assert blue < 50
