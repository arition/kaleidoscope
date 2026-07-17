from __future__ import annotations

import json
import queue
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast

import pytest

from benchmarks import pipeline


class FakeProbe:
    def reset(self) -> None:
        pass

    def snapshot(
        self,
    ) -> tuple[list[pipeline.TimingEvent], list[pipeline.TimingEvent]]:
        return (
            [pipeline.TimingEvent(started=1.0, ended=1.001)],
            [pipeline.TimingEvent(started=1.001, ended=1.002)],
        )


class FakeSequentialSession:
    def __init__(
        self,
        outbound: queue.Queue[tuple[float, dict[str, object], list[bytes]]],
    ) -> None:
        self._outbound = outbound
        self.acknowledged: list[tuple[int, int, str]] = []

    def request_frame_set(
        self,
        *,
        request_id: int,
        generation: int,
        frame: int,
        clip_ids: tuple[str, ...],
    ) -> None:
        self._outbound.put(
            (
                2.0,
                {
                    "type": "frame_set",
                    "request_id": request_id,
                    "generation": generation,
                    "frame": frame,
                    "frames": [
                        {
                            "clip_id": clip_ids[0],
                            "render_ms": 1.0,
                            "encode_ms": 1.0,
                        }
                    ],
                },
                [b"frame"],
            )
        )

    def ack_frame_set(
        self,
        *,
        request_id: int,
        generation: int,
        outcome: str,
    ) -> int:
        self.acknowledged.append((request_id, generation, outcome))
        return 3


class FakePacedSession:
    def __init__(self, *, send: Any, **_: Any) -> None:
        self._send = send
        self._unacknowledged: tuple[int, int, int] | None = None

    def request_frame_set(
        self,
        *,
        request_id: int,
        generation: int,
        frame: int,
        clip_ids: tuple[str, ...],
    ) -> None:
        if self._unacknowledged is not None:
            raise AssertionError("The prior benchmark delivery was not acknowledged.")
        self._unacknowledged = (request_id, generation, frame)
        self._send(
            {
                "type": "frame_set",
                "request_id": request_id,
                "generation": generation,
                "frame": frame,
                "frames": [
                    {
                        "clip_id": clip_ids[0],
                        "render_ms": 0.0,
                        "encode_ms": 0.0,
                    }
                ],
            },
            [b"frame"],
        )

    def ack_frame_set(
        self,
        *,
        request_id: int,
        generation: int,
        outcome: str,
    ) -> int:
        assert outcome == "painted"
        assert self._unacknowledged == (request_id, generation, request_id)
        self._unacknowledged = None
        return request_id

    def close(self) -> None:
        pass


def test_sequential_benchmark_acknowledges_each_captured_frame_set() -> None:
    outbound: queue.Queue[tuple[float, dict[str, object], list[bytes]]] = queue.Queue()
    session = FakeSequentialSession(outbound)

    pipeline._request_frame_set(
        session=cast(Any, session),
        outbound=outbound,
        probe=cast(Any, FakeProbe()),
        request_id=7,
        frame=3,
        clip_ids=("Source",),
    )

    assert session.acknowledged == [(7, 0, "painted")]


def test_paced_benchmark_acknowledges_before_submitting_the_next_frame(
    monkeypatch: Any,
) -> None:
    monkeypatch.setattr(pipeline, "PreviewSession", FakePacedSession)
    config = SimpleNamespace(num_frames=10, active_clip_ids=("Source",))

    result = pipeline.run_paced_playback(
        cast(Any, config),
        target_fps=1000,
        duration_s=0.002,
    )

    assert result["desired_frames"] == 2
    assert result["delivered_frames"] == 2


def test_release_benchmark_report_uses_requested_identity_and_paths() -> None:
    results = cast(
        dict[str, Any],
        json.loads(
            (pipeline.ROOT / "benchmarks/results/t6-pipeline.json").read_text(encoding="utf-8")
        ),
    )
    results["environment"]["git_index_tree"] = "0123456789abcdef"
    results["environment"]["git_dirty"] = True
    results["environment"]["git_dirty_after_measurement"] = True
    results["baseline_comparison"] = pipeline._baseline_comparison(
        results,
        results,
        baseline_path=Path("benchmarks/results/t6-pipeline.json"),
    )
    results["decision"] = pipeline._decision(results)
    output_path = pipeline.ROOT / "benchmarks/results/t13-pipeline.json"
    report_path = pipeline.ROOT / "tasks/t13-benchmark-report.md"

    report = pipeline.render_report(
        results,
        report_label="T13",
        output_path=output_path,
        report_path=report_path,
    )

    assert report.startswith("# T13 Pipeline Benchmark Report\n")
    assert "Source tree: `0123456789abcdef`" in report
    assert "Working tree dirty before/after measurement: `True` / `True`" in report
    assert "G1 approval required before T7" not in report
    assert "`benchmarks/results/t13-pipeline.json`" in report
    assert str(pipeline.ROOT) not in report
    assert "Performance evidence supports G2 review" in report
    assert "T6 baseline" in report
    assert "delta +0.00 ms" in report
    assert pipeline.benchmark_exit_code(results) == 0
    assert (
        "PYTHONPATH=src:. .venv/bin/python -m benchmarks.pipeline "
        "--output benchmarks/results/t13-pipeline.json "
        "--report tasks/t13-benchmark-report.md --report-label T13"
    ) in report


