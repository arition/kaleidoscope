from __future__ import annotations

import argparse
import base64
import ctypes
import gc
import importlib
import importlib.metadata
import json
import math
import os
import platform
import queue
import subprocess
import tempfile
import threading
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from functools import partial
from io import BytesIO
from pathlib import Path
from typing import Any, cast

from PIL import Image, features

import kaleidoscope.session as session_module
from kaleidoscope.encoding import EncodedImage, encode_jpeg
from kaleidoscope.frame_adapter import RGB24Frame, interleave_rgb24
from kaleidoscope.session import PreviewSession
from kaleidoscope.sources import (
    PreviewConfig,
    build_preview_config,
    load_vapoursynth_runtime,
)

from .clips import make_tiled_clip, make_tiled_clip_set
from .common import simulate_latest_wins_playback, summarize
from .memory import process_peak_rss_bytes, process_rss_bytes, system_memory_bytes

type JsonObject = dict[str, Any]
type MetricSamples = dict[str, list[float]]

ROOT = Path(__file__).resolve().parents[1]
QUALITY = 80
vs = importlib.import_module("vapoursynth")


@dataclass(frozen=True, slots=True)
class Scenario:
    name: str
    clip_count: int
    width: int
    height: int
    source_format: str

    @property
    def path(self) -> str:
        return "direct_rgb24" if self.source_format == "RGB24" else "fallback_yuv420p8"


SCENARIOS = (
    Scenario("direct_1x_1280x720", 1, 1280, 720, "RGB24"),
    Scenario("direct_2x_960x540", 2, 960, 540, "RGB24"),
    Scenario("direct_4x_640x360", 4, 640, 360, "RGB24"),
    Scenario("fallback_1x_1280x720", 1, 1280, 720, "YUV420P8"),
    Scenario("fallback_2x_960x540", 2, 960, 540, "YUV420P8"),
    Scenario("fallback_4x_640x360", 4, 640, 360, "YUV420P8"),
)


@dataclass(frozen=True, slots=True)
class TimingEvent:
    started: float
    ended: float

    @property
    def elapsed_ms(self) -> float:
        return (self.ended - self.started) * 1000


class SessionProbe:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._interleave_events: list[TimingEvent] = []
        self._encode_events: list[TimingEvent] = []

    def reset(self) -> None:
        with self._lock:
            self._interleave_events.clear()
            self._encode_events.clear()

    def interleave(self, frame: RGB24Frame) -> bytes:
        started = time.perf_counter()
        try:
            return interleave_rgb24(frame)
        finally:
            ended = time.perf_counter()
            with self._lock:
                self._interleave_events.append(TimingEvent(started, ended))

    def encode(
        self,
        pixels: bytes,
        width: int,
        height: int,
        quality: int,
    ) -> EncodedImage:
        started = time.perf_counter()
        try:
            return encode_jpeg(pixels, width, height, quality)
        finally:
            ended = time.perf_counter()
            with self._lock:
                self._encode_events.append(TimingEvent(started, ended))

    def snapshot(self) -> tuple[list[TimingEvent], list[TimingEvent]]:
        with self._lock:
            return list(self._interleave_events), list(self._encode_events)


def _pointer_address(pointer: ctypes.c_void_p | int) -> int:
    address = pointer if isinstance(pointer, int) else pointer.value
    if address is None or address <= 0:
        raise ValueError("Frame plane has an invalid pointer.")
    return address


def interleave_rgb24_buffer(frame: RGB24Frame) -> bytes:
    if frame.format.name != "RGB24" or frame.format.num_planes != 3:
        raise ValueError("Frame must use the planar RGB24 format.")
    if frame.width <= 0 or frame.height <= 0:
        raise ValueError("Frame dimensions must be positive.")

    planes: list[bytes] = []
    strides: list[int] = []
    for plane in range(3):
        stride = frame.get_stride(plane)
        if stride < frame.width:
            raise ValueError("Frame plane stride is shorter than its width.")
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


def _encode_pillow(
    pixels: bytes,
    width: int,
    height: int,
    quality: int,
    *,
    image_format: str,
    mime: str,
    options: Mapping[str, object],
) -> EncodedImage:
    with (
        Image.frombytes("RGB", (width, height), pixels) as image,
        BytesIO() as output,
    ):
        image.save(output, format=image_format, quality=quality, **options)
        return EncodedImage(mime=mime, data=output.getvalue())


def _codec_operations() -> dict[str, Callable[[bytes, int, int, int], EncodedImage]]:
    operations: dict[str, Callable[[bytes, int, int, int], EncodedImage]] = {
        "jpeg_420": encode_jpeg,
        "jpeg_444": lambda pixels, width, height, quality: _encode_pillow(
            pixels,
            width,
            height,
            quality,
            image_format="JPEG",
            mime="image/jpeg",
            options={"subsampling": "4:4:4", "optimize": False, "progressive": False},
        ),
    }
    if features.check("webp"):
        operations["webp_method_0"] = (
            lambda pixels, width, height, quality: _encode_pillow(
                pixels,
                width,
                height,
                quality,
                image_format="WEBP",
                mime="image/webp",
                options={"method": 0, "lossless": False, "exact": False},
            )
        )
    return operations


def _measure_operation(
    operation: Callable[[], Any],
    *,
    warmup: int,
    samples: int,
) -> tuple[MetricSamples, Any]:
    result: Any = None
    for _ in range(warmup):
        result = operation()
    raw: MetricSamples = {"wall_ms": [], "cpu_ms": []}
    for _ in range(samples):
        cpu_started = time.process_time()
        started = time.perf_counter()
        result = operation()
        raw["wall_ms"].append((time.perf_counter() - started) * 1000)
        raw["cpu_ms"].append((time.process_time() - cpu_started) * 1000)
    return raw, result


def _metric_summary(raw: Mapping[str, Sequence[float]]) -> JsonObject:
    return {name: summarize(values) for name, values in raw.items() if values}


def _number(value: object) -> float:
    if not isinstance(value, int | float) or isinstance(value, bool):
        raise TypeError("Expected a numeric benchmark value.")
    return float(value)


