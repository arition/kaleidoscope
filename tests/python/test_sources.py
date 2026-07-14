from __future__ import annotations

from dataclasses import FrozenInstanceError
from fractions import Fraction
from typing import Any

import pytest

from kaleidoscope.sources import (
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


def make_runtime(outputs: dict[int, object] | None = None) -> VapourSynthRuntime:
    registry = {} if outputs is None else outputs
    return VapourSynthRuntime(
        video_node_type=FakeVideoNode,
        video_output_type=FakeVideoOutput,
        audio_node_type=FakeAudioNode,
        get_outputs=lambda: registry,
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


def test_mapping_preserves_ids_labels_order_and_calculates_preview_size() -> None:
    source = FakeVideoNode(width=1920, height=1080)
    filtered = FakeVideoNode(width=1280, height=720)

    config = build_preview_config(
        {"Source": source, "Filtered": filtered},
        mode="side-by-side",
        width=960,
        height=540,
        runtime=make_runtime(),
    )

    assert [item.id for item in config.clips] == ["Source", "Filtered"]
    assert [item.label for item in config.clips] == ["Source", "Filtered"]
    assert [(item.output_width, item.output_height) for item in config.clips] == [
        (960, 540),
        (960, 540),
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
        ({"width": 0}, "unsupported_dimensions"),
        ({"height": -1}, "unsupported_dimensions"),
    ],
)
def test_invalid_selection_and_dimension_options_are_rejected(
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


def test_preview_size_never_upscales() -> None:
    config = build_preview_config(
        FakeVideoNode(width=640, height=360),
        width=1920,
        height=1080,
        runtime=make_runtime(),
    )

    assert (config.clips[0].output_width, config.clips[0].output_height) == (
        640,
        360,
    )
