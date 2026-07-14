# T6 Pipeline Benchmark Report

Generated: 2026-07-14T21:39:15.738803+00:00
Commit: `9ba489f1daae3aa20637151614645a9bc971b507`

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
| 1 x 1280x720 direct RGB24 | 15.25 | <150.00 | 19.70 | <250.00 | PASS |
| 2 x 960x540 direct RGB24 | 15.09 | <225.00 | 21.71 | <350.00 | PASS |

## Complete Path

| Scenario | Backend median/p95 ms | Simulated paint median/p95 ms | Payload KiB | Backend CPU median ms |
| --- | ---: | ---: | ---: | ---: |
| `direct_1x_1280x720` | 8.67/9.64 | 15.25/19.70 | 17.8 | 10.56 |
| `direct_2x_960x540` | 5.57/7.20 | 15.09/21.71 | 35.5 | 8.39 |
| `direct_4x_640x360` | 5.96/6.21 | 10.40/17.22 | 34.4 | 10.00 |
| `fallback_1x_1280x720` | 6.14/7.58 | 13.42/22.08 | 21.5 | 7.49 |
| `fallback_2x_960x540` | 6.34/6.64 | 15.42/18.90 | 36.1 | 9.48 |
| `fallback_4x_640x360` | 6.47/7.15 | 11.26/21.36 | 37.9 | 11.11 |

## Preparation And Backend Stages

| Scenario | Setup wall/cpu ms | Render barrier ms | Interleave total ms | Encode total ms | Assembly/send ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| `direct_1x_1280x720` | 0.06/0.07 | 1.84 | 3.09 | 3.74 | 0.02 |
| `direct_2x_960x540` | 0.06/0.08 | 3.37 | 1.27 | 2.87 | 0.02 |
| `direct_4x_640x360` | 0.07/0.08 | 4.79 | 1.28 | 2.73 | 0.02 |
| `fallback_1x_1280x720` | 0.99/2.65 | 2.21 | 1.08 | 2.68 | 0.02 |
| `fallback_2x_960x540` | 1.71/4.01 | 4.12 | 1.29 | 2.88 | 0.02 |
| `fallback_4x_640x360` | 2.90/7.23 | 5.17 | 1.45 | 2.84 | 0.02 |

## Interleave

| Resolution | Buffer median ms | NumPy median ms | Buffer/NumPy | Plane strides |
| --- | ---: | ---: | ---: | --- |
| 640x480 | 1.39 | 0.31 | 4.41x | `[640, 640, 640]` |
| 1280x720 | 3.61 | 0.97 | 3.71x | `[1280, 1280, 1280]` |
| 1920x1080 | 10.24 | 2.33 | 4.40x | `[1920, 1920, 1920]` |

## Codec

All rows use quality 80. WebP uses Pillow's speed-focused `method=0`; the lossless row also sets `lossless=True`.

| Resolution | Codec | Encode median ms | CPU median ms | Payload KiB | Browser decode p95 ms |
| --- | --- | ---: | ---: | ---: | ---: |
| 640x480 | `jpeg_420` | 0.76 | 0.76 | 6.0 | n/a |
| 640x480 | `jpeg_444` | 1.18 | 1.17 | 10.1 | n/a |
| 640x480 | `webp_lossy_method_0` | 3.43 | 3.40 | 1.9 | n/a |
| 640x480 | `webp_lossless_method_0` | 3.46 | 3.44 | 2.7 | n/a |
| 1280x720 | `jpeg_420` | 2.16 | 2.14 | 17.9 | 8.05 |
| 1280x720 | `jpeg_444` | 3.43 | 3.38 | 27.2 | 8.30 |
| 1280x720 | `webp_lossy_method_0` | 13.20 | 13.02 | 4.8 | 8.30 |
| 1280x720 | `webp_lossless_method_0` | 12.76 | 12.58 | 4.2 | 7.66 |
| 1920x1080 | `jpeg_420` | 4.93 | 4.87 | 45.2 | n/a |
| 1920x1080 | `jpeg_444` | 7.80 | 7.70 | 71.6 | n/a |
| 1920x1080 | `webp_lossy_method_0` | 29.24 | 28.78 | 8.9 | n/a |
| 1920x1080 | `webp_lossless_method_0` | 26.14 | 25.79 | 9.1 | n/a |

## Browser Stages

All comm values below are the labeled in-process copy simulation.

