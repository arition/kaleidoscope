# T13 Release Readiness

Assessment date: 2026-07-17

## Decision

**Gate 2: HOLD**

The product, benchmark, packaging, and local compatibility evidence is strong,
but the release pipeline does not yet provide a trustworthy boundary for code
from the candidate source tree. Hosted GitHub Actions has also not run in this
repository, and the final VS Code visual/accessibility checklist is incomplete.

No artifact in `dist/` is approved for publication.

## Blocking Findings

The independent source-security rereview returned `SOURCE SECURITY: BLOCK`:

1. `network_guard.c` is compiled from the same source snapshot it is intended
   to confine. A malicious revision can replace the guard before namespaces,
   environment scrubbing, runner-path masking, or seccomp are established.
2. Candidate files are uploaded after the guarded process exits.
   `actions/upload-artifact` follows symbolic links, so source-controlled build
   output can make an expected distribution path resolve to a host-only file.
3. The guard does not make the complete GitHub runner installation read-only.
   Source code may be able to replace the runner's built-in JavaScript action
   runtime before the subsequent upload action starts.
4. Build and verifier dependencies are pinned by version but are not locked by
   cryptographic hashes. Mutable third-party code runs before isolation.

The workflow now uses producer artifact IDs, independently checks the source
archive SHA-256 before extraction, and runs project build logic offline under
the guard. These are useful defense-in-depth controls, but they do not resolve
the trust origin of the guard or the post-guard upload boundary.

## Passing Evidence

- Guarded Python and packaging suite: 217 passed, 2 expected skips.
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

- Supply the isolation wrapper from an independently trusted, digest-pinned
  artifact or image rather than from the candidate source tree.
- Prevent candidate output from influencing later runner actions. The trusted
  wrapper must emit and validate regular, non-symlink publication files, and
  the runner installation/action runtime must be immutable to guarded code.
- Lock every pre-isolation Python and npm dependency by artifact hash or move it
  into the trusted release image.
- Run the complete workflow on hosted GitHub Actions and retain required-check
  evidence for the exact candidate.
- Complete the current VS Code notebook visual, keyboard, and accessibility
  release checklist.
- Rebuild wheel, sdist, and wheelhouse from the final staged tree, rerun all
  guarded source and artifact smokes, and obtain a new independent security
  approval.

## Gate Record

Performance and functional evidence support release review. Security custody,
hosted-CI evidence, and the VS Code manual checklist do not. Gate 2 therefore
remains **HOLD** without exception.