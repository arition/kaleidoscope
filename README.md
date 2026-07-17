# Kaleidoscope

Kaleidoscope is an anywidget-based Jupyter player for real-time VapourSynth
preview and synchronized clip comparison. It supports exact seeking, playback,
single and side-by-side views, wipe, overlay, and visual difference modes while
preserving the source resolution supplied by the caller.

## Requirements

- Python 3.12 or newer.
- VapourSynth R77/API R4.2 and a working Python binding for the selected kernel.
- JupyterLab 4, Notebook 7, or VS Code with Jupyter support.

The `vapoursynth-kaleidoscope` distribution declares the official VapourSynth
R77 package as a dependency. If you use a custom VapourSynth build or external
plugins, install and verify those in the notebook environment first. Packaged
platform-neutral checks are in `docs/installation.md`.

## Quick Start

```python
import vapoursynth as vs
from kaleidoscope import preview

core = vs.core
source = core.std.BlankClip(
    width=640,
    height=360,
    format=vs.RGB24,
    length=240,
    fpsnum=24000,
    fpsden=1001,
    color=[220, 40, 40],
)
filtered = core.std.BlankClip(clip=source, color=[40, 120, 220])

player = preview(
    {"Source": source, "Filtered": filtered},
    mode="side-by-side",
)
player
```

Close the widget when it is no longer needed:

```python
player.close()
```

The packaged `examples/quickstart.ipynb` notebook creates all media in memory
and requires no input files. Wheels also install it at
`kaleidoscope/examples/quickstart.ipynb`.

## Preview Options

```python
preview(
    clips=None,
    *,
    output_ids=None,
    mode="auto",
    primary=None,
    secondary=None,
    visible=None,
    overlay_opacity=0.5,
    max_visible_clips=4,
    codec="jpeg",
    quality=80,
    lossless=False,
    cache_size=32,
    max_in_flight=4,
    autoplay=False,
)
```

| Option | Default | Contract |
| --- | --- | --- |
| `clips` | `None` | One clip, a sequence, a labeled mapping, or a snapshot of registered outputs when omitted. |
| `output_ids` | `None` | With `clips=None`, select a non-empty sequence of unique non-negative registered output IDs. |
| `mode` | `"auto"` | `auto`, `single`, `side-by-side`, `wipe`, `overlay`, or `difference`. |
| `primary` / `secondary` | `None` | Initial A/B clip IDs; pair modes require distinct IDs. |
| `visible` | `None` | Initial ordered side-by-side clip IDs. |
| `overlay_opacity` | `0.5` | Number from `0` through `1`. |
| `max_visible_clips` | `4` | Integer from `1` through `4`. |
| `codec` | `"jpeg"` | `jpeg` or `webp`. |
| `quality` | `80` | JPEG: `0`-`95`; WebP: `0`-`100`. |
| `lossless` | `False` | Boolean; `True` is valid only with WebP. |
| `cache_size` | `32` | Non-negative encoded-frame entry limit; `0` disables the cache. |
| `max_in_flight` | `4` | Integer from `1` through `16` submitted clip-frame renders. |
| `autoplay` | `False` | Boolean; starts after the first successful browser handshake. |

## Documentation

- Installation: `docs/installation.md`
- Usage: `docs/usage.md`
- Architecture: `docs/architecture.md`
- Troubleshooting: `docs/troubleshooting.md`

## Development

```bash
npm ci
npm test -- --run
npm run build
release_dir=dist/release-candidate
release_guard=dist/release-network-guard
.venv/bin/hatch build "$release_dir"
KALEIDOSCOPE_ARTIFACT_DIR="$release_dir" .venv/bin/hatch run test:prepare-wheelhouse
cc -std=c11 -O2 -Wall -Wextra -Werror \
    -o "$release_guard" tests/packaging/network_guard.c
KALEIDOSCOPE_ARTIFACT_DIR="$release_dir" \
    "$release_guard" sh -eu -c \
      '.venv/bin/hatch run test:pytest && .venv/bin/hatch run test:artifact-smoke'
```

Frontend assets are committed into `src/kaleidoscope/static` so wheels and
source distributions install without Node.js or a runtime network request.
Contributors must run `npm run build` before `hatch build` after changing
frontend sources. The exact release filenames are selected inside the dedicated
artifact directory, so unrelated files are left untouched. The initial `npm ci`,
artifact build, wheelhouse preparation, and network-guard compilation are the
network-enabled preparation phase. The artifact pytest repeats `npm ci --offline`
from the populated npm cache to prove the committed bundle comes from the
lockfile toolchain. Both post-preparation checks run beneath one inherited Linux
seccomp filter. Pytest and artifact smoke therefore run their complete
process trees with only Unix-domain `socket()` and `socketpair()` creation
permitted; IPv4, IPv6, packet, netlink, x32, and `io_uring` network paths are
denied.

## License

Kaleidoscope is available under the MIT License. The license text is packaged
as `LICENSE`.