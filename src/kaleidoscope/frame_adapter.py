from __future__ import annotations

import ctypes
from typing import Protocol


class FrameAdapterError(ValueError):
    pass


class FrameFormat(Protocol):
    name: str
    num_planes: int


class RGB24Frame(Protocol):
    width: int
    height: int
    format: FrameFormat

    def get_stride(self, plane: int) -> int: ...

    def get_read_ptr(self, plane: int) -> ctypes.c_void_p | int: ...


def _pointer_address(pointer: ctypes.c_void_p | int) -> int:
    address = pointer if isinstance(pointer, int) else pointer.value
    if address is None or address <= 0:
        raise FrameAdapterError("Frame plane has an invalid read pointer.")
    return address


def interleave_rgb24(frame: RGB24Frame) -> bytes:
    if frame.format.name != "RGB24" or frame.format.num_planes != 3:
        raise FrameAdapterError("Frame must use the planar RGB24 format.")
    if frame.width <= 0 or frame.height <= 0:
        raise FrameAdapterError("Frame dimensions must be positive.")

    planes: list[bytes] = []
    strides: list[int] = []
    for plane in range(3):
        stride = frame.get_stride(plane)
        if stride < frame.width:
            raise FrameAdapterError("Frame plane stride is shorter than its width.")
        address = _pointer_address(frame.get_read_ptr(plane))
        planes.append(ctypes.string_at(address, stride * frame.height))
        strides.append(stride)

    interleaved = bytearray(frame.width * frame.height * 3)
    output_row_size = frame.width * 3
    for row in range(frame.height):
        output_start = row * output_row_size
        for plane, data in enumerate(planes):
            input_start = row * strides[plane]
            interleaved[output_start + plane : output_start + output_row_size : 3] = (
                data[input_start : input_start + frame.width]
            )
    return bytes(interleaved)
