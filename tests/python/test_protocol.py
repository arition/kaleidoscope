from __future__ import annotations

import pytest

from kaleidoscope.protocol import (
    PROTOCOL_VERSION,
    ProtocolError,
    parse_frontend_message,
)


def test_parse_frontend_message_accepts_protocol_v1_ready() -> None:
    message = parse_frontend_message(
        {
            "protocol": 1,
            "type": "ready",
            "session_id": "session-1",
            "capabilities": {"image_bitmap": True, "webp": False},
        }
    )

    assert message["protocol"] == PROTOCOL_VERSION
    assert message["type"] == "ready"
    assert message["session_id"] == "session-1"
    assert message["capabilities"] == {"image_bitmap": True, "webp": False}


def test_parse_frontend_message_rejects_incompatible_protocol() -> None:
    with pytest.raises(ProtocolError) as error:
        parse_frontend_message(
            {
                "protocol": 2,
                "type": "ready",
                "session_id": "session-1",
                "capabilities": {"image_bitmap": True, "webp": False},
            }
        )

    assert error.value.code == "protocol_mismatch"


def test_parse_frontend_message_accepts_a_single_frame_set_request() -> None:
    message = parse_frontend_message(
        {
            "protocol": 1,
            "type": "request_frame_set",
            "session_id": "session-1",
            "request_id": 7,
            "generation": 0,
            "frame": 0,
            "clip_ids": ["Source"],
            "reason": "seek",
        }
    )

    assert message["type"] == "request_frame_set"
    assert message["request_id"] == 7
    assert message["clip_ids"] == ["Source"]


@pytest.mark.parametrize(
    "message",
    [
        {},
        {"protocol": 1, "type": "unknown", "session_id": "session-1"},
        {
            "protocol": 1,
            "type": "ready",
            "session_id": "",
            "capabilities": {"image_bitmap": True, "webp": False},
        },
        {
            "protocol": 1,
            "type": "ready",
            "session_id": "session-1",
            "capabilities": {"image_bitmap": "yes", "webp": False},
        },
        {
            "protocol": 1,
            "type": "request_frame_set",
            "session_id": "session-1",
            "request_id": 0,
            "generation": 0,
            "frame": -1,
            "clip_ids": ["Source"],
            "reason": "seek",
        },
    ],
)
def test_parse_frontend_message_rejects_malformed_messages(message: object) -> None:
    with pytest.raises(ProtocolError) as error:
        parse_frontend_message(message)

    assert error.value.code == "invalid_message"
