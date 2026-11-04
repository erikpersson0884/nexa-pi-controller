import unittest
import re
from unittest.mock import patch

import webui


class WebUiTestCase(unittest.TestCase):
    def setUp(self):
        self.client = webui.app.test_client()
        self.client.application.config["WTF_CSRF_ENABLED"] = False
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
        self.assertIn('<details class="timers">', html)
        self.assertIn("<h3>Weekly schedule</h3>", html)
        self.assertNotIn('<details class="timers" open>', html)
        self.assertIn('id="pair-modal"', html)
        self.assertIn('id="pair-name"', html)
        self.assertIn('>Pair</button>', html)
        self.assertIn('function pairOutlet(event)', html)

    def test_homepage_contains_csrf_token_for_api_requests(self):
        response = self.client.get("/")

        self.assertIn('name="csrf-token"', response.get_data(as_text=True))

    def test_homepage_explains_when_no_outlets_have_been_added(self):
        webui.configured_devices = []

        response = self.client.get("/")

        self.assertIn(
            'No outlets configured',
            response.get_data(as_text=True),
        )
        self.assertIn(
            'Put a Nexa outlet in learning mode, then click "Add outlet" '
            'to pair it.',
            response.get_data(as_text=True),
        )
        self.assertIn('Pair an outlet to set timers', response.get_data(as_text=True))
        self.assertIn(
            'Add an outlet first, then you can create countdowns and weekly schedules.',
            response.get_data(as_text=True),
        )

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
