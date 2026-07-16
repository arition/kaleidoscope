from __future__ import annotations

import socket
import subprocess
import sys

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
        raise AssertionError(
            f"Artifact smoke network guard did not block family {family}"
        )
    try:
        socket.socketpair(family, socket.SOCK_STREAM)
    except PermissionError:
        pass
    else:
        raise AssertionError(
            f"Artifact smoke network guard did not block socketpair family {family}"
        )

local_socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
local_socket.close()
local_pair = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
for local_socket in local_pair:
    local_socket.close()

for probe in sys.argv[1:]:
    subprocess.run([probe], check=True)
