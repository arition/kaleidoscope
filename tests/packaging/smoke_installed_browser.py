from __future__ import annotations

import json
import sys
from base64 import b64encode
from pathlib import Path
from threading import Event

import vapoursynth as vs

from kaleidoscope import PreviewWidget, preview


def capture_frame_set(
    clips: object,
    mode: str,
    clip_ids: list[str | int],
) -> tuple[dict[str, object], list[bytes]]:
    delivered = Event()
    sent: list[tuple[dict[str, object], list[bytes] | None]] = []
    original_send = PreviewWidget.send

    def capture(
        self: PreviewWidget,
        content: dict[str, object],
        buffers: list[bytes] | None = None,
    ) -> None:
        del self
        sent.append((content, buffers))
        if content.get("type") == "frame_set":
            delivered.set()

    PreviewWidget.send = capture
    try:
        widget = preview(clips, mode=mode)
        widget._handle_custom_message(
            widget,
            {
                "protocol": 1,
                "type": "ready",
                "session_id": widget.session_id,
                "capabilities": {"image_bitmap": True, "webp": True},
            },
            [],
        )
        widget._handle_custom_message(
            widget,
            {
                "protocol": 1,
                "type": "request_frame_set",
                "session_id": widget.session_id,
                "request_id": 0,
                "generation": 0,
                "frame": 0,
                "clip_ids": clip_ids,
                "reason": "seek",
            },
            [],
        )
        assert delivered.wait(10), sent
        frame_set, buffers = next(
            item for item in sent if item[0]["type"] == "frame_set"
        )
        assert buffers is not None
        widget.close()
        return frame_set, buffers
    finally:
        PreviewWidget.send = original_send


def create_case(
    name: str,
    clips: object,
    mode: str,
    clip_ids: list[str | int],
) -> dict[str, object]:
    frame_set, buffers = capture_frame_set(clips, mode, clip_ids)
    return {
        "name": name,
        "mode": mode,
        "clip_ids": clip_ids,
        "frame_set": frame_set,
        "buffers": [b64encode(buffer).decode("ascii") for buffer in buffers],
    }


def main() -> None:
    target = Path(sys.argv[1]).resolve()
    output = Path(sys.argv[2]).resolve()
    package_dir = Path(__import__("kaleidoscope").__file__).resolve().parent
    assert package_dir.is_relative_to(target), (package_dir, target)

    core = vs.core
    source = core.std.BlankClip(
        width=64,
        height=48,
        format=vs.RGB24,
        length=1,
        fpsnum=24,
        fpsden=1,
        color=[255, 32, 16],
    )
    comm_case_path = output / "comm-case.json"
    assert comm_case_path.is_file()
    comm_case = json.loads(comm_case_path.read_text())
    payload = {
        "cases": [
            create_case("single", source, "single", [0]),
            comm_case,
        ]
    }
    output.mkdir(parents=True, exist_ok=True)
    (output / "cases.json").write_text(json.dumps(payload))
    (output / "index.js").write_bytes(
        (package_dir / "static" / "index.js").read_bytes()
    )
    (output / "index.css").write_bytes(
        (package_dir / "static" / "index.css").read_bytes()
    )
    harness = Path(__file__).with_name("installed_browser_harness")
    (output / "index.html").write_bytes((harness / "index.html").read_bytes())
    (output / "model.js").write_bytes((harness / "model.js").read_bytes())
    (output / "cases.js").write_text(f"export default {json.dumps(payload)};\n")


if __name__ == "__main__":
    main()
