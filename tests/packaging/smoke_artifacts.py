from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import venv
from hashlib import sha256
from pathlib import Path

ROOT = Path(__file__).parents[2]
DIST = Path(os.environ.get("KALEIDOSCOPE_ARTIFACT_DIR", ROOT / "dist")).resolve()
WHEELHOUSE = DIST / "wheelhouse"
WHEEL_NAME = "vapoursynth_kaleidoscope-0.1.0-py3-none-any.whl"
SDIST_NAME = "vapoursynth_kaleidoscope-0.1.0.tar.gz"
MANIFEST_NAME = "manifest.json"
INSTALLED_SMOKE = Path(__file__).with_name("smoke_installed.py")
INSTALLED_NOTEBOOK_SMOKE = Path(__file__).with_name("smoke_installed_notebook.py")
INSTALLED_BROWSER_SMOKE = Path(__file__).with_name("smoke_installed_browser.py")
BROWSER_SMOKE = Path(__file__).with_name("smoke_installed_browser.mjs")
NETWORK_SMOKE = Path(__file__).with_name("smoke_network_blocked.py")
NETWORK_GUARD_SOURCE = Path(__file__).with_name("network_guard.c")
NETWORK_PROBE_SOURCE = Path(__file__).with_name("network_probe.c")
JAVASCRIPT = ROOT / "src/kaleidoscope/static/index.js"
STYLESHEET = ROOT / "src/kaleidoscope/static/index.css"
QUICKSTART = ROOT / "examples/quickstart.ipynb"


def artifact(name: str) -> Path:
    path = DIST / name
    if not path.is_file():
        raise RuntimeError(f"Expected artifact {path}")
    return path


def run(*command: str, cwd: Path, env: dict[str, str] | None = None) -> None:
    subprocess.run(command, cwd=cwd, env=env, check=True)


def pip_environment() -> dict[str, str]:
    environment = {
        key: value for key, value in os.environ.items() if not key.startswith("PIP_")
    }
    for variable in ("PYTHONHOME", "PYTHONPATH"):
        environment.pop(variable, None)
    environment.update(
        {
            "PIP_CONFIG_FILE": os.devnull,
            "PIP_DISABLE_PIP_VERSION_CHECK": "1",
            "PIP_NO_INDEX": "1",
            "HTTP_PROXY": "http://127.0.0.1:9",
            "HTTPS_PROXY": "http://127.0.0.1:9",
            "NO_PROXY": "",
        }
    )
    return environment


def environment_python(environment: Path) -> Path:
    scripts = "Scripts" if os.name == "nt" else "bin"
    executable = "python.exe" if os.name == "nt" else "python"
    return environment / scripts / executable


def file_hash(path: Path) -> str:
    return sha256(path.read_bytes()).hexdigest()


def require_network_guard() -> None:
    if os.environ.get("KALEIDOSCOPE_NETWORK_GUARD_ACTIVE") != "1":
        raise RuntimeError("Run artifact smoke through tests/packaging/network_guard.c")
    try:
        descriptor = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    except PermissionError:
        return
    descriptor.close()
    raise RuntimeError("Artifact smoke is not protected by the network guard")


def verify_wheelhouse(wheelhouse: Path, release_wheel: Path) -> None:
    if wheelhouse.is_symlink() or not wheelhouse.is_dir():
        raise RuntimeError(f"Expected wheelhouse directory at {wheelhouse}")
    manifest_path = wheelhouse / MANIFEST_NAME
    if manifest_path.is_symlink() or not manifest_path.is_file():
        raise RuntimeError(f"Expected wheelhouse manifest at {manifest_path}")
    try:
        manifest = json.loads(manifest_path.read_text())
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError("Wheelhouse manifest is unreadable") from error
    if set(manifest) != {"algorithm", "files"} or manifest["algorithm"] != "sha256":
        raise RuntimeError("Wheelhouse manifest schema is invalid")
    files = manifest["files"]
    if not isinstance(files, dict) or not files:
        raise RuntimeError("Wheelhouse manifest has no files")
    expected_names = set(files)
    actual_names = {entry.name for entry in wheelhouse.iterdir()}
    if actual_names != expected_names | {MANIFEST_NAME}:
        raise RuntimeError("Wheelhouse contents do not match the manifest")
    for name, expected_hash in files.items():
        path = wheelhouse / name
        if (
            not isinstance(name, str)
            or Path(name).name != name
            or not name.endswith(".whl")
            or not isinstance(expected_hash, str)
            or len(expected_hash) != 64
            or path.is_symlink()
            or not path.is_file()
        ):
            raise RuntimeError(f"Invalid wheelhouse entry {name!r}")
        if file_hash(path) != expected_hash:
            raise RuntimeError(f"Wheelhouse hash mismatch for {name}")
    copied_wheel = wheelhouse / WHEEL_NAME
    if not copied_wheel.is_file() or file_hash(copied_wheel) != file_hash(
        release_wheel
    ):
        raise RuntimeError(
            "Wheelhouse package wheel does not match the release artifact"
        )


