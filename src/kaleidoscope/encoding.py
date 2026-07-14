from __future__ import annotations

from dataclasses import dataclass
from io import BytesIO

from PIL import Image

MAX_ENCODED_FRAME_BYTES = 16 * 1024 * 1024


class EncodingError(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class EncodedImage:
    mime: str
    data: bytes


def encode_jpeg(
    pixels: bytes,
    width: int,
    height: int,
    quality: int,
) -> EncodedImage:
    if width <= 0 or height <= 0:
        raise EncodingError("Image dimensions must be positive.")
    if len(pixels) != width * height * 3:
        raise EncodingError("RGB byte length does not match the image dimensions.")
    if not 1 <= quality <= 100:
        raise EncodingError("JPEG quality must be between 1 and 100.")

    with (
        Image.frombytes("RGB", (width, height), pixels) as image,
        BytesIO() as output,
    ):
        image.save(
            output,
            format="JPEG",
            quality=quality,
            subsampling="4:2:0",
            optimize=False,
            progressive=False,
        )
        data = output.getvalue()

    if not data or len(data) > MAX_ENCODED_FRAME_BYTES:
        raise EncodingError("Encoded frame exceeds the payload limit.")
    return EncodedImage(mime="image/jpeg", data=data)
