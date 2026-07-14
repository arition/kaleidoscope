from __future__ import annotations

import importlib
import logging
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from fractions import Fraction
from typing import Any, Literal

from .encoding import Codec, supports_codec

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
type ColorFamily = Literal["gray", "rgb", "yuv"]

_LOGGER = logging.getLogger(__name__)
_COMPARISON_MODES: frozenset[str] = frozenset(
    {"auto", "single", "side-by-side", "wipe", "overlay", "difference"}
)
_ALIGNED_MODES: frozenset[str] = frozenset({"wipe", "overlay", "difference"})
_MATRIX_RGB = 0
_MATRIX_BT709 = 1
_TRANSFER_BT709 = 1
_RANGE_LIMITED = 0
_RANGE_FULL = 1


class KaleidoscopeError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True, slots=True)
class ColorMetadata:
    matrix: int | None = None
    transfer: int | None = None
    range: int | None = None
    color_family: ColorFamily | None = None


@dataclass(frozen=True, slots=True)
class ClipWarning:
    code: str
    message: str


@dataclass(frozen=True, slots=True)
class VapourSynthRuntime:
    video_node_type: type[Any]
    video_output_type: type[Any]
    audio_node_type: type[Any]
    get_outputs: Callable[[], Mapping[int, object]]
    read_color_metadata: Callable[[object], ColorMetadata]
    prepare_rgb24: Callable[
        [object, int, int, int | None, int | None, int | None], object
    ]


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
    preview_format: str = "RGB24"
    warnings: tuple[ClipWarning, ...] = ()


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
    codec: Codec
    quality: int
    lossless: bool
    cache_size: int
    max_in_flight: int
    autoplay: bool


def load_vapoursynth_runtime() -> VapourSynthRuntime:
    vapoursynth = importlib.import_module("vapoursynth")

    def read_color_metadata(node: Any) -> ColorMetadata:
        frame = node.get_frame(0)
        try:
            return ColorMetadata(
                matrix=_optional_int_prop(frame.props, "_Matrix"),
                transfer=_optional_int_prop(frame.props, "_Transfer"),
                range=_optional_int_prop(frame.props, "_Range"),
                color_family=_vapoursynth_color_family(
                    node.format.color_family,
                    vapoursynth,
                ),
            )
        finally:
            frame.close()

    def prepare_rgb24(
        node: Any,
        width: int,
        height: int,
        matrix: int | None,
        transfer: int | None,
        color_range: int | None,
    ) -> object:
        del width, height
        arguments: dict[str, object] = {
            "format": vapoursynth.RGB24,
        }
        if matrix is not None:
            arguments["matrix_in"] = matrix
        if transfer is not None:
            arguments["transfer_in"] = transfer
        if color_range is not None:
            arguments["range_in"] = color_range
        return node.resize.Lanczos(**arguments)

    return VapourSynthRuntime(
        video_node_type=vapoursynth.VideoNode,
        video_output_type=vapoursynth.VideoOutputTuple,
        audio_node_type=vapoursynth.AudioNode,
        get_outputs=vapoursynth.get_outputs,
        read_color_metadata=read_color_metadata,
        prepare_rgb24=prepare_rgb24,
    )


def _optional_int_prop(props: Any, key: str) -> int | None:
    try:
        return int(props[key])
    except KeyError:
        return None


def _vapoursynth_color_family(value: object, vapoursynth: Any) -> ColorFamily:
    if value == vapoursynth.GRAY:
        return "gray"
    if value == vapoursynth.RGB:
        return "rgb"
    if value == vapoursynth.YUV:
        return "yuv"
    raise ValueError("Unsupported VapourSynth color family.")


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


def _join_assumptions(assumptions: list[str]) -> str:
    if len(assumptions) == 1:
        return assumptions[0]
    if len(assumptions) == 2:
        return f"{assumptions[0]} and {assumptions[1]}"
    return f"{', '.join(assumptions[:-1])}, and {assumptions[-1]}"


def _infer_color_family(source_format: str) -> ColorFamily:
    if source_format.startswith("RGB"):
        return "rgb"
    if source_format.startswith("GRAY"):
        return "gray"
    return "yuv"


