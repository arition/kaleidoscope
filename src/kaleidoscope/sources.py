from __future__ import annotations

import importlib
import logging
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from fractions import Fraction
from typing import Any, Literal

type ClipId = int | str
type ComparisonMode = Literal[
    "auto",
    "single",
    "side-by-side",
    "wipe",
    "overlay",
    "difference",
]
type ResolvedMode = Literal[
    "single",
    "side-by-side",
    "wipe",
    "overlay",
    "difference",
]

_LOGGER = logging.getLogger(__name__)
_COMPARISON_MODES: frozenset[str] = frozenset(
    {"auto", "single", "side-by-side", "wipe", "overlay", "difference"}
)
_ALIGNED_MODES: frozenset[str] = frozenset({"wipe", "overlay", "difference"})


class KaleidoscopeError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True, slots=True)
class VapourSynthRuntime:
    video_node_type: type[Any]
    video_output_type: type[Any]
    audio_node_type: type[Any]
    get_outputs: Callable[[], Mapping[int, object]]


@dataclass(frozen=True, slots=True)
class NormalizedClip:
    id: ClipId
    label: str
    node: object
    source_format: str
    source_width: int
    source_height: int
    output_width: int
    output_height: int


@dataclass(frozen=True, slots=True)
class PreviewConfig:
    clips: tuple[NormalizedClip, ...]
    num_frames: int
    fps: Fraction
    mode: ResolvedMode
    primary: ClipId | None
    secondary: ClipId | None
    active_clip_ids: tuple[ClipId, ...]
    overlay_opacity: float
    max_visible_clips: int
    quality: int
    cache_size: int
    max_in_flight: int
    autoplay: bool


def load_vapoursynth_runtime() -> VapourSynthRuntime:
    vapoursynth = importlib.import_module("vapoursynth")
    return VapourSynthRuntime(
        video_node_type=vapoursynth.VideoNode,
        video_output_type=vapoursynth.VideoOutputTuple,
        audio_node_type=vapoursynth.AudioNode,
        get_outputs=vapoursynth.get_outputs,
    )


def _is_clip_id(value: object) -> bool:
    return (isinstance(value, int) and not isinstance(value, bool)) or (
        isinstance(value, str) and bool(value)
    )


def _normalize_inputs(
    clips: object | None,
    runtime: VapourSynthRuntime,
) -> tuple[tuple[ClipId, str, object], ...]:
    if clips is None:
        snapshot = dict(runtime.get_outputs())
        normalized: list[tuple[ClipId, str, object]] = []
        for output_id in sorted(snapshot):
            output = snapshot[output_id]
            if isinstance(output, runtime.video_output_type):
                normalized.append((output_id, f"Output {output_id}", output.clip))
            elif isinstance(output, runtime.audio_node_type):
                _LOGGER.debug("Ignoring registered audio output %s", output_id)
        if not normalized:
            raise KaleidoscopeError(
                "no_video_outputs",
                "No registered VapourSynth video outputs were found.",
            )
        return tuple(normalized)

    if isinstance(clips, runtime.video_node_type):
        return ((0, "Clip 0", clips),)

    if isinstance(clips, Mapping):
        normalized = []
        seen_ids: set[ClipId] = set()
        for clip_id, node in clips.items():
            if not _is_clip_id(clip_id):
                raise KaleidoscopeError(
                    "invalid_clip",
                    "Clip IDs must be non-empty strings or integers.",
                )
            if clip_id in seen_ids:
                raise KaleidoscopeError(
                    "duplicate_clip_id",
                    f"Clip ID {clip_id!r} is duplicated.",
                )
            seen_ids.add(clip_id)
            normalized.append((clip_id, str(clip_id), node))
        if not normalized:
            raise KaleidoscopeError("invalid_clip", "At least one clip is required.")
        return tuple(normalized)

    if isinstance(clips, Sequence) and not isinstance(clips, str | bytes | bytearray):
        if not clips:
            raise KaleidoscopeError("invalid_clip", "At least one clip is required.")
        return tuple((index, f"Clip {index}", node) for index, node in enumerate(clips))

    raise KaleidoscopeError(
        "invalid_clip",
        "Clips must be a VideoNode, sequence, mapping, or registered output snapshot.",
    )


