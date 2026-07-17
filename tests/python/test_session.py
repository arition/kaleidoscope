from __future__ import annotations

import ctypes
from concurrent.futures import Future
from dataclasses import replace
from fractions import Fraction
from io import BytesIO
from threading import Event, Thread

import pytest
from PIL import Image

from kaleidoscope.encoding import EncodedImage
from kaleidoscope.session import PreviewSession
from kaleidoscope.sources import (
    ClipWarning,
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


def make_config(
    node: FakeVideoNode,
    *additional_clips: tuple[str, FakeVideoNode],
    cache_size: int = 32,
) -> PreviewConfig:
    clips = [
        NormalizedClip(
            id="Source",
            label="Source",
            node=node,
            source_format="RGB24",
            source_width=1,
            source_height=1,
            output_width=1,
            output_height=1,
        )
    ]
    clips.extend(
        NormalizedClip(
            id=clip_id,
            label=clip_id,
            node=clip_node,
            source_format="RGB24",
            source_width=1,
            source_height=1,
            output_width=1,
            output_height=1,
        )
        for clip_id, clip_node in additional_clips
    )
    active_clip_ids = tuple(clip.id for clip in clips)
    return PreviewConfig(
        clips=tuple(clips),
        num_frames=10,
        fps=Fraction(24, 1),
        mode="single" if len(clips) == 1 else "side-by-side",
        primary="Source",
        secondary=None if len(clips) == 1 else clips[1].id,
        active_clip_ids=active_clip_ids,
        overlay_opacity=0.5,
        max_visible_clips=4,
        codec="jpeg",
        quality=80,
        lossless=False,
        cache_size=cache_size,
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


def test_session_uses_configured_webp_lossless_encoder() -> None:
    node = FakeVideoNode()
    frame = FakeFrame()
    config = make_config(node)
    config = PreviewConfig(
        clips=config.clips,
        num_frames=config.num_frames,
        fps=config.fps,
        mode=config.mode,
        primary=config.primary,
        secondary=config.secondary,
        active_clip_ids=config.active_clip_ids,
        overlay_opacity=config.overlay_opacity,
        max_visible_clips=config.max_visible_clips,
        codec="webp",
        quality=100,
        lossless=True,
        cache_size=config.cache_size,
        max_in_flight=config.max_in_flight,
        autoplay=config.autoplay,
    )
    sent: list[tuple[dict[str, object], list[bytes]]] = []
    session = PreviewSession(
        session_id="session-1",
        config=config,
        send=lambda message, buffers: sent.append((message, buffers)),
        clock=lambda: 0.0,
    )

    session.request_frame_set(
        request_id=7,
        generation=0,
        frame=0,
        clip_ids=("Source",),
    )
    node.future.set_result(frame)

    message, buffers = sent[0]
    frames = message["frames"]
    assert isinstance(frames, list)
    assert frames[0]["mime"] == "image/webp"
    assert buffers[0].startswith(b"RIFF")
    assert buffers[0][8:12] == b"WEBP"


def test_frame_set_waits_for_every_clip_and_preserves_requested_order() -> None:
    source_node = FakeVideoNode()
    filtered_node = FakeVideoNode()
    source_frame = FakeFrame()
    filtered_frame = FakeFrame()
    sent: list[tuple[dict[str, object], list[bytes]]] = []
    session = PreviewSession(
        session_id="session-1",
        config=make_config(source_node, ("Filtered", filtered_node)),
        send=lambda message, buffers: sent.append((message, buffers)),
        encoder=lambda pixels, width, height, quality: EncodedImage(
            mime="image/jpeg",
            data=b"encoded:" + pixels,
        ),
        clock=lambda: 0.0,
    )

    session.request_frame_set(
        request_id=8,
        generation=2,
        frame=3,
        clip_ids=("Filtered", "Source"),
    )

    filtered_node.future.set_result(filtered_frame)

    assert filtered_frame.closed is True
    assert source_frame.closed is False
    assert sent == []

    source_node.future.set_result(source_frame)

    assert source_frame.closed is True
    assert sent == [
        (
            {
                "protocol": 1,
                "type": "frame_set",
                "session_id": "session-1",
                "request_id": 8,
                "generation": 2,
                "frame": 3,
                "frames": [
                    {
                        "clip_id": "Filtered",
                        "buffer_index": 0,
                        "mime": "image/jpeg",
                        "byte_length": 11,
                        "render_ms": 0.0,
                        "encode_ms": 0.0,
                    },
                    {
                        "clip_id": "Source",
                        "buffer_index": 1,
                        "mime": "image/jpeg",
                        "byte_length": 11,
                        "render_ms": 0.0,
                        "encode_ms": 0.0,
                    },
                ],
            },
            [b"encoded:\x0c\x228", b"encoded:\x0c\x228"],
        )
    ]


def test_failed_frame_set_member_never_releases_a_partial_set() -> None:
    source_node = FakeVideoNode()
    filtered_node = FakeVideoNode()
    source_frame = FakeFrame()
    sent: list[tuple[dict[str, object], list[bytes]]] = []
    session = PreviewSession(
        session_id="session-1",
        config=make_config(source_node, ("Filtered", filtered_node)),
        send=lambda message, buffers: sent.append((message, buffers)),
        encoder=lambda pixels, width, height, quality: EncodedImage(
            mime="image/jpeg",
            data=b"encoded:" + pixels,
        ),
        clock=lambda: 0.0,
    )

    session.request_frame_set(
        request_id=9,
        generation=2,
        frame=3,
        clip_ids=("Source", "Filtered"),
    )
    source_node.future.set_result(source_frame)
    filtered_node.future.set_exception(RuntimeError("unsafe render details"))

    assert source_frame.closed is True
    assert sent == [
        (
            {
                "protocol": 1,
                "type": "error",
                "session_id": "session-1",
                "request_id": 9,
                "generation": 2,
                "clip_id": "Filtered",
                "code": "render_failed",
                "message": "The preview frame could not be rendered.",
                "recoverable": True,
            },
            [],
        )
    ]


def test_stale_frame_set_members_close_without_sending() -> None:
    source_node = FakeVideoNode()
    filtered_node = FakeVideoNode()
    old_source_future = source_node.future
    old_filtered_future = filtered_node.future
    sent: list[tuple[dict[str, object], list[bytes]]] = []
    session = PreviewSession(
        session_id="session-1",
        config=make_config(source_node, ("Filtered", filtered_node)),
        send=lambda message, buffers: sent.append((message, buffers)),
        encoder=lambda pixels, width, height, quality: EncodedImage(
            mime="image/jpeg",
            data=b"encoded:" + pixels,
        ),
        clock=lambda: 0.0,
    )

    session.request_frame_set(
        request_id=1,
        generation=0,
        frame=0,
        clip_ids=("Source", "Filtered"),
    )
    source_node.future = Future()
    filtered_node.future = Future()
    session.request_frame_set(
        request_id=2,
        generation=1,
        frame=1,
        clip_ids=("Source", "Filtered"),
    )

    old_source_frame = FakeFrame()
    old_filtered_frame = FakeFrame()
    old_source_future.set_result(old_source_frame)
    old_filtered_future.set_result(old_filtered_frame)

    assert old_source_frame.closed is True
    assert old_filtered_frame.closed is True
    assert sent == []

    new_source_frame = FakeFrame()
    new_filtered_frame = FakeFrame()
    source_node.future.set_result(new_source_frame)
    filtered_node.future.set_result(new_filtered_frame)

    assert new_source_frame.closed is True
    assert new_filtered_frame.closed is True
    assert len(sent) == 1
    message, buffers = sent[0]
    assert message["type"] == "frame_set"
    assert message["request_id"] == 2
    assert message["generation"] == 1
    assert message["frame"] == 1
    assert len(buffers) == 2


@pytest.mark.parametrize("target", [0, 5, 9])
def test_frame_set_requests_exact_boundary_and_middle_frames(target: int) -> None:
    source_node = FakeVideoNode()
    filtered_node = FakeVideoNode()
    sent: list[tuple[dict[str, object], list[bytes]]] = []
    session = PreviewSession(
        session_id="session-1",
        config=make_config(source_node, ("Filtered", filtered_node)),
        send=lambda message, buffers: sent.append((message, buffers)),
        encoder=lambda pixels, width, height, quality: EncodedImage(
            mime="image/jpeg",
            data=b"encoded:" + pixels,
        ),
        clock=lambda: 0.0,
    )

    session.request_frame_set(
        request_id=target,
        generation=target,
        frame=target,
        clip_ids=("Source", "Filtered"),
    )

    assert source_node.requested == [target]
    assert filtered_node.requested == [target]

    source_node.future.set_result(FakeFrame())
    filtered_node.future.set_result(FakeFrame())

    assert len(sent) == 1
    assert sent[0][0]["frame"] == target


@pytest.mark.parametrize(
    ("request_id", "generation"),
    [(2, 2), (1, 3), (3, 1)],
)
def test_session_rejects_non_monotonic_request_identities_without_replacing_work(
    request_id: int,
    generation: int,
) -> None:
    node = FakeVideoNode()
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
        request_id=2,
        generation=2,
        frame=2,
        clip_ids=("Source",),
    )

    with pytest.raises(ValueError, match="monotonically"):
        session.request_frame_set(
            request_id=request_id,
            generation=generation,
            frame=3,
            clip_ids=("Source",),
        )

    node.future.set_result(FakeFrame())

    assert len(sent) == 1
    assert sent[0][0]["request_id"] == 2
    assert sent[0][0]["generation"] == 2
    assert sent[0][0]["frame"] == 2


def test_session_accepts_increasing_request_id_with_same_generation() -> None:
    node = FakeVideoNode()
    old_future = node.future
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
        request_id=2,
        generation=2,
        frame=2,
        clip_ids=("Source",),
    )
    node.future = Future()
    session.request_frame_set(
        request_id=3,
        generation=2,
        frame=3,
        clip_ids=("Source",),
    )

    old_frame = FakeFrame()
    old_future.set_result(old_frame)
    assert old_frame.closed is True
    assert sent == []

    current_frame = FakeFrame()
    node.future.set_result(current_frame)
    assert current_frame.closed is True
    assert len(sent) == 1
    assert sent[0][0]["request_id"] == 3
    assert sent[0][0]["generation"] == 2
    assert sent[0][0]["frame"] == 3