def _prepare_preview_node(
    node: object,
    *,
    label: str,
    source_format: str,
    source_width: int,
    source_height: int,
    runtime: VapourSynthRuntime,
) -> tuple[object, tuple[ClipWarning, ...]]:
    if source_format == "RGB24":
        return node, ()

    matrix: int | None = None
    transfer: int | None = None
    color_range: int | None = None
    warnings: tuple[ClipWarning, ...] = ()
    if source_format != "RGB24":
        try:
            metadata = runtime.read_color_metadata(node)
        except Exception as error:
            raise KaleidoscopeError(
                "conversion_failed",
                f"Could not inspect clip {label!r} for automatic RGB24 conversion.",
            ) from error

        color_family = metadata.color_family or _infer_color_family(source_format)
        default_matrix = {
            "gray": None,
            "rgb": _MATRIX_RGB,
            "yuv": _MATRIX_BT709,
        }[color_family]
        default_range = _RANGE_LIMITED if color_family == "yuv" else _RANGE_FULL
        matrix = metadata.matrix if metadata.matrix is not None else default_matrix
        transfer = (
            metadata.transfer if metadata.transfer is not None else _TRANSFER_BT709
        )
        color_range = metadata.range if metadata.range is not None else default_range
        assumed: list[str] = []
        if metadata.matrix is None and default_matrix is not None:
            assumed.append("matrix RGB" if color_family == "rgb" else "matrix BT.709")
        if metadata.transfer is None:
            assumed.append("transfer BT.709")
        if metadata.range is None:
            assumed.append("range limited" if color_family == "yuv" else "range full")

        warning_list = [
            ClipWarning(
                code="automatic_rgb24_conversion",
                message=(
                    f"{source_format} is being converted automatically for preview; "
                    "convert to RGB24 explicitly upstream for controlled color "
                    "handling."
                ),
            )
        ]
        if assumed:
            warning_list.append(
                ClipWarning(
                    code="assumed_color_metadata",
                    message=(
                        "Source color metadata is incomplete; preview assumes "
                        f"{_join_assumptions(assumed)}."
                    ),
                )
            )
        warnings = tuple(warning_list)

    try:
        prepared = runtime.prepare_rgb24(
            node,
            source_width,
            source_height,
            matrix,
            transfer,
            color_range,
        )
    except Exception as error:
        raise KaleidoscopeError(
            "conversion_failed",
            f"Could not prepare clip {label!r} as RGB24 for preview.",
        ) from error

    preview_format = getattr(getattr(prepared, "format", None), "name", None)
    if (
        preview_format != "RGB24"
        or getattr(prepared, "width", None) != source_width
        or getattr(prepared, "height", None) != source_height
    ):
        raise KaleidoscopeError(
            "conversion_failed",
            f"Could not prepare clip {label!r} as RGB24 for preview.",
        )
    return prepared, warnings


def _validate_clip(
    clip_id: ClipId,
    label: str,
    node: object,
    runtime: VapourSynthRuntime,
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
    preview_node, warnings = _prepare_preview_node(
        node,
        label=label,
        source_format=format_name,
        source_width=source_width,
        source_height=source_height,
        runtime=runtime,
    )
    return (
        NormalizedClip(
            id=clip_id,
            label=label,
            node=preview_node,
            source_format=format_name,
            preview_format="RGB24",
            source_width=source_width,
            source_height=source_height,
            output_width=source_width,
            output_height=source_height,
            warnings=warnings,
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
    codec: Codec = "jpeg",
    quality: int = 80,
    lossless: bool = False,
    cache_size: int = 32,
    max_in_flight: int = 4,
    autoplay: bool = False,
    runtime: VapourSynthRuntime,
) -> PreviewConfig:
    if mode not in _COMPARISON_MODES:
        raise KaleidoscopeError("comparison_unsupported", f"Unknown mode {mode!r}.")
    if (
        not isinstance(max_visible_clips, int)
        or isinstance(max_visible_clips, bool)
        or not 1 <= max_visible_clips <= 4
    ):
        raise KaleidoscopeError(
            "too_many_visible_clips",
            "max_visible_clips must be between 1 and 4.",
        )
    if not isinstance(overlay_opacity, int | float) or not 0 <= overlay_opacity <= 1:
        raise KaleidoscopeError(
            "comparison_unsupported",
            "overlay_opacity must be between 0 and 1.",
        )
    if codec not in {"jpeg", "webp"}:
        raise KaleidoscopeError(
            "invalid_encoding",
            "codec must be either 'jpeg' or 'webp'.",
        )
    if not supports_codec(codec):
        raise KaleidoscopeError(
            "unsupported_codec",
            "Pillow WebP support is unavailable.",
        )
    if not isinstance(lossless, bool):
        raise KaleidoscopeError("invalid_encoding", "lossless must be a boolean.")
    maximum_quality = 95 if codec == "jpeg" else 100
    if (
        not isinstance(quality, int)
        or isinstance(quality, bool)
        or not 0 <= quality <= maximum_quality
    ):
        raise KaleidoscopeError(
            "invalid_encoding",
            f"{codec.upper()} quality must be between 0 and {maximum_quality}.",
        )
    if lossless and codec != "webp":
        raise KaleidoscopeError(
            "invalid_encoding",
            "lossless=True is only available with codec='webp'.",
        )
    if (
        not isinstance(cache_size, int)
        or isinstance(cache_size, bool)
        or cache_size < 0
    ):
        raise KaleidoscopeError("invalid_clip", "cache_size must be non-negative.")
    if (
        not isinstance(max_in_flight, int)
        or isinstance(max_in_flight, bool)
        or not 1 <= max_in_flight <= 16
    ):
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
        codec=codec,
        quality=quality,
        lossless=lossless,
        cache_size=cache_size,
        max_in_flight=max_in_flight,
        autoplay=autoplay,
    )
