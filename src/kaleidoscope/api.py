from __future__ import annotations

from collections.abc import Mapping, Sequence
from concurrent.futures import Future
from fractions import Fraction
from typing import Any, Protocol

from .encoding import Codec
from .sources import (
    ClipId,
    ComparisonMode,
    build_preview_config,
    load_vapoursynth_runtime,
)
from .widget import PreviewWidget


class VideoNodeLike(Protocol):
    @property
    def width(self) -> int: ...

    @property
    def height(self) -> int: ...

    @property
    def num_frames(self) -> int: ...

    @property
    def fps(self) -> Fraction: ...

    @property
    def format(self) -> object: ...

    def get_frame(self, frame: int) -> object: ...

    def get_frame_async(self, frame: int) -> Future[Any]: ...


type ClipInput = (
    VideoNodeLike | Sequence[VideoNodeLike] | Mapping[ClipId, VideoNodeLike]
)


def preview(
    clips: ClipInput | None = None,
    *,
    output_ids: Sequence[int] | None = None,
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
) -> PreviewWidget:
    config = build_preview_config(
        clips,
        output_ids=output_ids,
        mode=mode,
        primary=primary,
        secondary=secondary,
        visible=visible,
        overlay_opacity=overlay_opacity,
        max_visible_clips=max_visible_clips,
        codec=codec,
        quality=quality,
        lossless=lossless,
        cache_size=cache_size,
        max_in_flight=max_in_flight,
        autoplay=autoplay,
        runtime=load_vapoursynth_runtime(),
    )
    return PreviewWidget(config=config)
