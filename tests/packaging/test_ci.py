from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).parents[2]
WORKFLOW = ROOT / ".github" / "workflows" / "ci.yml"
QUALITY_JOBS = {"python", "frontend", "browser", "hosts"}
SOURCE_SNAPSHOT_JOB = "source-snapshot"
ARTIFACT_BUILD_JOB = "artifact-build"
ARTIFACT_VERIFY_JOB = "artifact-verify"


def load_workflow() -> dict[str, Any]:
    workflow = yaml.load(WORKFLOW.read_text(), Loader=yaml.BaseLoader)
    assert isinstance(workflow, dict)
    return workflow


def job_steps(job: dict[str, Any]) -> list[dict[str, Any]]:
    steps = job.get("steps")
    assert isinstance(steps, list)
    assert all(isinstance(step, dict) for step in steps)
    return steps


def assert_blocking_command(job: dict[str, Any], command: str) -> None:
    matches = [step for step in job_steps(job) if step.get("run") == command]
    assert len(matches) == 1
    step = matches[0]
    assert "continue-on-error" not in step
    assert "if" not in step


def assert_hardened_checkouts(
    job: dict[str, Any],
    *,
    required: bool = True,
) -> None:
    checkouts = [step for step in job_steps(job) if str(step.get("uses", "")).startswith("actions/checkout@")]
    assert len(checkouts) == int(required)
    if not required:
        return
    checkout = checkouts[0]
    assert checkout["uses"].removeprefix("actions/checkout@").isalnum()
    assert len(checkout["uses"].rsplit("@", 1)[1]) == 40
    assert checkout.get("with", {}).get("persist-credentials") == "false"


def assert_actions_are_pinned(job: dict[str, Any]) -> None:
    for step in job_steps(job):
        action = step.get("uses")
        if not isinstance(action, str):
            continue
        revision = action.rsplit("@", 1)[-1]
        assert len(revision) == 40
        assert all(character in "0123456789abcdef" for character in revision)


def action_name(step: dict[str, Any]) -> str | None:
    action = step.get("uses")
    if not isinstance(action, str):
        return None
    return action.split("@", 1)[0]


def active_shell_lines(command: str) -> list[str]:
    return [line.strip() for line in command.splitlines() if line.strip() and not line.lstrip().startswith("#")]


