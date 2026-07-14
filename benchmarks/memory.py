from __future__ import annotations

from pathlib import Path


def _proc_value_bytes(path: Path, key: str) -> int | None:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return None
    prefix = f"{key}:"
    for line in lines:
        if line.startswith(prefix):
            fields = line.split()
            if len(fields) >= 2:
                return int(fields[1]) * 1024
    return None


def process_rss_bytes() -> int | None:
    return _proc_value_bytes(Path("/proc/self/status"), "VmRSS")


def process_peak_rss_bytes() -> int | None:
    return _proc_value_bytes(Path("/proc/self/status"), "VmHWM")


def system_memory_bytes() -> int | None:
    return _proc_value_bytes(Path("/proc/meminfo"), "MemTotal")
