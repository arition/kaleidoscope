from __future__ import annotations

from collections.abc import Sequence
from math import isfinite
from typing import Literal, NotRequired, TypedDict, TypeGuard, cast, overload

from .sources import ClipId, ClipWarningCode, ResolvedMode

PROTOCOL_VERSION: Literal[1] = 1
MAX_FRAME_BUFFER_BYTES = 16 * 1024 * 1024
MAX_FRAME_SET_BYTES = 64 * 1024 * 1024

type BackendErrorCode = Literal[
    "invalid_message",
    "protocol_mismatch",
    "unsupported_codec",
    "invalid_clip",
    "unsupported_dimensions",
    "render_failed",
    "conversion_failed",
    "encode_failed",
    "decode_failed",
    "kernel_disconnected",
    "session_closed",
]


class Capabilities(TypedDict):
    image_bitmap: bool
    webp: bool


class ReadyMessage(TypedDict):
    protocol: Literal[1]
    type: Literal["ready"]
    session_id: str
    capabilities: Capabilities


class CloseMessage(TypedDict):
    protocol: Literal[1]
    type: Literal["close"]
    session_id: str


class RequestFrameSetMessage(TypedDict):
    protocol: Literal[1]
    type: Literal["request_frame_set"]
    session_id: str
    request_id: int
    generation: int
    frame: int
    clip_ids: list[ClipId]
    reason: Literal["seek", "playback", "prefetch"]


class AckFrameSetMessage(TypedDict):
    protocol: Literal[1]
    type: Literal["ack_frame_set"]
    session_id: str
    request_id: int
    generation: int
    outcome: Literal["painted", "stale", "decode_error"]


class SetPlayingMessage(TypedDict):
    protocol: Literal[1]
    type: Literal["set_playing"]
    session_id: str
    playing: bool


class SetViewMessage(TypedDict):
    protocol: Literal[1]
    type: Literal["set_view"]
    session_id: str
    generation: int
    mode: ResolvedMode
    clip_ids: list[ClipId]
    overlay_opacity: float


type FrontendMessage = (
    ReadyMessage
    | CloseMessage
    | RequestFrameSetMessage
    | AckFrameSetMessage
    | SetPlayingMessage
    | SetViewMessage
)


class MetadataMessage(TypedDict):
    protocol: Literal[1]
    type: Literal["metadata"]
    session_id: str
    status: Literal["initialized"]


class ClipWarningMetadata(TypedDict):
    code: ClipWarningCode
    message: str


class ClipMetadata(TypedDict):
    id: ClipId
    label: str
    source_format: str
    source_width: int
    source_height: int
    output_width: int
    output_height: int
    warnings: list[ClipWarningMetadata]


class PreviewMetadataPayload(TypedDict):
    num_frames: int
    fps_num: int
    fps_den: int
    mode: ResolvedMode
    active_clip_ids: list[ClipId]
    overlay_opacity: float
    max_visible_clips: int
    autoplay: bool
    clips: list[ClipMetadata]


class PreviewMetadataMessage(MetadataMessage, PreviewMetadataPayload):
    pass


class ErrorMessage(TypedDict):
    protocol: Literal[1]
    type: Literal["error"]
    session_id: str
    code: BackendErrorCode
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
        code: Literal["invalid_message", "protocol_mismatch", "unsupported_codec"],
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
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return 0 <= value <= 10**308
    return isinstance(value, float) and isfinite(value) and value >= 0


def _is_clip_id(value: object) -> TypeGuard[ClipId]:
    return (
        isinstance(value, int)
        and not isinstance(value, bool)
        and -(2**53 - 1) <= value <= 2**53 - 1
    ) or (isinstance(value, str) and bool(value))


