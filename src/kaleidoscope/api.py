from __future__ import annotations

from collections.abc import Mapping, Sequence

from .encoding import Codec
from .sources import (
    ClipId,
    ComparisonMode,
    build_preview_config,
    load_vapoursynth_runtime,
)
from .widget import PreviewWidget

type ClipInput = object | Sequence[object] | Mapping[ClipId, object]


def preview(
    clips: ClipInput | None = None,
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
) -> PreviewWidget:
    config = build_preview_config(
        clips,
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
