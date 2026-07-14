from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from io import BytesIO
from typing import Literal

from PIL import Image, features

MAX_ENCODED_FRAME_BYTES = 16 * 1024 * 1024

type Codec = Literal["jpeg", "webp"]
type Encoder = Callable[[bytes, int, int, int], "EncodedImage"]


class EncodingError(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class EncodedImage:
    mime: str
    data: bytes


def _validate_rgb(pixels: bytes, width: int, height: int) -> None:
    if width <= 0 or height <= 0:
        raise EncodingError("Image dimensions must be positive.")
    if len(pixels) != width * height * 3:
        raise EncodingError("RGB byte length does not match the image dimensions.")


def _validate_payload(data: bytes) -> None:
    if not data or len(data) > MAX_ENCODED_FRAME_BYTES:
        raise EncodingError("Encoded frame exceeds the payload limit.")


def supports_codec(codec: Codec) -> bool:
    return codec == "jpeg" or (codec == "webp" and bool(features.check("webp")))


def encode_jpeg(
    pixels: bytes,
    width: int,
    height: int,
    quality: int,
) -> EncodedImage:
    _validate_rgb(pixels, width, height)
    if not 0 <= quality <= 95:
        raise EncodingError("JPEG quality must be between 0 and 95.")

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

    _validate_payload(data)
    return EncodedImage(mime="image/jpeg", data=data)


def encode_webp(
    pixels: bytes,
    width: int,
    height: int,
    quality: int,
    *,
    lossless: bool,
) -> EncodedImage:
    _validate_rgb(pixels, width, height)
    if not 0 <= quality <= 100:
        raise EncodingError("WebP quality must be between 0 and 100.")
    if not isinstance(lossless, bool):
        raise EncodingError("WebP lossless must be a boolean.")
    if not features.check("webp"):
        raise EncodingError("Pillow WebP support is unavailable.")

    with (
        Image.frombytes("RGB", (width, height), pixels) as image,
        BytesIO() as output,
    ):
        image.save(
            output,
            format="WEBP",
            quality=quality,
            lossless=lossless,
            method=0,
            exact=False,
        )
        data = output.getvalue()

    _validate_payload(data)
    return EncodedImage(mime="image/webp", data=data)


def create_encoder(codec: Codec, *, lossless: bool) -> Encoder:
    if codec == "jpeg":
        if lossless:
            raise EncodingError("Lossless encoding is only available with WebP.")
        return encode_jpeg
    if codec == "webp":
        if not supports_codec(codec):
            raise EncodingError("Pillow WebP support is unavailable.")

        def encoder(
            pixels: bytes,
            width: int,
            height: int,
            quality: int,
        ) -> EncodedImage:
            return encode_webp(
                pixels,
                width,
                height,
                quality,
                lossless=lossless,
            )

        return encoder
    raise EncodingError(f"Unsupported codec {codec!r}.")
