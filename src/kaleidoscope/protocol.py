from __future__ import annotations

from collections.abc import Mapping, Sequence
from math import isfinite
from typing import Literal, NotRequired, TypedDict, TypeGuard, cast

from .sources import ClipId

PROTOCOL_VERSION: Literal[1] = 1
MAX_FRAME_BUFFER_BYTES = 16 * 1024 * 1024
MAX_FRAME_SET_BYTES = 64 * 1024 * 1024


class Capabilities(TypedDict):
    image_bitmap: bool
    webp: bool


class ReadyMessage(TypedDict):
    protocol: Literal[1]
    type: Literal["ready"]
    session_id: str
    capabilities: Capabilities


class RequestFrameSetMessage(TypedDict):
    protocol: Literal[1]
    type: Literal["request_frame_set"]
    session_id: str
    request_id: int
    generation: int
    frame: int
    clip_ids: list[ClipId]
    reason: Literal["seek", "playback", "prefetch"]


type FrontendMessage = ReadyMessage | RequestFrameSetMessage


class MetadataMessage(TypedDict):
    protocol: Literal[1]
    type: Literal["metadata"]
    session_id: str
    status: Literal["initialized"]
    num_frames: NotRequired[int]
    fps_num: NotRequired[int]
    fps_den: NotRequired[int]
    mode: NotRequired[str]
    active_clip_ids: NotRequired[list[int | str]]
    max_visible_clips: NotRequired[int]
    clips: NotRequired[list[dict[str, object]]]


class ErrorMessage(TypedDict):
    protocol: Literal[1]
    type: Literal["error"]
    session_id: str
    code: str
    message: str
    recoverable: bool
    request_id: NotRequired[int]
    generation: NotRequired[int]
    clip_id: NotRequired[ClipId]


class FrameManifest(TypedDict):
    clip_id: ClipId
    buffer_index: int
    mime: str
    byte_length: int
    render_ms: float
    encode_ms: float


class FrameSetMessage(TypedDict):
    protocol: Literal[1]
    type: Literal["frame_set"]
    session_id: str
    request_id: int
    generation: int
    frame: int
    frames: list[FrameManifest]


class ProtocolError(ValueError):
    def __init__(
        self,
        code: Literal["invalid_message", "protocol_mismatch"],
        message: str,
    ) -> None:
        super().__init__(message)
        self.code = code


def _is_capabilities(value: object) -> TypeGuard[Capabilities]:
    return (
        isinstance(value, dict)
        and set(value) == {"image_bitmap", "webp"}
        and isinstance(value["image_bitmap"], bool)
        and isinstance(value["webp"], bool)
    )


def _is_nonnegative_int(value: object) -> TypeGuard[int]:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def _is_nonnegative_number(value: object) -> bool:
    return (
        isinstance(value, int | float)
        and not isinstance(value, bool)
        and isfinite(value)
        and value >= 0
    )


def _is_clip_id(value: object) -> TypeGuard[ClipId]:
    return (isinstance(value, int) and not isinstance(value, bool)) or (
        isinstance(value, str) and bool(value)
    )


def parse_frontend_message(value: object) -> FrontendMessage:
    if not isinstance(value, dict):
        raise ProtocolError("invalid_message", "Frontend message must be an object.")

    protocol = value.get("protocol")
    if protocol != PROTOCOL_VERSION:
        if isinstance(protocol, int):
            raise ProtocolError(
                "protocol_mismatch",
                "Unsupported protocol version "
                f"{protocol}; expected {PROTOCOL_VERSION}.",
            )
        raise ProtocolError(
            "invalid_message",
            "Frontend message is missing protocol version 1.",
        )

    session_id = value.get("session_id")
    if not isinstance(session_id, str) or not session_id:
        raise ProtocolError("invalid_message", "Frontend message has no session ID.")

    if value.get("type") == "ready":
        capabilities = value.get("capabilities")
        if not _is_capabilities(capabilities):
            raise ProtocolError("invalid_message", "Malformed ready message.")
        return cast(ReadyMessage, value)

    if value.get("type") == "request_frame_set":
        clip_ids = value.get("clip_ids")
        if (
            not _is_nonnegative_int(value.get("request_id"))
            or not _is_nonnegative_int(value.get("generation"))
            or not _is_nonnegative_int(value.get("frame"))
            or not isinstance(clip_ids, list)
            or not 1 <= len(clip_ids) <= 4
            or not all(_is_clip_id(clip_id) for clip_id in clip_ids)
            or len(set(clip_ids)) != len(clip_ids)
            or value.get("reason") not in {"seek", "playback", "prefetch"}
        ):
            raise ProtocolError("invalid_message", "Malformed frame-set request.")
        return cast(RequestFrameSetMessage, value)

    raise ProtocolError("invalid_message", "Unsupported frontend message type.")


def frame_set_message(
    session_id: str,
    *,
    request_id: int,
    generation: int,
    frame: int,
    frames: Sequence[FrameManifest],
) -> dict[str, object]:
    if not 1 <= len(frames) <= 4:
        raise ValueError("A frame-set manifest requires between one and four frames.")
    clip_ids: set[ClipId] = set()
    total_bytes = 0
    for buffer_index, manifest in enumerate(frames):
        clip_id = manifest.get("clip_id")
        byte_length = manifest.get("byte_length")
        if (
            not _is_clip_id(clip_id)
            or clip_id in clip_ids
            or manifest.get("buffer_index") != buffer_index
            or manifest.get("mime") not in {"image/jpeg", "image/webp"}
            or not isinstance(byte_length, int)
            or isinstance(byte_length, bool)
            or not 1 <= byte_length <= MAX_FRAME_BUFFER_BYTES
            or not _is_nonnegative_number(manifest.get("render_ms"))
            or not _is_nonnegative_number(manifest.get("encode_ms"))
        ):
            raise ValueError("Malformed frame-set manifest.")
        clip_ids.add(clip_id)
        total_bytes += byte_length
    if total_bytes > MAX_FRAME_SET_BYTES:
        raise ValueError("Frame-set payload exceeds the transport limit.")

    message: FrameSetMessage = {
        "protocol": PROTOCOL_VERSION,
        "type": "frame_set",
        "session_id": session_id,
        "request_id": request_id,
        "generation": generation,
        "frame": frame,
        "frames": list(frames),
    }
    return cast(dict[str, object], message)


def runtime_error_message(
    session_id: str,
    *,
    request_id: int,
    generation: int,
    clip_id: ClipId,
    code: str,
    message: str,
) -> dict[str, object]:
    error: ErrorMessage = {
        "protocol": PROTOCOL_VERSION,
        "type": "error",
        "session_id": session_id,
        "request_id": request_id,
        "generation": generation,
        "clip_id": clip_id,
        "code": code,
        "message": message,
        "recoverable": True,
    }
    return cast(dict[str, object], error)


def metadata_message(
    session_id: str,
    payload: Mapping[str, object] | None = None,
) -> MetadataMessage:
    message: dict[str, object] = {
        "protocol": PROTOCOL_VERSION,
        "type": "metadata",
        "session_id": session_id,
        "status": "initialized",
    }
    if payload is not None:
        message.update(payload)
    return cast(MetadataMessage, message)


def error_message(session_id: str, error: ProtocolError) -> ErrorMessage:
    return {
        "protocol": PROTOCOL_VERSION,
        "type": "error",
        "session_id": session_id,
        "code": error.code,
        "message": str(error),
        "recoverable": False,
    }
