import unittest
import re
import os
from unittest.mock import patch

os.environ.setdefault("SECRET_KEY", "test-secret-key")
os.environ.setdefault("AUTH_USERNAME", "admin")
os.environ.setdefault(
    "AUTH_PASSWORD_HASH",
    "$argon2id$v=19$m=65536,t=3,p=4$qdYeh8vk7ZB8iwFoTYVQYg$Kjew+lbiX79B7HkSvR0v/H1gBdXEHhyOL6dUbvTmB6U",
)

import webui


class WebUiTestCase(unittest.TestCase):
    def setUp(self):
        webui.AUTH_USERNAME = "admin"
        webui.AUTH_PASSWORD_HASH = (
            "$argon2id$v=19$m=65536,t=3,p=4$qdYeh8vk7ZB8iwFoTYVQYg$"
            "Kjew+lbiX79B7HkSvR0v/H1gBdXEHhyOL6dUbvTmB6U"
        )
        self.client = webui.app.test_client()
        self.client.application.config["WTF_CSRF_ENABLED"] = False
        with self.client.session_transaction() as session:
            session["authenticated"] = True
        self.devices = webui.configured_devices
        self.state = webui.state
        self.timers = webui.timers
        webui.configured_devices = [{"unit": 0, "name": "Test outlet"}]
        webui.state = {}
        webui.timers = {"schedules": [], "countdowns": []}

    def tearDown(self):
        webui.configured_devices = self.devices
        webui.state = self.state
        webui.timers = self.timers

    def test_homepage_references_logo_as_favicon(self):
        response = self.client.get("/")

        self.assertEqual(response.status_code, 200)
        html = response.get_data(as_text=True)
        self.assertIn(
            '<link rel="icon" type="image/svg+xml" href="/static/logo.svg">',
            html,
        )
        self.assertIn(
            '<link rel="icon" type="image/png" href="/static/logo.png">',
            html,
        )
        self.assertIn('id="outlet-list"', html)
        self.assertIn('id="timer-sheet"', html)
        self.assertIn('id="editor-sheet"', html)
        self.assertIn('id="pair-modal"', html)
        self.assertIn('id="pair-name"', html)
        self.assertIn('id="rename-modal"', html)
        self.assertIn('id="remove-modal"', html)
        self.assertIn('rel="manifest"', html)
        self.assertIn('>Pair</button>', html)
        self.assertIn('<script src="/static/app.js"></script>', html)

    def test_homepage_contains_csrf_token_for_api_requests(self):
        response = self.client.get("/")

        self.assertIn('name="csrf-token"', response.get_data(as_text=True))

    def test_api_requires_authentication(self):
        with self.client.session_transaction() as session:
            session.clear()
        response = self.client.get("/api/devices")
        self.assertEqual(response.status_code, 401)

    def test_login_accepts_valid_credentials(self):
        with self.client.session_transaction() as session:
            session.clear()
        response = self.client.post(
            "/login",
            data={"username": "admin", "password": "test-password"},
        )
        self.assertEqual(response.status_code, 302)
        with self.client.session_transaction() as session:
            self.assertTrue(session["authenticated"])

    def test_login_rejects_malformed_password_hash(self):
        with self.client.session_transaction() as session:
            session.clear()
        with patch.object(webui, "AUTH_PASSWORD_HASH", "$argon2id=invalid"):
            response = self.client.post(
                "/login",
                data={"username": "admin", "password": "test-password"},
            )
        self.assertEqual(response.status_code, 401)

    def test_homepage_explains_when_no_outlets_have_been_added(self):
        webui.configured_devices = []

        response = self.client.get("/")

        self.assertEqual(response.status_code, 200)
        with self.client.get("/static/app.js") as js_response:
            app_js = js_response.get_data(as_text=True)
        page = response.get_data(as_text=True)
        self.assertIn(
            'No outlets configured',
            app_js,
        )
        self.assertIn('Put the outlet in learning mode.', page)
        self.assertIn('Press Pair.', page)

    def test_mutating_requests_require_a_csrf_token(self):
        self.client.application.config["WTF_CSRF_ENABLED"] = True

        rejected = self.client.post("/api/0/on")
        self.assertEqual(rejected.status_code, 400)

        page = self.client.get("/")
        token = re.search(
            r'<meta name="csrf-token" content="([^"]+)"', page.get_data(as_text=True)
        ).group(1)
        with patch.object(webui, "apply"):
            accepted = self.client.post(
                "/api/0/on",
                headers={"X-CSRFToken": token},
            )
        self.assertEqual(accepted.status_code, 200)

    def test_app_assets_are_served(self):
        with self.client.get("/static/app.css") as css:
            self.assertEqual(css.status_code, 200)
            self.assertIn(b"--bg:", css.data)
        with self.client.get("/static/app.js") as js:
            self.assertEqual(js.status_code, 200)
            self.assertIn(b"function pairOutlet(event)", js.data)

        with self.client.get("/static/manifest.webmanifest") as manifest:
            self.assertEqual(manifest.status_code, 200)
            self.assertEqual(manifest.mimetype, "application/manifest+json")

        with self.client.get("/sw.js") as worker:
            self.assertEqual(worker.status_code, 200)
            self.assertIn(b"addEventListener('fetch'", worker.data)
            self.assertIn(
                b"if (schedules.length) parts.push(fmtDays(schedules[0].days).toLowerCase());",
                js.data,
            )

    def test_logo_assets_are_served(self):
        with self.client.get("/static/logo.svg") as svg:
            self.assertEqual(svg.status_code, 200)
            self.assertEqual(svg.mimetype, "image/svg+xml")
            self.assertTrue(svg.data.startswith(b"<svg"))
        with self.client.get("/static/logo.png") as png:
            self.assertEqual(png.status_code, 200)
            self.assertEqual(png.mimetype, "image/png")
            self.assertTrue(png.data)

    def test_device_list_returns_configured_devices_and_state(self):
        webui.state[0] = True

        response = self.client.get("/api/devices")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json, [
            {"unit": 0, "name": "Test outlet", "state": True},
        ])

    def test_received_command_updates_one_configured_outlet(self):
        with patch.object(webui, "save_state") as save_state:
            webui.receive_command(987654, False, True, 0)

        self.assertTrue(webui.state[0])
        save_state.assert_called_once_with(webui.state)

    def test_received_group_command_updates_all_configured_outlets(self):
        webui.configured_devices = [
            {"unit": 0, "name": "First"},
            {"unit": 1, "name": "Second"},
        ]
        with patch.object(webui, "save_state") as save_state:
            webui.receive_command(987654, True, False, 15)

        self.assertEqual(webui.state[0], False)
        self.assertEqual(webui.state[1], False)
        save_state.assert_called_once_with(webui.state)

    def test_device_order_can_be_updated(self):
        webui.configured_devices[:] = [
            {"unit": 0, "name": "First"},
            {"unit": 1, "name": "Second"},
        ]
        with patch.object(webui, "save_devices") as save_devices:
            response = self.client.put(
                "/api/devices/order", json={"order": [1, 0]}
            )
        self.assertEqual(response.status_code, 200)
        self.assertEqual([d["unit"] for d in webui.configured_devices], [1, 0])
        save_devices.assert_called_once_with(webui.configured_devices)

    def test_device_order_rejects_invalid_units(self):
        response = self.client.put("/api/devices/order", json={"order": [1]})
        self.assertEqual(response.status_code, 400)
        response = self.client.put("/api/devices/order", json={"order": [0, 0]})
        self.assertEqual(response.status_code, 400)

    def test_switch_rejects_unknown_units_and_actions(self):
        self.assertEqual(self.client.post("/api/9/on").status_code, 400)
        self.assertEqual(self.client.post("/api/0/toggle").status_code, 400)

    def test_switch_applies_command(self):
        with patch.object(webui, "apply") as apply:
            response = self.client.post("/api/0/on")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json, {"ok": True})
        apply.assert_called_once_with(0, True)

    def test_pair_requires_name_and_adds_next_available_unit(self):
        self.assertEqual(
            self.client.post("/api/pair", json={"name": " "}).status_code,
            400,
        )

        with patch.object(webui, "transmit"), patch.object(webui, "save_devices"), \
                patch.object(webui, "save_state"):
            response = self.client.post("/api/pair", json={"name": " Kitchen "})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json, {"ok": True, "unit": 1})
        self.assertEqual(webui.configured_devices[-1], {
            "unit": 1, "name": "Kitchen",
        })
        self.assertTrue(webui.state[1])

    def test_device_can_be_renamed_and_removed_with_timers(self):
        with patch.object(webui, "save_devices"):
            response = self.client.patch("/api/devices/0", json={"name": "Kitchen"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(webui.configured_devices[0]["name"], "Kitchen")

        webui.timers["schedules"].append({
            "id": "schedule1", "unit": 0, "action": "on",
            "time": "08:00", "days": [0], "enabled": True,
        })
        with patch.object(webui, "save_devices"), patch.object(webui, "save_state"), \
                patch.object(webui, "save_timers"):
            response = self.client.delete("/api/devices/0")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(webui.configured_devices, [])
        self.assertEqual(webui.timers["schedules"], [])

    def test_schedule_can_be_updated(self):
        webui.timers["schedules"].append({
            "id": "schedule1", "unit": 0, "action": "on",
            "time": "08:00", "days": [0], "enabled": True,
        })
        with patch.object(webui, "save_timers"):
            response = self.client.patch(
                "/api/schedules/schedule1",
                json={"unit": 0, "action": "off", "time": "18:30", "days": [5, 6]},
            )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(webui.timers["schedules"][0]["time"], "18:30")
        self.assertEqual(webui.timers["schedules"][0]["days"], [5, 6])

    def test_countdown_can_be_added_read_and_deleted(self):
        with patch.object(webui, "save_timers"):
            response = self.client.post(
                "/api/countdowns",
                json={"unit": 0, "action": "off", "minutes": 5},
            )
        self.assertEqual(response.status_code, 200)
        countdown_id = response.json["ok"] and webui.timers["countdowns"][0]["id"]

        response = self.client.get("/api/timers")
        self.assertEqual(response.json["countdowns"][0]["name"], "Test outlet")
        self.assertGreaterEqual(response.json["countdowns"][0]["remaining"], 299)

        with patch.object(webui, "save_timers"):
            response = self.client.delete(f"/api/countdowns/{countdown_id}")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(webui.timers["countdowns"], [])

    def test_countdown_and_schedule_validation(self):
        self.assertEqual(self.client.post(
            "/api/countdowns",
            json={"unit": 0, "action": "off", "minutes": 0},
        ).status_code, 400)
        self.assertEqual(self.client.post(
            "/api/schedules",
            json={"unit": 0, "action": "on", "time": "25:00", "days": [1]},
        ).status_code, 400)
        self.assertEqual(self.client.post(
            "/api/schedules",
            json={"unit": 0, "action": "on", "time": "08:30", "days": []},
        ).status_code, 400)

    def test_schedule_can_be_toggled_and_deleted(self):
        with patch.object(webui, "save_timers"):
            response = self.client.post(
                "/api/schedules",
                json={"unit": 0, "action": "on", "time": "08:30", "days": [2, 1, 2]},
            )
        schedule_id = webui.timers["schedules"][0]["id"]
        self.assertEqual(webui.timers["schedules"][0]["days"], [1, 2])

        with patch.object(webui, "save_timers"):
            response = self.client.post(f"/api/schedules/{schedule_id}/toggle")
        self.assertEqual(response.status_code, 200)
        self.assertFalse(webui.timers["schedules"][0]["enabled"])

        with patch.object(webui, "save_timers"):
            response = self.client.delete(f"/api/schedules/{schedule_id}")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(webui.timers["schedules"], [])


if __name__ == "__main__":
    unittest.main()
