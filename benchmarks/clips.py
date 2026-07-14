from __future__ import annotations

import importlib
from math import ceil
from typing import Any


def _tile_color(
    vapoursynth: Any,
    format_id: int,
    x: int,
    y: int,
    seed: int,
) -> list[int]:
    if format_id == vapoursynth.RGB24:
        return [
            (x * 31 + y * 17 + seed * 13) % 256,
            (x * 11 + y * 37 + seed * 29) % 256,
            (x * 43 + y * 7 + seed * 19) % 256,
        ]
    return [
        16 + ((x * 23 + y * 17 + seed * 11) % 220),
        16 + ((x * 13 + y * 31 + seed * 7) % 225),
        16 + ((x * 37 + y * 5 + seed * 17) % 225),
    ]


def make_tiled_clip(
    *,
    format_name: str,
    width: int,
    height: int,
    seed: int,
    num_frames: int,
) -> Any:
    vs = importlib.import_module("vapoursynth")

    columns, rows = 8, 6
    if width % columns or height % rows:
        raise ValueError("Benchmark dimensions must be divisible by the tile grid.")
    format_id = getattr(vs, format_name)
    tile_width = width // columns
    tile_height = height // rows
    variant_length = ceil(num_frames / 4)
    variants = []
    for variant in range(4):
        row_clips = []
        variant_seed = seed * 4 + variant
        for y in range(rows):
            cells = [
                vs.core.std.BlankClip(
                    width=tile_width,
                    height=tile_height,
                    length=variant_length,
                    fpsnum=24,
                    fpsden=1,
                    format=format_id,
                    color=_tile_color(vs, format_id, x, y, variant_seed),
                )
                for x in range(columns)
            ]
            row_clips.append(vs.core.std.StackHorizontal(cells))
        variants.append(vs.core.std.StackVertical(row_clips))
    return vs.core.std.Interleave(variants)


def make_tiled_clip_set(
    *,
    clip_count: int,
    format_name: str,
    width: int,
    height: int,
    num_frames: int,
) -> dict[str, Any]:
    return {
        f"Clip {index + 1}": make_tiled_clip(
            format_name=format_name,
            width=width,
            height=height,
            seed=index,
            num_frames=num_frames,
        )
        for index in range(clip_count)
    }