@pytest.mark.parametrize("failed_gate", ["latency", "playback", "memory"])
def test_release_benchmark_holds_and_fails_when_any_gate_fails(
    failed_gate: str,
) -> None:
    results = cast(
        dict[str, Any],
        json.loads(
            (pipeline.ROOT / "benchmarks/results/t6-pipeline.json").read_text(encoding="utf-8")
        ),
    )
    if failed_gate == "latency":
        raw = results["scenarios"]["direct_1x_1280x720"]["paused"]["raw"]
        raw["request_to_send_ms"] = [60_000.0] * len(raw["request_to_send_ms"])
    elif failed_gate == "playback":
        playback = results["scenarios"]["direct_1x_1280x720"]["playback"]["30_fps"]
        playback["raw"]["delivered_request_ids"] = []
    else:
        raw = results["cleanup_probe"]["raw"]["rss_after_close_bytes"]
        raw[-1] = raw[0] + 1024**3
    results["decision"] = pipeline._decision(results)

    report = pipeline.render_report(
        results,
        report_label="T13",
        output_path=Path("benchmarks/results/t13-pipeline.json"),
        report_path=Path("tasks/t13-benchmark-report.md"),
    )

    assert results["decision"]["benchmark_gate_passed"] is False
    assert "**HOLD:" in report
    assert "Performance evidence supports G2 review" not in report
    assert pipeline.benchmark_exit_code(results) == 1


def test_release_benchmark_recomputes_stale_serialized_decision() -> None:
    results = cast(
        dict[str, Any],
        json.loads(
            (pipeline.ROOT / "benchmarks/results/t6-pipeline.json").read_text(encoding="utf-8")
        ),
    )
    playback = results["scenarios"]["direct_1x_1280x720"]["playback"]["30_fps"]
    results["decision"] = pipeline._decision(results)
    playback["raw"]["delivered_request_ids"] = []
    assert results["decision"]["benchmark_gate_passed"] is True

    report = pipeline.render_report(
        results,
        report_label="T13",
        output_path=Path("benchmarks/results/t13-pipeline.json"),
        report_path=Path("tasks/t13-benchmark-report.md"),
    )

    assert "**HOLD:" in report
    assert pipeline.benchmark_exit_code(results) == 1


@pytest.mark.parametrize(
    "corruption",
    ["duplicate_request_ids", "out_of_range_request_id", "metric_length_mismatch"],
)
def test_release_benchmark_holds_for_malformed_playback_evidence(
    corruption: str,
) -> None:
    results = cast(
        dict[str, Any],
        json.loads(
            (pipeline.ROOT / "benchmarks/results/t6-pipeline.json").read_text(encoding="utf-8")
        ),
    )
    playback = results["scenarios"]["direct_1x_1280x720"]["playback"]["30_fps"]
    raw = playback["raw"]
    request_ids = raw["delivered_request_ids"]
    if corruption == "duplicate_request_ids":
        request_ids[:] = [request_ids[0]] * len(request_ids)
    elif corruption == "out_of_range_request_id":
        request_ids[-1] = playback["desired_frames"]
    else:
        raw["payload_bytes"].pop()

    decision = pipeline._decision(results)

    assert playback["raw_evidence_valid"] is False
    assert decision["paced_playback_threshold_passed"] is False
    assert decision["benchmark_gate_passed"] is False


@pytest.mark.parametrize(
    "failed_gate",
    ["latency", "playback", "browser_model", "memory"],
)
def test_release_benchmark_recomputes_gate_inputs_from_raw_samples(
    failed_gate: str,
) -> None:
    results = cast(
        dict[str, Any],
        json.loads(
            (pipeline.ROOT / "benchmarks/results/t6-pipeline.json").read_text(encoding="utf-8")
        ),
    )
    results["decision"] = pipeline._decision(results)
    assert results["decision"]["benchmark_gate_passed"] is True

    if failed_gate == "latency":
        raw = results["scenarios"]["direct_1x_1280x720"]["paused"]["raw"]
        raw["request_to_send_ms"] = [60_000.0] * len(raw["request_to_send_ms"])
    elif failed_gate == "playback":
        raw = results["scenarios"]["direct_1x_1280x720"]["playback"]["30_fps"]["raw"]
        raw["lag_ms"] = [60_000.0] * len(raw["lag_ms"])
    elif failed_gate == "browser_model":
        raw = results["browser"]["fixtures"]["direct_1x_1280x720"]["raw"]
        raw["simulated_receive_to_paint_ms"] = [60_000.0] * len(
            raw["simulated_receive_to_paint_ms"]
        )
    else:
        raw = results["cleanup_probe"]["raw"]["rss_after_close_bytes"]
        raw[-1] = raw[0] + 1024**3

    report = pipeline.render_report(
        results,
        report_label="T13",
        output_path=Path("benchmarks/results/t13-pipeline.json"),
        report_path=Path("tasks/t13-benchmark-report.md"),
    )

    assert "**HOLD:" in report
    assert pipeline.benchmark_exit_code(results) == 1