def _browser_fixture(
    *,
    name: str,
    width: int,
    height: int,
    source_format: str,
    message: Mapping[str, object],
    buffers: Sequence[bytes],
) -> JsonObject:
    return {
        "name": name,
        "width": width,
        "height": height,
        "source_format": source_format,
        "message": dict(message),
        "buffers_base64": [
            base64.b64encode(buffer).decode("ascii") for buffer in buffers
        ],
    }


def run_microbenchmarks(
    *,
    warmup: int,
    samples: int,
) -> tuple[JsonObject, list[JsonObject]]:
    resolutions = ((640, 480), (1280, 720), (1920, 1080))
    interleave_results: JsonObject = {}
    codec_results: JsonObject = {}
    browser_fixtures: list[JsonObject] = []
    codec_operations = _codec_operations()

    for width, height in resolutions:
        resolution = f"{width}x{height}"
        clip = make_tiled_clip(
            format_name="RGB24",
            width=width,
            height=height,
            seed=9,
            num_frames=4,
        )
        frame = cast(RGB24Frame, clip.get_frame(0))
        try:
            production_pixels = interleave_rgb24(frame)
            buffer_pixels = interleave_rgb24_buffer(frame)
            if buffer_pixels != production_pixels:
                raise RuntimeError("NumPy and buffer interleave outputs differ.")
            implementations = {
                "buffer_only": partial(interleave_rgb24_buffer, frame),
                "numpy_2_4_3": partial(interleave_rgb24, frame),
            }
            resolution_interleave: JsonObject = {}
            for name, interleave_operation in implementations.items():
                raw, result = _measure_operation(
                    interleave_operation,
                    warmup=warmup,
                    samples=samples,
                )
                if result != production_pixels:
                    raise RuntimeError(f"{name} changed the benchmark pixels.")
                resolution_interleave[name] = {
                    "raw": raw,
                    "summary": _metric_summary(raw),
                }
            resolution_interleave["plane_strides"] = [
                frame.get_stride(plane) for plane in range(3)
            ]
            interleave_results[resolution] = resolution_interleave

            resolution_codecs: JsonObject = {}
            for name, codec_operation in codec_operations.items():
                raw, encoded = _measure_operation(
                    partial(
                        codec_operation,
                        production_pixels,
                        width,
                        height,
                        QUALITY,
                    ),
                    warmup=warmup,
                    samples=samples,
                )
                assert isinstance(encoded, EncodedImage)
                payload_samples = [float(len(encoded.data))] * samples
                raw["payload_bytes"] = payload_samples
                resolution_codecs[name] = {
                    "mime": encoded.mime,
                    "raw": raw,
                    "summary": _metric_summary(raw),
                }
                if resolution == "1280x720":
                    message = {
                        "protocol": 1,
                        "type": "frame_set",
                        "session_id": "codec-benchmark",
                        "request_id": 0,
                        "generation": 0,
                        "frame": 0,
                        "frames": [
                            {
                                "clip_id": name,
                                "buffer_index": 0,
                                "mime": encoded.mime,
                                "byte_length": len(encoded.data),
                                "render_ms": 0.0,
                                "encode_ms": 0.0,
                            }
                        ],
                    }
                    browser_fixtures.append(
                        _browser_fixture(
                            name=f"codec_{name}_1280x720",
                            width=width,
                            height=height,
                            source_format="RGB24",
                            message=message,
                            buffers=[encoded.data],
                        )
                    )
            codec_results[resolution] = resolution_codecs
        finally:
            cast(Any, frame).close()

    return (
        {
            "interleave": interleave_results,
            "codecs": codec_results,
            "quality": QUALITY,
            "webp_supported_by_pillow": features.check("webp"),
        },
        browser_fixtures,
    )


def _append_metric(raw: MetricSamples, name: str, value: float) -> None:
    raw.setdefault(name, []).append(float(value))


def _request_frame_set(
    *,
    session: PreviewSession,
    outbound: queue.Queue[tuple[float, dict[str, object], list[bytes]]],
    probe: SessionProbe,
    request_id: int,
    frame: int,
    clip_ids: Sequence[int | str],
) -> tuple[JsonObject, dict[str, object], list[bytes]]:
    probe.reset()
    cpu_started = time.process_time()
    started = time.perf_counter()
    session.request_frame_set(
        request_id=request_id,
        generation=0,
        frame=frame,
        clip_ids=clip_ids,
    )
    try:
        sent_at, message, buffers = outbound.get(timeout=60)
    except queue.Empty as error:
        raise RuntimeError("Timed out waiting for the benchmark frame set.") from error
    cpu_ms = (time.process_time() - cpu_started) * 1000
    if message.get("type") != "frame_set":
        raise RuntimeError(f"Benchmark frame request failed: {message!r}")
    frames = cast(list[dict[str, object]], message["frames"])
    interleave_events, encode_events = probe.snapshot()
    if len(interleave_events) != len(clip_ids) or len(encode_events) != len(clip_ids):
        raise RuntimeError("Benchmark instrumentation missed a frame-set member.")
    render_values = [_number(frame_manifest["render_ms"]) for frame_manifest in frames]
    encode_values = [_number(frame_manifest["encode_ms"]) for frame_manifest in frames]
    encode_ends = [event.ended for event in encode_events]
    metrics: JsonObject = {
        "request_to_send_ms": (sent_at - started) * 1000,
        "backend_cpu_ms": cpu_ms,
        "render_barrier_ms": max(render_values),
        "render_total_ms": sum(render_values),
        "interleave_barrier_ms": max(event.elapsed_ms for event in interleave_events),
        "interleave_total_ms": sum(event.elapsed_ms for event in interleave_events),
        "encode_barrier_ms": max(encode_values),
        "encode_total_ms": sum(encode_values),
        "member_completion_spread_ms": (
            (max(encode_ends) - min(encode_ends)) * 1000
            if len(encode_ends) > 1
            else 0.0
        ),
        "assembly_send_ms": max(0.0, (sent_at - max(encode_ends)) * 1000),
        "payload_bytes": float(sum(len(buffer) for buffer in buffers)),
    }
    return metrics, message, buffers


