# T6 Pipeline Benchmark Report

Generated: 2026-07-14T12:23:06.926050+00:00
Commit: `6e395b41c85872c42d6edbf8bdf0dc3effe97243`

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
| 1 x 1280x720 direct RGB24 | 15.55 | <150.00 | 20.59 | <250.00 | PASS |
| 2 x 960x540 direct RGB24 | 16.28 | <225.00 | 19.53 | <350.00 | PASS |

## Complete Path

| Scenario | Backend median/p95 ms | Simulated paint median/p95 ms | Payload KiB | Backend CPU median ms |
| --- | ---: | ---: | ---: | ---: |
| `direct_1x_1280x720` | 8.82/9.63 | 15.55/20.59 | 17.8 | 10.56 |
| `direct_2x_960x540` | 5.68/7.56 | 16.28/19.53 | 35.5 | 8.53 |
| `direct_4x_640x360` | 6.16/6.72 | 11.07/16.94 | 34.4 | 10.27 |
| `fallback_1x_1280x720` | 6.16/8.77 | 16.35/20.35 | 21.5 | 7.58 |
| `fallback_2x_960x540` | 6.69/8.25 | 14.72/19.97 | 36.1 | 9.71 |
| `fallback_4x_640x360` | 6.30/6.90 | 11.19/21.61 | 37.9 | 11.39 |

## Preparation And Backend Stages

| Scenario | Setup wall/cpu ms | Render barrier ms | Interleave total ms | Encode total ms | Assembly/send ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| `direct_1x_1280x720` | 0.11/0.10 | 1.89 | 3.11 | 3.70 | 0.03 |
| `direct_2x_960x540` | 0.09/0.10 | 3.40 | 1.29 | 2.92 | 0.02 |
| `direct_4x_640x360` | 0.10/0.12 | 4.83 | 1.37 | 2.75 | 0.03 |
| `fallback_1x_1280x720` | 0.95/2.56 | 2.26 | 1.09 | 2.79 | 0.02 |
| `fallback_2x_960x540` | 1.69/4.12 | 4.10 | 1.32 | 2.93 | 0.02 |
| `fallback_4x_640x360` | 4.28/8.75 | 5.02 | 1.29 | 2.83 | 0.03 |

## Interleave

| Resolution | Buffer median ms | NumPy median ms | Buffer/NumPy | Plane strides |
| --- | ---: | ---: | ---: | --- |
| 640x480 | 1.34 | 0.32 | 4.25x | `[640, 640, 640]` |
| 1280x720 | 3.72 | 0.96 | 3.88x | `[1280, 1280, 1280]` |
| 1920x1080 | 10.45 | 2.34 | 4.47x | `[1920, 1920, 1920]` |

## Codec

Quality 80; WebP uses Pillow's speed-focused `method=0`.

| Resolution | Codec | Encode median ms | CPU median ms | Payload KiB | Browser decode p95 ms |
| --- | --- | ---: | ---: | ---: | ---: |
| 640x480 | `jpeg_420` | 0.75 | 0.75 | 6.0 | n/a |
| 640x480 | `jpeg_444` | 1.18 | 1.17 | 10.1 | n/a |
| 640x480 | `webp_method_0` | 3.40 | 3.39 | 1.9 | n/a |
| 1280x720 | `jpeg_420` | 2.17 | 2.15 | 17.9 | 8.53 |
| 1280x720 | `jpeg_444` | 3.44 | 3.40 | 27.2 | 8.97 |
| 1280x720 | `webp_method_0` | 13.18 | 13.04 | 4.8 | 8.50 |
| 1920x1080 | `jpeg_420` | 4.93 | 4.88 | 45.2 | n/a |
| 1920x1080 | `jpeg_444` | 8.16 | 8.07 | 71.6 | n/a |
| 1920x1080 | `webp_method_0` | 28.41 | 27.98 | 8.9 | n/a |

## Browser Stages

All comm values below are the labeled in-process copy simulation.

