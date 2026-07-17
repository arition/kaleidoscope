# T13 Release Readiness

Assessment date: 2026-07-17

## Decision

**Gate 2: HOLD**

The product, benchmark, packaging, and local compatibility evidence is strong.
Hosted GitHub Actions reached the release jobs, but the workflow must be rerun
after the CI fix and the final VS Code visual/accessibility checklist remains
incomplete.

No artifact in `dist/` is approved for publication.

## CI Simplification

The candidate-built Linux namespace/seccomp guard has been removed. Current
hosted runners reject its unprivileged namespace setup, and a guard compiled
from the candidate source cannot be a trustworthy boundary for that source.
Project code also already runs in the earlier quality jobs, so wrapping only the
release jobs did not establish workflow-wide isolation.

The workflow retains the useful reproducibility controls: read-only token
permissions, checkout credentials disabled, source-archive SHA-256 validation,
a scrubbed environment for candidate-controlled commands, prefetched wheels,
pip `--no-index`, npm `--offline`, and fresh wheel/sdist install environments.
These package-manager settings do not block arbitrary runtime network access.
The workflow does not claim to execute deliberately malicious source safely. If
that becomes a release requirement, use a separately trusted builder or image
rather than restoring a wrapper built from the source being tested.

## Previous Qualification Evidence

The following evidence predates the CI simplification and must be refreshed for
the final candidate:

- Python and packaging suite: 217 passed, 2 expected skips on the previous tree.
- Fresh offline wheel and sdist installs: passed.
- Real IPC-kernel notebook and installed-byte Chromium smokes: passed for both
  wheel and sdist.
- Frontend unit suite: 108 passed.
- Protected frontend branch coverage: 90.71% to 95.27%.
- Ruff lint/format and strict mypy: passed.
- Frontend type check and production asset build: passed.
- npm audit: zero vulnerabilities.
- JupyterLab 4.6.1 and Notebook 7.6.0 real-comm smokes: passed locally.
- Chromium and Firefox Playwright coverage: passed in the local qualification
  evidence.
- Python 3.12.3 and previous Python 3.13.9 compatibility evidence: passed.
- VapourSynth R77 remains constrained to `>=77,<78`.
- PyPI JSON lookup for `vapoursynth-kaleidoscope`: 404 at assessment time.
- License: MIT.

The T13 performance report records passing latency, paced-playback, and cleanup
memory gates. Required paused-preview p95 latency was 20.86 ms for one
1280x720 clip and 21.64 ms for two 960x540 clips.

## Evidence Identity

- Repository commit during qualification:
  `c4d95892183a6b93a0d4c16a663a13fa8990dbe5`.
- Benchmark source tree:
  `f75656c6de8aa466add0c9ef3146a4834e852043`.
- Obsolete candidate index tree:
  `97b63e760d29eabcc2bf1fd295edda623cb57327`.
- Obsolete wheel SHA-256:
  `da9e8dedecd35b359a9b2c04916fbc3f6537db02adeac624923a9dfc71ff8d10`.
- Obsolete sdist SHA-256:
  `447f1e3c8ed08f70b7a8f0bcf191d660dcf14bf79eba638077b5798c2c749f51`.

The candidate identity is explicitly obsolete because later workflow,
isolation, and policy changes were not rebuilt into it. A final release tree
and publishable artifact hashes do not exist while Gate 2 is on hold.

## Remaining Qualification

Release review may resume only after all of the following are complete:

- Run the complete workflow on hosted GitHub Actions and retain required-check
  evidence for the exact candidate.
- Complete the current VS Code notebook visual, keyboard, and accessibility
  release checklist.
- Rebuild wheel, sdist, and wheelhouse from the final staged tree and rerun all
  source and artifact smokes.

## Gate Record

Performance and functional evidence support release review. Hosted-CI evidence
for the fixed workflow and the VS Code manual checklist are still incomplete.
Gate 2 therefore remains **HOLD**.
