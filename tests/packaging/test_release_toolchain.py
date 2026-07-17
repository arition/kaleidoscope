from __future__ import annotations

import tomllib
from pathlib import Path

ROOT = Path(__file__).parents[2]


def test_release_toolchain_and_supported_python_versions_are_explicit() -> None:
    pyproject = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))

    assert pyproject["build-system"]["requires"] == ["hatchling==1.31.0"]
    classifiers = set(pyproject["project"]["classifiers"])
    assert "Programming Language :: Python :: 3.12" in classifiers
    assert "Programming Language :: Python :: 3.13" in classifiers

    test_dependencies = set(pyproject["tool"]["hatch"]["envs"]["test"]["dependencies"])
    assert "pytest>=9.0.3,<10" in test_dependencies
    assert "pytest-cov>=7,<8" in test_dependencies

    host_dependencies = set(pyproject["tool"]["hatch"]["envs"]["host"]["dependencies"])
    assert host_dependencies == {
        "ipykernel==7.3.0",
        "jupyterlab==4.6.1",
        "notebook==7.6.0",
    }

    workflow = (ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
    assert workflow.count('pip install "hatch==1.17.1"') == 3
    assert workflow.count('pip install "hatchling==1.31.0"') == 1
    assert workflow.count("-m hatchling build --directory") == 1
    assert '"$tools_dir/bin/hatch" build' not in workflow
    assert "hatch>=" not in workflow