def test_ack_window_releases_only_the_latest_completed_frame_set() -> None:
    node = FakeVideoNode()
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
        request_id=0,
        generation=0,
        frame=0,
        clip_ids=("Source",),
    )
    node.future.set_result(FakeFrame())
    assert [message["frame"] for message, _ in sent] == [0]

    node.future = Future()
    session.request_frame_set(
        request_id=1,
        generation=0,
        frame=1,
        clip_ids=("Source",),
    )
    node.future.set_result(FakeFrame())
    assert [message["frame"] for message, _ in sent] == [0]

    node.future = Future()
    session.request_frame_set(
        request_id=2,
        generation=0,
        frame=2,
        clip_ids=("Source",),
    )
    node.future.set_result(FakeFrame())
    assert [message["frame"] for message, _ in sent] == [0]

    assert (
        session.ack_frame_set(
            request_id=0,
            generation=0,
            outcome="painted",
        )
        == 0
    )
    assert [message["frame"] for message, _ in sent] == [0, 2]


def test_ack_window_drops_completed_pending_set_when_newer_request_starts() -> None:
    node = FakeVideoNode()
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
        request_id=0,
        generation=0,
        frame=0,
        clip_ids=("Source",),
    )
    node.future.set_result(FakeFrame())

    node.future = Future()
    session.request_frame_set(
        request_id=1,
        generation=0,
        frame=1,
        clip_ids=("Source",),
    )
    node.future.set_result(FakeFrame())

    node.future = Future()
    session.request_frame_set(
        request_id=2,
        generation=0,
        frame=2,
        clip_ids=("Source",),
    )
    session.ack_frame_set(request_id=0, generation=0, outcome="painted")

    assert [message["frame"] for message, _ in sent] == [0]

    node.future.set_result(FakeFrame())

    assert [message["frame"] for message, _ in sent] == [0, 2]


