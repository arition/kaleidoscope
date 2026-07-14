from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from math import ceil, floor
from statistics import fmean


def percentile(values: Sequence[float], probability: float) -> float:
    if not values:
        raise ValueError("At least one value is required.")
    if not 0 <= probability <= 1:
        raise ValueError("Probability must be between zero and one.")

    ordered = sorted(values)
    position = (len(ordered) - 1) * probability
    lower = floor(position)
    upper = ceil(position)
    if lower == upper:
        return float(ordered[lower])
    weight = position - lower
    return float(ordered[lower] * (1 - weight) + ordered[upper] * weight)


def summarize(values: Sequence[float]) -> dict[str, float]:
    if not values:
        raise ValueError("At least one value is required.")
    return {
        "min": float(min(values)),
        "median": percentile(values, 0.5),
        "p95": percentile(values, 0.95),
        "max": float(max(values)),
        "mean": float(fmean(values)),
    }


@dataclass(frozen=True, slots=True)
class PlaybackModel:
    target_fps: float
    duration_s: float
    desired_frames: int
    delivered_frames: int
    dropped_frames: int
    delivered_fps: float
    lag_ms: dict[str, float]


def simulate_latest_wins_playback(
    service_times_ms: Sequence[float],
    *,
    target_fps: float,
    duration_s: float,
) -> PlaybackModel:
    if not service_times_ms or any(value <= 0 for value in service_times_ms):
        raise ValueError("Service times must contain positive values.")
    if target_fps <= 0 or duration_s <= 0:
        raise ValueError("Playback rate and duration must be positive.")

    interval_ms = 1000 / target_fps
    horizon_ms = duration_s * 1000
    desired_frames = floor(horizon_ms / interval_ms)
    arrivals = [index * interval_ms for index in range(desired_frames)]
    next_arrival = 0
    next_service = 0
    completion_ms: float | None = None
    active_arrival_ms = 0.0
    pending_arrival_ms: float | None = None
    lag_samples: list[float] = []

    def start(arrival_ms: float, start_ms: float) -> float:
        nonlocal next_service, active_arrival_ms
        active_arrival_ms = arrival_ms
        service_ms = service_times_ms[next_service % len(service_times_ms)]
        next_service += 1
        return start_ms + service_ms

    while next_arrival < len(arrivals) or completion_ms is not None:
        arrival_ms = arrivals[next_arrival] if next_arrival < len(arrivals) else None
        if completion_ms is None:
            assert arrival_ms is not None
            completion_ms = start(arrival_ms, arrival_ms)
            next_arrival += 1
            continue

        if arrival_ms is not None and arrival_ms < completion_ms:
            pending_arrival_ms = arrival_ms
            next_arrival += 1
            continue

        if completion_ms > horizon_ms:
            break
        lag_samples.append(completion_ms - active_arrival_ms)
        if pending_arrival_ms is None:
            completion_ms = None
        else:
            completion_ms = start(pending_arrival_ms, completion_ms)
            pending_arrival_ms = None

    delivered_frames = len(lag_samples)
    return PlaybackModel(
        target_fps=target_fps,
        duration_s=duration_s,
        desired_frames=desired_frames,
        delivered_frames=delivered_frames,
        dropped_frames=desired_frames - delivered_frames,
        delivered_fps=delivered_frames / duration_s,
        lag_ms=summarize(lag_samples) if lag_samples else {},
    )
