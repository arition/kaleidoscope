from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

import nbformat
from nbclient import NotebookClient

ROOT = Path(__file__).parents[2]
NOTEBOOK = ROOT / "examples" / "quickstart.ipynb"
KERNEL_NAME = "kaleidoscope-notebook-smoke"


def write_kernel_spec(data_directory: Path) -> None:
    kernel_directory = data_directory / "kernels" / KERNEL_NAME
    kernel_directory.mkdir(parents=True)
    kernel_spec = {
        "argv": [
            sys.executable,
            "-m",
            "ipykernel_launcher",
            "-f",
            "{connection_file}",
        ],
        "display_name": "Kaleidoscope notebook smoke",
        "language": "python",
        "env": {"PYTHONPATH": str(ROOT / "src")},
    }
    (kernel_directory / "kernel.json").write_text(json.dumps(kernel_spec))


def main() -> None:
    notebook = nbformat.read(NOTEBOOK, as_version=4)
    registered_cell = next(
        cell
        for cell in notebook.cells
        if cell.cell_type == "code" and "registered_outputs = [" in cell.source
    )
    registered_cell_source = registered_cell.source
    registered_index = notebook.cells.index(registered_cell)
    notebook.cells.insert(
        registered_index,
        nbformat.v4.new_code_cell(
            f"""capacity_outputs = []
for capacity_output_id in range(1024, 2047):
    capacity_clip = vs.core.std.BlankClip(
        width=320,
        height=180,
        format=vs.RGB24,
        length=1,
        fpsnum=30,
        fpsden=1,
        color=[4, 5, 6],
    )
    capacity_clip.set_output(capacity_output_id)
    capacity_outputs.append(capacity_output_id)

before_capacity_check = {{
    output_id: output.clip
    for output_id, output in vs.get_outputs().items()
    if isinstance(output, vs.VideoOutputTuple)
}}
capacity_namespace = {{
    "preview": preview,
    "source": source,
    "filtered": filtered,
    "vs": vs,
}}
try:
    exec(
        compile(
            {registered_cell_source!r},
            "quickstart-registered-output-cell",
            "exec",
        ),
        capacity_namespace,
    )
except RuntimeError as error:
    assert str(error) == "The quickstart needs two free output IDs in 1024..2047."
else:
    raise AssertionError("Expected the quickstart capacity check to fail")
after_capacity_check = {{
    output_id: output.clip
    for output_id, output in vs.get_outputs().items()
    if isinstance(output, vs.VideoOutputTuple)
}}
assert set(after_capacity_check) == set(before_capacity_check)
assert all(
    after_capacity_check[output_id] is expected_clip
    for output_id, expected_clip in before_capacity_check.items()
)
for capacity_output_id in capacity_outputs:
    vs.clear_output(capacity_output_id)"""
        ),
    )
    notebook.cells.insert(
        registered_index + 1,
        nbformat.v4.new_code_cell(
            f"""original_set_output = vs.VideoNode.set_output
registration_calls = 0

def interrupt_second_registration(self, output_id=0, alpha=None, alt_output=0):
    global registration_calls
    registration_calls += 1
    if registration_calls == 2:
        raise KeyboardInterrupt("simulated second output registration interruption")
    return original_set_output(self, output_id, alpha, alt_output)

vs.VideoNode.set_output = interrupt_second_registration
before_interrupted_registration = {{
    output_id: output.clip
    for output_id, output in vs.get_outputs().items()
    if isinstance(output, vs.VideoOutputTuple)
}}
interrupted_namespace = {{
    "preview": preview,
    "source": source,
    "filtered": filtered,
    "vs": vs,
}}
try:
    exec(
        compile(
            {registered_cell_source!r},
            "quickstart-interrupted-registration-cell",
            "exec",
        ),
        interrupted_namespace,
    )
except KeyboardInterrupt as error:
    assert str(error) == "simulated second output registration interruption"
else:
    raise AssertionError("Expected the second output registration to be interrupted")
finally:
    vs.VideoNode.set_output = original_set_output
after_interrupted_registration = {{
    output_id: output.clip
    for output_id, output in vs.get_outputs().items()
    if isinstance(output, vs.VideoOutputTuple)
}}
assert set(after_interrupted_registration) == set(before_interrupted_registration)
assert all(
    after_interrupted_registration[output_id] is expected_clip
    for output_id, expected_clip in before_interrupted_registration.items()
)
exec(
    compile(
        {registered_cell_source!r},
        "quickstart-post-interruption-registration-cell",
        "exec",
    ),
    interrupted_namespace,
)
interrupted_namespace["registered_player"].close()
for output_id, expected_clip in interrupted_namespace["registered_outputs"]:
    output = vs.get_outputs().get(output_id)
    assert isinstance(output, vs.VideoOutputTuple)
    assert output.clip is expected_clip
    vs.clear_output(output_id)
assert set(vs.get_outputs()) == set(before_interrupted_registration)
assert all(
    vs.get_output(output_id).clip is expected_clip
    for output_id, expected_clip in before_interrupted_registration.items()
)"""
        ),
    )
    notebook.cells.insert(
        registered_index + 3,
        nbformat.v4.new_code_cell(
            """replaced_output_id, _ = registered_outputs[0]
replacement_clip = vs.core.std.BlankClip(
    width=320,
    height=180,
    format=vs.RGB24,
    length=1,
    fpsnum=30,
    fpsden=1,
    color=[9, 8, 7],
)
replacement_clip.set_output(replaced_output_id)"""
        ),
    )
    notebook.cells.insert(
        registered_index + 4,
        nbformat.v4.new_code_cell(registered_cell.source),
    )
    notebook.cells.insert(
        0,
        nbformat.v4.new_code_cell(
            """import vapoursynth as vs

sentinel_output_id = 900
assert sentinel_output_id not in vs.get_outputs()
sentinel_clip = vs.core.std.BlankClip(
    width=320,
    height=180,
    format=vs.RGB24,
    length=1,
    fpsnum=30,
    fpsden=1,
    color=[1, 2, 3],
)
sentinel_clip.set_output(sentinel_output_id)"""
        ),
    )
    notebook.cells.append(
        nbformat.v4.new_code_cell(
            """assert set(vs.get_outputs()) == {sentinel_output_id, replaced_output_id}
assert vs.get_output(replaced_output_id).clip is replacement_clip
vs.clear_output(sentinel_output_id)
vs.clear_output(replaced_output_id)
assert not vs.get_outputs()"""
        )
    )

    with tempfile.TemporaryDirectory(prefix="kaleidoscope-notebook-") as temporary:
        data_directory = Path(temporary) / "jupyter"
        write_kernel_spec(data_directory)
        previous_jupyter_path = os.environ.get("JUPYTER_PATH")
        os.environ["JUPYTER_PATH"] = str(data_directory)
        try:
            NotebookClient(
                notebook,
                kernel_name=KERNEL_NAME,
                timeout=60,
                resources={"metadata": {"path": str(ROOT)}},
            ).execute()
        finally:
            if previous_jupyter_path is None:
                os.environ.pop("JUPYTER_PATH", None)
            else:
                os.environ["JUPYTER_PATH"] = previous_jupyter_path


if __name__ == "__main__":
    main()
