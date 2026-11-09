import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest


class GpioInitializationTestCase(unittest.TestCase):
    def run_imports(self, work_dir=None):
        env = os.environ.copy()
        env["GPIO_MODE"] = "hardware"
        if work_dir is None:
            env.pop("LG_WD", None)
        else:
            env["LG_WD"] = work_dir
        code = """
import builtins
import json
import os
import stat
import types

original_import = builtins.__import__
seen = []
def import_hook(name, *args, **kwargs):
    if name == "lgpio":
        path = os.environ["LG_WD"]
        seen.append((path, stat.S_IMODE(os.stat(path).st_mode)))
        return types.ModuleType("lgpio")
    return original_import(name, *args, **kwargs)
builtins.__import__ = import_hook
from nexa_pi_controller import radio, receiver
assert radio.lgpio is receiver.lgpio
print(json.dumps(seen))
"""
        result = subprocess.run(
            [sys.executable, "-c", code],
            env=env,
            cwd=Path(__file__).resolve().parent.parent,
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_default_directory_is_private_before_lgpio_import_and_cleaned_up(self):
        seen = self.run_imports()
        self.assertEqual(len(seen), 1)
        path, mode = seen[0]
        self.assertTrue(os.path.isabs(path))
        self.assertEqual(mode, stat.S_IRWXU)
        self.assertFalse(os.path.exists(path))

    def test_explicit_working_directory_is_preserved(self):
        with tempfile.TemporaryDirectory() as work_dir:
            self.assertEqual(self.run_imports(work_dir), [[work_dir, stat.S_IRWXU]])
            self.assertTrue(os.path.isdir(work_dir))
