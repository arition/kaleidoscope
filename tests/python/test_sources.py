from __future__ import annotations

from dataclasses import FrozenInstanceError
from fractions import Fraction
from typing import Any

import pytest

from kaleidoscope.sources import (
    ColorMetadata,
    KaleidoscopeError,
    VapourSynthRuntime,
    build_preview_config,
    load_vapoursynth_runtime,
)


class FakeFormat:
    def __init__(self, name: str) -> None:
        self.name = name


class FakeVideoNode:
    def __init__(
        self,
        *,
        width: int = 1920,
        height: int = 1080,
        num_frames: int = 240,
        fps: Fraction = Fraction(24, 1),
        format_name: str | None = "RGB24",
    ) -> None:
        self.width = width
        self.height = height
        self.num_frames = num_frames
        self.fps = fps
        self.format = None if format_name is None else FakeFormat(format_name)


class FakeAudioNode:
    pass


class FakeVideoOutput:
    def __init__(self, clip: FakeVideoNode) -> None:
        self.clip = clip
        self.alpha = None
        self.alt_output = 0


def make_runtime(
    outputs: dict[int, object] | None = None,
    *,
    color_metadata: ColorMetadata | None = None,
    prepare_rgb24: Any | None = None,
) -> VapourSynthRuntime:
    registry = {} if outputs is None else outputs

    def default_prepare_rgb24(
        node: object,
        width: int,
        height: int,
        matrix: int | None,
        transfer: int | None,
        color_range: int | None,
    ) -> FakeVideoNode:
        del matrix, transfer, color_range
        assert isinstance(node, FakeVideoNode)
        return FakeVideoNode(
            width=width,
            height=height,
            num_frames=node.num_frames,
            fps=node.fps,
            format_name="RGB24",
        )

    return VapourSynthRuntime(
        video_node_type=FakeVideoNode,
        video_output_type=FakeVideoOutput,
        audio_node_type=FakeAudioNode,
        get_outputs=lambda: registry,
        read_color_metadata=lambda node: color_metadata or ColorMetadata(),
        prepare_rgb24=prepare_rgb24 or default_prepare_rgb24,
    )


def test_single_clip_normalizes_to_an_immutable_ordered_config() -> None:
    clip = FakeVideoNode()

    config = build_preview_config(clip, runtime=make_runtime())

    assert config.mode == "single"
    assert config.active_clip_ids == (0,)
    assert config.num_frames == 240
    assert config.fps == Fraction(24, 1)
    assert [(item.id, item.label, item.node) for item in config.clips] == [
        (0, "Clip 0", clip)
    ]
    with pytest.raises(FrozenInstanceError):
        config.clips[0].label = "Changed"  # type: ignore[misc]


def test_mapping_preserves_ids_labels_order_and_original_dimensions() -> None:
    source = FakeVideoNode(width=1920, height=1080)
    filtered = FakeVideoNode(width=1280, height=720)

    config = build_preview_config(
        {"Source": source, "Filtered": filtered},
        mode="side-by-side",
        runtime=make_runtime(),
    )

    assert [item.id for item in config.clips] == ["Source", "Filtered"]
    assert [item.label for item in config.clips] == ["Source", "Filtered"]
    assert [(item.output_width, item.output_height) for item in config.clips] == [
        (1920, 1080),
        (1280, 720),
    ]
    assert config.active_clip_ids == ("Source", "Filtered")


def test_registry_is_snapshotted_sorted_and_ignores_audio() -> None:
    first = FakeVideoNode()
    second = FakeVideoNode()
    outputs: dict[int, object] = {
        9: FakeVideoOutput(second),
        2: FakeAudioNode(),
        5: FakeVideoOutput(first),
    }

    config = build_preview_config(None, runtime=make_runtime(outputs))
    outputs[1] = FakeVideoOutput(FakeVideoNode())

    assert [(item.id, item.label) for item in config.clips] == [
        (5, "Output 5"),
        (9, "Output 9"),
    ]
    assert [item.node for item in config.clips] == [first, second]