def _positive_int(value: object, *, code: str, message: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
        raise KaleidoscopeError(code, message)
    return value


def _clip_fps(node: object) -> Fraction:
    fps = getattr(node, "fps", None)
    numerator = getattr(fps, "numerator", None)
    denominator = getattr(fps, "denominator", None)
    if (
        not isinstance(numerator, int)
        or not isinstance(denominator, int)
        or numerator <= 0
        or denominator <= 0
    ):
        raise KaleidoscopeError(
            "invalid_clip",
            "Clips must have a positive constant frame rate.",
        )
    return Fraction(numerator, denominator)


def _output_dimensions(
    source_width: int,
    source_height: int,
    width: int | None,
    height: int | None,
) -> tuple[int, int]:
    scales = [Fraction(1, 1)]
    if width is not None:
        scales.append(Fraction(width, source_width))
    if height is not None:
        scales.append(Fraction(height, source_height))
    scale = min(scales)
    return max(1, int(source_width * scale)), max(1, int(source_height * scale))


def _validate_clip(
    clip_id: ClipId,
    label: str,
    node: object,
    runtime: VapourSynthRuntime,
    width: int | None,
    height: int | None,
) -> tuple[NormalizedClip, int, Fraction]:
    if not isinstance(node, runtime.video_node_type):
        raise KaleidoscopeError(
            "invalid_clip",
            f"Clip {label!r} is not a VapourSynth VideoNode.",
        )

    source_width = _positive_int(
        getattr(node, "width", None),
        code="unsupported_dimensions",
        message=f"Clip {label!r} must have fixed positive dimensions.",
    )
    source_height = _positive_int(
        getattr(node, "height", None),
        code="unsupported_dimensions",
        message=f"Clip {label!r} must have fixed positive dimensions.",
    )
    num_frames = _positive_int(
        getattr(node, "num_frames", None),
        code="invalid_clip",
        message=f"Clip {label!r} must have a positive frame count.",
    )
    fps = _clip_fps(node)
    video_format = getattr(node, "format", None)
    format_name = getattr(video_format, "name", None)
    if not isinstance(format_name, str) or not format_name:
        raise KaleidoscopeError(
            "invalid_clip",
            f"Clip {label!r} must have a known constant format.",
        )
    output_width, output_height = _output_dimensions(
        source_width,
        source_height,
        width,
        height,
    )
    return (
        NormalizedClip(
            id=clip_id,
            label=label,
            node=node,
            source_format=format_name,
            source_width=source_width,
            source_height=source_height,
            output_width=output_width,
            output_height=output_height,
        ),
        num_frames,
        fps,
    )


def _resolve_id(
    value: ClipId | None,
    clip_ids: tuple[ClipId, ...],
    *,
    fallback: ClipId,
) -> ClipId:
    resolved = fallback if value is None else value
    if resolved not in clip_ids:
        raise KaleidoscopeError(
            "invalid_clip",
            f"Unknown clip ID {resolved!r}.",
        )
    return resolved


def _resolve_selection(
    mode: ResolvedMode,
    clips: tuple[NormalizedClip, ...],
    primary: ClipId | None,
    secondary: ClipId | None,
    visible: Sequence[ClipId] | None,
    max_visible_clips: int,
) -> tuple[ClipId | None, ClipId | None, tuple[ClipId, ...]]:
    clip_ids = tuple(clip.id for clip in clips)
    first = clip_ids[0]

    if mode == "single":
        selected_primary = _resolve_id(primary, clip_ids, fallback=first)
        if secondary is not None:
            _resolve_id(secondary, clip_ids, fallback=first)
        return selected_primary, None, (selected_primary,)

    if mode == "side-by-side":
        if visible is None:
            active = clip_ids[:max_visible_clips]
        else:
            active = tuple(visible)
            if not active:
                raise KaleidoscopeError(
                    "comparison_unsupported",
                    "Side-by-side mode requires at least one visible clip.",
                )
            if len(set(active)) != len(active):
                raise KaleidoscopeError(
                    "duplicate_clip_id",
                    "Visible clip IDs must be unique.",
                )
            for clip_id in active:
                _resolve_id(clip_id, clip_ids, fallback=first)
        if len(active) > max_visible_clips:
            raise KaleidoscopeError(
                "too_many_visible_clips",
                "The visible clip selection exceeds max_visible_clips.",
            )
        selected_primary = _resolve_id(
            primary,
            clip_ids,
            fallback=active[0],
        )
        if secondary is not None:
            _resolve_id(secondary, clip_ids, fallback=first)
        return selected_primary, None, active

    if len(clips) < 2:
        raise KaleidoscopeError(
            "comparison_unsupported",
            f"{mode} mode requires at least two clips.",
        )
    selected_primary = _resolve_id(primary, clip_ids, fallback=first)
    if secondary is None:
        selected_secondary = next(
            clip_id for clip_id in clip_ids if clip_id != selected_primary
        )
    else:
        selected_secondary = _resolve_id(secondary, clip_ids, fallback=first)
    if selected_secondary == selected_primary:
        raise KaleidoscopeError(
            "comparison_unsupported",
            "Comparison modes require distinct primary and secondary clips.",
        )
    active = (selected_primary, selected_secondary)
    if len(active) > max_visible_clips:
        raise KaleidoscopeError(
            "too_many_visible_clips",
            "The active comparison exceeds max_visible_clips.",
        )
    return selected_primary, selected_secondary, active


def build_preview_config(
    clips: object | None,
    *,
    mode: ComparisonMode = "auto",
    primary: ClipId | None = None,
    secondary: ClipId | None = None,
    visible: Sequence[ClipId] | None = None,
    overlay_opacity: float = 0.5,
    max_visible_clips: int = 4,
    width: int | None = None,
    height: int | None = 720,
    quality: int = 80,
    cache_size: int = 32,
    max_in_flight: int = 4,
    autoplay: bool = False,
    runtime: VapourSynthRuntime,
) -> PreviewConfig:
    if mode not in _COMPARISON_MODES:
        raise KaleidoscopeError("comparison_unsupported", f"Unknown mode {mode!r}.")
    if not isinstance(max_visible_clips, int) or not 1 <= max_visible_clips <= 4:
        raise KaleidoscopeError(
            "too_many_visible_clips",
            "max_visible_clips must be between 1 and 4.",
        )
    if width is not None:
        _positive_int(
            width,
            code="unsupported_dimensions",
            message="Preview width must be a positive integer.",
        )
    if height is not None:
        _positive_int(
            height,
            code="unsupported_dimensions",
            message="Preview height must be a positive integer.",
        )
    if not isinstance(overlay_opacity, int | float) or not 0 <= overlay_opacity <= 1:
        raise KaleidoscopeError(
            "comparison_unsupported",
            "overlay_opacity must be between 0 and 1.",
        )
    if (
        not isinstance(quality, int)
        or isinstance(quality, bool)
        or not 1 <= quality <= 100
    ):
        raise KaleidoscopeError("invalid_clip", "quality must be between 1 and 100.")
    if (
        not isinstance(cache_size, int)
        or isinstance(cache_size, bool)
        or cache_size < 0
    ):
        raise KaleidoscopeError("invalid_clip", "cache_size must be non-negative.")
    if not isinstance(max_in_flight, int) or not 1 <= max_in_flight <= 16:
        raise KaleidoscopeError(
            "invalid_clip",
            "max_in_flight must be between 1 and 16.",
        )

    normalized_inputs = _normalize_inputs(clips, runtime)
    normalized_clips: list[NormalizedClip] = []
    timeline_frames: int | None = None
    timeline_fps: Fraction | None = None
    for clip_id, label, node in normalized_inputs:
        clip, num_frames, fps = _validate_clip(
            clip_id,
            label,
            node,
            runtime,
            width,
            height,
        )
        if timeline_frames is None:
            timeline_frames = num_frames
            timeline_fps = fps
        elif num_frames != timeline_frames or fps != timeline_fps:
            raise KaleidoscopeError(
                "incompatible_clips",
                "All clips must have matching frame counts and frame rates.",
            )
        normalized_clips.append(clip)

    clips_tuple = tuple(normalized_clips)
    resolved_mode: ResolvedMode
    if mode == "auto":
        resolved_mode = "single" if len(clips_tuple) == 1 else "side-by-side"
    else:
        resolved_mode = mode
    selected_primary, selected_secondary, active_clip_ids = _resolve_selection(
        resolved_mode,
        clips_tuple,
        primary,
        secondary,
        visible,
        max_visible_clips,
    )

    if resolved_mode in _ALIGNED_MODES:
        selected = {clip.id: clip for clip in clips_tuple if clip.id in active_clip_ids}
        first_clip, second_clip = (selected[clip_id] for clip_id in active_clip_ids)
        if (
            first_clip.source_width != second_clip.source_width
            or first_clip.source_height != second_clip.source_height
        ):
            raise KaleidoscopeError(
                "comparison_unsupported",
                "Aligned comparison modes require matching source dimensions.",
            )

    assert timeline_frames is not None
    assert timeline_fps is not None
    return PreviewConfig(
        clips=clips_tuple,
        num_frames=timeline_frames,
        fps=timeline_fps,
        mode=resolved_mode,
        primary=selected_primary,
        secondary=selected_secondary,
        active_clip_ids=active_clip_ids,
        overlay_opacity=float(overlay_opacity),
        max_visible_clips=max_visible_clips,
        quality=quality,
        cache_size=cache_size,
        max_in_flight=max_in_flight,
        autoplay=autoplay,
    )