def run_paced_playback(
    config: PreviewConfig,
    *,
    target_fps: float,
    duration_s: float,
) -> JsonObject:
    deliveries: list[tuple[float, dict[str, object], list[bytes]]] = []
    delivery_lock = threading.Lock()
    final_delivery = threading.Event()
    desired_frames = max(1, math.floor(duration_s * target_fps))

    def send(message: dict[str, object], buffers: list[bytes]) -> None:
        with delivery_lock:
            deliveries.append((time.perf_counter(), message, buffers))
        if message.get("request_id") == desired_frames - 1:
            final_delivery.set()

    session = PreviewSession(
        session_id="paced-benchmark",
        config=config,
        send=send,
    )
    scheduled: dict[int, float] = {}
    started = time.perf_counter()
    cpu_started = time.process_time()
    try:
        for request_id in range(desired_frames):
            scheduled_at = started + request_id / target_fps
            remaining = scheduled_at - time.perf_counter()
            if remaining > 0:
                time.sleep(remaining)
            scheduled[request_id] = scheduled_at
            session.request_frame_set(
                request_id=request_id,
                generation=0,
                frame=request_id % config.num_frames,
                clip_ids=config.active_clip_ids,
            )
        horizon = started + duration_s
        remaining = horizon - time.perf_counter()
        if remaining > 0:
            time.sleep(remaining)
        if not final_delivery.wait(timeout=60):
            raise RuntimeError("The final paced benchmark request did not complete.")
    finally:
        session.close()
    cpu_ms = (time.process_time() - cpu_started) * 1000
    finished = time.perf_counter()
    with delivery_lock:
        completed = list(deliveries)
    errors = [
        message for _, message, _ in completed if message.get("type") != "frame_set"
    ]
    if errors:
        raise RuntimeError(f"Paced benchmark failed: {errors[0]!r}")
    frame_sets = [
        (sent_at, message, buffers)
        for sent_at, message, buffers in completed
        if message.get("type") == "frame_set"
    ]
    lag_ms = [
        (sent_at - scheduled[cast(int, message["request_id"])]) * 1000
        for sent_at, message, _ in frame_sets
    ]
    payload_bytes = [
        float(sum(len(buffer) for buffer in buffers)) for _, _, buffers in frame_sets
    ]
    render_barrier_ms = [
        max(
            _number(frame["render_ms"])
            for frame in cast(list[dict[str, object]], message["frames"])
        )
        for _, message, _ in frame_sets
    ]
    encode_barrier_ms = [
        max(
            _number(frame["encode_ms"])
            for frame in cast(list[dict[str, object]], message["frames"])
        )
        for _, message, _ in frame_sets
    ]
    delivered_frames = len(frame_sets)
    raw: JsonObject = {
        "delivered_request_ids": [
            cast(int, message["request_id"]) for _, message, _ in frame_sets
        ],
        "lag_ms": lag_ms,
        "payload_bytes": payload_bytes,
        "render_barrier_ms": render_barrier_ms,
        "encode_barrier_ms": encode_barrier_ms,
    }
    return {
        "target_fps": target_fps,
        "duration_s": duration_s,
        "desired_frames": desired_frames,
        "delivered_frames": delivered_frames,
        "dropped_frames": desired_frames - delivered_frames,
        "delivered_fps": delivered_frames / duration_s,
        "backend_cpu_ms": cpu_ms,
        "backend_cpu_core_equivalents": cpu_ms / (duration_s * 1000),
        "payload_megabits_per_second": sum(payload_bytes) * 8 / duration_s / 1_000_000,
        "drain_ms": max(0.0, (finished - (started + duration_s)) * 1000),
        "raw": raw,
        "summary": {
            "lag_ms": summarize(lag_ms),
            "payload_bytes": summarize(payload_bytes),
            "render_barrier_ms": summarize(render_barrier_ms),
            "encode_barrier_ms": summarize(encode_barrier_ms),
        },
    }


def run_scenario(
    scenario: Scenario,
    *,
    warmup: int,
    samples: int,
    playback_duration_s: float,
) -> tuple[JsonObject, JsonObject]:
    rss_before = process_rss_bytes()
    num_frames = max(samples + warmup + 8, math.ceil(playback_duration_s * 30) + 8)
    source_clips = make_tiled_clip_set(
        clip_count=scenario.clip_count,
        format_name=scenario.source_format,
        width=scenario.width,
        height=scenario.height,
        num_frames=num_frames,
    )
    setup_cpu_started = time.process_time()
    setup_started = time.perf_counter()
    config = build_preview_config(
        source_clips,
        mode="single" if scenario.clip_count == 1 else "side-by-side",
        visible=tuple(source_clips),
        width=scenario.width,
        height=scenario.height,
        quality=QUALITY,
        max_in_flight=4,
        runtime=load_vapoursynth_runtime(),
    )
    setup_wall_ms = (time.perf_counter() - setup_started) * 1000
    setup_cpu_ms = (time.process_time() - setup_cpu_started) * 1000
    rss_after_setup = process_rss_bytes()

    outbound: queue.Queue[tuple[float, dict[str, object], list[bytes]]] = queue.Queue()
    probe = SessionProbe()

    def send(message: dict[str, object], buffers: list[bytes]) -> None:
        outbound.put((time.perf_counter(), message, buffers))

    session = PreviewSession(
        session_id=scenario.name,
        config=config,
        send=send,
        encoder=probe.encode,
    )
    session_namespace = vars(session_module)
    original_interleave = cast(
        Callable[[RGB24Frame], bytes],
        session_namespace["interleave_rgb24"],
    )
    session_namespace["interleave_rgb24"] = probe.interleave
    raw: MetricSamples = {}
    fixture_message: dict[str, object] | None = None
    fixture_buffers: list[bytes] | None = None
    try:
        for request_id in range(warmup):
            _request_frame_set(
                session=session,
                outbound=outbound,
                probe=probe,
                request_id=request_id,
                frame=request_id % config.num_frames,
                clip_ids=config.active_clip_ids,
            )
        for sample in range(samples):
            request_id = warmup + sample
            metrics, message, buffers = _request_frame_set(
                session=session,
                outbound=outbound,
                probe=probe,
                request_id=request_id,
                frame=request_id % config.num_frames,
                clip_ids=config.active_clip_ids,
            )
            for name, value in metrics.items():
                _append_metric(raw, name, cast(float, value))
            if fixture_message is None:
                fixture_message = message
                fixture_buffers = buffers
    finally:
        session.close()
        session_namespace["interleave_rgb24"] = original_interleave
    rss_after_paused = process_rss_bytes()
    assert fixture_message is not None
    assert fixture_buffers is not None

    playback_rates = (24.0, 30.0) if scenario.clip_count == 1 else (24.0,)
    playback = {
        f"{rate:g}_fps": run_paced_playback(
            config,
            target_fps=rate,
            duration_s=playback_duration_s,
        )
        for rate in playback_rates
    }
    rss_after_playback = process_rss_bytes()
    warnings = {
        str(clip.id): [warning.code for warning in clip.warnings]
        for clip in config.clips
    }
    result: JsonObject = {
        "scenario": {**asdict(scenario), "path": scenario.path},
        "settings": {
            "quality": QUALITY,
            "warmup": warmup,
            "samples": samples,
            "playback_duration_s": playback_duration_s,
            "max_in_flight": config.max_in_flight,
        },
        "setup": {"wall_ms": setup_wall_ms, "cpu_ms": setup_cpu_ms},
        "warnings": warnings,
        "paused": {"raw": raw, "summary": _metric_summary(raw)},
        "playback": playback,
        "memory": {
            "rss_before_bytes": rss_before,
            "rss_after_setup_bytes": rss_after_setup,
            "rss_after_paused_bytes": rss_after_paused,
            "rss_after_playback_bytes": rss_after_playback,
        },
    }
    fixture = _browser_fixture(
        name=scenario.name,
        width=scenario.width,
        height=scenario.height,
        source_format=scenario.source_format,
        message=fixture_message,
        buffers=fixture_buffers,
    )

    del session, config, source_clips
    vs.core.clear_cache()
    gc.collect()
    result["memory"]["rss_after_cleanup_bytes"] = process_rss_bytes()
    result["memory"]["peak_rss_bytes"] = process_peak_rss_bytes()
    return result, fixture


