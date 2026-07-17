from __future__ import annotations

from collections.abc import Iterator

import pytest
from ipywidgets import Widget


@pytest.fixture(autouse=True)
def close_widgets_after_test() -> Iterator[None]:
    yield
    Widget.close_all()