def test_release_benchmark_overwrites_cached_combined_latency() -> None:
    results = cast(
        dict[str, Any],
        json.loads(
            (pipeline.ROOT / "benchmarks/results/t6-pipeline.json").read_text(encoding="utf-8")
        ),
    )
    raw = results["scenarios"]["direct_1x_1280x720"]["paused"]["raw"]
    primary_backend = list(raw["request_to_send_ms"])
    primary_browser = list(
        results["browser"]["fixtures"]["direct_1x_1280x720"]["raw"]["simulated_receive_to_paint_ms"]
    )
    raw["simulated_request_to_paint_ms"] = [60_000.0] * len(primary_backend)

    pipeline._decision(results)

    assert raw["simulated_request_to_paint_ms"] == [
        backend + browser
        for backend, browser in zip(
            primary_backend,
            primary_browser,
            strict=True,
        )
    ]


def test_release_report_recomputes_visible_derived_metrics() -> None:
    results = cast(
        dict[str, Any],
        json.loads(
            (pipeline.ROOT / "benchmarks/results/t13-pipeline.json").read_text(encoding="utf-8")
        ),
    )
    playback = results["scenarios"]["direct_1x_1280x720"]["playback"]["30_fps"]
    playback["backend_cpu_ms"] = 1500.0
    playback["backend_cpu_core_equivalents"] = -1.0
    fixture = results["browser"]["fixtures"]["direct_4x_640x360"]
    fixture["raw"]["decode_barrier_ms"] = [60_000.0] * len(fixture["raw"]["decode_barrier_ms"])
    fixture["cdp"]["js_heap_used_before_bytes"] = 1024.0
    fixture["cdp"]["js_heap_used_after_bytes"] = 5120.0
    fixture["cdp"]["js_heap_used_delta_bytes"] = -1.0
    comparison = results["baseline_comparison"]["direct_4x_640x360"]
    comparison["browser_decode_p95_ms"] = -1.0
    comparison["browser_decode_p95_delta_ms"] = -1.0

    report = pipeline.render_report(
        results,
        report_label="T13",
        output_path=Path("benchmarks/results/t13-pipeline.json"),
        report_path=Path("tasks/t13-benchmark-report.md"),
    )

    assert playback["backend_cpu_core_equivalents"] == 0.5
    assert fixture["cdp"]["js_heap_used_delta_bytes"] == 4096.0
    refreshed_comparison = results["baseline_comparison"]["direct_4x_640x360"]
    assert refreshed_comparison["browser_decode_p95_ms"] == 60_000.0
    assert refreshed_comparison["browser_decode_p95_delta_ms"] == pytest.approx(
        60_000.0 - refreshed_comparison["baseline_browser_decode_p95_ms"]
    )
    assert "60000.00 ms browser decode p95" in report
    assert "4.0 |" in report


@pytest.mark.parametrize(
    ("path", "value"),
    [
        (("summary", "lag_ms", "p95"), 60_000.0),
        (("summary", "lag_ms", "max"), 60_000.0),
        (("drain_ms",), 60_000.0),
        (("simulated_render_to_paint", "lag_ms", "p95"), 60_000.0),
        (("simulated_render_to_paint", "lag_ms", "max"), 60_000.0),
    ],
)
def test_release_benchmark_holds_when_playback_lag_is_unbounded(
    path: tuple[str, ...],
    value: float,
) -> None:
    results = cast(
        dict[str, Any],
        json.loads(
            (pipeline.ROOT / "benchmarks/results/t6-pipeline.json").read_text(encoding="utf-8")
        ),
    )
    playback = results["scenarios"]["direct_1x_1280x720"]["playback"]["30_fps"]
    target: dict[str, Any] = playback
    for key in path[:-1]:
        target = target[key]
    target[path[-1]] = value

    viable = pipeline._playback_viable(playback)

    assert viable is False


def test_checked_t13_report_is_generated_from_raw_results() -> None:
    results_path = pipeline.ROOT / "benchmarks/results/t13-pipeline.json"
    report_path = pipeline.ROOT / "tasks/t13-benchmark-report.md"
    results = cast(
        dict[str, Any],
        json.loads(results_path.read_text(encoding="utf-8")),
    )

    expected = pipeline.render_report(
        results,
        report_label="T13",
        output_path=results_path,
        report_path=report_path,
    )

    assert report_path.read_text(encoding="utf-8") == expected
