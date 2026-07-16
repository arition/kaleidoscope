from __future__ import annotations

import os
import socket


def require_network_guard() -> None:
    if "KALEIDOSCOPE_ARTIFACT_DIR" not in os.environ:
        return
    if os.environ.get("KALEIDOSCOPE_NETWORK_GUARD_ACTIVE") != "1":
        raise RuntimeError("Run release pytest through tests/packaging/network_guard.c")
    try:
        descriptor = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    except PermissionError:
        return
    descriptor.close()
    raise RuntimeError("Release pytest is not protected by the network guard")


require_network_guard()
