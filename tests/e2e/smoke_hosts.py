from __future__ import annotations

import argparse
import importlib.metadata
import json
import os
import secrets
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).parents[2]
BROWSER_SMOKE = Path(__file__).with_name("smoke_hosts.mjs")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("host", choices=("jupyterlab", "notebook"))
    return parser.parse_args()


def reserve_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        return int(listener.getsockname()[1])


def create_token() -> str:
    return secrets.token_urlsafe(32)


def write_server_config(root: Path, token: str) -> Path:
    config_dir = root / "jupyter-config"
    config_dir.mkdir(parents=True, mode=0o700)
    config_dir.chmod(0o700)
    config_path = config_dir / "jupyter_server_config.py"
    config_path.write_text(
        "c = get_config()\n"
        f"c.IdentityProvider.token = {token!r}\n"
        "c.ServerApp.terminals_enabled = False\n",
        encoding="utf-8",
    )
    config_path.chmod(0o600)
    return config_path


def build_server_command(
    *,
    host: str,
    port: int,
    root: Path,
    labextensions: Path,
) -> list[str]:
    return [
        sys.executable,
        "-m",
        host,
        "--no-browser",
        f"--config={root / 'jupyter-config' / 'jupyter_server_config.py'}",
        f"--ServerApp.port={port}",
        "--ServerApp.port_retries=0",
        "--ServerApp.ip=127.0.0.1",
        f"--ServerApp.root_dir={root}",
        "--ServerApp.allow_root=True",
        f"--LabApp.labextensions_path={labextensions}",
        f"--LabServerApp.labextensions_path={labextensions}",
    ]


def redact_url(url: str) -> str:
    parsed = urllib.parse.urlsplit(url)
    query = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
    redacted_query = [(name, "<redacted>" if name == "token" else value) for name, value in query]
    return urllib.parse.urlunsplit(parsed._replace(query=urllib.parse.urlencode(redacted_query)))


def write_notebook(root: Path) -> Path:
    notebook = {
        "cells": [
            {
                "cell_type": "code",
                "execution_count": None,
                "metadata": {},
                "outputs": [],
                "source": [
                    "import vapoursynth as vs\n",
                    "from kaleidoscope import preview\n",
                    "clip = vs.core.std.BlankClip(\n",
                    "    width=64, height=48, length=2, format=vs.RGB24,\n",
                    "    color=[220, 40, 20], fpsnum=24, fpsden=1,\n",
                    ")\n",
                    "preview(clip)\n",
                ],
            }
        ],
        "metadata": {
            "kernelspec": {
                "display_name": "Python 3",
                "language": "python",
                "name": "python3",
            },
            "language_info": {"name": "python", "version": "3.12"},
        },
        "nbformat": 4,
        "nbformat_minor": 5,
    }
    path = root / "host-smoke.ipynb"
    path.write_text(json.dumps(notebook))
    return path


def server_log_tail(path: Path, token: str) -> str:
    tail = "\n".join(path.read_text(errors="replace").splitlines()[-80:])
    return tail.replace(token, "<redacted>")


def wait_for_server(
    base_url: str,
    token: str,
    process: subprocess.Popen[str],
    log_path: Path,
) -> None:
    deadline = time.monotonic() + 60
    status_url = f"{base_url}/api/status?token={token}"
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"Jupyter server exited early:\n{server_log_tail(log_path, token)}")
        try:
            with urllib.request.urlopen(status_url, timeout=1) as response:
                if response.status == 200:
                    return
        except (OSError, urllib.error.URLError):
            time.sleep(0.1)
    raise RuntimeError(
        f"Timed out waiting for {redact_url(status_url)}:\n{server_log_tail(log_path, token)}"
    )


def stop_server(process: subprocess.Popen[str]) -> None:
    if process.poll() is not None:
        return
    os.killpg(process.pid, signal.SIGTERM)
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait(timeout=10)


def main() -> None:
    args = parse_args()
    port = reserve_port()
    base_url = f"http://127.0.0.1:{port}"
    token = create_token()
    with tempfile.TemporaryDirectory(prefix="kaleidoscope-host-smoke-") as temporary:
        root = Path(temporary)
        notebook = write_notebook(root)
        write_server_config(root, token)
        log_path = root / "jupyter.log"
        labextensions = Path(sys.prefix) / "share" / "jupyter" / "labextensions"
        environment = os.environ.copy()
        environment.update(
            {
                "HOME": str(root / "home"),
                "IPYTHONDIR": str(root / "ipython"),
                "JUPYTER_CONFIG_DIR": str(root / "jupyter-config"),
                "JUPYTER_RUNTIME_DIR": str(root / "jupyter-runtime"),
            }
        )
        command = build_server_command(
            host=args.host,
            port=port,
            root=root,
            labextensions=labextensions,
        )
        with log_path.open("w") as log:
            process = subprocess.Popen(
                command,
                cwd=root,
                stdout=log,
                stderr=subprocess.STDOUT,
                text=True,
                start_new_session=True,
                env=environment,
            )
            try:
                wait_for_server(base_url, token, process, log_path)
                browser_environment = os.environ.copy()
                browser_environment["KALEIDOSCOPE_JUPYTER_TOKEN"] = token
                subprocess.run(
                    [
                        "node",
                        str(BROWSER_SMOKE),
                        args.host,
                        importlib.metadata.version(args.host),
                        base_url,
                        notebook.name,
                    ],
                    cwd=ROOT,
                    check=True,
                    env=browser_environment,
                )
            finally:
                stop_server(process)


if __name__ == "__main__":
    main()
