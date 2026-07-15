from __future__ import annotations

from collections import OrderedDict
from collections.abc import Hashable
from threading import Lock
from typing import Generic, TypeVar

DEFAULT_CACHE_BYTE_BUDGET = 64 * 1024 * 1024

_Key = TypeVar("_Key", bound=Hashable)
_Value = TypeVar("_Value")


class ByteBoundedLRU(Generic[_Key, _Value]):
    def __init__(self, max_entries: int, max_bytes: int) -> None:
        if max_entries < 0 or max_bytes < 0:
            raise ValueError("Cache bounds must not be negative.")
        self._max_entries = max_entries
        self._max_bytes = max_bytes
        self._entries: OrderedDict[_Key, tuple[_Value, int]] = OrderedDict()
        self._current_bytes = 0
        self._lock = Lock()

    def get(self, key: _Key) -> _Value | None:
        with self._lock:
            entry = self._entries.pop(key, None)
            if entry is None:
                return None
            self._entries[key] = entry
            return entry[0]

    def put(self, key: _Key, value: _Value, byte_size: int) -> None:
        if byte_size < 0:
            raise ValueError("Cached byte size must not be negative.")
        with self._lock:
            replaced = self._entries.pop(key, None)
            if replaced is not None:
                self._current_bytes -= replaced[1]
            if (
                self._max_entries == 0
                or self._max_bytes == 0
                or byte_size > self._max_bytes
            ):
                return
            self._entries[key] = (value, byte_size)
            self._current_bytes += byte_size
            while (
                len(self._entries) > self._max_entries
                or self._current_bytes > self._max_bytes
            ):
                _, (_, evicted_size) = self._entries.popitem(last=False)
                self._current_bytes -= evicted_size

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()
            self._current_bytes = 0
