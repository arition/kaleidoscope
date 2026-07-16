# Troubleshooting

## `import vapoursynth` Fails

The native VapourSynth runtime or its Python binding is unavailable to the
selected kernel. Verify it with:

```bash
python -c "import vapoursynth as vs; print(vs.__version__)"
```

Use the exact Python executable backing the notebook kernel. Reinstalling only
Kaleidoscope does not provide the native runtime.

## No Registered Video Outputs

`preview()` without arguments reads the current VapourSynth output registry. Set
at least one video output before calling it:

```python
clip.set_output(0)
preview()
```

Audio-only outputs are intentionally ignored.

## Clips Cannot Be Compared

All clips must have identical frame counts and frame rates. Wipe, overlay, and
difference also require matching dimensions. Normalize timelines and resize
upstream before creating the player.

## Automatic RGB24 Conversion Warning

The source was not RGB24, so Kaleidoscope prepared a conversion for browser
encoding. The warning includes assumed color metadata where applicable. For
controlled color handling, convert to RGB24 explicitly in the script and pass
that node to `preview()`.

## WebP or Lossless Configuration Is Rejected

Lossless output is supported only with `codec="webp"`. The browser must also
pass decoder negotiation before metadata and rendering begin. Use JPEG when the
target browser cannot decode WebP.

## Preview Stops After Kernel Restart

The frontend enters a durable disconnected state when its widget comm closes.
Rerun the cell to create a new Python session and widget; the old view cannot be
reconnected safely.

## Fullscreen Is Unavailable

Notebook iframe permissions or browser policy may reject the Fullscreen API.
Kaleidoscope reports this as a recoverable status. Open the notebook in a host
that permits fullscreen or continue in the responsive inline view.

## Memory or CPU Use Is Too High

- Resize clips upstream to the resolution needed for inspection.
- Lower `quality` for lossy JPEG or WebP.
- Reduce `cache_size` or set it to zero.
- Reduce `max_in_flight` for expensive graphs.
- Close unused players with `player.close()`.

Kaleidoscope intentionally retains the last complete synchronized frame while a
new set is buffering, so one complete visible set remains allocated.