def test_generation_advance_retires_old_delivery_before_replacement_request() -> None:
    node = FakeVideoNode()
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
        request_id=0,
        generation=0,
        frame=0,
        clip_ids=("Source",),
    )
    node.future.set_result(FakeFrame())

    session.advance_generation(1)
    node.future = Future()
    session.request_frame_set(
        request_id=1,
        generation=1,
        frame=1,
        clip_ids=("Source",),
    )
    node.future.set_result(FakeFrame())

    assert [message["frame"] for message, _ in sent] == [0]
    assert (
        session.ack_frame_set(
            request_id=0,
            generation=0,
            outcome="stale",
        )
        == 0
    )
    assert [message["frame"] for message, _ in sent] == [0, 1]
    assert (
        session.ack_frame_set(
            request_id=1,
            generation=1,
            outcome="painted",
        )
        == 1
    )


def test_generation_advance_rejects_decrease_and_ignores_equal_or_closed() -> None:
    node = FakeVideoNode()
    session = PreviewSession(
        session_id="session-1",
        config=make_config(node),
        send=lambda message, buffers: None,
    )

    session.advance_generation(2)
    session.advance_generation(2)
    with pytest.raises(ValueError, match="must not decrease"):
        session.advance_generation(1)
    session.close()
    session.advance_generation(3)

    assert session._last_generation == 2


