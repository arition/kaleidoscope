from __future__ import annotations

from kaleidoscope.cache import ByteBoundedLRU


def test_cache_evicts_least_recently_used_entry_by_count() -> None:
    cache = ByteBoundedLRU[str, bytes](max_entries=2, max_bytes=100)
    cache.put("first", b"1", 1)
    cache.put("second", b"22", 2)

    assert cache.get("first") == b"1"

    cache.put("third", b"333", 3)

    assert cache.get("second") is None
    assert cache.get("first") == b"1"
    assert cache.get("third") == b"333"


def test_cache_evicts_entries_until_within_byte_budget() -> None:
    cache = ByteBoundedLRU[str, bytes](max_entries=4, max_bytes=5)
    cache.put("first", b"111", 3)
    cache.put("second", b"22", 2)
    cache.put("third", b"333", 3)

    assert cache.get("first") is None
    assert cache.get("second") == b"22"
    assert cache.get("third") == b"333"


def test_zero_capacity_and_oversized_entries_are_not_cached() -> None:
    disabled = ByteBoundedLRU[str, bytes](max_entries=0, max_bytes=100)
    disabled.put("frame", b"data", 4)

    bounded = ByteBoundedLRU[str, bytes](max_entries=2, max_bytes=3)
    bounded.put("frame", b"data", 4)

    assert disabled.get("frame") is None
    assert bounded.get("frame") is None


def test_clear_releases_all_entries() -> None:
    cache = ByteBoundedLRU[str, bytes](max_entries=2, max_bytes=100)
    cache.put("first", b"1", 1)
    cache.put("second", b"2", 1)

    cache.clear()

    assert cache.get("first") is None
    assert cache.get("second") is None