def parse_frontend_message(value: object) -> FrontendMessage:
    if not isinstance(value, dict):
        raise ProtocolError("invalid_message", "Frontend message must be an object.")

    protocol = value.get("protocol")
    if not isinstance(protocol, int) or isinstance(protocol, bool):
        raise ProtocolError(
            "invalid_message",
            "Frontend message is missing protocol version 1.",
        )
    if protocol != PROTOCOL_VERSION:
        raise ProtocolError(
            "protocol_mismatch",
            f"Unsupported protocol version {protocol}; expected {PROTOCOL_VERSION}.",
        )

    session_id = value.get("session_id")
    if not isinstance(session_id, str) or not session_id:
        raise ProtocolError("invalid_message", "Frontend message has no session ID.")

    if value.get("type") == "ready":
        capabilities = value.get("capabilities")
        if not _is_capabilities(capabilities):
            raise ProtocolError("invalid_message", "Malformed ready message.")
        return cast(ReadyMessage, value)

    if value.get("type") == "close":
        if set(value) != {"protocol", "type", "session_id"}:
            raise ProtocolError("invalid_message", "Malformed close message.")
        return cast(CloseMessage, value)

    if value.get("type") == "request_frame_set":
        clip_ids = value.get("clip_ids")
        reason = value.get("reason")
        if (
            not _is_nonnegative_int(value.get("request_id"))
            or not _is_nonnegative_int(value.get("generation"))
            or not _is_nonnegative_int(value.get("frame"))
            or not isinstance(clip_ids, list)
            or not 1 <= len(clip_ids) <= 4
            or not all(_is_clip_id(clip_id) for clip_id in clip_ids)
            or len(set(clip_ids)) != len(clip_ids)
            or not isinstance(reason, str)
            or reason not in {"seek", "playback", "prefetch"}
        ):
            raise ProtocolError("invalid_message", "Malformed frame-set request.")
        return cast(RequestFrameSetMessage, value)

    if value.get("type") == "ack_frame_set":
        outcome = value.get("outcome")
        if (
            not _is_nonnegative_int(value.get("request_id"))
            or not _is_nonnegative_int(value.get("generation"))
            or not isinstance(outcome, str)
            or outcome not in {"painted", "stale", "decode_error"}
        ):
            raise ProtocolError("invalid_message", "Malformed frame-set ACK.")
        return cast(AckFrameSetMessage, value)

    if value.get("type") == "set_playing":
        if not isinstance(value.get("playing"), bool):
            raise ProtocolError("invalid_message", "Malformed playing state.")
        return cast(SetPlayingMessage, value)

    if value.get("type") == "set_view":
        clip_ids = value.get("clip_ids")
        mode = value.get("mode")
        overlay_opacity = value.get("overlay_opacity")
        valid_cardinality = (
            (mode == "single" and isinstance(clip_ids, list) and len(clip_ids) == 1)
            or (mode == "side-by-side" and isinstance(clip_ids, list) and 1 <= len(clip_ids) <= 4)
            or (
                isinstance(mode, str)
                and mode in {"wipe", "overlay", "difference"}
                and isinstance(clip_ids, list)
                and len(clip_ids) == 2
            )
        )
        if (
            not _is_nonnegative_int(value.get("generation"))
            or not isinstance(clip_ids, list)
            or not valid_cardinality
            or not all(_is_clip_id(clip_id) for clip_id in clip_ids)
            or len(set(clip_ids)) != len(clip_ids)
            or not _is_nonnegative_number(overlay_opacity)
            or cast(float, overlay_opacity) > 1
        ):
            raise ProtocolError("invalid_message", "Malformed comparison view.")
        return cast(SetViewMessage, value)

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
    code: Literal["render_failed", "conversion_failed", "encode_failed"],
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


@overload
def metadata_message(session_id: str, payload: None = None) -> MetadataMessage: ...


@overload
def metadata_message(
    session_id: str,
    payload: PreviewMetadataPayload,
) -> PreviewMetadataMessage: ...


def metadata_message(
    session_id: str,
    payload: PreviewMetadataPayload | None = None,
) -> MetadataMessage | PreviewMetadataMessage:
    message: MetadataMessage = {
        "protocol": PROTOCOL_VERSION,
        "type": "metadata",
        "session_id": session_id,
        "status": "initialized",
    }
    if payload is None:
        return message
    return {
        **message,
        **payload,
    }


def error_message(session_id: str, error: ProtocolError) -> ErrorMessage:
    return {
        "protocol": PROTOCOL_VERSION,
        "type": "error",
        "session_id": session_id,
        "code": error.code,
        "message": str(error),
        "recoverable": False,
    }
