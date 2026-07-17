from __future__ import annotations

import ctypes
import errno
import os
import socket
import subprocess
import sys
import tempfile
from pathlib import Path

if os.environ.get("KALEIDOSCOPE_NETWORK_NAMESPACE_ACTIVE") != "1":
    raise AssertionError("Artifact smoke is not inside the private network namespace")
if any(key.startswith(("ACTIONS_", "GITHUB_", "RUNNER_")) for key in os.environ):
    raise AssertionError("Artifact smoke inherited GitHub runner state")
require_pid_one = "--require-pid-one" in sys.argv[1:]
if require_pid_one and (os.getpid() != 1 or os.getppid() != 0):
    raise AssertionError("Artifact smoke is not PID 1 in a private PID namespace")
if os.environ.get("KALEIDOSCOPE_PID_NAMESPACE_ACTIVE") != "1":
    raise AssertionError("Artifact smoke lacks the private PID namespace marker")
for path in Path("/proc").glob("[0-9]*/environ"):
    try:
        process_environment = path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        continue
    if "KALEIDOSCOPE_OUTER_PROCESS_MARKER=" in process_environment:
        raise AssertionError("Artifact smoke can read the outer process environment")

mount_info = Path("/proc/self/mountinfo").read_text(encoding="utf-8")
private_run_is_tmpfs = False
for line in mount_info.splitlines():
    mount_fields, filesystem = line.split(" - ", 1)
    if mount_fields.split()[4] == "/run" and filesystem.split()[0] == "tmpfs":
        private_run_is_tmpfs = True
        break
if not private_run_is_tmpfs:
    raise AssertionError("Artifact smoke does not have a private tmpfs at /run")

library = ctypes.CDLL(None, use_errno=True)
if library.umount2(b"/run", 0) != -1 or ctypes.get_errno() != errno.EACCES:
    raise AssertionError("Artifact smoke can remove private mount boundaries")

private_runner_temp = os.environ.get("KALEIDOSCOPE_PRIVATE_RUNNER_TEMP")
private_actions = os.environ.get("KALEIDOSCOPE_PRIVATE_ACTIONS_DIR")
readonly_tool_cache = os.environ.get("KALEIDOSCOPE_READONLY_TOOL_CACHE")
require_tool_markers = os.environ.get("KALEIDOSCOPE_REQUIRE_TOOL_MARKERS") == "1"
for path_value, expected_filesystem in (
    (private_runner_temp, "tmpfs"),
    (private_actions, "tmpfs"),
):
    if path_value is None:
        continue
    path = Path(path_value)
    if (path / "host-marker").exists():
        raise AssertionError(f"Artifact smoke can see the host marker at {path}")
    if not any(
        line.split(" - ", 1)[0].split()[4] == path.as_posix()
        and line.split(" - ", 1)[1].split()[0] == expected_filesystem
        for line in mount_info.splitlines()
    ):
        raise AssertionError(f"Artifact smoke lacks a private tmpfs at {path}")

if readonly_tool_cache is not None:
    tool_cache = Path(readonly_tool_cache)
    if require_tool_markers and not (tool_cache / "host-marker").is_file():
        raise AssertionError("Artifact smoke cannot read the tool cache marker")
    try:
        (tool_cache / "guard-write-probe").write_text("forbidden")
    except OSError:
        pass
    else:
        raise AssertionError("Artifact smoke can write to the runner tool cache")

for variable in (
    "KALEIDOSCOPE_NPM_CACHE",
    "KALEIDOSCOPE_PLAYWRIGHT_BROWSERS_PATH",
):
    path_value = os.environ.get(variable)
    if path_value is None:
        continue
    path = Path(path_value)
    if not path.is_absolute() or not path.is_dir():
        raise AssertionError(f"Artifact smoke cannot read explicit tool path {path}")
    if require_tool_markers and not (path / "tool-marker").is_file():
        raise AssertionError(f"Artifact smoke cannot read tool marker at {path}")

for family in (
    socket.AF_INET,
    socket.AF_INET6,
    socket.AF_PACKET,
    socket.AF_NETLINK,
):
    try:
        socket.socket(family, socket.SOCK_STREAM)
    except PermissionError:
        pass
    else:
        raise AssertionError(f"Artifact smoke network guard did not block family {family}")
    try:
        socket.socketpair(family, socket.SOCK_STREAM)
    except PermissionError:
        pass
    else:
        raise AssertionError(f"Artifact smoke network guard did not block socketpair family {family}")

local_socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
local_socket.close()
local_pair = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
for local_socket in local_pair:
    local_socket.close()

with tempfile.TemporaryDirectory(
    prefix="kaleidoscope-local-ipc-",
    dir="/tmp",
) as temporary:
    socket_path = str(Path(temporary) / "probe.sock")
    with (
        socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server,
        socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client,
    ):
        server.bind(socket_path)
        server.listen(1)
        client.connect(socket_path)
        connection, _ = server.accept()
        connection.close()

for probe in (argument for argument in sys.argv[1:] if argument != "--require-pid-one"):
    subprocess.run([probe], check=True)
