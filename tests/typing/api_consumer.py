from concurrent.futures import Future
from fractions import Fraction

from kaleidoscope import preview


class R77VideoNodeShape:
    width = 640
    height = 360
    num_frames = 24
    fps = Fraction(24, 1)
    format = object()

    def get_frame(self, frame: int) -> object:
        return frame

    def get_frame_async(self, frame: int) -> Future[object]:
        future: Future[object] = Future()
        future.set_result(frame)
        return future


class NonFutureNode:
    width = 640
    height = 360
    num_frames = 24
    fps = Fraction(24, 1)
    format = object()

    def get_frame(self, frame: int) -> object:
        return frame

    def get_frame_async(self, frame: int) -> int:
        return frame


class MetadataOnlyNode:
    width = 640
    height = 360
    num_frames = 24
    fps = Fraction(24, 1)
    format = object()


preview(R77VideoNodeShape())
preview(NonFutureNode())  # type: ignore[arg-type]
preview(MetadataOnlyNode())  # type: ignore[arg-type]