| Scenario | Comm copy ms | Validate ms | Decode median/p95 ms | Atomic draw/commit ms | Flush ms | Receive-to-paint p95 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `direct_1x_1280x720` | 0.00 | 0.00 | 4.35/8.01 | 1.85 | 0.60 | 10.46 |
| `direct_2x_960x540` | 0.00 | 0.00 | 6.70/8.56 | 2.00 | 0.70 | 15.72 |
| `direct_4x_640x360` | 0.00 | 0.00 | 2.10/8.25 | 1.90 | 0.30 | 11.36 |
| `fallback_1x_1280x720` | 0.00 | 0.00 | 4.30/8.16 | 1.90 | 0.55 | 15.41 |
| `fallback_2x_960x540` | 0.00 | 0.00 | 4.45/8.00 | 2.00 | 0.70 | 12.68 |
| `fallback_4x_640x360` | 0.00 | 0.00 | 2.20/7.82 | 1.90 | 0.30 | 14.51 |

## Paced Playback

| Scenario | Target fps | Backend fps/drops | Modeled paint fps/drops | Modeled lag p95 ms | Payload Mbit/s | Backend CPU cores |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `direct_1x_1280x720` | 24 | 24.00/0 | 24.00/0 | 19.85 | 3.51 | 0.19 |
| `direct_1x_1280x720` | 30 | 30.00/0 | 30.00/0 | 19.85 | 4.39 | 0.22 |
| `direct_2x_960x540` | 24 | 24.00/0 | 24.00/0 | 24.69 | 6.95 | 0.21 |
| `direct_4x_640x360` | 24 | 24.00/0 | 24.00/0 | 17.60 | 6.75 | 0.25 |
| `fallback_1x_1280x720` | 24 | 24.00/0 | 24.00/0 | 25.05 | 4.22 | 0.19 |
| `fallback_1x_1280x720` | 30 | 30.00/0 | 30.00/0 | 25.05 | 5.27 | 0.24 |
| `fallback_2x_960x540` | 24 | 24.00/0 | 24.00/0 | 20.15 | 7.06 | 0.24 |
| `fallback_4x_640x360` | 24 | 24.00/0 | 24.00/0 | 24.94 | 7.46 | 0.28 |

## Memory

RSS is process-wide and includes VapourSynth/Pillow allocator retention. Chromium JS heap is collected separately in the raw JSON.

| Scenario | Before MiB | After setup MiB | After playback MiB | After cleanup MiB |
| --- | ---: | ---: | ---: | ---: |
| `direct_1x_1280x720` | 107.8 | 107.8 | 715.8 | 695.3 |
| `direct_2x_960x540` | 695.3 | 695.3 | 720.1 | 720.1 |
| `direct_4x_640x360` | 720.1 | 720.1 | 720.2 | 720.2 |
| `fallback_1x_1280x720` | 720.2 | 720.3 | 805.5 | 789.7 |
| `fallback_2x_960x540` | 789.7 | 789.7 | 791.4 | 791.4 |
| `fallback_4x_640x360` | 791.4 | 791.4 | 779.3 | 779.3 |

Repeated 320x240 construct/request/close probe:

- Iterations: 12; post-close RSS min/median/max: 779.3/779.3/779.3 MiB.
- First-to-last RSS growth: 0.0 MiB; second-half spread: 0.0 MiB.

Browser JS heap after forced GC:

| Scenario | Before MiB | After MiB | Delta KiB |
| --- | ---: | ---: | ---: |
| `direct_1x_1280x720` | 1.13 | 1.12 | -11.5 |
| `direct_2x_960x540` | 1.12 | 1.12 | 0.3 |
| `direct_4x_640x360` | 1.12 | 1.13 | 15.5 |
| `fallback_1x_1280x720` | 1.13 | 1.13 | -0.5 |
| `fallback_2x_960x540` | 1.13 | 1.14 | 6.2 |
| `fallback_4x_640x360` | 1.14 | 1.14 | 3.5 |

## Architecture Decision

- Default encoder: **Pillow JPEG**, codec **jpeg**, chroma **4:2:0**, quality **80**.
- User-selectable encoding: JPEG quality 0-95 (lossy only), or WebP quality 0-100 with lossy/lossless selection and `method=0`.
- Resolution policy: **preserve source resolution; resize upstream**.
- Interleave: **NumPy**; NumPy runtime dependency: **True**.
- Image-per-frame transport: **retain**.
- Gate status: latency=True, paced playback=True.
- Real Jupyter comm latency remains a later host-integration measurement; this gate uses an explicitly labeled local copy simulation.
- Rationale: JPEG 4:2:0 remains the default because it is the fastest measured encoder and avoids the larger 4:4:4 payload. Lossy and lossless WebP remain explicit user choices because they save bytes on the measured fixtures but cost materially more CPU. NumPy remains only because its measured 720p gain is at least 20% and at least 1 ms.
- **G1 approval required before T7**.

Raw samples and all environment fields are in `benchmarks/results/t6-pipeline.json`.

## Reproduce

```bash
.venv/bin/python -m pip install -e . -r benchmarks/requirements.txt
npm ci
PYTHONPATH=src:. .venv/bin/python -m benchmarks.pipeline
```
