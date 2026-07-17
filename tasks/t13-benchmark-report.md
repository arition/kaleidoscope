# T13 Pipeline Benchmark Report

Generated: 2026-07-17T01:12:10.422896+00:00
Commit: `c4d95892183a6b93a0d4c16a663a13fa8990dbe5`
Source tree: `f75656c6de8aa466add0c9ef3146a4834e852043`
Working tree dirty before/after measurement: `True` / `True`

## Method

Warm-up: 5 complete frame sets; measured samples: 30; microbenchmark samples: 15; paced duration: 3.0 s. Percentiles use sorted linear interpolation at `(n - 1) * p`.

Inputs are deterministic 8 x 6 tiled VapourSynth standard-filter graphs. Direct cases are caller-prepared RGB24. Fallback cases start as YUV420P8 and use the production one-time RGB24 conversion node.

Browser measurements use Chromium with the production `parseBackendMessage`, `validateFrameSetBuffers`, and `paintFrameSet` functions. Comm transfer is simulated by copying already-received ArrayBuffers; it is not a real Jupyter comm measurement.

Paced playback is measured directly through the backend scheduler. A second latest-wins model applies the measured local request-to-paint service times to estimate browser-inclusive delivery and drops.

## Environment

- CPU: AMD Ryzen Threadripper 3960X 24-Core Processor (48 logical CPUs)
- RAM: 125.6 GiB
- Platform: Linux-7.0.12-201.fc44.x86_64-x86_64-with-glibc2.39
- Python: 3.12.3; Node: v18.19.1; npm: 9.2.0
- Packages: `{"Pillow": "12.3.0", "VapourSynth": "77", "numpy": "2.4.3", "playwright_node": "1.55.1"}`
- Chromium: 140.0.7339.186

## Latency Gate

| Case | Median ms | Target | p95 ms | Target | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| 1 x 1280x720 direct RGB24 | 15.83 | <150.00 | 20.86 | <250.00 | PASS |
| 2 x 960x540 direct RGB24 | 16.92 | <225.00 | 21.64 | <350.00 | PASS |

## Complete Path

| Scenario | Backend median/p95 ms | Simulated paint median/p95 ms | Payload KiB | Backend CPU median ms |
| --- | ---: | ---: | ---: | ---: |
| `direct_1x_1280x720` | 8.71/9.74 | 15.83/20.86 | 17.8 | 10.49 |
| `direct_2x_960x540` | 5.70/7.37 | 16.92/21.64 | 35.5 | 8.61 |
| `direct_4x_640x360` | 5.92/6.57 | 16.46/51.27 | 34.4 | 9.95 |
| `fallback_1x_1280x720` | 6.05/7.68 | 16.48/19.40 | 21.5 | 7.42 |
| `fallback_2x_960x540` | 6.44/8.62 | 17.28/20.47 | 36.1 | 9.75 |
| `fallback_4x_640x360` | 6.41/6.96 | 11.66/108.44 | 37.9 | 11.56 |

The non-gated `direct_4x_640x360` scaling probe measured 43.17 ms browser decode p95 versus the T6 baseline of 8.25 ms (delta +34.92 ms), and 51.27 ms simulated paint p95 versus 17.22 ms (delta +34.05 ms). The required one- and two-clip cases remain the release acceptance targets.

## Preparation And Backend Stages

| Scenario | Setup wall/cpu ms | Render barrier ms | Interleave total ms | Encode total ms | Assembly/send ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| `direct_1x_1280x720` | 0.06/0.07 | 1.87 | 3.04 | 3.70 | 0.03 |
| `direct_2x_960x540` | 0.07/0.08 | 3.39 | 1.28 | 2.90 | 0.03 |
| `direct_4x_640x360` | 0.07/0.08 | 4.65 | 1.21 | 2.73 | 0.03 |
| `fallback_1x_1280x720` | 1.04/2.72 | 2.20 | 1.08 | 2.76 | 0.03 |
| `fallback_2x_960x540` | 3.31/5.82 | 4.12 | 1.31 | 2.92 | 0.03 |
| `fallback_4x_640x360` | 2.86/7.52 | 5.16 | 1.34 | 2.82 | 0.03 |

