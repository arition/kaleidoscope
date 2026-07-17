from __future__ import annotations

import asyncio
import json
import sys
import tempfile
from base64 import b64encode
from pathlib import Path
from typing import Any

import nbformat
from jupyter_client import AsyncKernelManager
from jupyter_client.kernelspec import KernelSpec, KernelSpecManager
from nbclient import NotebookClient

WIDGET_VIEW_MIME = "application/vnd.jupyter.widget-view+json"
WIDGET_STATE_MIME = "application/vnd.jupyter.widget-state+json"
KERNEL_NAME = "kaleidoscope-installed-notebook-smoke"
IPC_KERNEL_LAUNCHER = Path(__file__).with_name("ipc_kernel_launcher.py")
IPC_TEMP_ROOT = Path("/tmp")


def ipc_runtime_directory() -> tempfile.TemporaryDirectory[str]:
    return tempfile.TemporaryDirectory(prefix="ks-ipc-", dir=IPC_TEMP_ROOT)


def contains_frame_set(value: Any) -> bool:
    if isinstance(value, dict):
        return value.get("type") == "frame_set" or any(
            contains_frame_set(child) for child in value.values()
        )
    if isinstance(value, list):
        return any(contains_frame_set(child) for child in value)
    return False


def widget_model_id(cell: Any) -> str | None:
    for output in cell.get("outputs", []):
        data = output.get("data", {})
        view = data.get(WIDGET_VIEW_MIME)
        if isinstance(view, dict) and isinstance(view.get("model_id"), str):
            return view["model_id"]
    return None


def send_custom(client: Any, comm_id: str, content: dict[str, Any]) -> None:
    assert client.kc is not None
    message = client.kc.session.msg(
        "comm_msg",
        content={
            "comm_id": comm_id,
            "data": {"method": "custom", "content": content},
        },
    )
    client.kc.shell_channel.send(message)


async def receive_custom(
    client: NotebookClient,
    *,
    expected_type: str,
    cell: Any,
    cell_index: int,
) -> tuple[dict[str, Any], list[bytes]]:
    assert client.kc is not None
    while True:
        message = await client.kc.get_iopub_msg(timeout=10)
        if message["msg_type"] in {"comm_open", "comm_msg", "comm_close"}:
            client.handle_comm_msg(cell["outputs"], message, cell_index)
        if message["msg_type"] != "comm_msg":
            continue
        data = message["content"].get("data", {})
        content = data.get("content") if data.get("method") == "custom" else None
        if isinstance(content, dict) and content.get("type") == expected_type:
            return content, [bytes(buffer) for buffer in message.get("buffers", [])]


async def execute_notebook(
    notebook: Any,
    manager: AsyncKernelManager,
    root: Path,
) -> tuple[Any, dict[str, Any]]:
    client = NotebookClient(
        notebook,
        km=manager,
        kernel_name=KERNEL_NAME,
        timeout=60,
        resources={"metadata": {"path": str(root)}},
        store_widget_state=True,
    )
    client.reset_execution_trackers()
    captured_case: dict[str, Any] | None = None

    async with client.async_setup_kernel(cwd=str(root)):
        for index, cell in enumerate(client.nb.cells):
            if cell.cell_type != "code":
                continue
            await client.async_execute_cell(
                cell,
                index,
                execution_count=client.code_cells_executed + 1,
            )
            source = "".join(cell.source)
            if 'mode="side-by-side"' not in source:
                continue

            model_id = widget_model_id(cell)
            assert model_id is not None
            session_id = client.widget_state[model_id]["session_id"]
            send_custom(
                client,
                model_id,
                {
                    "protocol": 1,
                    "type": "ready",
                    "session_id": session_id,
                    "capabilities": {"image_bitmap": True, "webp": True},
                },
            )
            metadata, metadata_buffers = await receive_custom(
                client,
                expected_type="metadata",
                cell=cell,
                cell_index=index,
            )
            assert metadata_buffers == []
            send_custom(
                client,
                model_id,
                {
                    "protocol": 1,
                    "type": "request_frame_set",
                    "session_id": session_id,
                    "request_id": 0,
                    "generation": 0,
                    "frame": 0,
                    "clip_ids": metadata["active_clip_ids"],
                    "reason": "seek",
                },
            )
            frame_set, frame_buffers = await receive_custom(
                client,
                expected_type="frame_set",
                cell=cell,
                cell_index=index,
            )
            assert len(frame_buffers) == len(metadata["active_clip_ids"])
            send_custom(
                client,
                model_id,
                {
                    "protocol": 1,
                    "type": "ack_frame_set",
                    "session_id": session_id,
                    "request_id": frame_set["request_id"],
                    "generation": frame_set["generation"],
                    "outcome": "painted",
                },
            )
            captured_case = {
                "name": "side-by-side",
                "mode": metadata["mode"],
                "clip_ids": metadata["active_clip_ids"],
                "frame_set": frame_set,
                "buffers": [b64encode(buffer).decode("ascii") for buffer in frame_buffers],
            }

        client.set_widgets_metadata()

    assert captured_case is not None
    return client.nb, captured_case


def main() -> None:
    target = Path(sys.argv[1]).resolve()
    browser_output = Path(sys.argv[2]).resolve()
    package_dir = Path(__import__("kaleidoscope").__file__).resolve().parent
    assert package_dir.is_relative_to(target), (package_dir, target)
    notebook_path = package_dir / "examples" / "quickstart.ipynb"
    notebook = nbformat.read(notebook_path, as_version=4)

    with ipc_runtime_directory() as temporary:
        root = Path(temporary)
        kernel_spec_manager = KernelSpecManager(kernel_dirs=[])
        kernel_spec_manager.get_kernel_spec = lambda name: KernelSpec(
            argv=[
                sys.executable,
                str(IPC_KERNEL_LAUNCHER),
                "-f",
                "{connection_file}",
            ],
            display_name="Installed Kaleidoscope notebook smoke",
            language="python",
        )
        manager = AsyncKernelManager(
            kernel_name=KERNEL_NAME,
            kernel_spec_manager=kernel_spec_manager,
            transport="ipc",
            connection_file=str(root / "kernel.json"),
        )
        executed, captured_case = asyncio.run(execute_notebook(notebook, manager, root))

    browser_output.mkdir(parents=True, exist_ok=True)
    (browser_output / "comm-case.json").write_text(json.dumps(captured_case))

    widget_views = [
        output
        for cell in executed.cells
        if cell.cell_type == "code"
        for output in cell.get("outputs", [])
        if WIDGET_VIEW_MIME in output.get("data", {})
    ]
    assert len(widget_views) == 3
    for cell in executed.cells:
        if cell.cell_type != "code":
            continue
        for output in cell.get("outputs", []):
            data = output.get("data", {})
            assert "image/jpeg" not in data
            assert "image/webp" not in data

    widget_state = executed.metadata["widgets"][WIDGET_STATE_MIME]
    assert not contains_frame_set(widget_state)
    assert all(not model.get("buffers") for model in widget_state["state"].values())


if __name__ == "__main__":
    main()
