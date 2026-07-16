from __future__ import annotations

import importlib.util
import json
import os
import re
import shutil
import stat
import subprocess
import tarfile
import tempfile
import zipfile
from base64 import urlsafe_b64decode
from csv import reader
from email.parser import Parser
from hashlib import sha256
from io import StringIO
from pathlib import Path

import pytest

ROOT = Path(__file__).parents[2]
DIST = Path(os.environ.get("KALEIDOSCOPE_ARTIFACT_DIR", ROOT / "dist")).resolve()
PACKAGING = Path(__file__).parent
EXPECTED_DISTRIBUTION = "vapoursynth-kaleidoscope"
EXPECTED_VERSION = "0.1.0"
WHEEL_NAME = "vapoursynth_kaleidoscope-0.1.0-py3-none-any.whl"
SDIST_NAME = "vapoursynth_kaleidoscope-0.1.0.tar.gz"
DIST_INFO = "vapoursynth_kaleidoscope-0.1.0.dist-info"
SDIST_ROOT = "vapoursynth_kaleidoscope-0.1.0"
EXPECTED_REQUIREMENTS = {
    "anywidget<0.12,>=0.11",
    "numpy<3,>=2.4",
    "pillow<13,>=12.1",
    "traitlets<6,>=5.15",
    "vapoursynth<78,>=77",
}
PACKAGE_FILE_NAMES = {
    "kaleidoscope/__init__.py",
    "kaleidoscope/api.py",
    "kaleidoscope/cache.py",
    "kaleidoscope/encoding.py",
    "kaleidoscope/frame_adapter.py",
    "kaleidoscope/protocol.py",
    "kaleidoscope/py.typed",
    "kaleidoscope/scheduler.py",
    "kaleidoscope/session.py",
    "kaleidoscope/sources.py",
    "kaleidoscope/static/index.css",
    "kaleidoscope/static/index.js",
    "kaleidoscope/widget.py",
}
DOC_FILE_NAMES = {
    "docs/architecture.md",
    "docs/installation.md",
    "docs/troubleshooting.md",
    "docs/usage.md",
}
PACKAGE_FILES = {name: ROOT / "src" / name for name in PACKAGE_FILE_NAMES}
WHEEL_SOURCE_FILES = {
    **PACKAGE_FILES,
    "kaleidoscope/examples/quickstart.ipynb": ROOT / "examples/quickstart.ipynb",
}
SDIST_SOURCE_FILES = {
    "LICENSE": ROOT / "LICENSE",
    "README.md": ROOT / "README.md",
    "hatch_build.py": ROOT / "hatch_build.py",
    "pyproject.toml": ROOT / "pyproject.toml",
    "examples/quickstart.ipynb": ROOT / "examples/quickstart.ipynb",
    "tasks/benchmark-report.md": ROOT / "tasks/benchmark-report.md",
    **{name: ROOT / name for name in DOC_FILE_NAMES},
    **{f"src/{name}": path for name, path in PACKAGE_FILES.items()},
}

assert all(path.is_file() and not path.is_symlink() for path in PACKAGE_FILES.values())
assert all(
    path.is_file() and not path.is_symlink() for path in SDIST_SOURCE_FILES.values()
)


def artifact(name: str) -> Path:
    path = DIST / name
    assert path.is_file(), f"Expected artifact {path}"
    return path


def test_release_directory_contains_only_expected_entries() -> None:
    entries = {path.name: path for path in DIST.iterdir()}
    assert set(entries) == {WHEEL_NAME, SDIST_NAME, "wheelhouse"}
    assert all(not path.is_symlink() for path in entries.values())
    assert entries[WHEEL_NAME].is_file()
    assert entries[SDIST_NAME].is_file()
    assert entries["wheelhouse"].is_dir()

    load_artifact_smoke_module().verify_wheelhouse(
        entries["wheelhouse"],
        entries[WHEEL_NAME],
    )