## Interleave

| Resolution | Buffer median ms | NumPy median ms | Buffer/NumPy | Plane strides |
| --- | ---: | ---: | ---: | --- |
| 640x480 | 1.35 | 0.31 | 4.29x | `[640, 640, 640]` |
| 1280x720 | 3.61 | 0.97 | 3.73x | `[1280, 1280, 1280]` |
| 1920x1080 | 10.11 | 2.33 | 4.34x | `[1920, 1920, 1920]` |

## Codec

All rows use quality 80. WebP uses Pillow's speed-focused `method=0`; the lossless row also sets `lossless=True`.

| Resolution | Codec | Encode median ms | CPU median ms | Payload KiB | Browser decode p95 ms |
| --- | --- | ---: | ---: | ---: | ---: |
| 640x480 | `jpeg_420` | 0.76 | 0.75 | 6.0 | n/a |
| 640x480 | `jpeg_444` | 1.18 | 1.17 | 10.1 | n/a |
| 640x480 | `webp_lossy_method_0` | 3.44 | 3.41 | 1.9 | n/a |
| 640x480 | `webp_lossless_method_0` | 3.42 | 3.40 | 2.7 | n/a |
| 1280x720 | `jpeg_420` | 2.17 | 2.14 | 17.9 | 8.66 |
| 1280x720 | `jpeg_444` | 3.45 | 3.41 | 27.2 | 9.00 |
| 1280x720 | `webp_lossy_method_0` | 13.25 | 13.06 | 4.8 | 8.16 |
| 1280x720 | `webp_lossless_method_0` | 12.67 | 12.50 | 4.2 | 65.69 |
| 1920x1080 | `jpeg_420` | 4.93 | 4.86 | 45.2 | n/a |
| 1920x1080 | `jpeg_444` | 7.37 | 7.29 | 71.6 | n/a |
| 1920x1080 | `webp_lossy_method_0` | 27.29 | 26.92 | 8.9 | n/a |
| 1920x1080 | `webp_lossless_method_0` | 25.96 | 25.62 | 9.1 | n/a |

## Browser Stages

All comm values below are the labeled in-process copy simulation.

| Scenario | Comm copy ms | Validate ms | Decode median/p95 ms | Atomic draw/commit ms | Flush ms | Receive-to-paint p95 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `direct_1x_1280x720` | 0.00 | 0.00 | 7.95/8.76 | 2.00 | 0.60 | 11.50 |
| `direct_2x_960x540` | 0.00 | 0.00 | 8.20/9.31 | 2.20 | 0.70 | 15.50 |
| `direct_4x_640x360` | 0.00 | 0.00 | 8.00/43.17 | 2.20 | 0.30 | 45.69 |
| `fallback_1x_1280x720` | 0.00 | 0.00 | 7.60/8.66 | 2.10 | 0.60 | 12.93 |
| `fallback_2x_960x540` | 0.00 | 0.00 | 7.70/9.31 | 2.35 | 0.70 | 13.96 |
| `fallback_4x_640x360` | 0.00 | 0.00 | 2.40/99.84 | 2.10 | 0.30 | 102.38 |

## Paced Playback

| Scenario | Target fps | Backend fps/drops | Modeled paint fps/drops | Modeled lag p95 ms | Payload Mbit/s | Backend CPU cores |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `direct_1x_1280x720` | 24 | 24.00/0 | 24.00/0 | 20.76 | 3.51 | 0.19 |
| `direct_1x_1280x720` | 30 | 30.00/0 | 30.00/0 | 21.32 | 4.39 | 0.22 |
| `direct_2x_960x540` | 24 | 24.00/0 | 24.00/0 | 23.49 | 6.95 | 0.21 |
| `direct_4x_640x360` | 24 | 24.00/0 | 18.00/18 | 59.44 | 6.75 | 0.25 |
| `fallback_1x_1280x720` | 24 | 24.00/0 | 24.00/0 | 20.15 | 4.22 | 0.20 |
| `fallback_1x_1280x720` | 30 | 30.00/0 | 30.00/0 | 20.15 | 5.27 | 0.24 |
| `fallback_2x_960x540` | 24 | 24.00/0 | 24.00/0 | 20.58 | 7.06 | 0.24 |
| `fallback_4x_640x360` | 24 | 24.00/0 | 17.33/20 | 159.26 | 7.46 | 0.28 |