def test_registry_without_video_outputs_is_rejected() -> None:
    with pytest.raises(KaleidoscopeError) as error:
        build_preview_config(
            None,
            runtime=make_runtime({3: FakeAudioNode()}),
        )

    assert error.value.code == "no_video_outputs"


def test_real_vapoursynth_direct_node_and_sparse_registry() -> None:
    vapoursynth = pytest.importorskip("vapoursynth")
    vapoursynth.clear_outputs()
    try:
        direct = vapoursynth.core.std.BlankClip(
            width=320,
            height=180,
            length=12,
            fpsnum=24000,
            fpsden=1001,
            format=vapoursynth.RGB24,
        )
        runtime = load_vapoursynth_runtime()

        direct_config = build_preview_config(direct, runtime=runtime)

        assert direct_config.num_frames == 12
        assert direct_config.fps == Fraction(24000, 1001)
        assert direct_config.clips[0].source_format == "RGB24"

        direct.set_output(9)
        direct.std.FlipHorizontal().set_output(3)

        registry_config = build_preview_config(None, runtime=runtime)

        assert [clip.id for clip in registry_config.clips] == [3, 9]
        assert [clip.label for clip in registry_config.clips] == [
            "Output 3",
            "Output 9",
        ]
        assert all(
            isinstance(clip.node, vapoursynth.VideoNode)
            for clip in registry_config.clips
        )
    finally:
        vapoursynth.clear_outputs()


def test_real_vapoursynth_yuv_fallback_prepares_warned_rgb24_node() -> None:
    vapoursynth = pytest.importorskip("vapoursynth")
    source = vapoursynth.core.std.BlankClip(
        width=64,
        height=48,
        length=1,
        format=vapoursynth.YUV420P8,
        color=[81, 90, 240],
    )

    config = build_preview_config(
        source,
        runtime=load_vapoursynth_runtime(),
    )

    clip = config.clips[0]
    assert clip.node is not source
    assert clip.source_format == "YUV420P8"
    assert clip.preview_format == "RGB24"
    assert (clip.node.width, clip.node.height, clip.node.format.name) == (
        64,
        48,
        "RGB24",
    )
    assert [warning.code for warning in clip.warnings] == [
        "automatic_rgb24_conversion",
        "assumed_color_metadata",
    ]

    frame = clip.node.get_frame(0)
    try:
        assert (frame.width, frame.height, frame.format.name) == (64, 48, "RGB24")
    finally:
        frame.close()


@pytest.mark.parametrize(
    ("source_format", "expected_assumptions"),
    [
        ("RGB48", ("matrix RGB", "transfer BT.709", "range full")),
        ("GRAYS", ("transfer BT.709", "range full")),
    ],
)
def test_real_vapoursynth_non_yuv_fallback_uses_compatible_color_defaults(
    source_format: str,
    expected_assumptions: tuple[str, ...],
) -> None:
    vapoursynth = pytest.importorskip("vapoursynth")
    source = vapoursynth.core.std.BlankClip(
        width=64,
        height=48,
        length=1,
        format=getattr(vapoursynth, source_format),
    )

    config = build_preview_config(
        source,
        runtime=load_vapoursynth_runtime(),
    )

    clip = config.clips[0]
    assert clip.node.format.name == "RGB24"
    assert (clip.node.width, clip.node.height) == (64, 48)
    assert [warning.code for warning in clip.warnings] == [
        "automatic_rgb24_conversion",
        "assumed_color_metadata",
    ]
    for assumption in expected_assumptions:
        assert assumption in clip.warnings[1].message

    frame = clip.node.get_frame(0)
    try:
        assert frame.format.name == "RGB24"
    finally:
        frame.close()


@pytest.mark.parametrize(
    ("clip", "code"),
    [
        (object(), "invalid_clip"),
        (FakeVideoNode(width=0), "unsupported_dimensions"),
        (FakeVideoNode(height=0), "unsupported_dimensions"),
        (FakeVideoNode(num_frames=0), "invalid_clip"),
        (FakeVideoNode(fps=Fraction(0, 1)), "invalid_clip"),
        (FakeVideoNode(format_name=None), "invalid_clip"),
    ],
)
def test_invalid_clip_characteristics_are_rejected(clip: object, code: str) -> None:
    with pytest.raises(KaleidoscopeError) as error:
        build_preview_config(clip, runtime=make_runtime())

    assert error.value.code == code


