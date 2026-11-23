import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from nexa_pi_controller import dev


class DevelopmentSeedTestCase(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.data = Path(self.directory.name) / "dev-data"

    def test_seed_creates_valid_related_data_and_preserves_changes(self):
        with patch.object(dev.time, "time", return_value=1000):
            self.assertTrue(dev.seed_data(self.data))

        def read(name):
            return json.loads((self.data / f"nexa_{name}.json").read_text())

        devices = read("devices")
        state = read("state")
        timers = read("timers")
        layout = read("rooms")
        units = {device["unit"] for device in devices}
        self.assertEqual(len(units), len(devices))
        self.assertEqual({int(unit) for unit in state}, units)
        self.assertTrue(any(state.values()))
        self.assertTrue(any(not value for value in state.values()))
        self.assertEqual(timers["countdowns"][0]["run_at"], 4600)
        for timer in timers["schedules"] + timers["countdowns"]:
            self.assertTrue(set(timer["units"]) <= units)
        floors = {floor["id"] for floor in layout["floors"]}
        for room in layout["rooms"]:
            self.assertIn(room["floor_id"], floors)
            self.assertTrue(set(room["units"]) <= units)

        devices_path = self.data / "nexa_devices.json"
        devices_path.write_text('[]')
        self.assertFalse(dev.seed_data(self.data))
        self.assertEqual(devices_path.read_text(), '[]')

    def test_existing_partial_data_is_not_replaced_or_completed(self):
        self.data.mkdir()
        state_path = self.data / "nexa_state.json"
        state_path.write_text('{"0": true}')
        self.assertFalse(dev.seed_data(self.data))
        self.assertEqual(state_path.read_text(), '{"0": true}')
        self.assertFalse((self.data / "nexa_devices.json").exists())

    def test_launcher_uses_seeded_isolated_data_and_mock_radio(self):
        script = """
import sys
from pathlib import Path
from unittest.mock import patch
from nexa_pi_controller import dev

dev.DEV_DATA_DIR = Path(sys.argv[1])

def verify_app(app, host, port):
    from nexa_pi_controller import config, webui
    assert config.DATA_DIR == str(dev.DEV_DATA_DIR)
    assert config.GPIO_MODE == "mock"
    client = app.test_client()
    headers = {"Authorization": "Bearer test-api-key"}
    devices = client.get("/api/devices", headers=headers)
    timers = client.get("/api/timers", headers=headers)
    layout = client.get("/api/map", headers=headers)
    assert devices.status_code == timers.status_code == layout.status_code == 200
    assert len(devices.json) == 4
    assert len(timers.json["schedules"]) == 2
    assert all(webui.parse_schedule(schedule)[1] is None for schedule in timers.json["schedules"])
    assert timers.json["countdowns"][0]["remaining"] > 0
    assert len(layout.json["floors"]) == 2
    assert len(layout.json["rooms"]) == 3
    assert webui.parse_map(layout.json)[2] is None

with patch("flask.Flask.run", verify_app):
    dev.main()
"""
        environment = os.environ.copy()
        environment.update({
            "DATA_DIR": str(Path(self.directory.name) / "normal-data"),
            "GPIO_MODE": "hardware",
            "SECRET_KEY": "test-secret",
            "AUTH_USERNAME": "admin",
            "AUTH_PASSWORD": "test-password",
            "API_KEY": "test-api-key",
        })
        result = subprocess.run(
            [sys.executable, "-c", script, str(self.data)],
            env=environment, capture_output=True, text=True, timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((Path(self.directory.name) / "normal-data").exists())


if __name__ == "__main__":
    unittest.main()
