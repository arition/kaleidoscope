# Kaleidoscope Agent Guide

Kaleidoscope is a Python-owned VapourSynth session with a framework-free
TypeScript anywidget frontend. Read [README.md](README.md) for setup and the
public surface, and use [docs/architecture.md](docs/architecture.md) as the
canonical description of ownership, protocol, lifecycle, and security decisions.

## Validate Narrowly First

Use the owning test file immediately after an edit, then broaden to the relevant
quality gates.

```bash
# Python
hatch run test:pytest tests/python/test_session.py -q
hatch run lint:check
hatch run types:check

# Frontend
npm test -- --run tests/frontend/player.test.ts
npm run check
```

Use `npm test -- --run`; plain `npm test` enters watch mode. Python tests run the
checkout through Hatch with `PYTHONPATH=src`. Follow neighboring tests for local
style, and preserve the per-file branch coverage policy enforced by CI.

Run broader checks when the change crosses their boundary:

```bash
hatch run test:pytest tests/python
hatch run test:coverage
npm test -- --run
npm run test:coverage
npm run test:e2e -- --project=chromium
hatch run host:smoke -- jupyterlab
hatch run host:smoke -- notebook
```

Browser and real-host checks require the matching Playwright browsers and a
working VapourSynth R77 installation in the exact Python environment. See
[docs/installation.md](docs/installation.md) and
[docs/troubleshooting.md](docs/troubleshooting.md) before changing environment
or host-smoke code.

## Generated Assets And Packaging

- Frontend source or CSS changes must include `npm run build`; commit the
  regenerated `src/kaleidoscope/static/index.js` and `index.css`.
- Verify generated assets with
  `git diff --exit-code -- src/kaleidoscope/static` after the build.
- The source distribution intentionally embeds compiled assets and excludes the
  development `frontend/` tree, so installed builds do not require Node or a CDN.
- Run artifact-dependent packaging checks with a new dedicated
  `KALEIDOSCOPE_ARTIFACT_DIR`. Do not trust existing `dist/` contents, which may
  be stale. The full release procedure lives in [README.md](README.md) and
  `.github/workflows/ci.yml`.

Keep changes focused. Do not weaken validation, payload bounds, stale-request
suppression, frame cleanup, or offline packaging guarantees to make a test pass.
