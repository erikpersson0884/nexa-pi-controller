import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from nexa_pi_controller import storage


class StorageTestCase(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.data = Path(self.directory.name) / "data"
        patches = (
            patch.object(storage, "DEVICES_FILE", str(self.data / "devices.json")),
            patch.object(storage, "STATE_FILE", str(self.data / "state.json")),
            patch.object(storage, "TIMER_FILE", str(self.data / "timers.json")),
            patch.object(storage, "ROOMS_FILE", str(self.data / "rooms.json")),
        )
        for item in patches:
            item.start()
            self.addCleanup(item.stop)

    def test_missing_files_return_empty_data(self):
        self.assertEqual(storage.load_devices(), [])
        self.assertEqual(storage.load_state(), {})
        self.assertEqual(storage.load_timers(), {"schedules": [], "countdowns": []})
        self.assertEqual(storage.load_map(), ([storage.DEFAULT_FLOOR], []))

    def test_round_trip_all_data_and_create_directory(self):
        devices = [{"unit": 2, "name": "Lamp"}]
        state = {2: True}
        timers = {"schedules": [{"id": "s1"}], "countdowns": [{"id": "c1"}]}
        storage.save_devices(devices)
        storage.save_state(state)
        storage.save_timers(timers)
        self.assertEqual(storage.load_devices(), devices)
        self.assertEqual(storage.load_state(), state)
        self.assertEqual(storage.load_timers(), timers)

    def test_map_round_trip_and_legacy_room_migration(self):
        self.data.mkdir()
        legacy_room = {"id": "r1", "name": "Hall", "x": 0, "y": 0, "w": 30, "h": 30, "units": []}
        Path(storage.ROOMS_FILE).write_text(json.dumps([legacy_room]))
        self.assertEqual(
            storage.load_map(),
            ([storage.DEFAULT_FLOOR], [{**legacy_room, "floor_id": "ground-floor"}]),
        )

        floors = [storage.DEFAULT_FLOOR, {"id": "upper", "name": "Upper floor"}]
        rooms = [{**legacy_room, "floor_id": "upper"}]
        storage.save_map(floors, rooms)
        self.assertEqual(storage.load_map(), (floors, rooms))

    def test_devices_filter_invalid_units_and_blank_names(self):
        self.data.mkdir()
        Path(storage.DEVICES_FILE).write_text(json.dumps([
            {"unit": "2", "name": "Desk"},
            {"unit": -1, "name": "Negative"},
            {"unit": 16, "name": "Too high"},
            {"unit": 3, "name": "  "},
        ]))
        self.assertEqual(storage.load_devices(), [{"unit": 2, "name": "Desk"}])

    def test_invalid_devices_file_reports_error(self):
        self.data.mkdir()
        Path(storage.DEVICES_FILE).write_text("{}")
        with patch("builtins.print") as output:
            self.assertEqual(storage.load_devices(), [])
        self.assertIn("device configuration must be a list", str(output.call_args))

    def test_corrupt_state_and_timer_data_returns_empty(self):
        self.data.mkdir()
        Path(storage.STATE_FILE).write_text("{")
        Path(storage.TIMER_FILE).write_text("{")
        self.assertEqual(storage.load_state(), {})
        self.assertEqual(storage.load_timers(), {"schedules": [], "countdowns": []})

    def test_legacy_single_unit_timers_are_migrated_and_saved(self):
        self.data.mkdir()
        Path(storage.TIMER_FILE).write_text(json.dumps({
            "schedules": [{"id": "s1", "unit": 3, "action": "on"}],
            "countdowns": [{"id": "c1", "unit": 4, "run_at": 1}],
        }))
        timers = storage.load_timers()
        self.assertEqual(timers["schedules"][0]["units"], [3])
        self.assertNotIn("unit", timers["schedules"][0])
        self.assertEqual(timers["countdowns"][0]["units"], [4])
        saved = json.loads(Path(storage.TIMER_FILE).read_text())
        self.assertEqual(saved, timers)

    def test_timers_default_missing_collections(self):
        self.data.mkdir()
        Path(storage.TIMER_FILE).write_text('{"schedules": [{"id": "s1"}]}')
        self.assertEqual(
            storage.load_timers(),
            {"schedules": [{"id": "s1"}], "countdowns": []},
        )