def test_frame_set_rejects_timeline_cardinality_and_preview_format() -> None:
    node = FakeVideoNode()
    config = make_config(node)
    session = PreviewSession(
        session_id="session-1",
        config=config,
        send=lambda message, buffers: None,
    )

    with pytest.raises(ValueError, match="outside the clip timeline"):
        session.request_frame_set(
            request_id=0,
            generation=0,
            frame=-1,
            clip_ids=("Source",),
        )
    with pytest.raises(ValueError, match="between one and four clips"):
        session.request_frame_set(
            request_id=0,
            generation=0,
            frame=0,
            clip_ids=(),
        )

    incompatible = replace(config.clips[0], preview_format="YUV420P8")
    incompatible_session = PreviewSession(
        session_id="session-2",
        config=replace(config, clips=(incompatible,)),
        send=lambda message, buffers: None,
    )
    with pytest.raises(ValueError, match="prepared as RGB24"):
        incompatible_session.request_frame_set(
            request_id=0,
            generation=0,
            frame=0,
            clip_ids=("Source",),
        )


def test_generation_advance_discards_old_pending_but_preserves_delivery() -> None:
    node = FakeVideoNode()
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
        request_id=0,
        generation=0,
        frame=0,
        clip_ids=("Source",),
    )
    node.future.set_result(FakeFrame())
    node.future = Future()
    session.request_frame_set(
        request_id=1,
        generation=0,
        frame=1,
        clip_ids=("Source",),
    )
    node.future.set_result(FakeFrame())

    session.advance_generation(1)
    node.future = Future()
    session.request_frame_set(
        request_id=2,
        generation=1,
        frame=2,
        clip_ids=("Source",),
    )
    node.future.set_result(FakeFrame())

    assert [message["frame"] for message, _ in sent] == [0]
    session.ack_frame_set(request_id=0, generation=0, outcome="stale")
    assert [message["frame"] for message, _ in sent] == [0, 2]


def test_resend_unacknowledged_replays_the_delivery_without_advancing_window() -> None:
    node = FakeVideoNode()
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
        request_id=0,
        generation=0,
        frame=4,
        clip_ids=("Source",),
    )
    node.future.set_result(FakeFrame())

    session.resend_unacknowledged()

    assert [message["frame"] for message, _ in sent] == [4, 4]
    assert (
        session.ack_frame_set(
            request_id=0,
            generation=0,
            outcome="stale",
        )
        == 4
    )


def test_mismatched_old_ack_does_not_clear_newer_delivery() -> None:
    node = FakeVideoNode()
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
        request_id=0,
        generation=0,
        frame=0,
        clip_ids=("Source",),
    )
    node.future.set_result(FakeFrame())
    session.ack_frame_set(request_id=0, generation=0, outcome="painted")
    node.future = Future()
    session.request_frame_set(
        request_id=1,
        generation=1,
        frame=1,
        clip_ids=("Source",),
    )
    node.future.set_result(FakeFrame())

    with pytest.raises(ValueError, match="does not match"):
        session.ack_frame_set(request_id=0, generation=0, outcome="stale")

    assert (
        session.ack_frame_set(
            request_id=1,
            generation=1,
            outcome="painted",
        )
        == 1
    )