def run_cleanup_probe(*, iterations: int) -> JsonObject:
    baseline_rss = process_rss_bytes()
    rss_after_close: list[float] = []
    payload_bytes: list[float] = []
    for iteration in range(iterations):
        source_clips = make_tiled_clip_set(
            clip_count=1,
            format_name="RGB24",
            width=320,
            height=240,
            num_frames=4,
        )
        config = build_preview_config(
            source_clips,
            mode="single",
            visible=tuple(source_clips),
            width=320,
            height=240,
            quality=QUALITY,
            max_in_flight=1,
            runtime=load_vapoursynth_runtime(),
        )
        outbound: queue.Queue[tuple[dict[str, object], list[bytes]]] = queue.Queue()

        def send(
            message: dict[str, object],
            buffers: list[bytes],
            target: queue.Queue[tuple[dict[str, object], list[bytes]]] = outbound,
        ) -> None:
            target.put((message, buffers))

        session = PreviewSession(
            session_id=f"cleanup-{iteration}",
            config=config,
            send=send,
        )
        try:
            session.request_frame_set(
                request_id=iteration,
                generation=0,
                frame=iteration % config.num_frames,
                clip_ids=config.active_clip_ids,
            )
            try:
                message, buffers = outbound.get(timeout=60)
            except queue.Empty as error:
                raise RuntimeError("Cleanup probe frame set timed out.") from error
            if message.get("type") != "frame_set":
                raise RuntimeError(f"Cleanup probe failed: {message!r}")
            payload_bytes.append(float(sum(len(buffer) for buffer in buffers)))
        finally:
            session.close()
        del session, config, source_clips
        vs.core.clear_cache()
        gc.collect()
        rss = process_rss_bytes()
        if rss is not None:
            rss_after_close.append(float(rss))

    tail = rss_after_close[len(rss_after_close) // 2 :]
    return {
        "iterations": iterations,
        "baseline_rss_bytes": baseline_rss,
        "raw": {
            "rss_after_close_bytes": rss_after_close,
            "payload_bytes": payload_bytes,
        },
        "summary": {
            "rss_after_close_bytes": (
                summarize(rss_after_close) if rss_after_close else {}
            ),
            "payload_bytes": summarize(payload_bytes),
        },
        "rss_growth_first_to_last_bytes": (
            rss_after_close[-1] - rss_after_close[0]
            if len(rss_after_close) >= 2
            else 0.0
        ),
        "rss_tail_spread_bytes": max(tail) - min(tail) if tail else 0.0,
    }


def _run_browser(
    fixtures: Sequence[JsonObject],
    *,
    warmup: int,
    samples: int,
) -> JsonObject:
    with tempfile.TemporaryDirectory(
        prefix="kaleidoscope-benchmark-"
    ) as temp_directory:
        temp = Path(temp_directory)
        fixture_path = temp / "fixtures.json"
        bundle_path = temp / "browser.js"
        fixture_path.write_text(json.dumps(fixtures), encoding="utf-8")
        subprocess.run(
            [
                str(ROOT / "node_modules/.bin/esbuild"),
                str(ROOT / "benchmarks/browser.ts"),
                "--bundle",
                "--format=iife",
                "--target=es2022",
                f"--outfile={bundle_path}",
            ],
            cwd=ROOT,
            check=True,
        )
        completed = subprocess.run(
            [
                "node",
                str(ROOT / "benchmarks/run_browser.mjs"),
                "--fixtures",
                str(fixture_path),
                "--bundle",
                str(bundle_path),
                "--warmup",
                str(warmup),
                "--samples",
                str(samples),
            ],
            cwd=ROOT,
            check=False,
            capture_output=True,
            text=True,
        )
        if completed.returncode != 0:
            raise RuntimeError(
                "Browser benchmark failed:\n"
                f"stdout:\n{completed.stdout}\n"
                f"stderr:\n{completed.stderr}"
            )
        result = cast(JsonObject, json.loads(completed.stdout))

    for fixture in cast(dict[str, JsonObject], result["fixtures"]).values():
        raw = cast(MetricSamples, fixture["raw"])
        fixture["summary"] = _metric_summary(raw)
        cdp = cast(JsonObject, fixture["cdp"])
        measured_iterations = warmup + samples
        cdp["task_duration_ms_per_iteration"] = (
            float(cdp["task_duration_ms"]) / measured_iterations
        )
        cdp["script_duration_ms_per_iteration"] = (
            float(cdp["script_duration_ms"]) / measured_iterations
        )
        before = cdp.get("js_heap_used_before_bytes")
        after = cdp.get("js_heap_used_after_bytes")
        cdp["js_heap_used_delta_bytes"] = (
            float(after) - float(before)
            if before is not None and after is not None
            else None
        )
    result["comm_note"] = (
        "simulated_comm_copy_ms copies already-received ArrayBuffers in one Chromium "
        "process; it does not measure a real Jupyter comm or cross-process transfer."
    )
    return result


def _combine_pipeline_results(
    scenarios: JsonObject,
    browser: JsonObject,
) -> None:
    browser_fixtures = cast(dict[str, JsonObject], browser["fixtures"])
    for name, scenario_result in scenarios.items():
        paused = cast(JsonObject, scenario_result["paused"])
        backend_raw = cast(MetricSamples, paused["raw"])
        browser_result = browser_fixtures[name]
        browser_raw = cast(MetricSamples, browser_result["raw"])
        request_to_send = backend_raw["request_to_send_ms"]
        receive_to_paint = browser_raw["simulated_receive_to_paint_ms"]
        combined = [
            backend_ms + browser_ms
            for backend_ms, browser_ms in zip(
                request_to_send,
                receive_to_paint,
                strict=True,
            )
        ]
        backend_raw["simulated_request_to_paint_ms"] = combined
        paused["summary"] = _metric_summary(backend_raw)
        paused["browser_fixture"] = name
        paused["transport_note"] = browser["comm_note"]


def _add_playback_models(scenarios: JsonObject) -> None:
    for scenario_result in scenarios.values():
        scenario = cast(JsonObject, scenario_result)
        paused = cast(JsonObject, scenario["paused"])
        raw = cast(MetricSamples, paused["raw"])
        service_times = raw["simulated_request_to_paint_ms"]
        for playback_result in cast(JsonObject, scenario["playback"]).values():
            playback = cast(JsonObject, playback_result)
            model = simulate_latest_wins_playback(
                service_times,
                target_fps=_number(playback["target_fps"]),
                duration_s=_number(playback["duration_s"]),
            )
            playback["simulated_render_to_paint"] = asdict(model)


def _threshold(
    scenario: JsonObject,
    *,
    median_target_ms: float,
    p95_target_ms: float,
) -> JsonObject:
    summary = cast(JsonObject, cast(JsonObject, scenario["paused"])["summary"])
    latency = cast(JsonObject, summary["simulated_request_to_paint_ms"])
    median_ms = float(latency["median"])
    p95_ms = float(latency["p95"])
    return {
        "median_ms": median_ms,
        "median_target_ms": median_target_ms,
        "p95_ms": p95_ms,
        "p95_target_ms": p95_target_ms,
        "passed": median_ms < median_target_ms and p95_ms < p95_target_ms,
    }


def _decision(results: JsonObject) -> JsonObject:
    scenarios = cast(JsonObject, results["scenarios"])
    gates = cast(JsonObject, results["gates"])
    micro = cast(JsonObject, results["microbenchmarks"])
    interleave = cast(JsonObject, micro["interleave"])["1280x720"]
    buffer_median = float(
        cast(JsonObject, cast(JsonObject, interleave["buffer_only"])["summary"])[
            "wall_ms"
        ]["median"]
    )
    numpy_median = float(
        cast(JsonObject, cast(JsonObject, interleave["numpy_2_4_3"])["summary"])[
            "wall_ms"
        ]["median"]
    )
    numpy_speedup = buffer_median / numpy_median
    numpy_savings_ms = buffer_median - numpy_median
    keep_numpy = numpy_speedup >= 1.2 and numpy_savings_ms >= 1.0

    direct_one_playback = cast(
        JsonObject,
        cast(JsonObject, scenarios["direct_1x_1280x720"])["playback"]["30_fps"],
    )
    direct_two_playback = cast(
        JsonObject,
        cast(JsonObject, scenarios["direct_2x_960x540"])["playback"]["24_fps"],
    )
    playback_viable = all(
        _number(playback["delivered_frames"]) / _number(playback["desired_frames"])
        >= 0.9
        and _number(
            cast(JsonObject, playback["simulated_render_to_paint"])["delivered_frames"]
        )
        / _number(
            cast(JsonObject, playback["simulated_render_to_paint"])["desired_frames"]
        )
        >= 0.9
        for playback in (direct_one_playback, direct_two_playback)
    )
    latency_viable = all(
        bool(cast(JsonObject, gate)["passed"]) for gate in gates.values()
    )
    transport_viable = latency_viable and playback_viable
    return {
        "encoder": "Pillow JPEG",
        "chroma_policy": "4:2:0",
        "default_quality": QUALITY,
        "interleave": "NumPy" if keep_numpy else "buffer-only",
        "numpy_runtime_dependency": keep_numpy,
        "numpy_720p_speedup": numpy_speedup,
        "numpy_720p_median_savings_ms": numpy_savings_ms,
        "image_per_frame_transport": (
            "retain" if transport_viable else "revise before T7"
        ),
        "latency_targets_passed": latency_viable,
        "paced_playback_threshold_passed": playback_viable,
        "human_gate": "G1 approval required before T7",
        "rationale": (
            "JPEG 4:2:0 is the fastest measured encoder and avoids the larger 4:4:4 "
            "payload; WebP saves bytes but costs materially more CPU. NumPy remains "
            "only because its measured 720p gain is at least 20% and at least 1 ms."
        ),
    }


def _command_output(command: Sequence[str]) -> str | None:
    try:
        completed = subprocess.run(
            command,
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
    except (OSError, subprocess.CalledProcessError):
        return None
    return completed.stdout.strip()


def _package_version(name: str) -> str | None:
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return None


def _proc_field(path: Path, key: str) -> str | None:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return None
    prefix = f"{key}\t"
    for line in lines:
        if line.startswith(prefix):
            return line.split(":", 1)[1].strip()
    return None


def environment_metadata() -> JsonObject:
    return {
        "timestamp_utc": datetime.now(UTC).isoformat(),
        "git_commit": _command_output(("git", "rev-parse", "HEAD")),
        "git_dirty": bool(_command_output(("git", "status", "--short"))),
        "platform": platform.platform(),
        "uname": platform.uname()._asdict(),
        "cpu_model": _proc_field(Path("/proc/cpuinfo"), "model name"),
        "logical_cpu_count": os.cpu_count(),
        "system_memory_bytes": system_memory_bytes(),
        "python": platform.python_version(),
        "node": _command_output(("node", "--version")),
        "npm": _command_output(("npm", "--version")),
        "packages": {
            "VapourSynth": _package_version("VapourSynth"),
            "Pillow": _package_version("Pillow"),
            "numpy": _package_version("numpy"),
            "playwright_node": _command_output(
                (
                    "node",
                    "-p",
                    "require('./node_modules/playwright/package.json').version",
                )
            ),
        },
        "pillow_features": {
            "jpeg": features.check("jpg"),
            "webp": features.check("webp"),
        },
    }


def _format_ms(value: object) -> str:
    return f"{_number(value):.2f}"


def _format_kib(value: object) -> str:
    return f"{_number(value) / 1024:.1f}"


def _memory_mib(memory: Mapping[str, object], key: str) -> str:
    value = memory.get(key)
    return "n/a" if value is None else f"{_number(value) / (1024**2):.1f}"


def render_report(results: JsonObject) -> str:
    metadata = cast(JsonObject, results["environment"])
    settings = cast(JsonObject, results["settings"])
    gates = cast(JsonObject, results["gates"])
    scenarios = cast(JsonObject, results["scenarios"])
    micro = cast(JsonObject, results["microbenchmarks"])
    browser = cast(JsonObject, results["browser"])
    decision = cast(JsonObject, results["decision"])
    lines = [
        "# T6 Pipeline Benchmark Report",
        "",
        f"Generated: {metadata['timestamp_utc']}",
        f"Commit: `{metadata['git_commit']}`",
        "",
        "## Method",
        "",
        (
            f"Warm-up: {settings['warmup']} complete frame sets; measured samples: "
            f"{settings['samples']}; microbenchmark samples: "
            f"{settings['micro_samples']}; paced duration: "
            f"{settings['playback_duration_s']} s. Percentiles use sorted linear "
            "interpolation at `(n - 1) * p`."
        ),
        "",
        (
            "Inputs are deterministic 8 x 6 tiled VapourSynth standard-filter graphs. "
            "Direct cases are caller-prepared RGB24. Fallback cases start as YUV420P8 "
            "and use the production one-time RGB24 conversion node."
        ),
        "",
        (
            "Browser measurements use Chromium with the production "
            "`parseBackendMessage`, `validateFrameSetBuffers`, and `paintFrameSet` "
            "functions. Comm transfer is simulated by copying already-received "
            "ArrayBuffers; it is not a real Jupyter comm measurement."
        ),
        "",
        (
            "Paced playback is measured directly through the backend scheduler. A "
            "second latest-wins model applies the measured local request-to-paint "
            "service times to estimate browser-inclusive delivery and drops."
        ),
        "",
        "## Environment",
        "",
        (
            f"- CPU: {metadata['cpu_model']} "
            f"({metadata['logical_cpu_count']} logical CPUs)"
        ),
        f"- RAM: {float(metadata['system_memory_bytes']) / (1024**3):.1f} GiB",
        f"- Platform: {metadata['platform']}",
        (
            f"- Python: {metadata['python']}; Node: {metadata['node']}; "
            f"npm: {metadata['npm']}"
        ),
        f"- Packages: `{json.dumps(metadata['packages'], sort_keys=True)}`",
        f"- Chromium: {browser['chromium_version']}",
        "",
        "## Latency Gate",
        "",
        "| Case | Median ms | Target | p95 ms | Target | Result |",
        "| --- | ---: | ---: | ---: | ---: | --- |",
    ]
    gate_labels = {
        "one_720p": "1 x 1280x720 direct RGB24",
        "two_540p": "2 x 960x540 direct RGB24",
    }
    for name, label in gate_labels.items():
        gate = cast(JsonObject, gates[name])
        lines.append(
            f"| {label} | {_format_ms(gate['median_ms'])} | "
            f"<{_format_ms(gate['median_target_ms'])} | {_format_ms(gate['p95_ms'])} | "
            f"<{_format_ms(gate['p95_target_ms'])} | "
            f"{'PASS' if gate['passed'] else 'FAIL'} |"
        )

    lines.extend(
        [
            "",
            "## Complete Path",
            "",
            "| Scenario | Backend median/p95 ms | Simulated paint median/p95 ms "
            "| Payload KiB | Backend CPU median ms |",
            "| --- | ---: | ---: | ---: | ---: |",
        ]
    )
    for name, scenario in scenarios.items():
        paused = cast(JsonObject, scenario["paused"])
        summary = cast(JsonObject, paused["summary"])
        backend = cast(JsonObject, summary["request_to_send_ms"])
        complete = cast(JsonObject, summary["simulated_request_to_paint_ms"])
        payload = cast(JsonObject, summary["payload_bytes"])
        cpu = cast(JsonObject, summary["backend_cpu_ms"])
        lines.append(
            f"| `{name}` | {_format_ms(backend['median'])}/"
            f"{_format_ms(backend['p95'])} | "
            f"{_format_ms(complete['median'])}/{_format_ms(complete['p95'])} | "
            f"{_format_kib(payload['median'])} | {_format_ms(cpu['median'])} |"
        )

    lines.extend(
        [
            "",
            "## Preparation And Backend Stages",
            "",
            "| Scenario | Setup wall/cpu ms | Render barrier ms | Interleave total ms "
            "| Encode total ms | Assembly/send ms |",
            "| --- | ---: | ---: | ---: | ---: | ---: |",
        ]
    )
    for name, scenario in scenarios.items():
        setup = cast(JsonObject, scenario["setup"])
        summary = cast(JsonObject, cast(JsonObject, scenario["paused"])["summary"])
        render = cast(JsonObject, summary["render_barrier_ms"])
        interleave = cast(JsonObject, summary["interleave_total_ms"])
        encode = cast(JsonObject, summary["encode_total_ms"])
        assembly = cast(JsonObject, summary["assembly_send_ms"])
        lines.append(
            f"| `{name}` | {_format_ms(setup['wall_ms'])}/"
            f"{_format_ms(setup['cpu_ms'])} | {_format_ms(render['median'])} | "
            f"{_format_ms(interleave['median'])} | {_format_ms(encode['median'])} | "
            f"{_format_ms(assembly['median'])} |"
        )

    lines.extend(
        [
            "",
            "## Interleave",
            "",
            "| Resolution | Buffer median ms | NumPy median ms | Buffer/NumPy "
            "| Plane strides |",
            "| --- | ---: | ---: | ---: | --- |",
        ]
    )
    interleave_results = cast(JsonObject, micro["interleave"])
    for resolution, implementations in interleave_results.items():
        implementations = cast(JsonObject, implementations)
        buffer_summary = cast(JsonObject, implementations["buffer_only"])["summary"]
        numpy_summary = cast(JsonObject, implementations["numpy_2_4_3"])["summary"]
        buffer_ms = float(cast(JsonObject, buffer_summary)["wall_ms"]["median"])
        numpy_ms = float(cast(JsonObject, numpy_summary)["wall_ms"]["median"])
        lines.append(
            f"| {resolution} | {buffer_ms:.2f} | {numpy_ms:.2f} | "
            f"{buffer_ms / numpy_ms:.2f}x | `{implementations['plane_strides']}` |"
        )

    lines.extend(
        [
            "",
            "## Codec",
            "",
            "Quality 80; WebP uses Pillow's speed-focused `method=0`.",
            "",
            "| Resolution | Codec | Encode median ms | CPU median ms "
            "| Payload KiB | Browser decode p95 ms |",
            "| --- | --- | ---: | ---: | ---: | ---: |",
        ]
    )
    browser_fixtures = cast(JsonObject, browser["fixtures"])
    for resolution, codecs in cast(JsonObject, micro["codecs"]).items():
        for codec, codec_result in cast(JsonObject, codecs).items():
            summary = cast(JsonObject, cast(JsonObject, codec_result)["summary"])
            browser_decode = "n/a"
            if resolution == "1280x720":
                fixture = cast(JsonObject, browser_fixtures[f"codec_{codec}_1280x720"])
                fixture_summary = cast(JsonObject, fixture["summary"])
                decode = cast(JsonObject, fixture_summary["decode_barrier_ms"])
                browser_decode = _format_ms(decode["p95"])
            lines.append(
                f"| {resolution} | `{codec}` | "
                f"{_format_ms(summary['wall_ms']['median'])} | "
                f"{_format_ms(summary['cpu_ms']['median'])} | "
                f"{_format_kib(summary['payload_bytes']['median'])} | "
                f"{browser_decode} |"
            )

    lines.extend(
        [
            "",
            "## Browser Stages",
            "",
            "All comm values below are the labeled in-process copy simulation.",
            "",
            "| Scenario | Comm copy ms | Validate ms | Decode median/p95 ms "
            "| Atomic draw/commit ms | Flush ms | Receive-to-paint p95 ms |",
            "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
        ]
    )
    for name in scenarios:
        fixture = cast(JsonObject, browser_fixtures[name])
        summary = cast(JsonObject, fixture["summary"])
        comm = cast(JsonObject, summary["simulated_comm_copy_ms"])
        validation = cast(JsonObject, summary["protocol_validation_ms"])
        decode = cast(JsonObject, summary["decode_barrier_ms"])
        draw = cast(JsonObject, summary["paint_non_decode_ms"])
        flush = cast(JsonObject, summary["canvas_flush_ms"])
        complete = cast(JsonObject, summary["simulated_receive_to_paint_ms"])
        lines.append(
            f"| `{name}` | {_format_ms(comm['median'])} | "
            f"{_format_ms(validation['median'])} | {_format_ms(decode['median'])}/"
            f"{_format_ms(decode['p95'])} | {_format_ms(draw['median'])} | "
            f"{_format_ms(flush['median'])} | {_format_ms(complete['p95'])} |"
        )

    lines.extend(
        [
            "",
            "## Paced Playback",
            "",
            "| Scenario | Target fps | Backend fps/drops | Modeled paint fps/drops "
            "| Modeled lag p95 ms | Payload Mbit/s | Backend CPU cores |",
            "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
        ]
    )
    for name, scenario in scenarios.items():
        for playback in cast(JsonObject, scenario["playback"]).values():
            playback = cast(JsonObject, playback)
            model = cast(JsonObject, playback["simulated_render_to_paint"])
            model_lag = cast(JsonObject, model["lag_ms"])
            lines.append(
                f"| `{name}` | {float(playback['target_fps']):.0f} | "
                f"{float(playback['delivered_fps']):.2f}/"
                f"{playback['dropped_frames']} | "
                f"{float(model['delivered_fps']):.2f}/{model['dropped_frames']} | "
                f"{_format_ms(model_lag['p95'])} | "
                f"{float(playback['payload_megabits_per_second']):.2f} | "
                f"{float(playback['backend_cpu_core_equivalents']):.2f} |"
            )

    lines.extend(
        [
            "",
            "## Memory",
            "",
            "RSS is process-wide and includes VapourSynth/Pillow allocator retention. "
            "Chromium JS heap is collected separately in the raw JSON.",
            "",
            "| Scenario | Before MiB | After setup MiB | After playback MiB "
            "| After cleanup MiB |",
            "| --- | ---: | ---: | ---: | ---: |",
        ]
    )
    for name, scenario in scenarios.items():
        memory = cast(JsonObject, scenario["memory"])
        lines.append(
            f"| `{name}` | {_memory_mib(memory, 'rss_before_bytes')} | "
            f"{_memory_mib(memory, 'rss_after_setup_bytes')} | "
            f"{_memory_mib(memory, 'rss_after_playback_bytes')} | "
            f"{_memory_mib(memory, 'rss_after_cleanup_bytes')} |"
        )

    cleanup = cast(JsonObject, results["cleanup_probe"])
    cleanup_summary = cast(JsonObject, cleanup["summary"])
    cleanup_rss = cast(JsonObject, cleanup_summary["rss_after_close_bytes"])
    lines.extend(
        [
            "",
            "Repeated 320x240 construct/request/close probe:",
            "",
            (
                f"- Iterations: {cleanup['iterations']}; post-close RSS min/median/"
                f"max: {_memory_mib(cleanup_rss, 'min')}/"
                f"{_memory_mib(cleanup_rss, 'median')}/"
                f"{_memory_mib(cleanup_rss, 'max')} MiB."
            ),
            (
                "- First-to-last RSS growth: "
                f"{_number(cleanup['rss_growth_first_to_last_bytes']) / (1024**2):.1f} "
                "MiB; second-half spread: "
                f"{_number(cleanup['rss_tail_spread_bytes']) / (1024**2):.1f} MiB."
            ),
            "",
            "Browser JS heap after forced GC:",
            "",
            "| Scenario | Before MiB | After MiB | Delta KiB |",
            "| --- | ---: | ---: | ---: |",
        ]
    )
    for name in scenarios:
        fixture = cast(JsonObject, browser_fixtures[name])
        cdp = cast(JsonObject, fixture["cdp"])
        lines.append(
            f"| `{name}` | "
            f"{_number(cdp['js_heap_used_before_bytes']) / (1024**2):.2f} | "
            f"{_number(cdp['js_heap_used_after_bytes']) / (1024**2):.2f} | "
            f"{_number(cdp['js_heap_used_delta_bytes']) / 1024:.1f} |"
        )

    lines.extend(
        [
            "",
            "## Architecture Decision",
            "",
            (
                f"- Encoder: **{decision['encoder']}**, chroma "
                f"**{decision['chroma_policy']}**, quality "
                f"**{decision['default_quality']}**."
            ),
            (
                f"- Interleave: **{decision['interleave']}**; NumPy runtime "
                f"dependency: **{decision['numpy_runtime_dependency']}**."
            ),
            (
                "- Image-per-frame transport: "
                f"**{decision['image_per_frame_transport']}**."
            ),
            (
                f"- Gate status: latency={decision['latency_targets_passed']}, "
                "paced playback="
                f"{decision['paced_playback_threshold_passed']}."
            ),
            (
                "- Real Jupyter comm latency remains a later host-integration "
                "measurement; this gate uses an explicitly labeled local copy "
                "simulation."
            ),
            f"- **{decision['human_gate']}**.",
            "",
            (
                "Raw samples and all environment fields are in "
                "`benchmarks/results/t6-pipeline.json`."
            ),
            "",
            "## Reproduce",
            "",
            "```bash",
            ".venv/bin/python -m pip install -e . -r benchmarks/requirements.txt",
            "npm ci",
            "PYTHONPATH=src:. .venv/bin/python -m benchmarks.pipeline",
            "```",
            "",
        ]
    )
    return "\n".join(lines)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run the T6 Kaleidoscope pipeline benchmark."
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=ROOT / "benchmarks/results/t6-pipeline.json",
    )
    parser.add_argument(
        "--report",
        type=Path,
        default=ROOT / "tasks/benchmark-report.md",
    )
    parser.add_argument("--warmup", type=int, default=5)
    parser.add_argument("--samples", type=int, default=30)
    parser.add_argument("--micro-warmup", type=int, default=3)
    parser.add_argument("--micro-samples", type=int, default=15)
    parser.add_argument("--playback-seconds", type=float, default=3.0)
    parser.add_argument("--cleanup-iterations", type=int, default=12)
    parser.add_argument("--smoke", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.smoke:
        args.warmup = 1
        args.samples = 2
        args.micro_warmup = 1
        args.micro_samples = 2
        args.playback_seconds = 0.25
        args.cleanup_iterations = 3
    if (
        min(
            args.warmup,
            args.samples,
            args.micro_warmup,
            args.micro_samples,
            args.cleanup_iterations,
        )
        < 1
    ):
        raise ValueError("Warm-up and sample counts must be positive.")
    if args.playback_seconds <= 0:
        raise ValueError("Playback duration must be positive.")

    results: JsonObject = {
        "schema_version": 1,
        "environment": environment_metadata(),
        "settings": {
            "warmup": args.warmup,
            "samples": args.samples,
            "micro_warmup": args.micro_warmup,
            "micro_samples": args.micro_samples,
            "playback_duration_s": args.playback_seconds,
            "cleanup_iterations": args.cleanup_iterations,
            "quality": QUALITY,
            "four_clip_resolution_note": (
                "640x360 is a scaling probe, not an acceptance target."
            ),
        },
    }
    microbenchmarks, codec_fixtures = run_microbenchmarks(
        warmup=args.micro_warmup,
        samples=args.micro_samples,
    )
    results["microbenchmarks"] = microbenchmarks
    scenario_results: JsonObject = {}
    browser_fixtures: list[JsonObject] = list(codec_fixtures)
    for scenario in SCENARIOS:
        print(f"Running {scenario.name}...", flush=True)
        scenario_result, browser_fixture = run_scenario(
            scenario,
            warmup=args.warmup,
            samples=args.samples,
            playback_duration_s=args.playback_seconds,
        )
        scenario_results[scenario.name] = scenario_result
        browser_fixtures.append(browser_fixture)
    results["scenarios"] = scenario_results
    results["cleanup_probe"] = run_cleanup_probe(
        iterations=args.cleanup_iterations,
    )
    results["browser"] = _run_browser(
        browser_fixtures,
        warmup=args.warmup,
        samples=args.samples,
    )
    _combine_pipeline_results(scenario_results, cast(JsonObject, results["browser"]))
    _add_playback_models(scenario_results)
    results["gates"] = {
        "one_720p": _threshold(
            cast(JsonObject, scenario_results["direct_1x_1280x720"]),
            median_target_ms=150,
            p95_target_ms=250,
        ),
        "two_540p": _threshold(
            cast(JsonObject, scenario_results["direct_2x_960x540"]),
            median_target_ms=225,
            p95_target_ms=350,
        ),
    }
    results["decision"] = _decision(results)
    results["environment"]["git_dirty_after_run"] = bool(
        _command_output(("git", "status", "--short"))
    )

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(results, indent=2) + "\n", encoding="utf-8")
    args.report.write_text(render_report(results), encoding="utf-8")
    print(f"Raw results: {args.output}")
    print(f"Report: {args.report}")
    print(json.dumps(results["gates"], indent=2))
    print(json.dumps(results["decision"], indent=2))


if __name__ == "__main__":
    main()
