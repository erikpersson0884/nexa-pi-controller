import unittest
import re
import os
import tempfile
from unittest.mock import call, patch

os.environ.setdefault("SECRET_KEY", "test-secret-key")
os.environ.setdefault("AUTH_USERNAME", "admin")
os.environ.setdefault("AUTH_PASSWORD", "test-password")

from nexa_pi_controller import webui


class WebUiTestCase(unittest.TestCase):
    def setUp(self):
        self.previous_users_file = webui.USERS_FILE
        self.previous_username = webui.AUTH_USERNAME
        self.previous_password = webui.AUTH_PASSWORD
        self.addCleanup(setattr, webui, "USERS_FILE", self.previous_users_file)
        self.addCleanup(setattr, webui, "AUTH_USERNAME", self.previous_username)
        self.addCleanup(setattr, webui, "AUTH_PASSWORD", self.previous_password)
        self.user_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.user_directory.cleanup)
        webui.USERS_FILE = os.path.join(self.user_directory.name, "users.sqlite3")
        webui.AUTH_USERNAME = "admin"
        webui.AUTH_PASSWORD = "test-password"
        webui.user_store.initialize(
            webui.USERS_FILE, webui.AUTH_USERNAME, webui.AUTH_PASSWORD
        )
        self.admin = webui.user_store.get_user_by_username(
            webui.USERS_FILE, "admin"
        )
        self.client = webui.app.test_client()
        self.client.application.config["WTF_CSRF_ENABLED"] = False
        with self.client.session_transaction() as session:
            session["user_id"] = self.admin["id"]
            session["session_version"] = self.admin["session_version"]
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
        self.assertIn('<h2 id="timer-sheet-title">All timers</h2>', html)
        self.assertIn('id="editor-sheet"', html)
        self.assertIn('id="pair-modal"', html)
        self.assertIn('id="pair-name"', html)
        self.assertIn('id="rename-modal"', html)
        self.assertIn('id="remove-modal"', html)
        self.assertIn('aria-label="Current account"', html)
        self.assertNotIn("Signed in as", html)
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

    def test_api_key_authenticates_api_requests_without_a_browser_session(self):
        webui.API_KEY = "test-api-key"
        self.addCleanup(setattr, webui, "API_KEY", None)
        with self.client.session_transaction() as session:
            session.clear()

        response = self.client.get(
            "/api/devices",
            headers={"Authorization": "Bearer test-api-key"},
        )

        self.assertEqual(response.status_code, 200)

    def test_api_key_can_make_mutating_requests_without_a_csrf_token(self):
        webui.API_KEY = "test-api-key"
        self.addCleanup(setattr, webui, "API_KEY", None)
        self.client.application.config["WTF_CSRF_ENABLED"] = True
        with self.client.session_transaction() as session:
            session.clear()

        with patch.object(webui, "apply") as apply:
            response = self.client.post(
                "/api/0/on",
                headers={"Authorization": "Bearer test-api-key"},
            )

        self.assertEqual(response.status_code, 200)
        apply.assert_called_once_with(0, True)

    def test_api_rejects_an_invalid_api_key(self):
        webui.API_KEY = "test-api-key"
        self.addCleanup(setattr, webui, "API_KEY", None)

        response = self.client.get(
            "/api/devices",
            headers={"Authorization": "Bearer wrong-key"},
        )

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
            self.assertEqual(session["user_id"], self.admin["id"])
            self.assertIn("session_version", session)

    def test_temporary_password_requires_change_before_app_access(self):
        operator = webui.user_store.create_user(
            webui.USERS_FILE, "operator", "temporary-passphrase", "operator"
        )
        with self.client.session_transaction() as session:
            session.clear()
        login = self.client.post("/login", data={
            "username": "operator", "password": "temporary-passphrase",
        })
        self.assertEqual(login.status_code, 302)
        self.assertEqual(login.location, "/account/password")
        self.assertEqual(self.client.get("/").location, "/account/password")

        changed = self.client.post("/account/password", data={
            "new_password": "123456",
            "confirm_password": "123456",
        })
        self.assertEqual(changed.status_code, 302)
        self.assertEqual(self.client.get("/").status_code, 200)
        updated = webui.user_store.get_user_by_id(
            webui.USERS_FILE, operator["id"]
        )
        self.assertFalse(updated["must_change_password"])

    def test_password_change_has_a_cancel_action(self):
        response = self.client.get("/account/password")
        html = response.get_data(as_text=True)
        self.assertIn('href="/#settings"', html)
        self.assertIn('href="/#settings">‹ Settings</a>', html)
        self.assertIn('<header class="topbar">', html)
        self.assertIn("<h1>Change password</h1>", html)

        with self.client.session_transaction() as session:
            session.clear()
        temporary = webui.user_store.create_user(
            webui.USERS_FILE, "temporary", "temporary-passphrase", "operator"
        )
        with self.client.session_transaction() as session:
            session["user_id"] = temporary["id"]
            session["session_version"] = temporary["session_version"]
        response = self.client.get("/account/password")
        html = response.get_data(as_text=True)
        self.assertIn("<h1>Set your password</h1>", html)
        self.assertIn('form="cancel-form">Cancel and sign out</button>', html)

        cancelled = self.client.post("/logout")
        self.assertEqual(cancelled.status_code, 302)
        page = self.client.get("/")
        self.assertEqual(page.status_code, 302)
        self.assertTrue(page.location.startswith("/login?"))
        self.assertNotIn("password", page.location)

    def test_admin_can_create_users_with_temporary_passwords(self):
        response = self.client.post("/admin/users", data={
            "username": "new-operator",
            "role": "operator",
            "temporary_password": "abcdef",
        })
        self.assertEqual(response.status_code, 302)
        created = webui.user_store.get_user_by_username(
            webui.USERS_FILE, "new-operator"
        )
        self.assertEqual(created["role"], "operator")
        self.assertTrue(created["must_change_password"])

    def test_temporary_password_requires_at_least_six_characters(self):
        response = self.client.post("/admin/users", data={
            "username": "short-password",
            "role": "operator",
            "temporary_password": "abcde",
        })

        self.assertEqual(response.status_code, 302)
        self.assertIn("create=1", response.location)
        self.assertIsNone(
            webui.user_store.get_user_by_username(
                webui.USERS_FILE, "short-password"
            )
        )

    def test_account_creation_is_opened_from_a_button(self):
        response = self.client.get("/admin/users")
        html = response.get_data(as_text=True)
        self.assertIn('<header class="topbar">', html)
        self.assertIn("<h1>User management</h1>", html)
        self.assertIn("1 account (1 active) · Signed in as admin", html)
        self.assertIn('href="/#settings">‹ Settings</a>', html)
        self.assertIn('id="open-create-account"', html)
        self.assertIn('<dialog id="create-account-dialog"', html)
        self.assertIn('src="/static/users.js"', html)

        with self.client.get("/static/users.js") as script:
            self.assertEqual(script.status_code, 200)
            self.assertIn(b"createAccountDialog.showModal()", script.data)

    def test_user_cards_keep_self_controls_out_and_other_actions_in_the_menu(self):
        response = self.client.get("/admin/users")
        html = response.get_data(as_text=True)
        current_card = html.split(
            '<article class="account-panel user-panel user-current-card">', 1
        )[1].split("</article>", 1)[0]
        self.assertIn('<span class="user-role-badge">Admin</span>', current_card)
        self.assertIn('href="/account/password">Change password', current_card)
        self.assertNotIn("Save role", current_card)
        self.assertNotIn("Deactivate", current_card)
        self.assertNotIn("disabled", current_card)

        webui.user_store.create_user(
            webui.USERS_FILE, "operator", "temporary-passphrase", "operator"
        )
        response = self.client.get("/admin/users")
        html = response.get_data(as_text=True)
        self.assertIn("2 accounts (2 active) · Signed in as admin", html)
        self.assertIn('aria-label="More actions for operator"', html)
        self.assertIn("Password change required", html)
        self.assertIn("Deactivate account", html)
        self.assertIn('class="user-role-select"', html)
        self.assertIn('id="reset-password-dialog-2"', html)

    def test_account_cards_put_current_user_first_then_inactive_users_last(self):
        webui.user_store.create_user(
            webui.USERS_FILE, "active-zulu", "temporary-passphrase", "operator"
        )
        webui.user_store.create_user(
            webui.USERS_FILE, "inactive-user", "temporary-passphrase", "operator"
        )
        webui.user_store.create_user(
            webui.USERS_FILE, "active-alpha", "temporary-passphrase", "operator"
        )
        inactive = webui.user_store.get_user_by_username(
            webui.USERS_FILE, "inactive-user"
        )
        webui.user_store.update_user(
            webui.USERS_FILE, inactive["id"], is_active=False
        )

        response = self.client.get("/admin/users")
        rendered_order = re.findall(
            r'<article class="account-panel user-panel(?: user-current-card)?">.*?<h3>([^<]+)</h3>',
            response.get_data(as_text=True),
            re.DOTALL,
        )

        self.assertEqual(
            rendered_order,
            ["admin", "active-alpha", "active-zulu", "inactive-user"],
        )

    def test_invalid_account_creation_reopens_the_dialog(self):
        response = self.client.post("/admin/users", data={
            "username": "ab",
            "role": "operator",
            "temporary_password": "temporary-passphrase",
        })

        self.assertEqual(response.status_code, 302)
        self.assertIn("create=1", response.location)

    def test_operator_cannot_manage_user_accounts(self):
        operator = webui.user_store.create_user(
            webui.USERS_FILE, "operator", "temporary-passphrase", "operator"
        )
        webui.user_store.set_password(
            webui.USERS_FILE, operator["id"], "operator-password", False
        )
        operator = webui.user_store.get_user_by_id(
            webui.USERS_FILE, operator["id"]
        )
        with self.client.session_transaction() as session:
            session["user_id"] = operator["id"]
            session["session_version"] = operator["session_version"]

        self.assertEqual(self.client.get("/admin/users").status_code, 403)

    def test_last_active_admin_cannot_be_deactivated(self):
        invalid = self.client.post(
            f"/admin/users/{self.admin['id']}/active",
            data={"active": "invalid"},
        )
        self.assertEqual(invalid.status_code, 302)
        self.assertTrue(
            webui.user_store.get_user_by_id(
                webui.USERS_FILE, self.admin["id"]
            )["is_active"]
        )

        response = self.client.post(
            f"/admin/users/{self.admin['id']}/active",
            data={"active": "false"},
        )
        self.assertEqual(response.status_code, 302)
        admin = webui.user_store.get_user_by_id(
            webui.USERS_FILE, self.admin["id"]
        )
        self.assertTrue(admin["is_active"])

    def test_api_key_does_not_authorize_account_management(self):
        webui.API_KEY = "test-api-key"
        self.addCleanup(setattr, webui, "API_KEY", None)
        with self.client.session_transaction() as session:
            session.clear()

        response = self.client.get(
            "/admin/users",
            headers={"Authorization": "Bearer test-api-key"},
        )
        self.assertEqual(response.status_code, 302)

    def test_login_rejects_wrong_password(self):
        with self.client.session_transaction() as session:
            session.clear()
        response = self.client.post(
            "/login",
            data={"username": "admin", "password": "wrong-password"},
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

    def test_all_commands_transmit_and_update_each_configured_outlet(self):
        webui.configured_devices = [
            {"unit": 0, "name": "First"},
            {"unit": 2, "name": "Second"},
        ]
        with patch.object(webui, "transmit") as transmit, \
                patch.object(webui, "save_state"), \
                patch.object(webui.time, "sleep"):
            for action, on in (("off", False), ("on", True)):
                with self.subTest(action=action):
                    transmit.reset_mock()
                    response = self.client.post(f"/api/all/{action}")
                    self.assertEqual(response.status_code, 200)
                    self.assertEqual(response.json, {"ok": True})
                    self.assertEqual(transmit.call_args_list, [call(on, 0), call(on, 2)])
                    self.assertEqual(webui.state, {0: on, 2: on})

    def test_all_on_reports_transmission_errors(self):
        with patch.object(webui, "transmit", side_effect=RuntimeError("Radio failed")):
            response = self.client.post("/api/all/on")

        self.assertEqual(response.status_code, 500)
        self.assertEqual(response.json, {"error": "Radio failed"})
        self.assertEqual(webui.state, {})

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

    def test_device_can_be_renamed_and_reassigned(self):
        webui.state[0] = True
        webui.timers["schedules"].append({
            "id": "schedule1", "units": [0, 1], "action": "off",
            "time": "08:00", "days": [0], "enabled": True,
        })
        with patch.object(webui, "save_devices"), \
                patch.object(webui, "save_state"), \
                patch.object(webui, "save_timers"):
            response = self.client.patch(
                "/api/devices/0", json={"name": "Kitchen", "unit": 2}
            )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(webui.configured_devices[0], {"unit": 2, "name": "Kitchen"})
        self.assertTrue(webui.state[2])
        self.assertEqual(webui.timers["schedules"][0]["units"], [2, 1])

    def test_device_reassignment_rejects_used_unit(self):
        webui.configured_devices.append({"unit": 1, "name": "Second"})
        response = self.client.patch(
            "/api/devices/0", json={"name": "First", "unit": 1}
        )
        self.assertEqual(response.status_code, 409)

    def test_pair_can_use_requested_unit(self):
        with patch.object(webui, "transmit"), patch.object(webui, "save_devices"), \
                patch.object(webui, "save_state"):
            response = self.client.post(
                "/api/pair", json={"name": "Kitchen", "unit": 5}
            )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json, {"ok": True, "unit": 5})

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
        with patch.object(webui, "save_devices"), \
                patch.object(webui, "save_state"), \
                patch.object(webui, "save_timers"):
            response = self.client.patch("/api/devices/0", json={"name": "Kitchen"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(webui.configured_devices[0]["name"], "Kitchen")

        webui.timers["schedules"].append({
            "id": "schedule1", "units": [0], "action": "on",
            "time": "08:00", "days": [0], "enabled": True,
        })
        webui.timers["schedules"].append({
            "id": "schedule2", "units": [0, 1], "action": "on",
            "time": "09:00", "days": [0], "enabled": True,
        })
        webui.configured_devices.append({"unit": 1, "name": "Second"})
        with patch.object(webui, "save_devices"), patch.object(webui, "save_state"), \
                patch.object(webui, "save_timers"):
            response = self.client.delete("/api/devices/0")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(webui.configured_devices, [{"unit": 1, "name": "Second"}])
        self.assertEqual(
            [(s["id"], s["units"]) for s in webui.timers["schedules"]],
            [("schedule2", [1])],
        )

    def test_schedule_can_be_updated(self):
        webui.configured_devices.append({"unit": 1, "name": "Second"})
        webui.timers["schedules"].append({
            "id": "schedule1", "units": [0], "action": "on",
            "time": "08:00", "days": [0], "enabled": True,
        })
        with patch.object(webui, "save_timers"):
            response = self.client.put(
                "/api/schedules/schedule1",
                json={"units": [1, 0], "action": "off", "time": "18:30", "days": [5, 6]},
            )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(webui.timers["schedules"][0]["time"], "18:30")
        self.assertEqual(webui.timers["schedules"][0]["days"], [5, 6])
        self.assertEqual(webui.timers["schedules"][0]["units"], [1, 0])
        self.assertEqual(self.client.put(
            "/api/schedules/missing",
            json={"units": [0], "action": "off", "time": "18:30", "days": [5]},
        ).status_code, 404)

    def test_legacy_unit_key_is_still_accepted(self):
        with patch.object(webui, "save_timers"):
            response = self.client.post(
                "/api/schedules",
                json={"unit": 0, "action": "on", "time": "08:30", "days": [1]},
            )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(webui.timers["schedules"][0]["units"], [0])

    def test_timers_require_valid_units(self):
        for units in ([], [9], [0, 9], ["0"], "0", [True]):
            response = self.client.post("/api/schedules", json={
                "units": units, "action": "on", "time": "08:30", "days": [1],
            })
            self.assertEqual(response.status_code, 400, units)
            response = self.client.post("/api/countdowns", json={
                "units": units, "action": "on", "minutes": 5,
            })
            self.assertEqual(response.status_code, 400, units)

    def test_countdown_can_be_added_read_and_deleted(self):
        webui.configured_devices.append({"unit": 1, "name": "Second"})
        with patch.object(webui, "save_timers"):
            response = self.client.post(
                "/api/countdowns",
                json={"units": [0, 1], "action": "off", "minutes": 5},
            )
        self.assertEqual(response.status_code, 200)
        countdown_id = response.json["ok"] and webui.timers["countdowns"][0]["id"]

        response = self.client.get("/api/timers")
        countdown = response.json["countdowns"][0]
        self.assertEqual(countdown["units"], [0, 1])
        self.assertEqual(countdown["names"], ["Test outlet", "Second"])
        self.assertGreaterEqual(countdown["remaining"], 299)

        with patch.object(webui, "save_timers"):
            response = self.client.delete(f"/api/countdowns/{countdown_id}")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(webui.timers["countdowns"], [])

    def test_countdown_and_schedule_validation(self):
        self.assertEqual(self.client.post(
            "/api/countdowns",
            json={"units": [0], "action": "off", "minutes": 0},
        ).status_code, 400)
        self.assertEqual(self.client.post(
            "/api/schedules",
            json={"units": [0], "action": "on", "time": "25:00", "days": [1]},
        ).status_code, 400)
        self.assertEqual(self.client.post(
            "/api/schedules",
            json={"units": [0], "action": "on", "time": "08:30", "days": []},
        ).status_code, 400)

    def test_schedule_can_be_toggled_and_deleted(self):
        with patch.object(webui, "save_timers"):
            response = self.client.post(
                "/api/schedules",
                json={"units": [0], "action": "on", "time": "08:30", "days": [2, 1, 2]},
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

    def test_rooms_are_validated_saved_and_switched(self):
        webui.configured_devices = [{"unit": 0, "name": "A"}, {"unit": 1, "name": "B"}]
        room = {"id": "r1", "name": " Kitchen ", "x": 0, "y": 0, "w": 40, "h": 30, "units": [0, 1, 1]}
        old = webui.configured_rooms
        webui.configured_rooms = []
        try:
            with patch.object(webui.storage, "save_map") as save:
                self.assertEqual(self.client.put("/api/rooms", json=[room]).status_code, 200)
            save.assert_called_once()
            self.assertEqual(self.client.get("/api/rooms").get_json()[0]["units"], [0, 1])
            self.assertEqual(webui.configured_rooms[0]["name"], "Kitchen")

            for bad in ({**room, "units": [9]}, {**room, "w": 150}, {**room, "name": " "}):
                self.assertEqual(self.client.put("/api/rooms", json=[bad]).status_code, 400)
            self.assertEqual(self.client.put("/api/rooms", json=[room, room]).status_code, 400)

            with patch.object(webui, "apply") as apply, patch.object(webui.time, "sleep"):
                self.assertEqual(self.client.post("/api/rooms/r1/on").status_code, 200)
                self.assertEqual(self.client.post("/api/rooms/nope/on").status_code, 404)
            apply.assert_has_calls([call(0, True), call(1, True)])

            with patch.object(webui.storage, "save_map"), \
                    patch.object(webui, "save_devices"), patch.object(webui, "save_state"):
                self.client.delete("/api/devices/1")
            self.assertEqual(webui.configured_rooms[0]["units"], [0])
        finally:
            webui.configured_rooms = old

    def test_map_api_saves_multiple_floors_and_rejects_invalid_floor_references(self):
        old_floors = webui.configured_floors
        old_rooms = webui.configured_rooms
        webui.configured_floors = [{"id": "ground-floor", "name": "Ground floor"}]
        webui.configured_rooms = []
        floors = [
            {"id": "ground-floor", "name": "Ground floor"},
            {"id": "upper", "name": "Upper floor"},
        ]
        rooms = [
            {"id": "r1", "floor_id": "ground-floor", "name": "Hall",
             "x": 0, "y": 0, "w": 30, "h": 30, "units": []},
            {"id": "r2", "floor_id": "upper", "name": "Bedroom",
             "x": 0, "y": 0, "w": 30, "h": 30, "units": []},
        ]
        try:
            with patch.object(webui.storage, "save_map") as save:
                response = self.client.put("/api/map", json={"floors": floors, "rooms": rooms})
            self.assertEqual(response.status_code, 200)
            save.assert_called_once_with(floors, rooms)
            self.assertEqual(self.client.get("/api/map").get_json(),
                             {"floors": floors, "rooms": rooms})

            invalid_maps = [
                {"floors": [], "rooms": []},
                {"floors": floors, "rooms": [{**rooms[0], "floor_id": "missing"}]},
                {"floors": [floors[0], floors[0]], "rooms": []},
            ]
            for invalid_map in invalid_maps:
                self.assertEqual(self.client.put("/api/map", json=invalid_map).status_code, 400)
        finally:
            webui.configured_floors = old_floors
            webui.configured_rooms = old_rooms


if __name__ == "__main__":
    unittest.main()
