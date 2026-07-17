from __future__ import annotations

import shutil
from pathlib import Path

import vapoursynth as vs

from kaleidoscope.encoding import encode_jpeg, encode_webp
from kaleidoscope.frame_adapter import interleave_rgb24

ROOT = Path(__file__).parents[2]
HARNESS_SOURCE = Path(__file__).parent / "harness"
DEFAULT_SITE = ROOT / "node_modules" / ".cache" / "kaleidoscope-e2e-site"


def stage_harness(site: Path) -> Path:
    if site.exists():
        shutil.rmtree(site)
    harness = site / "tests" / "e2e" / "harness"
    static = site / "src" / "kaleidoscope" / "static"
    harness.mkdir(parents=True)
    static.mkdir(parents=True)
    for name in ("index.html", "model.js"):
        shutil.copy2(HARNESS_SOURCE / name, harness / name)
    for name in ("index.js", "index.css"):
        shutil.copy2(ROOT / "src" / "kaleidoscope" / "static" / name, static / name)
    return harness


def encode_fixture(output_dir: Path, name: str, color: list[int]) -> None:
    clip = vs.core.std.BlankClip(
        width=64,
        height=48,
        length=1,
        format=vs.RGB24,
        color=color,
    )
    frame = clip.get_frame_async(0).result()
    try:
        pixels = interleave_rgb24(frame)
        encoded = encode_jpeg(pixels, frame.width, frame.height, quality=95)
    finally:
        frame.close()

    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / name).write_bytes(encoded.data)


def encode_webp_fixture(output_dir: Path, name: str, color: list[int]) -> None:
    clip = vs.core.std.BlankClip(
        width=64,
        height=48,
        length=1,
        format=vs.RGB24,
        color=color,
    )
    frame = clip.get_frame_async(0).result()
    try:
        pixels = interleave_rgb24(frame)
        encoded = encode_webp(
            pixels,
            frame.width,
            frame.height,
            quality=100,
            lossless=True,
        )
    finally:
        frame.close()

    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / name).write_bytes(encoded.data)


def main() -> None:
    output_dir = stage_harness(DEFAULT_SITE)
    encode_fixture(output_dir, "frame.jpg", [220, 40, 20])
    encode_fixture(output_dir, "filtered.jpg", [20, 190, 220])
    encode_fixture(output_dir, "reference.jpg", [40, 210, 60])
    encode_webp_fixture(output_dir, "frame.webp", [220, 40, 20])


if __name__ == "__main__":
    main()
