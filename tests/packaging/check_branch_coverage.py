from __future__ import annotations

import json
import math
import sys
from pathlib import Path
from typing import Any

MINIMUM_BRANCH_COVERAGE = 90.0
TARGETS = (
    "src/kaleidoscope/cache.py",
    "src/kaleidoscope/protocol.py",
    "src/kaleidoscope/scheduler.py",
    "src/kaleidoscope/session.py",
    "src/kaleidoscope/widget.py",
)


def branch_percentage(files: object, target: str) -> float | None:
    if not isinstance(files, dict):
        return None
    file_data = files.get(target)
    if not isinstance(file_data, dict):
        return None
    summary = file_data.get("summary")
    if not isinstance(summary, dict):
        return None
    percentage: Any = summary.get("percent_branches_covered")
    if isinstance(percentage, bool) or not isinstance(percentage, int | float):
        return None
    value = float(percentage)
    if not math.isfinite(value) or not 0 <= value <= 100:
        return None
    return value


def main() -> int:
    if len(sys.argv) != 2:
        raise SystemExit("usage: check_branch_coverage.py COVERAGE_JSON")
    report = json.loads(Path(sys.argv[1]).read_text())
    files = report.get("files") if isinstance(report, dict) else None
    failures: list[str] = []
    for target in TARGETS:
        percentage = branch_percentage(files, target)
        if percentage is None:
            failures.append(f"{target}: missing")
        elif percentage < MINIMUM_BRANCH_COVERAGE:
            failures.append(f"{target}: {percentage:.2f}%")
    if failures:
        print(
            f"Branch coverage must meet {MINIMUM_BRANCH_COVERAGE:.2f}% per target:",
            file=sys.stderr,
        )
        for failure in failures:
            print(f"- {failure}", file=sys.stderr)
        return 1
    print(
        f"All {len(TARGETS)} branch-coverage targets meet "
        f"{MINIMUM_BRANCH_COVERAGE:.2f}%.",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
