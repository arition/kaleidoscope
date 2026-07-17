from __future__ import annotations

import pytest

from kaleidoscope.protocol import (
    PROTOCOL_VERSION,
    ProtocolError,
    frame_set_message,
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


def test_parse_frontend_message_accepts_session_close() -> None:
    message = parse_frontend_message(
        {
            "protocol": 1,
            "type": "close",
            "session_id": "session-1",
        }
    )

    assert message == {
        "protocol": 1,
        "type": "close",
        "session_id": "session-1",
    }


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


def test_parse_frontend_message_rejects_non_object_payloads() -> None:
    with pytest.raises(ProtocolError, match="must be an object"):
        parse_frontend_message([])


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


@pytest.mark.parametrize("outcome", ["painted", "stale", "decode_error"])
def test_parse_frontend_message_accepts_frame_set_ack(outcome: str) -> None:
    message = parse_frontend_message(
        {
            "protocol": 1,
            "type": "ack_frame_set",
            "session_id": "session-1",
            "request_id": 7,
            "generation": 2,
            "outcome": outcome,
        }
    )

    assert message == {
        "protocol": 1,
        "type": "ack_frame_set",
        "session_id": "session-1",
        "request_id": 7,
        "generation": 2,
        "outcome": outcome,
    }


@pytest.mark.parametrize("playing", [True, False])
def test_parse_frontend_message_accepts_playing_state(playing: bool) -> None:
    message = parse_frontend_message(
        {
            "protocol": 1,
            "type": "set_playing",
            "session_id": "session-1",
            "playing": playing,
        }
    )

    assert message["type"] == "set_playing"
    assert message["playing"] is playing


def test_parse_frontend_message_accepts_comparison_view() -> None:
    message = parse_frontend_message(
        {
            "protocol": 1,
            "type": "set_view",
            "session_id": "session-1",
            "generation": 3,
            "mode": "overlay",
            "clip_ids": ["Source", "Filtered"],
            "overlay_opacity": 0.25,
        }
    )

    assert message["type"] == "set_view"
    assert message["clip_ids"] == ["Source", "Filtered"]
    assert message["overlay_opacity"] == 0.25


def test_frame_set_message_preserves_ordered_buffer_mapping() -> None:
    message = frame_set_message(
        "session-1",
        request_id=7,
        generation=2,
        frame=11,
        frames=[
            {
                "clip_id": "Filtered",
                "buffer_index": 0,
                "mime": "image/jpeg",
                "byte_length": 4,
                "render_ms": 2.0,
                "encode_ms": 1.0,
            },
            {
                "clip_id": "Source",
                "buffer_index": 1,
                "mime": "image/webp",
                "byte_length": 5,
                "render_ms": 3.0,
                "encode_ms": 1.5,
            },
        ],
    )

    assert message["frames"] == [
        {
            "clip_id": "Filtered",
            "buffer_index": 0,
            "mime": "image/jpeg",
            "byte_length": 4,
            "render_ms": 2.0,
            "encode_ms": 1.0,
        },
        {
            "clip_id": "Source",
            "buffer_index": 1,
            "mime": "image/webp",
            "byte_length": 5,
            "render_ms": 3.0,
            "encode_ms": 1.5,
        },
    ]


def test_frame_set_message_rejects_non_deterministic_indices() -> None:
    with pytest.raises(ValueError, match="Malformed frame-set manifest"):
        frame_set_message(
            "session-1",
            request_id=7,
            generation=2,
            frame=11,
            frames=[
                {
                    "clip_id": "Source",
                    "buffer_index": 1,
                    "mime": "image/jpeg",
                    "byte_length": 4,
                    "render_ms": 2.0,
                    "encode_ms": 1.0,
                }
            ],
        )


@pytest.mark.parametrize(
    "message",
    [
        {},
        {
            "protocol": True,
            "type": "ready",
            "session_id": "session-1",
            "capabilities": {"image_bitmap": True, "webp": False},
        },
        {
            "protocol": 1.0,
            "type": "ready",
            "session_id": "session-1",
            "capabilities": {"image_bitmap": True, "webp": False},
        },
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
        {
            "protocol": 1,
            "type": "request_frame_set",
            "session_id": "session-1",
            "request_id": 0,
            "generation": 0,
            "frame": 0,
            "clip_ids": ["Source", "Source"],
            "reason": "seek",
        },
        {
            "protocol": 1,
            "type": "request_frame_set",
            "session_id": "session-1",
            "request_id": 0,
            "generation": 0,
            "frame": 0,
            "clip_ids": ["Source"],
            "reason": [],
        },
        {
            "protocol": 1,
            "type": "request_frame_set",
            "session_id": "session-1",
            "request_id": 0,
            "generation": 0,
            "frame": 0,
            "clip_ids": [2**53],
            "reason": "seek",
        },
        {
            "protocol": 1,
            "type": "ack_frame_set",
            "session_id": "session-1",
            "request_id": 0,
            "generation": 0,
            "outcome": "unknown",
        },
        {
            "protocol": 1,
            "type": "ack_frame_set",
            "session_id": "session-1",
            "request_id": 0,
            "generation": 0,
            "outcome": {},
        },
        {
            "protocol": 1,
            "type": "set_playing",
            "session_id": "session-1",
            "playing": 1,
        },
        {
            "protocol": 1,
            "type": "set_view",
            "session_id": "session-1",
            "generation": 1,
            "mode": "wipe",
            "clip_ids": ["Source", "Source"],
            "overlay_opacity": 0.5,
        },
        {
            "protocol": 1,
            "type": "set_view",
            "session_id": "session-1",
            "generation": 1,
            "mode": [],
            "clip_ids": ["Source"],
            "overlay_opacity": 0.5,
        },
        {
            "protocol": 1,
            "type": "set_view",
            "session_id": "session-1",
            "generation": 1,
            "mode": "overlay",
            "clip_ids": ["Source", "Filtered"],
            "overlay_opacity": 2,
        },
        {
            "protocol": 1,
            "type": "set_view",
            "session_id": "session-1",
            "generation": 1,
            "mode": "overlay",
            "clip_ids": ["Source", "Filtered"],
            "overlay_opacity": 10**1000,
        },
    ],
)
def test_parse_frontend_message_rejects_malformed_messages(message: object) -> None:
    with pytest.raises(ProtocolError) as error:
        parse_frontend_message(message)

    assert error.value.code == "invalid_message"
