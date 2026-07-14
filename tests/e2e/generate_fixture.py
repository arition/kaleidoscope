from __future__ import annotations

from pathlib import Path

import vapoursynth as vs

from kaleidoscope.encoding import encode_jpeg
from kaleidoscope.frame_adapter import interleave_rgb24

_OUTPUT = Path(__file__).parent / "harness" / "frame.jpg"


def main() -> None:
    clip = vs.core.std.BlankClip(
        width=64,
        height=48,
        length=1,
        format=vs.RGB24,
        color=[220, 40, 20],
    )
    frame = clip.get_frame_async(0).result()
    try:
        pixels = interleave_rgb24(frame)
        encoded = encode_jpeg(pixels, frame.width, frame.height, quality=95)
    finally:
        frame.close()

    _OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    _OUTPUT.write_bytes(encoded.data)


if __name__ == "__main__":
    main()
