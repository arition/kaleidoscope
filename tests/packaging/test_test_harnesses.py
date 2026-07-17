from __future__ import annotations

import importlib.util
import os
import stat
from pathlib import Path
from types import ModuleType

ROOT = Path(__file__).parents[2]
PLAYWRIGHT_CONFIG = ROOT / "playwright.config.ts"


def load_script(path: Path) -> ModuleType:
    spec = importlib.util.spec_from_file_location(path.stem, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_browser_harness_is_staged_without_exposing_the_repository(
    tmp_path: Path,
) -> None:
    fixture_script = load_script(ROOT / "tests" / "e2e" / "generate_fixture.py")
    site = tmp_path / "site"

    fixture_script.stage_harness(site)

    files = {path.relative_to(site).as_posix() for path in site.rglob("*") if path.is_file()}
    assert files == {
        "src/kaleidoscope/static/index.css",
        "src/kaleidoscope/static/index.js",
        "tests/e2e/harness/index.html",
        "tests/e2e/harness/model.js",
    }
    config = PLAYWRIGHT_CONFIG.read_text(encoding="utf-8")
    assert "--directory node_modules/.cache/kaleidoscope-e2e-site" in config
    assert "--directory ." not in config


def test_host_smoke_uses_a_private_runtime_token(tmp_path: Path) -> None:
    host_smoke = load_script(ROOT / "tests" / "e2e" / "smoke_hosts.py")
    token = host_smoke.create_token()

    assert token != host_smoke.create_token()
    assert len(token) >= 32
    config_path = host_smoke.write_server_config(tmp_path, token)
    assert stat.S_IMODE(config_path.stat().st_mode) == 0o600
    assert token in config_path.read_text(encoding="utf-8")

    command = host_smoke.build_server_command(
        host="jupyterlab",
        port=12345,
        root=tmp_path,
        labextensions=tmp_path / "labextensions",
    )
    assert all(token not in argument for argument in command)
    assert host_smoke.redact_url(f"http://127.0.0.1:12345/lab?token={token}") == (
        "http://127.0.0.1:12345/lab?token=%3Credacted%3E"
    )

    browser_smoke = (ROOT / "tests" / "e2e" / "smoke_hosts.mjs").read_text()
    assert "const diagnostic =" in browser_smoke
    assert "throw new Error(redact(diagnostic)" in browser_smoke


def test_installed_notebook_smoke_uses_a_short_private_ipc_directory(
    monkeypatch,
    tmp_path: Path,
) -> None:
    notebook_smoke = load_script(ROOT / "tests" / "packaging" / "smoke_installed_notebook.py")
    target = tmp_path / "environment"
    package_dir = target / "lib/python3.12/site-packages/kaleidoscope"
    browser_output = tmp_path / "browser-output"
    package = ModuleType("kaleidoscope")
    package.__file__ = str(package_dir / "__init__.py")
    monkeypatch.setitem(notebook_smoke.sys.modules, "kaleidoscope", package)

    notebook = notebook_smoke.nbformat.v4.new_notebook()
    monkeypatch.setattr(notebook_smoke.nbformat, "read", lambda *_args, **_kwargs: notebook)
    widget_view = notebook_smoke.nbformat.v4.new_output(
        output_type="display_data",
        data={notebook_smoke.WIDGET_VIEW_MIME: {"model_id": "model"}},
    )
    executed = notebook_smoke.nbformat.v4.new_notebook(
        cells=[notebook_smoke.nbformat.v4.new_code_cell(outputs=[widget_view]) for _ in range(3)]
    )
    executed.metadata["widgets"] = {notebook_smoke.WIDGET_STATE_MIME: {"state": {}}}
    runtime: Path | None = None
    runtime_mode: int | None = None
    socket_path_bytes: int | None = None
    connection_file: Path | None = None

    async def execute_notebook(_notebook, manager, root):
        nonlocal runtime, runtime_mode, socket_path_bytes, connection_file
        runtime = root
        runtime_mode = stat.S_IMODE(root.stat().st_mode)
        socket_path_bytes = len(os.fsencode(root / "kernel-ipc-5"))
        connection_file = Path(manager.connection_file)
        return executed, {"name": "side-by-side"}

    monkeypatch.setattr(notebook_smoke, "execute_notebook", execute_notebook)
    long_temp = tmp_path / ("nested-" + "x" * 120)
    long_temp.mkdir()
    monkeypatch.setenv("TMPDIR", str(long_temp))
    monkeypatch.setattr(notebook_smoke.tempfile, "tempdir", None)
    monkeypatch.setattr(
        notebook_smoke.sys,
        "argv",
        ["smoke_installed_notebook.py", str(target), str(browser_output)],
    )

    notebook_smoke.main()

    assert runtime is not None
    assert runtime.parent == Path("/tmp")
    assert runtime_mode == 0o700
    assert socket_path_bytes is not None and socket_path_bytes <= 107
    assert connection_file == runtime / "kernel.json"
    assert not runtime.exists()
