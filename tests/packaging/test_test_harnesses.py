from __future__ import annotations

import importlib.util
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