def test_ci_workflow_enforces_the_release_quality_gates() -> None:
    workflow = load_workflow()

    triggers = workflow["on"]
    assert isinstance(triggers, dict)
    assert {"push", "pull_request", "workflow_dispatch"} <= set(triggers)
    assert workflow["permissions"] == {"contents": "read"}

    jobs = workflow["jobs"]
    assert isinstance(jobs, dict)
    assert {
        "python",
        "frontend",
        "browser",
        "hosts",
        SOURCE_SNAPSHOT_JOB,
        ARTIFACT_BUILD_JOB,
        ARTIFACT_VERIFY_JOB,
        "artifacts",
    } <= set(jobs)

    python_job = jobs["python"]
    assert isinstance(python_job, dict)
    versions = python_job["strategy"]["matrix"]["python-version"]
    assert set(versions) == {"3.12", "3.13"}
    assert_blocking_command(python_job, "hatch run lint:check")
    assert_blocking_command(python_job, "hatch run types:check")
    assert_blocking_command(python_job, "hatch run test:pytest tests/python")
    assert_blocking_command(python_job, "hatch run test:coverage")

    frontend_job = jobs["frontend"]
    assert isinstance(frontend_job, dict)
    assert_blocking_command(frontend_job, "npm ci")
    assert_blocking_command(frontend_job, "npm run lint")
    assert_blocking_command(frontend_job, "npm run fmt:check")
    assert_blocking_command(frontend_job, "npm test -- --run")
    assert_blocking_command(frontend_job, "npm run test:coverage")
    assert_blocking_command(frontend_job, "npm run build")
    assert_blocking_command(frontend_job, "git diff --exit-code -- src/kaleidoscope/static")

    browser_job = jobs["browser"]
    assert isinstance(browser_job, dict)
    browsers = browser_job["strategy"]["matrix"]["browser"]
    assert set(browsers) == {"chromium", "firefox"}
    assert_blocking_command(browser_job, "npx playwright install --with-deps ${{ matrix.browser }}")
    assert_blocking_command(browser_job, "npm run test:e2e -- --project=${{ matrix.browser }}")
    browser_uploads = [
        step for step in job_steps(browser_job) if str(step.get("uses", "")).startswith("actions/upload-artifact@")
    ]
    assert len(browser_uploads) == 1
    assert browser_uploads[0].get("if") == "failure()"
    assert browser_uploads[0]["with"]["path"] == "test-results/"
    assert browser_uploads[0]["with"]["if-no-files-found"] == "warn"

    hosts_job = jobs["hosts"]
    assert isinstance(hosts_job, dict)
    hosts = hosts_job["strategy"]["matrix"]["host"]
    assert set(hosts) == {"jupyterlab", "notebook"}
    assert_blocking_command(hosts_job, "hatch run host:smoke -- ${{ matrix.host }}")

    source_snapshot_job = jobs[SOURCE_SNAPSHOT_JOB]
    assert isinstance(source_snapshot_job, dict)
    assert source_snapshot_job["runs-on"] == "ubuntu-24.04"
    assert set(source_snapshot_job["needs"]) == QUALITY_JOBS
    assert source_snapshot_job["outputs"] == {
        "artifact-id": "${{ steps.upload-source.outputs.artifact-id }}",
        "sha256": "${{ steps.create-source.outputs.sha256 }}",
    }
    source_snapshot_steps = job_steps(source_snapshot_job)
    assert [action_name(step) for step in source_snapshot_steps] == [
        "actions/checkout",
        None,
        "actions/upload-artifact",
    ]
    source_snapshot_commands = [step["run"] for step in source_snapshot_steps if "run" in step]
    assert len(source_snapshot_commands) == 1
    source_snapshot_command = source_snapshot_commands[0]
    source_snapshot_lines = active_shell_lines(source_snapshot_command)
    assert any(line.startswith("git archive ") for line in source_snapshot_lines)
    assert any("sha256sum" in line for line in source_snapshot_lines)
    assert any(line.endswith('>> "$GITHUB_OUTPUT"') for line in source_snapshot_lines)
    assert source_snapshot_steps[1]["id"] == "create-source"
    snapshot_uploads = [
        step for step in source_snapshot_steps if str(step.get("uses", "")).startswith("actions/upload-artifact@")
    ]
    assert len(snapshot_uploads) == 1
    assert snapshot_uploads[0]["id"] == "upload-source"
    assert snapshot_uploads[0]["with"] == {
        "name": "release-source",
        "path": "dist/release-source/source.tar.gz",
        "if-no-files-found": "error",
    }

    artifact_build_job = jobs[ARTIFACT_BUILD_JOB]
    assert isinstance(artifact_build_job, dict)
    assert artifact_build_job["runs-on"] == "ubuntu-24.04"
    assert artifact_build_job["needs"] == SOURCE_SNAPSHOT_JOB
    assert artifact_build_job["outputs"] == {
        "artifact-id": "${{ steps.upload-candidate.outputs.artifact-id }}",
    }
    artifact_build_steps = job_steps(artifact_build_job)
    assert [action_name(step) for step in artifact_build_steps] == [
        None,
        "actions/download-artifact",
        None,
        "actions/upload-artifact",
    ]
    artifact_build_commands = [step["run"] for step in artifact_build_steps if "run" in step]
    assert all("test:pytest" not in command for command in artifact_build_commands)
    build_command = artifact_build_commands[-1]
    assert "python3 -m venv" in build_command
    assert 'pip install "hatchling==1.31.0"' in build_command
    assert '"$tools_dir/bin/python" -m pip download' in build_command
    assert "KALEIDOSCOPE_WHEELHOUSE_SOURCE" in build_command
    assert "tests/packaging/network_guard.c" not in build_command
    assert "release_guard" not in build_command
    build_lines = active_shell_lines(build_command)
    assert sum(line.startswith("env -i") for line in build_lines) == 2
    assert 'build_path="$tools_dir/bin:/usr/local/bin:/usr/bin:/bin"' in build_lines
    assert build_lines.count('HOME="$build_home" \\') == 2
    assert build_lines.count('PATH="$build_path" \\') == 2
    assert build_lines.count('TMPDIR="$build_home/tmp" \\') == 2
    assert build_lines.count("PYTHONNOUSERSITE=1 \\") == 2
    assert build_lines.count("PIP_CONFIG_FILE=/dev/null \\") == 2
    assert build_lines.count("PIP_NO_INDEX=1 \\") == 2
    assert '"$tools_dir/bin/python" -m hatchling build --directory "$release_dir"' in build_command
    assert '"$tools_dir/bin/python" tests/packaging/prepare_wheelhouse.py' in build_command
    assert "exec env" not in build_command
    assert '"$tools_dir/bin/hatch"' not in build_command
    assert "test:prepare-wheelhouse" not in build_command
    build_digest_line = next(index for index, line in enumerate(build_lines) if "sha256sum -c -" in line)
    build_extract_line = next(index for index, line in enumerate(build_lines) if line.startswith("tar -xzf "))
    build_download_line = next(index for index, line in enumerate(build_lines) if " -m pip download" in line)
    build_artifact_line = next(index for index, line in enumerate(build_lines) if " -m hatchling build" in line)
    assert build_digest_line < build_extract_line
    assert build_download_line < build_artifact_line
    build_downloads = [step for step in artifact_build_steps if action_name(step) == "actions/download-artifact"]
    assert len(build_downloads) == 1
    assert build_downloads[0]["with"] == {
        "artifact-ids": "${{ needs.source-snapshot.outputs.artifact-id }}",
        "path": "dist/release-source",
        "merge-multiple": "true",
    }
    build_uploads = [step for step in artifact_build_steps if action_name(step) == "actions/upload-artifact"]
    assert len(build_uploads) == 1
    assert build_uploads[0]["id"] == "upload-candidate"
    assert build_uploads[0]["with"] == {
        "name": "release-candidate",
        "path": "dist/release-candidate/",
        "if-no-files-found": "error",
    }

    artifact_verify_job = jobs[ARTIFACT_VERIFY_JOB]
    assert isinstance(artifact_verify_job, dict)
    assert artifact_verify_job["runs-on"] == "ubuntu-24.04"
    assert set(artifact_verify_job["needs"]) == {
        SOURCE_SNAPSHOT_JOB,
        ARTIFACT_BUILD_JOB,
    }
    verify_steps = job_steps(artifact_verify_job)
    assert [action_name(step) for step in verify_steps] == [
        None,
        "actions/download-artifact",
        "actions/download-artifact",
        "actions/setup-node",
        None,
    ]
    verify_downloads = [
        step for step in verify_steps if str(step.get("uses", "")).startswith("actions/download-artifact@")
    ]
    assert len(verify_downloads) == 2
    assert {tuple(sorted(download["with"].items())) for download in verify_downloads} == {
        (
            ("artifact-ids", "${{ needs.artifact-build.outputs.artifact-id }}"),
            ("merge-multiple", "true"),
            ("path", "dist/release-candidate"),
        ),
        (
            ("artifact-ids", "${{ needs.source-snapshot.outputs.artifact-id }}"),
            ("merge-multiple", "true"),
            ("path", "dist/release-source"),
        ),
    }
    setup_nodes = [step for step in verify_steps if action_name(step) == "actions/setup-node"]
    assert len(setup_nodes) == 1
    assert setup_nodes[0]["with"] == {"node-version": "22"}
    assert verify_steps[0]["run"] == (
        "test ! -e dist/release-candidate && test ! -L dist/release-candidate\n"
        "test ! -e dist/release-source && test ! -L dist/release-source\n"
    )
    artifact_verify_commands = [step["run"] for step in verify_steps if "run" in step]
    assert all("tests/packaging/network_guard.c" not in command for command in artifact_verify_commands)
    assert all("release_guard" not in command for command in artifact_verify_commands)
    assert any(
        '"$tools_dir/bin/python" -m pytest tests/python tests/packaging' in command
        and '"$tools_dir/bin/python" tests/packaging/smoke_artifacts.py' in command
        for command in artifact_verify_commands
    )
    verify_command = verify_steps[-1]["run"]
    assert verify_steps[-1]["name"] == "Prepare verifier and check offline installs"
    verify_lines = active_shell_lines(verify_command)
    verify_digest_line = next(index for index, line in enumerate(verify_lines) if "sha256sum -c -" in line)
    verify_extract_line = next(index for index, line in enumerate(verify_lines) if line.startswith("tar -xzf "))
    assert verify_digest_line < verify_extract_line
    assert sum(line.startswith("env -i") for line in verify_lines) == 4
    assert 'node_command="$(command -v node)"' in verify_lines
    assert 'npm_command="$(command -v npm)"' in verify_lines
    assert '"$RUNNER_TOOL_CACHE"/node/*/x64/bin/node) ;;' in verify_lines
    assert '"$RUNNER_TOOL_CACHE"/node/*/x64/bin/npm) ;;' in verify_lines
    assert 'node_bin="$(dirname "$node_command")"' in verify_lines
    assert 'test "$node_bin" = "$(dirname "$npm_command")"' in verify_lines
    assert 'setup_path="$node_bin:/usr/bin:/bin"' in verify_lines
    assert 'verify_path="$tools_dir/bin:$node_bin:/usr/bin:/bin"' in verify_lines
    assert verify_lines.count('HOME="$setup_home" \\') == 2
    assert verify_lines.count('PATH="$setup_path" \\') == 2
    assert verify_lines.count('TMPDIR="$setup_home/tmp" \\') == 2
    assert verify_lines.count('HOME="$verify_home" \\') == 2
    assert verify_lines.count('PATH="$verify_path" \\') == 2
    assert verify_lines.count('TMPDIR="$verify_home/tmp" \\') == 2
    assert verify_lines.count("PYTHONNOUSERSITE=1 \\") == 2
    assert verify_lines.count("PIP_CONFIG_FILE=/dev/null \\") == 2
    assert verify_lines.count("PIP_NO_INDEX=1 \\") == 2
    assert verify_lines.count("npm_config_offline=true \\") == 2
    assert '"$npm_command" ci \\' in verify_lines
    assert verify_lines.count('PLAYWRIGHT_BROWSERS_PATH="$playwright_browsers" \\') == 1
    assert "python3 -m venv" in verify_command
    tool_install_start = next(
        index for index, line in enumerate(verify_lines) if '"$tools_dir/bin/python" -m pip install' in line
    )
    tool_install_end = next(
        index
        for index, line in enumerate(verify_lines[tool_install_start + 1 :], tool_install_start + 1)
        if line.startswith("mkdir -p")
    )
    assert all('"$source_dir"' not in line for line in verify_lines[tool_install_start:tool_install_end])
    assert '"$npm_command" ci' in verify_command
    assert 'cp "$source_dir/package.json" "$source_dir/package-lock.json"' in verify_command
    assert "--ignore-scripts" in verify_command
    assert '--cache "$npm_cache"' in verify_command
    assert '--prefix "$frontend_tools"' in verify_command
    assert 'PLAYWRIGHT_BROWSERS_PATH="$playwright_browsers"' in verify_command
    assert "install --with-deps chromium" in verify_command
    assert 'KALEIDOSCOPE_NPM_CACHE="$npm_cache"' in verify_command
    assert 'KALEIDOSCOPE_PLAYWRIGHT_BROWSERS_PATH="$playwright_browsers"' in verify_command
    assert 'ln -s "$frontend_tools/node_modules" "$source_dir/node_modules"' in verify_command
    assert all("hatch build" not in command for command in artifact_verify_commands)
    assert all("test:prepare-wheelhouse" not in command for command in artifact_verify_commands)
    assert "run" in verify_steps[-1]
    assert "smoke_artifacts.py" in verify_command
    assert not any(str(step.get("uses", "")).startswith("actions/upload-artifact@") for step in verify_steps)
    assert not any(action_name(step) in {"actions/checkout", "actions/setup-python"} for step in verify_steps)

    artifact_job = jobs["artifacts"]
    assert isinstance(artifact_job, dict)
    assert artifact_job["runs-on"] == "ubuntu-24.04"
    assert set(artifact_job["needs"]) == {
        ARTIFACT_BUILD_JOB,
        ARTIFACT_VERIFY_JOB,
    }
    artifact_steps = job_steps(artifact_job)
    assert all("run" not in step for step in artifact_steps)
    assert [action_name(step) for step in artifact_steps] == [
        "actions/download-artifact",
        "actions/upload-artifact",
    ]
    downloads = [step for step in artifact_steps if str(step.get("uses", "")).startswith("actions/download-artifact@")]
    assert len(downloads) == 1
    assert downloads[0]["with"] == {
        "artifact-ids": "${{ needs.artifact-build.outputs.artifact-id }}",
        "path": "dist/release-candidate",
        "merge-multiple": "true",
    }
    uploads = [step for step in artifact_steps if str(step.get("uses", "")).startswith("actions/upload-artifact@")]
    assert len(uploads) == 1
    assert uploads[0]["with"]["name"] == "distributions"

    for name, job in jobs.items():
        assert isinstance(job, dict)
        assert "continue-on-error" not in job
        assert "if" not in job
        assert_hardened_checkouts(
            job,
            required=name not in {ARTIFACT_BUILD_JOB, ARTIFACT_VERIFY_JOB, "artifacts"},
        )
        assert_actions_are_pinned(job)
        for step in job_steps(job):
            if "run" in step:
                assert "continue-on-error" not in step