| Scenario | Comm copy ms | Validate ms | Decode median/p95 ms | Atomic draw/commit ms | Flush ms | Receive-to-paint p95 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `direct_1x_1280x720` | 0.00 | 0.00 | 4.80/8.81 | 1.80 | 0.60 | 11.20 |
| `direct_2x_960x540` | 0.00 | 0.00 | 7.25/8.65 | 2.10 | 0.70 | 13.20 |
| `direct_4x_640x360` | 0.00 | 0.00 | 2.30/7.96 | 1.80 | 0.30 | 10.71 |
| `fallback_1x_1280x720` | 0.00 | 0.00 | 8.05/8.30 | 1.80 | 0.60 | 12.43 |
| `fallback_2x_960x540` | 0.00 | 0.00 | 2.65/8.55 | 2.00 | 0.70 | 13.29 |
| `fallback_4x_640x360` | 0.00 | 0.00 | 2.20/8.36 | 1.80 | 0.30 | 15.41 |

## Paced Playback

| Scenario | Target fps | Backend fps/drops | Modeled paint fps/drops | Modeled lag p95 ms | Payload Mbit/s | Backend CPU cores |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `direct_1x_1280x720` | 24 | 24.00/0 | 24.00/0 | 20.79 | 3.51 | 0.18 |
| `direct_1x_1280x720` | 30 | 30.00/0 | 30.00/0 | 20.79 | 4.39 | 0.21 |
| `direct_2x_960x540` | 24 | 24.00/0 | 24.00/0 | 19.73 | 6.95 | 0.21 |
| `direct_4x_640x360` | 24 | 24.00/0 | 24.00/0 | 17.04 | 6.75 | 0.25 |
| `fallback_1x_1280x720` | 24 | 24.00/0 | 24.00/0 | 20.41 | 4.22 | 0.19 |
| `fallback_1x_1280x720` | 30 | 30.00/0 | 30.00/0 | 20.41 | 5.27 | 0.23 |
| `fallback_2x_960x540` | 24 | 24.00/0 | 24.00/0 | 20.38 | 7.06 | 0.24 |
| `fallback_4x_640x360` | 24 | 24.00/0 | 24.00/0 | 24.98 | 7.46 | 0.28 |

## Memory

RSS is process-wide and includes VapourSynth/Pillow allocator retention. Chromium JS heap is collected separately in the raw JSON.

| Scenario | Before MiB | After setup MiB | After playback MiB | After cleanup MiB |
| --- | ---: | ---: | ---: | ---: |
| `direct_1x_1280x720` | 106.9 | 106.9 | 732.8 | 697.6 |
| `direct_2x_960x540` | 697.6 | 697.6 | 720.2 | 720.2 |
| `direct_4x_640x360` | 720.2 | 720.2 | 720.3 | 720.3 |
| `fallback_1x_1280x720` | 720.3 | 720.4 | 816.9 | 714.2 |
| `fallback_2x_960x540` | 714.2 | 714.2 | 737.0 | 737.0 |
| `fallback_4x_640x360` | 737.0 | 721.2 | 725.9 | 725.9 |

Repeated 320x240 construct/request/close probe:

- Iterations: 12; post-close RSS min/median/max: 725.9/725.9/725.9 MiB.
- First-to-last RSS growth: 0.0 MiB; second-half spread: 0.0 MiB.

Browser JS heap after forced GC:

| Scenario | Before MiB | After MiB | Delta KiB |
| --- | ---: | ---: | ---: |
| `direct_1x_1280x720` | 1.13 | 1.13 | 0.8 |
| `direct_2x_960x540` | 1.13 | 1.12 | -11.4 |
| `direct_4x_640x360` | 1.12 | 1.13 | 15.5 |
| `fallback_1x_1280x720` | 1.13 | 1.13 | -0.5 |
| `fallback_2x_960x540` | 1.13 | 1.13 | 0.3 |
| `fallback_4x_640x360` | 1.13 | 1.14 | 8.4 |

## Architecture Decision

- Encoder: **Pillow JPEG**, chroma **4:2:0**, quality **80**.
- Interleave: **NumPy**; NumPy runtime dependency: **True**.
- Image-per-frame transport: **retain**.
- Gate status: latency=True, paced playback=True.
- Real Jupyter comm latency remains a later host-integration measurement; this gate uses an explicitly labeled local copy simulation.
- **G1 approval required before T7**.

Raw samples and all environment fields are in `benchmarks/results/t6-pipeline.json`.

## Reproduce

```bash
.venv/bin/python -m pip install -e . -r benchmarks/requirements.txt
npm ci
PYTHONPATH=src:. .venv/bin/python -m benchmarks.pipeline
```
