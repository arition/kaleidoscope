from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).parents[2]
CHECKER = ROOT / "tests" / "packaging" / "check_branch_coverage.py"
VITEST_CONFIG = ROOT / "vitest.config.ts"
TARGETS = (
    "src/kaleidoscope/cache.py",
    "src/kaleidoscope/protocol.py",
    "src/kaleidoscope/scheduler.py",
    "src/kaleidoscope/session.py",
    "src/kaleidoscope/widget.py",
)
FRONTEND_TARGETS = (
    "frontend/index.ts",
    "frontend/player.ts",
    "frontend/protocol.ts",
    "frontend/scheduler.ts",
)


def write_report(path: Path, percentages: dict[str, float]) -> None:
    path.write_text(
        json.dumps(
            {
                "files": {
                    name: {
                        "summary": {
                            "percent_branches_covered": percentage,
                        }
                    }
                    for name, percentage in percentages.items()
                }
            }
        )
    )


def run_checker(report: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(CHECKER), str(report)],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )


def test_branch_coverage_checker_accepts_every_target_at_ninety_percent(
    tmp_path: Path,
) -> None:
    report = tmp_path / "coverage.json"
    write_report(report, dict.fromkeys(TARGETS, 90.0))

    result = run_checker(report)

    assert result.returncode == 0, result.stderr
    assert "All 5 branch-coverage targets meet 90.00%." in result.stdout


def test_frontend_branch_coverage_policy_is_per_file_at_ninety_percent() -> None:
    config = VITEST_CONFIG.read_text(encoding="utf-8")

    for target in FRONTEND_TARGETS:
        assert config.count(f'"{target}"') == 1
    assert "branches: 90" in config
    assert "perFile: true" in config


def test_branch_coverage_checker_rejects_low_or_missing_targets(
    tmp_path: Path,
) -> None:
    report = tmp_path / "coverage.json"
    percentages = dict.fromkeys(TARGETS, 95.0)
    percentages[TARGETS[0]] = 89.99
    percentages.pop(TARGETS[-1])
    write_report(report, percentages)

    result = run_checker(report)

    assert result.returncode == 1
    assert f"{TARGETS[0]}: 89.99%" in result.stderr
    assert f"{TARGETS[-1]}: missing" in result.stderr


@pytest.mark.parametrize(
    "invalid_percentage",
    [float("nan"), float("inf"), float("-inf"), -0.01, 100.01],
)
def test_branch_coverage_checker_rejects_invalid_percentages(
    tmp_path: Path,
    invalid_percentage: float,
) -> None:
    report = tmp_path / "coverage.json"
    percentages = dict.fromkeys(TARGETS, 95.0)
    percentages[TARGETS[0]] = invalid_percentage
    write_report(report, percentages)

    result = run_checker(report)

    assert result.returncode == 1
    assert f"{TARGETS[0]}: missing" in result.stderr
