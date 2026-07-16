from __future__ import annotations

from typing import Any

from ipykernel import kernelapp
from ipykernel.iostream import IOPubThread


def ipc_only_iopub_thread(
    socket: Any,
    *,
    pipe: bool = False,
    session: Any = False,
) -> IOPubThread:
    if pipe is not True:
        raise RuntimeError("Expected ipykernel to request its subprocess IOPub bridge")
    return IOPubThread(socket, pipe=False, session=session)


def main() -> None:
    kernelapp.IOPubThread = ipc_only_iopub_thread
    kernelapp.launch_new_instance()


if __name__ == "__main__":
    main()
