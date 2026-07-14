from __future__ import annotations

import ctypes

from kaleidoscope.frame_adapter import interleave_rgb24


class FakeFormat:
    name = "RGB24"
    num_planes = 3


class PaddedFrame:
    width = 2
    height = 2
    format = FakeFormat()

    def __init__(self) -> None:
        self._stride = 4
        self._planes = [
            ctypes.create_string_buffer(bytes([1, 2, 99, 99, 3, 4, 99, 99])),
            ctypes.create_string_buffer(bytes([10, 20, 88, 88, 30, 40, 88, 88])),
            ctypes.create_string_buffer(bytes([100, 110, 77, 77, 120, 130, 77, 77])),
        ]

    def get_stride(self, plane: int) -> int:
        del plane
        return self._stride

    def get_read_ptr(self, plane: int) -> ctypes.c_void_p:
        return ctypes.cast(self._planes[plane], ctypes.c_void_p)


def test_interleave_rgb24_copies_visible_pixels_from_padded_planes() -> None:
    frame = PaddedFrame()

    pixels = interleave_rgb24(frame)

    assert pixels == bytes(
        [
            1,
            10,
            100,
            2,
            20,
            110,
            3,
            30,
            120,
            4,
            40,
            130,
        ]
    )
