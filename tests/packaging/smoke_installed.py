from __future__ import annotations

import sys
from hashlib import sha256
from pathlib import Path
from threading import Event

import vapoursynth as vs

from kaleidoscope import PreviewWidget, preview


def smoke_player(clips: object, mode: str, clip_ids: list[str | int]) -> None:
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
        metadata = next(content for content, _ in sent if content["type"] == "metadata")
        frame_set, buffers = next(item for item in sent if item[0]["type"] == "frame_set")
        assert metadata["mode"] == mode
        assert frame_set["frame"] == 0
        assert buffers is not None and len(buffers) == len(clip_ids)
        widget.close()
    finally:
        PreviewWidget.send = original_send


def main() -> None:
    target = Path(sys.argv[1]).resolve()
    expected_javascript_hash = sys.argv[2]
    expected_stylesheet_hash = sys.argv[3]
    expected_quickstart_hash = sys.argv[4]
    package_dir = Path(__import__("kaleidoscope").__file__).resolve().parent
    assert package_dir.is_relative_to(target), (package_dir, target)
    assert (package_dir / "py.typed").is_file()
    assert sha256((package_dir / "static" / "index.js").read_bytes()).hexdigest() == (
        expected_javascript_hash
    )
    assert sha256((package_dir / "static" / "index.css").read_bytes()).hexdigest() == (
        expected_stylesheet_hash
    )
    assert (
        sha256((package_dir / "examples" / "quickstart.ipynb").read_bytes()).hexdigest()
        == expected_quickstart_hash
    )

    core = vs.core
    source = core.std.BlankClip(
        width=16,
        height=16,
        format=vs.RGB24,
        length=1,
        fpsnum=24,
        fpsden=1,
        color=[255, 0, 0],
    )
    filtered = core.std.BlankClip(clip=source, color=[0, 0, 255])
    smoke_player(source, "single", [0])
    smoke_player(
        {"Source": source, "Filtered": filtered},
        "side-by-side",
        ["Source", "Filtered"],
    )


if __name__ == "__main__":
    main()