@pytest.mark.parametrize(
    "clips",
    [
        [FakeVideoNode(num_frames=10), FakeVideoNode(num_frames=11)],
        [
            FakeVideoNode(fps=Fraction(24, 1)),
            FakeVideoNode(fps=Fraction(30, 1)),
        ],
    ],
)
def test_mismatched_timelines_are_rejected(clips: list[FakeVideoNode]) -> None:
    with pytest.raises(KaleidoscopeError) as error:
        build_preview_config(clips, runtime=make_runtime())

    assert error.value.code == "incompatible_clips"


def test_side_by_side_accepts_different_dimensions() -> None:
    config = build_preview_config(
        [
            FakeVideoNode(width=1920, height=1080),
            FakeVideoNode(width=640, height=480),
        ],
        mode="side-by-side",
        runtime=make_runtime(),
    )

    assert config.mode == "side-by-side"
    assert config.active_clip_ids == (0, 1)


@pytest.mark.parametrize("mode", ["wipe", "overlay", "difference"])
def test_aligned_modes_reject_different_source_dimensions(mode: str) -> None:
    with pytest.raises(KaleidoscopeError) as error:
        build_preview_config(
            [
                FakeVideoNode(width=1920, height=1080),
                FakeVideoNode(width=640, height=480),
            ],
            mode=mode,
            runtime=make_runtime(),
        )

    assert error.value.code == "comparison_unsupported"


def test_pair_and_visible_defaults_are_deterministic() -> None:
    clips = {
        "A": FakeVideoNode(),
        "B": FakeVideoNode(),
        "C": FakeVideoNode(),
    }

    pair = build_preview_config(
        clips,
        mode="wipe",
        primary="B",
        runtime=make_runtime(),
    )
    grid = build_preview_config(
        clips,
        mode="side-by-side",
        visible=["C", "A"],
        runtime=make_runtime(),
    )

    assert pair.primary == "B"
    assert pair.secondary == "A"
    assert pair.active_clip_ids == ("B", "A")
    assert grid.active_clip_ids == ("C", "A")


@pytest.mark.parametrize(
    ("kwargs", "code"),
    [
        ({"mode": "wipe", "primary": 0, "secondary": 0}, "comparison_unsupported"),
        ({"mode": "single", "primary": "missing"}, "invalid_clip"),
        ({"mode": "side-by-side", "visible": []}, "comparison_unsupported"),
        (
            {"mode": "side-by-side", "visible": [0, 1], "max_visible_clips": 1},
            "too_many_visible_clips",
        ),
        ({"max_visible_clips": 0}, "too_many_visible_clips"),
        ({"max_visible_clips": True}, "too_many_visible_clips"),
        ({"max_in_flight": True}, "invalid_clip"),
        ({"autoplay": 1}, "invalid_clip"),
        ({"codec": "png"}, "invalid_encoding"),
        ({"codec": "jpeg", "quality": 96}, "invalid_encoding"),
        ({"codec": "webp", "quality": 101}, "invalid_encoding"),
        ({"codec": "jpeg", "lossless": True}, "invalid_encoding"),
    ],
)
def test_invalid_selection_and_encoding_options_are_rejected(
    kwargs: dict[str, Any],
    code: str,
) -> None:
    clips = [FakeVideoNode(), FakeVideoNode()]

    with pytest.raises(KaleidoscopeError) as error:
        build_preview_config(clips, runtime=make_runtime(), **kwargs)

    assert error.value.code == code


def test_pair_mode_requires_two_clips() -> None:
    with pytest.raises(KaleidoscopeError) as error:
        build_preview_config(
            FakeVideoNode(),
            mode="wipe",
            runtime=make_runtime(),
        )

    assert error.value.code == "comparison_unsupported"