def install_network_guard(environment: Path) -> tuple[Path, Path, Path]:
    if not sys.platform.startswith("linux"):
        raise RuntimeError("The artifact network guard currently requires Linux.")
    guard_directory = environment / "network-guard"
    guard_directory.mkdir(parents=True, exist_ok=True)
    guard = guard_directory / "network_guard"
    dynamic_probe = guard_directory / "network_probe"
    static_probe = guard_directory / "network_probe_static"
    run(
        "cc",
        "-O2",
        "-o",
        str(guard),
        str(NETWORK_GUARD_SOURCE),
        cwd=ROOT,
    )
    run(
        "cc",
        "-O2",
        "-o",
        str(dynamic_probe),
        str(NETWORK_PROBE_SOURCE),
        cwd=ROOT,
    )
    run(
        "cc",
        "-static",
        "-O2",
        "-o",
        str(static_probe),
        str(NETWORK_PROBE_SOURCE),
        cwd=ROOT,
    )
    return guard, dynamic_probe, static_probe


def run_guarded(
    guard: Path,
    *command: str,
    cwd: Path,
    env: dict[str, str] | None = None,
) -> None:
    run(str(guard), *command, cwd=cwd, env=env)


def install_and_smoke(
    artifact: Path,
    environment: Path,
    wheelhouse: Path,
    cwd: Path,
) -> None:
    try:
        venv.EnvBuilder(with_pip=True).create(environment)
        python = environment_python(environment)
        offline_environment = pip_environment()
        network_guard, dynamic_probe, static_probe = install_network_guard(environment)
        run_guarded(
            network_guard,
            str(python),
            str(NETWORK_SMOKE),
            str(dynamic_probe),
            str(static_probe),
            cwd=cwd,
            env=offline_environment,
        )
        run_guarded(
            network_guard,
            str(python),
            "-m",
            "pip",
            "--isolated",
            "install",
            "--no-cache-dir",
            "--no-index",
            "--find-links",
            str(wheelhouse),
            "ipykernel>=7,<8",
            "nbclient>=0.10,<0.11",
            "nbformat>=5.10,<6",
            str(artifact),
            cwd=cwd,
            env=offline_environment,
        )
        browser_output = cwd / f"{environment.name}-browser"
        run_guarded(
            network_guard,
            str(python),
            str(INSTALLED_NOTEBOOK_SMOKE),
            str(environment),
            str(browser_output),
            cwd=cwd,
            env=offline_environment,
        )
        run_guarded(
            network_guard,
            str(python),
            str(INSTALLED_BROWSER_SMOKE),
            str(environment),
            str(browser_output),
            cwd=cwd,
            env=offline_environment,
        )
        run_guarded(
            network_guard,
            "node",
            str(BROWSER_SMOKE),
            str(browser_output),
            cwd=ROOT,
            env=offline_environment,
        )
        run_guarded(
            network_guard,
            str(python),
            str(INSTALLED_SMOKE),
            str(environment),
            file_hash(JAVASCRIPT),
            file_hash(STYLESHEET),
            file_hash(QUICKSTART),
            cwd=cwd,
            env=offline_environment,
        )
    finally:
        shutil.rmtree(environment, ignore_errors=True)


def main() -> None:
    require_network_guard()
    wheel = artifact(WHEEL_NAME)
    sdist = artifact(SDIST_NAME)
    verify_wheelhouse(WHEELHOUSE, wheel)
    with tempfile.TemporaryDirectory(prefix="kaleidoscope-artifacts-") as temporary:
        root = Path(temporary)
        install_and_smoke(wheel, root / "wheel-environment", WHEELHOUSE, root)
        install_and_smoke(sdist, root / "sdist-environment", WHEELHOUSE, root)


def run_main() -> None:
    main()


if __name__ == "__main__":
    run_main()
