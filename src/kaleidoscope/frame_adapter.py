from __future__ import annotations

import ctypes
from typing import Protocol

import numpy as np


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

    interleaved = np.empty((frame.height, frame.width, 3), dtype=np.uint8)
    for plane in range(3):
        stride = frame.get_stride(plane)
        if stride < frame.width:
            raise FrameAdapterError("Frame plane stride is shorter than its width.")
        address = _pointer_address(frame.get_read_ptr(plane))
        buffer_type = ctypes.c_uint8 * (stride * frame.height)
        source = np.ctypeslib.as_array(buffer_type.from_address(address)).reshape(
            frame.height,
            stride,
        )
        interleaved[:, :, plane] = source[:, : frame.width]
    return interleaved.tobytes()
