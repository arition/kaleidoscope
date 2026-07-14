from __future__ import annotations

from collections import deque
from collections.abc import Callable, Hashable, Iterable
from dataclasses import dataclass
from threading import Lock
from typing import Any, Protocol


class AsyncResult(Protocol):
    def add_done_callback(self, callback: Callable[[Any], None]) -> None: ...


@dataclass(frozen=True, slots=True)
class ScheduledFrame:
    fairness_key: Hashable
    submit: Callable[[], AsyncResult | None]
    completed: Callable[[Any], None]
    submission_failed: Callable[[Exception], None]


class FrameSetScheduler:
    def __init__(self, max_in_flight: int) -> None:
        if max_in_flight <= 0:
            raise ValueError("max_in_flight must be positive.")
        self._max_in_flight = max_in_flight
        self._pending: deque[ScheduledFrame] = deque()
        self._in_flight = 0
        self._closed = False
        self._lock = Lock()
        self._last_submitted_key: Hashable | None = None

    @property
    def in_flight(self) -> int:
        with self._lock:
            return self._in_flight

    def replace_pending(self, frames: Iterable[ScheduledFrame]) -> None:
        pending = list(frames)
        with self._lock:
            if self._closed:
                return
            if pending and self._last_submitted_key is not None:
                last_index = next(
                    (
                        index
                        for index, frame in enumerate(pending)
                        if frame.fairness_key == self._last_submitted_key
                    ),
                    None,
                )
                if last_index is not None:
                    next_index = (last_index + 1) % len(pending)
                    pending = pending[next_index:] + pending[:next_index]
            self._pending.clear()
            self._pending.extend(pending)
        self._drain()

    def close(self) -> None:
        with self._lock:
            self._closed = True
            self._pending.clear()

    def _take_next(self) -> ScheduledFrame | None:
        with self._lock:
            if (
                self._closed
                or self._in_flight >= self._max_in_flight
                or not self._pending
            ):
                return None
            self._in_flight += 1
            frame = self._pending.popleft()
            self._last_submitted_key = frame.fairness_key
            return frame

    def _release_slot(self) -> None:
        with self._lock:
            self._in_flight -= 1
        self._drain()

    def _finish(self, frame: ScheduledFrame, future: Any) -> None:
        try:
            frame.completed(future)
        finally:
            self._release_slot()

    def _register_completion(
        self,
        frame: ScheduledFrame,
        future: AsyncResult,
    ) -> None:
        callback_started = False

        def completed_callback(completed_future: Any) -> None:
            nonlocal callback_started
            callback_started = True
            self._finish(frame, completed_future)

        try:
            future.add_done_callback(completed_callback)
        except Exception as error:
            if callback_started:
                raise
            try:
                frame.submission_failed(error)
            finally:
                self._release_slot()

    def _drain(self) -> None:
        while (frame := self._take_next()) is not None:
            try:
                future = frame.submit()
            except Exception as error:
                try:
                    frame.submission_failed(error)
                finally:
                    self._release_slot()
                continue
            if future is None:
                self._release_slot()
                continue
            self._register_completion(frame, future)