def test_decode_error_ack_clears_pending_delivery() -> None:
    node = FakeVideoNode()
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
        request_id=0,
        generation=0,
        frame=0,
        clip_ids=("Source",),
    )
    node.future.set_result(FakeFrame())
    node.future = Future()
    session.request_frame_set(
        request_id=1,
        generation=0,
        frame=1,
        clip_ids=("Source",),
    )
    node.future.set_result(FakeFrame())

    assert (
        session.ack_frame_set(
            request_id=0,
            generation=0,
            outcome="decode_error",
        )
        == 0
    )
    assert [message["frame"] for message, _ in sent] == [0]


def test_ack_rejects_unknown_delivery_identity() -> None:
    node = FakeVideoNode()
    session = PreviewSession(
        session_id="session-1",
        config=make_config(node),
        send=lambda message, buffers: None,
    )

    with pytest.raises(ValueError, match="does not match"):
        session.ack_frame_set(
            request_id=7,
            generation=0,
            outcome="stale",
        )


def test_encoded_frame_cache_reuses_an_acknowledged_frame() -> None:
    node = FakeVideoNode()
    sent: list[tuple[dict[str, object], list[bytes]]] = []
    encode_calls = 0

    def encode(pixels: bytes, width: int, height: int, quality: int) -> EncodedImage:
        nonlocal encode_calls
        del width, height, quality
        encode_calls += 1
        return EncodedImage(mime="image/jpeg", data=b"encoded:" + pixels)

    session = PreviewSession(
        session_id="session-1",
        config=make_config(node, cache_size=1),
        send=lambda message, buffers: sent.append((message, buffers)),
        encoder=encode,
        clock=lambda: 0.0,
    )

    session.request_frame_set(
        request_id=0,
        generation=0,
        frame=0,
        clip_ids=("Source",),
    )
    node.future.set_result(FakeFrame())
    session.ack_frame_set(request_id=0, generation=0, outcome="painted")

    session.request_frame_set(
        request_id=1,
        generation=1,
        frame=0,
        clip_ids=("Source",),
    )

    assert node.requested == [0]
    assert encode_calls == 1
    assert [message["request_id"] for message, _ in sent] == [0, 1]
    assert sent[1][1] == sent[0][1]


def test_encoded_frame_cache_evicts_least_recently_used_entry() -> None:
    node = FakeVideoNode()
    session = PreviewSession(
        session_id="session-1",
        config=make_config(node, cache_size=1),
        send=lambda message, buffers: None,
        encoder=lambda pixels, width, height, quality: EncodedImage(
            mime="image/jpeg",
            data=b"encoded:" + pixels,
        ),
        clock=lambda: 0.0,
    )

    session.request_frame_set(
        request_id=0,
        generation=0,
        frame=0,
        clip_ids=("Source",),
    )
    node.future.set_result(FakeFrame())
    session.ack_frame_set(request_id=0, generation=0, outcome="painted")

    node.future = Future()
    session.request_frame_set(
        request_id=1,
        generation=1,
        frame=1,
        clip_ids=("Source",),
    )
    node.future.set_result(FakeFrame())
    session.ack_frame_set(request_id=1, generation=1, outcome="painted")

    node.future = Future()
    session.request_frame_set(
        request_id=2,
        generation=2,
        frame=0,
        clip_ids=("Source",),
    )

    assert node.requested == [0, 1, 0]


