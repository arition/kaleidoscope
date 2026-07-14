# Kaleidoscope Task List

Status: T2 complete; T3 is next  
Source plan: `tasks/plan.md`  
Source spec: `tasks/spec.md`, revision 0.3

Do not start product implementation until Gate 0 is complete. Check a task only after its acceptance criteria and listed verification pass.

## Gates

- [x] **G0 - Approve the product contract**
  - [x] Review every item in the spec approval checklist.
  - [x] Confirm `kaleidoscope` package/distribution name and MIT license.
  - [x] Confirm caller-owned `RGB24` plus warned fallback conversion.
  - [x] Confirm atomic multi-clip comparison modes and four-visible-clip cap.
  - [x] Confirm Linux-first host matrix and performance targets.
- [ ] **G1 - Approve pipeline benchmark outcome after T6**
  - [ ] Lock encoder/chroma policy.
  - [ ] Decide whether NumPy remains a runtime dependency.
  - [ ] Confirm image-per-frame transport remains viable or revise the spec.
- [ ] **G2 - Approve release readiness after T13**
  - [ ] Review compatibility, benchmark, memory, accessibility, and quality reports.

## Implementation Tasks

- [x] **T1 - Bootable packaged widget shell** (depends on G0)
  - [x] Add Python, TypeScript, Hatch, npm, esbuild, test, lint, and type-check scaffolding.
  - [x] Implement protocol-v1 `ready`/metadata handshake with a visible placeholder.
  - [x] Bundle ESM/CSS into wheel and sdist without runtime network requests.
  - [x] Establish and run every command in the verification command contract.

- [x] **T2 - Normalized sources and visible metadata** (depends on T1)
  - [x] Normalize a node, sequence, mapping, and registered-output snapshot.
  - [x] Preserve deterministic IDs/labels and ignore registered audio.
  - [x] Validate timeline, format, dimensions, mode cardinality, and selections.
  - [x] Render clip/timeline metadata and test stable error codes.

- [ ] **T3 - Single RGB24 frame end to end** (depends on T2)
  - [ ] Use caller-prepared target-size `RGB24` without conversion.
  - [ ] Retrieve frame 0 asynchronously and close every `VideoFrame` path.
  - [ ] Adapt strided planar RGB and encode a bounded MIME-typed payload.
  - [ ] Decode/paint in the browser and verify known canvas pixels.

- [ ] **T4 - Warned automatic RGB24 fallback** (depends on T3)
  - [ ] Keep direct and resize-only RGB24 paths warning-free.
  - [ ] Build one fallback conversion/resize node for non-RGB24 clips.
  - [ ] Emit automatic-conversion and assumed-color-metadata warnings.
  - [ ] Render visible accessible clip-specific warnings and test YUV preview.

- [ ] **T5 - Atomic two-clip side-by-side preview** (depends on T4)
  - [ ] Request both clips under one frame-set identity.
  - [ ] Assemble a validated manifest with deterministic binary buffers.
  - [ ] Stage decoded images and commit only complete synchronized sets.
  - [ ] Prove stale, missing, failed, or undecodable members never partially paint.

- [ ] **T6 - Pipeline benchmark and architecture gate** (depends on T5)
  - [ ] Benchmark one/two/four clips and RGB24/fallback paths.
  - [ ] Compare JPEG/WebP, chroma policies, and NumPy/buffer-only interleave.
  - [ ] Record render-through-paint percentiles, bytes, CPU, lag, and drops.
  - [ ] Publish the decision and complete G1 before continuing.

- [ ] **T7 - Exact paused navigation** (depends on T6 and G1 passing)
  - [ ] Add timeline, frame/time entry, stepping, and first/last controls.
  - [ ] Implement rational frame/time conversion and clamping.
  - [ ] Coalesce scrubs with latest-generation-wins behavior.
  - [ ] Prove exact first/middle/last synchronized seeks and no stale overwrite.

- [ ] **T8 - Clock-correct bounded playback** (depends on T7)
  - [ ] Add play/pause, autoplay-after-ready, end, restart, and visibility behavior.
  - [ ] Implement clock-derived desired frames and obsolete-frame dropping.
  - [ ] Enforce fair global in-flight and one-set ACK delivery bounds.
  - [ ] Add bounded per-session count/byte LRU behavior.

- [ ] **T9 - Interactive comparison modes** (depends on T7; coordinate with T8)
  - [ ] Add single and one-to-four side-by-side selectors.
  - [ ] Add distinct A/B selection for aligned pair modes.
  - [ ] Implement wipe, opacity overlay, and 8-bit visual difference.
  - [ ] Prove pair-mode switches reuse decoded images without rerendering.

- [ ] **T10 - Recoverable errors and complete lifecycle** (depends on T8 and T9)
  - [ ] Preserve the last complete set on clip-specific failures.
  - [ ] Implement decode-error ACK, retry/seek, and disconnected states.
  - [ ] Make close/removal cleanup idempotent and suppress late completions.
  - [ ] Prove multiple widgets remain independent and leak-free.

- [ ] **T11 - Accessible responsive notebook player** (depends on T10)
  - [ ] Complete keyboard scoping, labels, live regions, focus, and contrast.
  - [ ] Make wipe and opacity controls fully keyboard-operable.
  - [ ] Implement stable narrow/desktop/fullscreen layouts and theme support.
  - [ ] Run accessibility, screenshot, console, and canvas-pixel browser checks.

- [ ] **T12 - Distributable package, examples, and docs** (depends on T11)
  - [ ] Finalize wheel/sdist contents, `py.typed`, metadata, and license.
  - [ ] Add installation, usage, architecture, and troubleshooting docs.
  - [ ] Add a generated-media quickstart notebook.
  - [ ] Pass clean wheel/sdist installs and offline runtime smoke tests.

- [ ] **T13 - Compatibility matrix and final quality gate** (depends on T12)
  - [ ] Add CI for lint, types, tests, build, artifacts, and coverage.
  - [ ] Verify Python 3.12/3.13, VapourSynth baseline, and real Jupyter comms.
  - [ ] Complete JupyterLab, Notebook 7, VS Code, Chromium, and Firefox checks.
  - [ ] Run final performance, memory, accessibility, security, and code review.
  - [ ] Complete G2 with an explicit release or hold decision.

## Completion Rule

- [ ] Every task has focused tests added before or with its behavior.
- [ ] Targeted checks pass immediately after each slice.
- [ ] Full Python/frontend/build checks pass before moving to the next dependent task.
- [ ] Any contract change updates `tasks/spec.md` and `tasks/plan.md` before code follows it.