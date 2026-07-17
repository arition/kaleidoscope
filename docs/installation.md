# Installation

Kaleidoscope contains a browser widget and a Python package. Frame rendering is
provided by VapourSynth in the same environment used by the notebook kernel.

## 1. Install VapourSynth

The `vapoursynth-kaleidoscope` distribution depends on the official
`VapourSynth>=77,<78` package, which provides wheels for supported Python 3.12+
platforms. Install a custom VapourSynth build first if your platform or plugin
stack requires one. Kaleidoscope does not install third-party source, resize,
or format-conversion plugins.

Verify the selected Python environment before installing Kaleidoscope:

```bash
python -c "import vapoursynth as vs; print(vs.__version__)"
```

If this import fails after installation, fix the VapourSynth environment or
select the correct notebook kernel.

## 2. Install Kaleidoscope

Install from a wheel or package index into the kernel environment:

```bash
python -m pip install vapoursynth-kaleidoscope
```

For a locally built artifact:

```bash
python -m pip install dist/vapoursynth_kaleidoscope-0.1.0-py3-none-any.whl
```

The distribution name is `vapoursynth-kaleidoscope`; the Python import remains
`kaleidoscope`.

The wheel includes its ESM and CSS assets. It does not fetch scripts, styles,
fonts, analytics, or media from a CDN at runtime.

## 3. Verify the Kernel

Run this in a notebook cell:

```python
import vapoursynth as vs
import kaleidoscope

print(vs.__version__)
print(kaleidoscope.__name__)
```

Then run the generated-media [quickstart notebook](../examples/quickstart.ipynb).
Repository checkouts and source distributions provide that path; wheels also
install the notebook at `kaleidoscope/examples/quickstart.ipynb`.

## Building From Source

A repository checkout requires Node.js and npm when TypeScript or CSS sources
change:

```bash
npm ci
npm run build
.venv/bin/hatch build
```

An unpacked source distribution contains the built frontend assets and can
produce a wheel without Node.js. Use the normal PEP 517 isolated build:

```bash
python -m build --wheel
```

For an offline build, provide `hatchling==1.31.0` through a local wheelhouse and
configure pip with `--no-index` and `--find-links` for the isolated environment.
Release verification prepares
`${KALEIDOSCOPE_ARTIFACT_DIR:-dist}/wheelhouse` separately, then installs the
wheel and source distribution from that directory. On the supported Linux
release host, a native process-wide guard enters private user, mount, and network
namespaces, replaces `/run` with a private tmpfs, and blocks non-Unix socket
creation for pip, isolated build hooks, kernels, Chromium, and child processes.
Pathname Unix IPC remains available for the Jupyter kernel smoke, while host
Docker, container-runtime, D-Bus, and other service sockets are absent. Set
`KALEIDOSCOPE_ARTIFACT_DIR` to verify artifacts in a dedicated directory without
deleting unrelated repository output.