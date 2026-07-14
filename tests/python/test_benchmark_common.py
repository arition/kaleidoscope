from __future__ import annotations

import pytest

from benchmarks.common import (
    percentile,
    simulate_latest_wins_playback,
    summarize,
)


def test_percentile_interpolates_a_deterministic_distribution() -> None:
    values = [1.0, 2.0, 3.0, 4.0, 5.0]

    assert percentile(values, 0.5) == 3.0
    assert percentile(values, 0.95) == pytest.approx(4.8)
    assert summarize(values) == {
        "min": 1.0,
        "median": 3.0,
        "p95": pytest.approx(4.8),
        "max": 5.0,
        "mean": 3.0,
    }


def test_latest_wins_model_delivers_every_frame_when_capacity_is_sufficient() -> None:
    result = simulate_latest_wins_playback(
        [10.0, 12.0, 8.0],
        target_fps=24,
        duration_s=1,
    )

    assert result.desired_frames == 24
    assert result.delivered_frames == 24
    assert result.dropped_frames == 0
    assert result.delivered_fps == 24
    assert result.lag_ms["p95"] < 13


def test_latest_wins_model_replaces_pending_frames_when_capacity_is_low() -> None:
    result = simulate_latest_wins_playback(
        [80.0],
        target_fps=30,
        duration_s=1,
    )

    assert result.desired_frames == 29
    assert 10 <= result.delivered_frames <= 13
    assert result.dropped_frames > 0
    assert result.delivered_fps < result.target_fps
    assert result.lag_ms["max"] < 120