def test_preview_keeps_original_dimensions() -> None:
    config = build_preview_config(
        FakeVideoNode(width=640, height=360),
        runtime=make_runtime(),
    )

    assert (config.clips[0].output_width, config.clips[0].output_height) == (
        640,
        360,
    )


def test_webp_requires_pillow_codec_support(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("kaleidoscope.sources.supports_codec", lambda codec: False)

    with pytest.raises(KaleidoscopeError) as error:
        build_preview_config(
            FakeVideoNode(),
            codec="webp",
            runtime=make_runtime(),
        )

    assert error.value.code == "unsupported_codec"


def test_rgb24_is_reused_without_warnings() -> None:
    clip = FakeVideoNode(width=640, height=360)
    prepare_calls: list[object] = []

    config = build_preview_config(
        clip,
        runtime=make_runtime(
            prepare_rgb24=lambda *args: prepare_calls.append(args),
        ),
    )

    assert config.clips[0].node is clip
    assert config.clips[0].preview_format == "RGB24"
    assert config.clips[0].warnings == ()
    assert prepare_calls == []


def test_yuv_fallback_builds_one_rgb24_node_with_assumption_warnings() -> None:
    clip = FakeVideoNode(width=1920, height=1080, format_name="YUV420P8")
    prepared = FakeVideoNode(width=1920, height=1080)
    prepare_calls: list[
        tuple[object, int, int, int | None, int | None, int | None]
    ] = []

    def prepare_rgb24(
        node: object,
        width: int,
        height: int,
        matrix: int | None,
        transfer: int | None,
        color_range: int | None,
    ) -> FakeVideoNode:
        prepare_calls.append((node, width, height, matrix, transfer, color_range))
        return prepared

    config = build_preview_config(
        clip,
        runtime=make_runtime(prepare_rgb24=prepare_rgb24),
    )

    normalized = config.clips[0]
    assert normalized.node is prepared
    assert normalized.source_format == "YUV420P8"
    assert normalized.preview_format == "RGB24"
    assert [warning.code for warning in normalized.warnings] == [
        "automatic_rgb24_conversion",
        "assumed_color_metadata",
    ]
    assert "YUV420P8" in normalized.warnings[0].message
    assert "explicitly upstream" in normalized.warnings[0].message
    assert "matrix BT.709" in normalized.warnings[1].message
    assert "transfer BT.709" in normalized.warnings[1].message
    assert "range limited" in normalized.warnings[1].message
    assert prepare_calls == [(clip, 1920, 1080, 1, 1, 0)]


def test_yuv_fallback_uses_complete_source_color_metadata_without_assumption() -> None:
    clip = FakeVideoNode(format_name="YUV420P8")
    prepare_calls: list[
        tuple[object, int, int, int | None, int | None, int | None]
    ] = []

    def prepare_rgb24(
        node: object,
        width: int,
        height: int,
        matrix: int | None,
        transfer: int | None,
        color_range: int | None,
    ) -> FakeVideoNode:
        prepare_calls.append((node, width, height, matrix, transfer, color_range))
        assert isinstance(node, FakeVideoNode)
        return FakeVideoNode(width=width, height=height)

    config = build_preview_config(
        clip,
        runtime=make_runtime(
            color_metadata=ColorMetadata(matrix=5, transfer=6, range=1),
            prepare_rgb24=prepare_rgb24,
        ),
    )

    assert [warning.code for warning in config.clips[0].warnings] == [
        "automatic_rgb24_conversion"
    ]
    assert prepare_calls == [(clip, 1920, 1080, 5, 6, 1)]


def test_rgb24_conversion_graph_failure_has_stable_error_code() -> None:
    clip = FakeVideoNode(format_name="YUV420P8")

    def fail_conversion(*args: object) -> object:
        del args
        raise RuntimeError("unsafe <script>alert(1)</script>")

    with pytest.raises(KaleidoscopeError) as error:
        build_preview_config(
            clip,
            runtime=make_runtime(prepare_rgb24=fail_conversion),
        )

    assert error.value.code == "conversion_failed"
    assert "script" not in str(error.value)