def test_close_is_idempotent_clears_cache_and_ignores_late_completion() -> None:
    node = FakeVideoNode()
    sent: list[tuple[dict[str, object], list[bytes]]] = []
    session = PreviewSession(
        session_id="session-1",
        config=make_config(node, cache_size=1),
        send=lambda message, buffers: sent.append((message, buffers)),
        encoder=lambda pixels, width, height, quality: EncodedImage(
            mime="image/jpeg",
            data=b"encoded:" + pixels,
        ),
        clock=lambda: 0.0,
    )

    session.request_frame_set(
        request_id=0,
        generation=0,
        frame=0,
        clip_ids=("Source",),
    )
    first_frame = FakeFrame()
    node.future.set_result(first_frame)
    session.ack_frame_set(request_id=0, generation=0, outcome="painted")

    node.future = Future()
    session.request_frame_set(
        request_id=1,
        generation=1,
        frame=1,
        clip_ids=("Source",),
    )
    session.close()
    session.close()
    late_frame = FakeFrame()
    node.future.set_result(late_frame)

    assert first_frame.closed is True
    assert late_frame.closed is True
    assert sent[0][0]["type"] == "frame_set"
    assert len(sent) == 1
    assert session._cache.get(("Source", 0)) is None

    session.request_frame_set(
        request_id=2,
        generation=2,
        frame=0,
        clip_ids=("Source",),
    )
    assert node.requested == [0, 1]


def test_frame_set_rejects_duplicate_and_unknown_clip_ids() -> None:
    source_node = FakeVideoNode()
    filtered_node = FakeVideoNode()
    session = PreviewSession(
        session_id="session-1",
        config=make_config(source_node, ("Filtered", filtered_node)),
        send=lambda message, buffers: None,
    )

    with pytest.raises(ValueError, match="duplicate clip IDs"):
        session.request_frame_set(
            request_id=1,
            generation=0,
            frame=0,
            clip_ids=("Source", "Source"),
        )
    with pytest.raises(ValueError, match="Unknown clip ID"):
        session.request_frame_set(
            request_id=2,
            generation=0,
            frame=0,
            clip_ids=("Source", "Missing"),
        )


def test_transport_callback_can_close_the_session_without_deadlocking() -> None:
    node = FakeVideoNode()
    frame = FakeFrame()
    session: PreviewSession

    def send(message: dict[str, object], buffers: list[bytes]) -> None:
        del message, buffers
        session.close()

    session = PreviewSession(
        session_id="session-1",
        config=make_config(node),
        send=send,
        encoder=lambda pixels, width, height, quality: EncodedImage(
            mime="image/jpeg",
            data=b"encoded:" + pixels,
        ),
        clock=lambda: 0.0,
    )
    session.request_frame_set(
        request_id=1,
        generation=0,
        frame=0,
        clip_ids=("Source",),
    )

    completion = Thread(target=lambda: node.future.set_result(frame), daemon=True)
    completion.start()
    completion.join(timeout=1)

    assert completion.is_alive() is False
    assert frame.closed is True


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


def test_lazy_fallback_render_failure_reports_conversion_failed() -> None:
    node = FakeVideoNode()
    config = make_config(node)
    converted = NormalizedClip(
        id="Source",
        label="Source",
        node=node,
        source_format="YUV420P8",
        source_width=1,
        source_height=1,
        output_width=1,
        output_height=1,
        warnings=(
            ClipWarning(
                code="automatic_rgb24_conversion",
                message="Automatic RGB24 conversion is active.",
            ),
        ),
    )
    config = PreviewConfig(
        clips=(converted,),
        num_frames=config.num_frames,
        fps=config.fps,
        mode=config.mode,
        primary=config.primary,
        secondary=config.secondary,
        active_clip_ids=config.active_clip_ids,
        overlay_opacity=config.overlay_opacity,
        max_visible_clips=config.max_visible_clips,
        codec=config.codec,
        quality=config.quality,
        lossless=config.lossless,
        cache_size=config.cache_size,
        max_in_flight=config.max_in_flight,
        autoplay=config.autoplay,
    )
    sent: list[tuple[dict[str, object], list[bytes]]] = []
    session = PreviewSession(
        session_id="session-1",
        config=config,
        send=lambda message, buffers: sent.append((message, buffers)),
    )

    session.request_frame_set(
        request_id=1,
        generation=0,
        frame=0,
        clip_ids=("Source",),
    )
    node.future.set_exception(RuntimeError("unsafe conversion details"))

    assert sent == [
        (
            {
                "protocol": 1,
                "type": "error",
                "session_id": "session-1",
                "request_id": 1,
                "generation": 0,
                "clip_id": "Source",
                "code": "conversion_failed",
                "message": "The preview frame could not be converted to RGB24.",
                "recoverable": True,
            },
            [],
        )
    ]
