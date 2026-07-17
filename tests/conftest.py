from __future__ import annotations

import os
import socket
from collections.abc import Iterator

import pytest
from ipywidgets import Widget


def require_network_guard() -> None:
    if "KALEIDOSCOPE_ARTIFACT_DIR" not in os.environ:
        return
    if os.environ.get("KALEIDOSCOPE_NETWORK_GUARD_ACTIVE") != "1":
        raise RuntimeError("Run release pytest through tests/packaging/network_guard.c")
    if os.environ.get("KALEIDOSCOPE_NETWORK_NAMESPACE_ACTIVE") != "1":
        raise RuntimeError("Release pytest is not inside the private namespace")
    try:
        descriptor = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    except PermissionError:
        return
    descriptor.close()
    raise RuntimeError("Release pytest is not protected by the network guard")


require_network_guard()


@pytest.fixture(autouse=True)
def close_widgets_after_test() -> Iterator[None]:
    yield
    Widget.close_all()
