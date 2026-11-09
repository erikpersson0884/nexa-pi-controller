"""Shared lgpio initialization."""

import os
import tempfile

from .config import GPIO_MODE

_work_dir = None
if GPIO_MODE == "hardware" and "LG_WD" not in os.environ:
    _work_dir = tempfile.TemporaryDirectory(prefix="nexa-lgpio-")
    os.environ["LG_WD"] = _work_dir.name

try:
    import lgpio
except ImportError:
    lgpio = None
