from __future__ import annotations

from pathlib import Path
from typing import Any

from hatchling.builders.hooks.plugin.interface import BuildHookInterface


class CustomBuildHook(BuildHookInterface):
    def initialize(self, version: str, build_data: dict[str, Any]) -> None:
        ignored_path = Path(self.root, ".gitignore").resolve()
        force_include = build_data["force_include"]
        for source in tuple(force_include):
            if Path(source).resolve() == ignored_path:
                del force_include[source]
