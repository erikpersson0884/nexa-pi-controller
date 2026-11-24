import json
import io
import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

from nexa_pi_controller import dev, user_store


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

    def test_seed_users_preserves_existing_accounts_and_runs_once(self):
        database = self.data / "nexa_users.sqlite3"
        user_store.initialize(database, "admin", "initial-password")
        existing = user_store.create_user(database, "demo-admin-1", "existing-password", "operator")
        output = io.StringIO()
        with patch.object(dev.secrets, "token_urlsafe", side_effect=["temp-1", "temp-2", "temp-3"]):
            with redirect_stdout(output):
                self.assertTrue(dev.seed_users(self.data, "admin", "initial-password"))

        preserved = user_store.get_user_by_username(database, "demo-admin-1")
        self.assertEqual(preserved["id"], existing["id"])
        self.assertEqual(preserved["role"], "operator")
        self.assertTrue(user_store.verify_password(preserved, "existing-password"))
        for username, role, password, must_change in [
            ("demo-admin-2", "admin", "temp-1", False),
            ("demo-operator-1", "operator", "temp-2", True),
            ("demo-operator-2", "operator", "temp-3", False),
        ]:
            user = user_store.get_user_by_username(database, username)
            self.assertEqual(user["role"], role)
            self.assertEqual(user["must_change_password"], must_change)
            self.assertTrue(user_store.verify_password(user, password))
            password_type = "temporary password" if must_change else "password"
            self.assertIn(f"{username} ({role}) {password_type}: {password}", output.getvalue())

        user_store.set_password(database, preserved["id"], "changed-password")
        with patch.object(dev.secrets, "token_urlsafe") as generate:
            self.assertFalse(dev.seed_users(self.data, "admin", "initial-password"))
            generate.assert_not_called()
        self.assertTrue(user_store.verify_password(
            user_store.get_user_by_username(database, "demo-admin-1"), "changed-password"
        ))

    def test_seed_users_can_retry_missing_bootstrap_credentials(self):
        with self.assertRaises(user_store.BootstrapRequiredError):
            dev.seed_users(self.data, "admin", None)
        self.assertFalse((self.data / ".users-seeded").exists())
        with redirect_stdout(io.StringIO()):
            self.assertTrue(dev.seed_users(self.data, "admin", "initial-password"))

    def test_launcher_uses_seeded_isolated_data_and_mock_radio(self):
        script = """
import sys
from pathlib import Path
from unittest.mock import patch
from nexa_pi_controller import dev

dev.DEV_DATA_DIR = Path(sys.argv[1])

def verify_app(app, host, port):
    from nexa_pi_controller import config, user_store, webui
    assert config.DATA_DIR == str(dev.DEV_DATA_DIR)
    assert config.GPIO_MODE == "mock"
    app.config["WTF_CSRF_ENABLED"] = False
    client = app.test_client()
    headers = {"Authorization": "Bearer test-api-key"}
    devices = client.get("/api/devices", headers=headers)
    timers = client.get("/api/timers", headers=headers)
    layout = client.get("/api/map", headers=headers)
    log = client.get("/api/remote/log", headers=headers)
    assert devices.status_code == timers.status_code == layout.status_code == log.status_code == 200
    assert len(devices.json) == 4
    assert [device["state"] for device in devices.json] == [True, False, True, False]
    assert [(entry["group"], entry["on"], entry["unit"]) for entry in log.json] == [
        (True, False, 0), (False, True, 0), (False, False, 1),
    ]
    assert client.post("/login", data={"username": "admin", "password": "test-password"}).status_code == 302
    page = client.get("/receiver-log")
    assert page.status_code == 200
    assert b"<dt>Controller ID</dt><dd>987654</dd>" in page.data
    assert b"Living room lamp" in page.data
    assert len(timers.json["schedules"]) == 2
    assert all(webui.parse_schedule(schedule)[1] is None for schedule in timers.json["schedules"])
    assert timers.json["countdowns"][0]["remaining"] > 0
    assert len(layout.json["floors"]) == 2
    assert len(layout.json["rooms"]) == 3
    assert webui.parse_map(layout.json)[2] is None
    users = user_store.list_users(config.USERS_FILE)
    assert len(users) == 5
    for username, role, password, must_change in [
        ("demo-admin-1", "admin", "temp-1", True),
        ("demo-admin-2", "admin", "temp-2", False),
        ("demo-operator-1", "operator", "temp-3", True),
        ("demo-operator-2", "operator", "temp-4", False),
    ]:
        user = user_store.get_user_by_username(config.USERS_FILE, username)
        assert user["role"] == role
        assert user["must_change_password"] is must_change
        response = app.test_client().post("/login", data={"username": username, "password": password})
        expected = "/account/password" if must_change else "/"
        assert response.status_code == 302 and response.location == expected

with patch("flask.Flask.run", verify_app), patch.object(
    dev.secrets, "token_urlsafe", side_effect=["temp-1", "temp-2", "temp-3", "temp-4"]
):
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
        for _ in range(2):
            result = subprocess.run(
                [sys.executable, "-c", script, str(self.data)],
                cwd=Path(__file__).resolve().parent.parent,
                env=environment, capture_output=True, text=True, timeout=30,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((Path(self.directory.name) / "normal-data").exists())


if __name__ == "__main__":
    unittest.main()
