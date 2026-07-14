from __future__ import annotations

from pathlib import Path

import vapoursynth as vs

from kaleidoscope.encoding import encode_jpeg
from kaleidoscope.frame_adapter import interleave_rgb24

_OUTPUT_DIR = Path(__file__).parent / "harness"


def encode_fixture(name: str, color: list[int]) -> None:
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

    _OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    (_OUTPUT_DIR / name).write_bytes(encoded.data)


def main() -> None:
    encode_fixture("frame.jpg", [220, 40, 20])
    encode_fixture("filtered.jpg", [20, 190, 220])


if __name__ == "__main__":
    main()
