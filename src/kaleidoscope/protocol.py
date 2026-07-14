from __future__ import annotations

from typing import Literal, NotRequired, TypedDict, TypeGuard, cast

PROTOCOL_VERSION: Literal[1] = 1


class Capabilities(TypedDict):
    image_bitmap: bool
    webp: bool


class ReadyMessage(TypedDict):
    protocol: Literal[1]
    type: Literal["ready"]
    session_id: str
    capabilities: Capabilities


class MetadataMessage(TypedDict):
    protocol: Literal[1]
    type: Literal["metadata"]
    session_id: str
    status: Literal["initialized"]


class ErrorMessage(TypedDict):
    protocol: Literal[1]
    type: Literal["error"]
    session_id: str
    code: Literal["invalid_message", "protocol_mismatch"]
    message: str
    recoverable: bool
    request_id: NotRequired[int]


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


def parse_frontend_message(value: object) -> ReadyMessage:
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

    if value.get("type") != "ready":
        raise ProtocolError("invalid_message", "Unsupported frontend message type.")

    session_id = value.get("session_id")
    capabilities = value.get("capabilities")
    if (
        not isinstance(session_id, str)
        or not session_id
        or not _is_capabilities(capabilities)
    ):
        raise ProtocolError("invalid_message", "Malformed ready message.")

    return cast(ReadyMessage, value)


def metadata_message(session_id: str) -> MetadataMessage:
    return {
        "protocol": PROTOCOL_VERSION,
        "type": "metadata",
        "session_id": session_id,
        "status": "initialized",
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
