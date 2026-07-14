from __future__ import annotations

from io import BytesIO

import pytest
from PIL import Image, features

from kaleidoscope.encoding import (
    EncodingError,
    create_encoder,
    encode_jpeg,
    encode_webp,
)


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


@pytest.mark.skipif(not features.check("webp"), reason="Pillow lacks WebP support")
def test_encode_webp_lossless_round_trips_exact_rgb_pixels() -> None:
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

    encoded = encode_webp(
        pixels,
        width=2,
        height=2,
        quality=100,
        lossless=True,
    )

    assert encoded.mime == "image/webp"
    assert encoded.data.startswith(b"RIFF")
    assert encoded.data[8:12] == b"WEBP"
    with Image.open(BytesIO(encoded.data)) as image:
        assert image.mode == "RGB"
        assert image.size == (2, 2)
        assert image.tobytes() == pixels


@pytest.mark.parametrize("quality", [-1, 96])
def test_encode_jpeg_rejects_quality_outside_documented_range(quality: int) -> None:
    with pytest.raises(EncodingError, match="between 0 and 95"):
        encode_jpeg(bytes(3), width=1, height=1, quality=quality)


@pytest.mark.parametrize("quality", [-1, 101])
def test_encode_webp_rejects_quality_outside_documented_range(quality: int) -> None:
    with pytest.raises(EncodingError, match="between 0 and 100"):
        encode_webp(
            bytes(3),
            width=1,
            height=1,
            quality=quality,
            lossless=False,
        )


def test_create_webp_encoder_rejects_missing_pillow_support(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("kaleidoscope.encoding.features.check", lambda feature: False)

    with pytest.raises(EncodingError, match="WebP support is unavailable"):
        create_encoder("webp", lossless=False)