def load_artifact_smoke_module():
    spec = importlib.util.spec_from_file_location(
        "kaleidoscope_artifact_smoke",
        PACKAGING / "smoke_artifacts.py",
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_ipc_kernel_launcher_module():
    spec = importlib.util.spec_from_file_location(
        "kaleidoscope_ipc_kernel_launcher",
        PACKAGING / "ipc_kernel_launcher.py",
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_wheelhouse_module():
    spec = importlib.util.spec_from_file_location(
        "kaleidoscope_prepare_wheelhouse",
        PACKAGING / "prepare_wheelhouse.py",
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def assert_release_metadata(metadata: str) -> None:
    parsed_metadata = Parser().parsestr(metadata)

    assert parsed_metadata["Name"] == EXPECTED_DISTRIBUTION
    assert parsed_metadata["Version"] == EXPECTED_VERSION
    assert parsed_metadata["Requires-Python"] == ">=3.12"
    assert parsed_metadata["License-Expression"] == "MIT"
    assert parsed_metadata["License-File"] == "LICENSE"
    assert parsed_metadata["Description-Content-Type"] == "text/markdown"
    requirements = {
        requirement.lower()
        for requirement in parsed_metadata.get_all("Requires-Dist", [])
    }
    assert requirements == EXPECTED_REQUIREMENTS
    description = parsed_metadata.get_payload()
    assert not re.search(r"\[[^\]]+\]\((?!https?://|mailto:|#)[^)]+\)", description)


def test_wheel_contains_release_files_and_exact_source_assets() -> None:
    wheel = artifact(WHEEL_NAME)
    with zipfile.ZipFile(wheel) as archive:
        members = archive.infolist()
        assert all(
            member.create_system == 3
            and not member.is_dir()
            and stat.S_IFMT(member.external_attr >> 16) in {0, stat.S_IFREG}
            for member in members
        )
        member_names = [member.filename for member in members]
        assert len(member_names) == len(set(member_names))
        names = set(member_names)
        metadata_name = f"{DIST_INFO}/METADATA"
        metadata = archive.read(metadata_name).decode()
        expected_names = set(WHEEL_SOURCE_FILES) | {
            metadata_name,
            f"{DIST_INFO}/RECORD",
            f"{DIST_INFO}/WHEEL",
            f"{DIST_INFO}/licenses/LICENSE",
        }
        assert names == expected_names
        for name, source in WHEEL_SOURCE_FILES.items():
            assert archive.read(name) == source.read_bytes(), name
        assert (
            archive.read(f"{DIST_INFO}/licenses/LICENSE")
            == (ROOT / "LICENSE").read_bytes()
        )
        records = list(reader(StringIO(archive.read(f"{DIST_INFO}/RECORD").decode())))
        record_names = [row[0] for row in records]
        assert len(record_names) == len(set(record_names))
        assert set(record_names) == names
        for name, digest, size in records:
            if name == f"{DIST_INFO}/RECORD":
                assert digest == ""
                assert size == ""
                continue
            algorithm, encoded_digest = digest.split("=", 1)
            assert algorithm == "sha256"
            payload = archive.read(name)
            padding = "=" * (-len(encoded_digest) % 4)
            assert (
                urlsafe_b64decode(encoded_digest + padding) == sha256(payload).digest()
            )
            assert int(size) == len(payload)

    assert_release_metadata(metadata)
    assert (
        re.search(
            rb"https?://",
            (ROOT / "src/kaleidoscope/static/index.js").read_bytes()
            + (ROOT / "src/kaleidoscope/static/index.css").read_bytes(),
        )
        is None
    )


def test_sdist_is_offline_buildable_without_development_frontend_sources() -> None:
    sdist = artifact(SDIST_NAME)
    with tarfile.open(sdist) as archive:
        members = archive.getmembers()
        assert all(member.isfile() for member in members)
        member_names = [member.name for member in members]
        assert len(member_names) == len(set(member_names))
        names = set(member_names)
        roots = {name.split("/", 1)[0] for name in names}
        assert roots == {SDIST_ROOT}
        root = roots.pop()
        expected_names = {f"{root}/{name}" for name in SDIST_SOURCE_FILES} | {
            f"{root}/PKG-INFO"
        }
        assert names == expected_names
        for name, source in SDIST_SOURCE_FILES.items():
            archived = archive.extractfile(f"{root}/{name}")
            assert archived is not None
            assert archived.read() == source.read_bytes(), name
        pyproject_name = f"{root}/pyproject.toml"
        pyproject = archive.extractfile(pyproject_name)
        assert pyproject is not None
        build_configuration = pyproject.read().decode()
        metadata_file = archive.extractfile(f"{root}/PKG-INFO")
        assert metadata_file is not None
        metadata = metadata_file.read().decode()

    assert_release_metadata(metadata)
    assert "hatch-jupyter-builder" not in build_configuration
    assert "hatch_jupyter_builder" not in build_configuration
    assert "npm_builder" not in build_configuration


def test_frontend_assets_match_locked_source_build(tmp_path: Path) -> None:
    lockfile = json.loads((ROOT / "package-lock.json").read_text())
    declared_version = lockfile["packages"][""]["devDependencies"]["esbuild"]
    locked_version = lockfile["packages"]["node_modules/esbuild"]["version"]
    assert declared_version == locked_version == "0.28.1"

    npm = shutil.which("npm")
    assert npm is not None
    environment = {
        key: value
        for key, value in os.environ.items()
        if not key.lower().startswith("npm_config_")
        and key not in {"ESBUILD_BINARY_PATH", "NODE_OPTIONS", "NODE_PATH"}
    }
    with tempfile.TemporaryDirectory(
        prefix="kaleidoscope-frontend-toolchain-",
        dir=tmp_path,
    ) as temporary:
        toolchain = Path(temporary)
        for name in ("package.json", "package-lock.json"):
            shutil.copy2(ROOT / name, toolchain / name)
        subprocess.run(
            [
                npm,
                "ci",
                "--ignore-scripts",
                "--no-audit",
                "--no-fund",
                "--offline",
            ],
            cwd=toolchain,
            env=environment,
            check=True,
        )
        installed_package = json.loads(
            (toolchain / "node_modules/esbuild/package.json").read_text()
        )
        assert installed_package["version"] == locked_version
        executable = (toolchain / "node_modules/.bin/esbuild").resolve()
        assert executable.is_file() and executable.is_relative_to(toolchain)
        actual_version = subprocess.run(
            [str(executable), "--version"],
            cwd=toolchain,
            env=environment,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        assert actual_version == locked_version

        javascript = toolchain / "index.js"
        stylesheet = toolchain / "index.css"
        subprocess.run(
            [
                str(executable),
                "frontend/index.ts",
                "--bundle",
                "--format=esm",
                "--target=es2022",
                f"--outfile={javascript}",
            ],
            cwd=ROOT,
            env=environment,
            check=True,
        )
        subprocess.run(
            [
                str(executable),
                "frontend/styles.css",
                "--bundle",
                f"--outfile={stylesheet}",
            ],
            cwd=ROOT,
            env=environment,
            check=True,
        )

        assert (
            javascript.read_bytes()
            == (ROOT / "src/kaleidoscope/static/index.js").read_bytes()
        )
        assert (
            stylesheet.read_bytes()
            == (ROOT / "src/kaleidoscope/static/index.css").read_bytes()
        )


def test_artifact_smoke_uses_fresh_offline_install_environments() -> None:
    smoke = (PACKAGING / "smoke_artifacts.py").read_text()
    preparation = (PACKAGING / "prepare_wheelhouse.py").read_text()

    assert "venv.EnvBuilder" in smoke
    assert "def pip_environment(" in smoke
    assert 'key.startswith("PIP_")' in smoke
    assert '"PIP_CONFIG_FILE": os.devnull' in smoke
    assert '"--isolated"' in smoke
    assert '"--no-cache-dir"' in smoke
    assert '"--no-index"' in smoke
    assert '"--find-links"' in smoke
    assert '"--no-deps"' not in smoke
    assert '"--target"' not in smoke
    assert '"--no-build-isolation"' not in smoke
    assert '"download"' not in smoke
    assert "prepare_wheelhouse" not in smoke
    assert "smoke_installed_notebook.py" in smoke
    assert "smoke_installed_browser.py" in smoke
    assert "smoke_installed_browser.mjs" in smoke
    assert "SECCOMP_MODE_FILTER" in (PACKAGING / "network_guard.c").read_text()
    assert "run_guarded" in smoke
    assert "KALEIDOSCOPE_NETWORK_GUARD_ACTIVE" in smoke
    assert '"LD_PRELOAD"' not in smoke
    assert '"download"' in preparation
    test_source = (PACKAGING / "test_artifacts.py").read_text()
    assert '"--offline"' in test_source
    forbidden_npm_option = "--prefer" + "-offline"
    assert f'"{forbidden_npm_option}"' not in test_source


def test_ipc_kernel_launcher_disables_subprocess_iopub_bridge(monkeypatch) -> None:
    launcher = load_ipc_kernel_launcher_module()
    calls: list[tuple[object, bool, object]] = []
    result = object()

    def create_iopub_thread(
        socket: object,
        *,
        pipe: bool = False,
        session: object = False,
    ) -> object:
        calls.append((socket, pipe, session))
        return result

    monkeypatch.setattr(launcher, "IOPubThread", create_iopub_thread)

    socket = object()
    session = object()
    assert launcher.ipc_only_iopub_thread(socket, pipe=True, session=session) is result
    assert calls == [(socket, False, session)]
    with pytest.raises(RuntimeError, match="Expected ipykernel"):
        launcher.ipc_only_iopub_thread(socket, pipe=False, session=session)


def test_wheelhouse_preparation_atomically_replaces_all_contents(
    monkeypatch,
    tmp_path: Path,
) -> None:
    preparation = load_wheelhouse_module()
    wheelhouse = tmp_path / "wheelhouse"
    wheelhouse.mkdir()
    artifact = tmp_path / preparation.WHEEL_NAME
    artifact.write_bytes(b"current artifact")
    stale_copy = wheelhouse / preparation.WHEEL_NAME
    stale_copy.write_bytes(b"stale artifact")
    obsolete_wheel = wheelhouse / "obsolete-1.0-py3-none-any.whl"
    obsolete_wheel.write_bytes(b"obsolete")

    monkeypatch.setattr(preparation, "DIST", tmp_path)
    monkeypatch.setattr(preparation, "WHEELHOUSE", wheelhouse)
    exchange_calls: list[tuple[Path, Path]] = []

    def exchange_directories(fresh: Path, current: Path) -> None:
        assert current == wheelhouse
        assert stale_copy.read_bytes() == b"stale artifact"
        exchange_calls.append((fresh, current))
        exchanged = tmp_path / "exchanged-wheelhouse"
        os.replace(current, exchanged)
        os.replace(fresh, current)
        os.replace(exchanged, fresh)

    monkeypatch.setattr(preparation, "exchange_directories", exchange_directories)

    def create_fresh_download(command, **_kwargs) -> None:
        assert stale_copy.read_bytes() == b"stale artifact"
        assert obsolete_wheel.is_file()
        destination = Path(command[command.index("--dest") + 1])
        (destination / preparation.WHEEL_NAME).write_bytes(b"current artifact")
        (destination / "dependency-1.0-py3-none-any.whl").write_bytes(b"dependency")

    monkeypatch.setattr(preparation.subprocess, "run", create_fresh_download)

    preparation.main()

    manifest = json.loads((wheelhouse / preparation.MANIFEST_NAME).read_text())
    expected_files = {
        preparation.WHEEL_NAME: sha256(b"current artifact").hexdigest(),
        "dependency-1.0-py3-none-any.whl": sha256(b"dependency").hexdigest(),
    }
    assert manifest == {"algorithm": "sha256", "files": expected_files}
    assert len(exchange_calls) == 1
    assert {path.name for path in wheelhouse.iterdir()} == {
        preparation.MANIFEST_NAME,
        *expected_files,
    }


def test_wheelhouse_preparation_preserves_previous_contents_on_failure(
    monkeypatch,
    tmp_path: Path,
) -> None:
    preparation = load_wheelhouse_module()
    wheelhouse = tmp_path / "wheelhouse"
    wheelhouse.mkdir()
    stale_copy = wheelhouse / preparation.WHEEL_NAME
    stale_copy.write_bytes(b"stale artifact")
    artifact = tmp_path / preparation.WHEEL_NAME
    artifact.write_bytes(b"current artifact")

    monkeypatch.setattr(preparation, "DIST", tmp_path)
    monkeypatch.setattr(preparation, "WHEELHOUSE", wheelhouse)
    monkeypatch.setattr(
        preparation.subprocess,
        "run",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            subprocess.CalledProcessError(1, "pip download")
        ),
    )

    with pytest.raises(subprocess.CalledProcessError):
        preparation.main()

    assert stale_copy.read_bytes() == b"stale artifact"
    assert {path.name for path in tmp_path.iterdir()} == {
        "wheelhouse",
        preparation.WHEEL_NAME,
    }


def test_wheelhouse_preparation_reports_interrupted_publication(
    monkeypatch,
    tmp_path: Path,
) -> None:
    preparation = load_wheelhouse_module()
    recovery = tmp_path / ".wheelhouse-download-recovery"
    recovery.mkdir()
    artifact = tmp_path / preparation.WHEEL_NAME
    artifact.write_bytes(b"current artifact")

    monkeypatch.setattr(preparation, "DIST", tmp_path)
    monkeypatch.setattr(preparation, "WHEELHOUSE", tmp_path / "wheelhouse")

    with pytest.raises(RuntimeError, match="manual recovery"):
        preparation.main()

    assert recovery.is_dir()


def test_wheelhouse_first_publication_rejects_unsupported_host(
    monkeypatch,
    tmp_path: Path,
) -> None:
    preparation = load_wheelhouse_module()
    fresh_directory = tmp_path / "fresh-wheelhouse"
    fresh_directory.mkdir()

    monkeypatch.setattr(preparation, "DIST", tmp_path)
    monkeypatch.setattr(preparation, "WHEELHOUSE", tmp_path / "wheelhouse")
    monkeypatch.setattr(preparation.sys, "platform", "darwin")

    with pytest.raises(RuntimeError, match="Linux renameat2"):
        preparation.replace_wheelhouse(fresh_directory)

    assert fresh_directory.is_dir()
    assert not preparation.WHEELHOUSE.exists()


def test_wheelhouse_publication_restores_previous_contents_on_sync_failure(
    monkeypatch,
    tmp_path: Path,
) -> None:
    preparation = load_wheelhouse_module()
    wheelhouse = tmp_path / "wheelhouse"
    wheelhouse.mkdir()
    stale_copy = wheelhouse / preparation.WHEEL_NAME
    stale_copy.write_bytes(b"stale artifact")
    fresh_directory = tmp_path / "fresh-wheelhouse"
    fresh_directory.mkdir()
    fresh_copy = fresh_directory / preparation.WHEEL_NAME
    fresh_copy.write_bytes(b"current artifact")
    exchanges: list[tuple[Path, Path]] = []

    monkeypatch.setattr(preparation, "DIST", tmp_path)
    monkeypatch.setattr(preparation, "WHEELHOUSE", wheelhouse)

    def exchange_directories(left: Path, right: Path) -> None:
        exchanges.append((left, right))
        temporary = tmp_path / "exchange-temporary"
        os.replace(left, temporary)
        os.replace(right, left)
        os.replace(temporary, right)

    sync_calls = 0

    def sync_directory(_directory: Path) -> None:
        nonlocal sync_calls
        sync_calls += 1
        if sync_calls == 1:
            raise OSError("simulated publication sync failure")

    monkeypatch.setattr(preparation, "exchange_directories", exchange_directories)
    monkeypatch.setattr(preparation, "sync_directory", sync_directory)

    with pytest.raises(OSError, match="simulated publication sync failure"):
        preparation.replace_wheelhouse(fresh_directory)

    assert exchanges == [
        (fresh_directory, wheelhouse),
        (fresh_directory, wheelhouse),
    ]
    assert stale_copy.read_bytes() == b"stale artifact"
    assert not fresh_directory.exists()


def test_wheelhouse_publication_reports_unsupported_exchange(
    monkeypatch,
    tmp_path: Path,
) -> None:
    preparation = load_wheelhouse_module()

    class FakeRenameAt2:
        argtypes: list[object]
        restype: object

        def __call__(self, *_args) -> int:
            return -1

    class FakeLibrary:
        renameat2 = FakeRenameAt2()

    monkeypatch.setattr(
        preparation.ctypes,
        "CDLL",
        lambda *_args, **_kwargs: FakeLibrary(),
    )
    monkeypatch.setattr(
        preparation.ctypes,
        "get_errno",
        lambda: preparation.errno.ENOSYS,
    )

    with pytest.raises(
        RuntimeError,
        match=r"renameat2\(RENAME_EXCHANGE\).*required",
    ):
        preparation.exchange_directories(
            tmp_path / "fresh-wheelhouse",
            tmp_path / "wheelhouse",
        )


def test_artifact_smoke_rejects_tampered_wheelhouse(
    tmp_path: Path,
) -> None:
    smoke = load_artifact_smoke_module()
    wheel = tmp_path / smoke.WHEEL_NAME
    wheel.write_bytes(b"release wheel")
    wheelhouse = tmp_path / "wheelhouse"
    wheelhouse.mkdir()
    copied_wheel = wheelhouse / smoke.WHEEL_NAME
    copied_wheel.write_bytes(wheel.read_bytes())
    dependency = wheelhouse / "dependency-1.0-py3-none-any.whl"
    dependency.write_bytes(b"dependency")
    manifest = {
        "algorithm": "sha256",
        "files": {
            copied_wheel.name: sha256(copied_wheel.read_bytes()).hexdigest(),
            dependency.name: sha256(dependency.read_bytes()).hexdigest(),
        },
    }
    (wheelhouse / smoke.MANIFEST_NAME).write_text(json.dumps(manifest))

    smoke.verify_wheelhouse(wheelhouse, wheel)
    dependency.write_bytes(b"tampered")

    with pytest.raises(RuntimeError, match="hash mismatch"):
        smoke.verify_wheelhouse(wheelhouse, wheel)


def test_artifact_smoke_discards_failed_install_environment(
    monkeypatch,
    tmp_path: Path,
) -> None:
    smoke = load_artifact_smoke_module()
    environment = tmp_path / "environment"

    class FakeBuilder:
        def create(self, path: Path) -> None:
            path.mkdir()

    monkeypatch.setattr(smoke.venv, "EnvBuilder", lambda **_kwargs: FakeBuilder())
    monkeypatch.setattr(
        smoke,
        "run",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("failed")),
    )

    try:
        smoke.install_and_smoke(
            tmp_path / "artifact.whl",
            environment,
            tmp_path / "wheelhouse",
            tmp_path,
        )
    except RuntimeError:
        pass
    else:
        raise AssertionError("Expected the simulated install to fail")

    assert not environment.exists()


def test_artifact_smoke_entrypoint_preserves_unowned_build_state(
    monkeypatch,
    tmp_path: Path,
) -> None:
    smoke = load_artifact_smoke_module()
    sentinel = tmp_path / "build" / "sentinel.txt"
    sentinel.parent.mkdir()
    sentinel.write_text("owned elsewhere")
    monkeypatch.setattr(smoke, "ROOT", tmp_path)
    monkeypatch.setattr(
        smoke,
        "main",
        lambda: (_ for _ in ()).throw(RuntimeError("failed")),
    )

    with pytest.raises(RuntimeError, match="failed"):
        smoke.run_main()

    assert sentinel.read_text() == "owned elsewhere"


def test_quickstart_notebook_uses_generated_media_without_saved_outputs() -> None:
    notebook_path = Path(__file__).parents[2] / "examples" / "quickstart.ipynb"
    notebook = json.loads(notebook_path.read_text())
    code = "\n".join(
        cell["source"] if isinstance(cell["source"], str) else "".join(cell["source"])
        for cell in notebook["cells"]
        if cell["cell_type"] == "code"
    )

    assert "core.std.BlankClip" in code
    assert "preview(" in code
    assert 'mode="side-by-side"' in code
    assert "player.close()" in code
    assert "vs.clear_output(output_id)" in code
    assert "vs.clear_outputs()" not in code
    assert "set_output(0)" not in code
    assert "set_output(1)" not in code
    assert not re.search(r"(?:Source|LWLibavSource|FFMS2|imwri|lsmas)\s*\(", code)
    assert all(
        cell.get("outputs", []) == [] and cell.get("execution_count") is None
        for cell in notebook["cells"]
        if cell["cell_type"] == "code"
    )