Playback acceptance requires at least 90% backend and modeled delivery, p95 lag <= 1 frame period, maximum lag <= 2 frame periods, and backend drain <= 2 frame periods.

## Memory

RSS is process-wide and includes VapourSynth/Pillow allocator retention. Chromium JS heap is collected separately in the raw JSON.

| Scenario | Before MiB | After setup MiB | After playback MiB | After cleanup MiB |
| --- | ---: | ---: | ---: | ---: |
| `direct_1x_1280x720` | 107.1 | 107.1 | 709.4 | 675.8 |
| `direct_2x_960x540` | 675.8 | 675.8 | 716.8 | 716.8 |
| `direct_4x_640x360` | 716.8 | 716.8 | 716.9 | 716.9 |
| `fallback_1x_1280x720` | 716.9 | 716.9 | 816.6 | 732.4 |
| `fallback_2x_960x540` | 732.4 | 716.7 | 757.1 | 757.1 |
| `fallback_4x_640x360` | 757.1 | 757.1 | 757.1 | 757.1 |

Repeated 320x240 construct/request/close probe:

- Iterations: 12; post-close RSS min/median/max: 757.1/757.1/757.1 MiB.
- First-to-last RSS growth: 0.0 MiB; second-half spread: 0.0 MiB.
- Cleanup acceptance tolerance: at least two post-close samples, with growth and second-half spread each <= 16 MiB.

Browser JS heap after forced GC:

| Scenario | Before MiB | After MiB | Delta KiB |
| --- | ---: | ---: | ---: |
| `direct_1x_1280x720` | 1.23 | 1.22 | -9.0 |
| `direct_2x_960x540` | 1.22 | 1.23 | 5.3 |
| `direct_4x_640x360` | 1.23 | 1.26 | 37.4 |
| `fallback_1x_1280x720` | 1.26 | 1.29 | 25.7 |
| `fallback_2x_960x540` | 1.29 | 1.30 | 14.1 |
| `fallback_4x_640x360` | 1.30 | 1.33 | 26.1 |

## Architecture Decision

- Default encoder: **Pillow JPEG**, codec **jpeg**, chroma **4:2:0**, quality **80**.
- User-selectable encoding: JPEG quality 0-95 (lossy only), or WebP quality 0-100 with lossy/lossless selection and `method=0`.
- Resolution policy: **preserve source resolution; resize upstream**.
- Interleave: **NumPy**; NumPy runtime dependency: **True**.
- Image-per-frame transport: **retain**.
- Gate status: latency=True, paced playback=True, cleanup memory=True.
- Real Jupyter comm latency remains a later host-integration measurement; this gate uses an explicitly labeled local copy simulation.
- Rationale: JPEG 4:2:0 remains the default because it is the fastest measured encoder and avoids the larger 4:4:4 payload. Lossy and lossless WebP remain explicit user choices because they save bytes on the measured fixtures but cost materially more CPU. NumPy remains only because its measured 720p gain is at least 20% and at least 1 ms.
- **Performance evidence supports G2 review; compatibility and final quality gates remain separate.**

Raw samples and all environment fields are in `benchmarks/results/t13-pipeline.json`.

## Reproduce

```bash
.venv/bin/python -m pip install -e . -r benchmarks/requirements.txt
npm ci
PYTHONPATH=src:. .venv/bin/python -m benchmarks.pipeline --output benchmarks/results/t13-pipeline.json --report tasks/t13-benchmark-report.md --report-label T13
```
