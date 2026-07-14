from __future__ import annotations

from io import BytesIO

from PIL import Image

from kaleidoscope.encoding import encode_jpeg


def test_encode_jpeg_produces_a_decodable_baseline_rgb_image() -> None:
    pixels = bytes(
        [
            255,
            0,
            0,
            0,
            255,
            0,
            0,
            0,
            255,
            255,
            255,
            255,
        ]
    )

    encoded = encode_jpeg(pixels, width=2, height=2, quality=80)

    assert encoded.mime == "image/jpeg"
    assert encoded.data.startswith(b"\xff\xd8")
    assert encoded.data.endswith(b"\xff\xd9")
    assert len(encoded.data) < 16 * 1024
    with Image.open(BytesIO(encoded.data)) as image:
        assert image.mode == "RGB"
        assert image.size == (2, 2)
        assert image.info.get("progressive") is None
