# Usage

`kaleidoscope.preview()` normalizes one or more VapourSynth `VideoNode` objects
into a synchronized player. Every supplied clip must have the same frame count and
frame rate. Wipe, overlay, and difference additionally require matching output
dimensions.

## Direct Clip

```python
from kaleidoscope import preview

player = preview(clip)
player
```

A single clip is labeled `Clip 0`.

## Sequences and Mappings

Sequences receive stable numeric IDs. Mappings preserve insertion order and use
their keys as both IDs and labels:

```python
preview([source, filtered], mode="side-by-side")

preview(
    {"Source": source, "Filtered": filtered},
    mode="wipe",
    primary="Source",
    secondary="Filtered",
)
```

Clip IDs may be strings or JavaScript-safe integers.

## Registered Outputs

Calling `preview()` without clips snapshots the currently registered
VapourSynth video outputs, sorts them by output index, and ignores audio:

```python
source.set_output(0)
filtered.set_output(1)
player = preview()
```

Later registry changes do not mutate an existing player.

Pass `output_ids` to snapshot only specific registered video outputs. This is
useful in shared kernels where unrelated outputs may use a different timeline:

```python
player = preview(output_ids=[12, 15])
```

`output_ids` is available only when `clips` is omitted. It must be a non-empty
sequence of unique non-negative integers, and each selected ID must currently
refer to a registered video output.

## Public Option Reference

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

| Option | Default | Accepted values |
| --- | --- | --- |
| `clips` | `None` | A `VideoNode`, ordered sequence, insertion-ordered mapping, or `None` for registered-output discovery. |
| `output_ids` | `None` | A non-empty sequence of unique non-negative integers, only with `clips=None`. |
| `mode` | `"auto"` | `auto`, `single`, `side-by-side`, `wipe`, `overlay`, or `difference`. |
| `primary` | `None` | A normalized clip ID used for single mode and the A layer. |
| `secondary` | `None` | A distinct normalized clip ID used for the B layer. |
| `visible` | `None` | An ordered sequence of clip IDs for side-by-side mode. |
| `overlay_opacity` | `0.5` | A number from `0` through `1`. |
| `max_visible_clips` | `4` | An integer from `1` through `4`. |
| `codec` | `"jpeg"` | `jpeg` or `webp`. |
| `quality` | `80` | JPEG integer `0`-`95`; WebP integer `0`-`100`. |
| `lossless` | `False` | A boolean; `True` requires `codec="webp"`. |
| `cache_size` | `32` | A non-negative integer; `0` disables encoded-frame caching. |
| `max_in_flight` | `4` | An integer from `1` through `16`, counted per submitted clip frame. |
| `autoplay` | `False` | A boolean; playback starts only after the first successful `ready` handshake. |

## Comparison Modes

- `single`: one selected clip.
- `side-by-side`: one to four selected clips in a responsive grid.
- `wipe`: clip B is revealed over clip A with an adjustable boundary.
- `overlay`: clip B is blended over clip A with adjustable opacity.
- `difference`: browser-side 8-bit visual difference for inspection, not a
  reference-quality measurement.
- `auto`: chooses `single` for one clip and `side-by-side` for multiple clips.

Use `primary`, `secondary`, and `visible` to set initial selections. Aligned
pair modes require distinct A and B clips.

## Playback and Navigation

Use the visible controls to play, pause, seek, step, jump to first/last, enter a
frame, enter a time, or toggle fullscreen. Keyboard shortcuts apply only while
focus is inside the player:

- `Space`: play or pause.
- `Left`/`Right`: step one frame.
- `Shift+Left`/`Shift+Right`: seek one second.
- `Home`/`End`: first or last frame.
- `F`: enter or exit fullscreen.

## Encoding and Resolution

Kaleidoscope preserves the dimensions of the supplied nodes. Resize upstream if
you want a smaller preview payload.

```python
preview(source, codec="jpeg", quality=80)
preview(source, codec="webp", quality=85)
preview(source, codec="webp", lossless=True)
```

JPEG is the default. `lossless=True` is valid only for WebP. Cache and render
concurrency can be bounded with `cache_size` and `max_in_flight`.

## RGB24 and Warnings

Caller-prepared `RGB24` is used directly. Other formats are converted once to a
prepared RGB24 node and receive a visible warning because inferred matrix,
transfer, or range choices may not match the intended color pipeline. Convert
upstream when color handling must be explicit.

## Cleanup

Each widget owns one backend render session, in-flight frames, and encoded
cache. Multiple notebook views of that same widget coordinate so only one view
drives the session. Removing the active view hands control and the current frame
to a surviving view; removing the final view closes the backend session while
the comm is live. Close the widget explicitly when finished, especially in a
long-lived kernel:

```python
player.close()
```

Saved notebook output does not contain a durable playable copy of streamed
frame buffers; rerun the cell after reopening.