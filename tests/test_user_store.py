import os
import sqlite3
import tempfile
import unittest
from contextlib import closing

from nexa_pi_controller import user_store


class UserStoreTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.database = os.path.join(self.directory.name, "users.sqlite3")

    def test_imports_configured_admin_once(self):
        user_store.initialize(self.database, "admin", "initial-passphrase")
        initial = user_store.get_user_by_username(self.database, "admin")

        user_store.initialize(self.database, "replacement", "different-password")

        users = user_store.list_users(self.database)
        self.assertEqual(len(users), 1)
        self.assertEqual(users[0]["id"], initial["id"])
        self.assertTrue(user_store.verify_password(initial, "initial-passphrase"))
        self.assertFalse(user_store.verify_password(initial, "different-password"))

    def test_bootstrap_can_be_retried_after_missing_password(self):
        with self.assertRaises(user_store.BootstrapRequiredError):
            user_store.initialize(self.database, "admin", None)

        user_store.initialize(self.database, "admin", "initial-passphrase")

        self.assertIsNotNone(
            user_store.get_user_by_username(self.database, "admin")
        )

    def test_last_active_admin_cannot_be_deactivated(self):
        user_store.initialize(self.database, "admin", "initial-passphrase")
        admin = user_store.get_user_by_username(self.database, "admin")

        with self.assertRaises(user_store.LastAdminError):
            user_store.update_user(
                self.database, admin["id"], is_active=False
            )

        self.assertTrue(
            user_store.get_user_by_id(self.database, admin["id"])["is_active"]
        )

    def test_existing_accounts_skip_welcome_but_new_accounts_receive_it(self):
        with closing(sqlite3.connect(self.database)) as connection, connection:
            connection.executescript("""
                CREATE TABLE users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    username TEXT NOT NULL COLLATE NOCASE UNIQUE,
                    password_hash TEXT NOT NULL,
                    role TEXT NOT NULL,
                    is_active INTEGER NOT NULL DEFAULT 1,
                    must_change_password INTEGER NOT NULL DEFAULT 0,
                    session_version INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );
                INSERT INTO users (username, password_hash, role)
                VALUES ('admin', 'existing-hash', 'admin');
            """)
        user_store.initialize(self.database, "admin", "initial-passphrase")
        admin = user_store.get_user_by_username(self.database, "admin")
        self.assertTrue(admin["welcome_completed"])
        new = user_store.create_user(self.database, "new-user", "password", "operator")
        self.assertFalse(new["welcome_completed"])
        user_store.complete_welcome(self.database, new["id"])
        self.assertTrue(user_store.get_user_by_id(self.database, new["id"])["welcome_completed"])
        user_store.complete_welcome(self.database, new["id"])
        self.assertTrue(user_store.get_user_by_id(self.database, new["id"])["welcome_completed"])

    def test_bootstrap_admin_receives_welcome(self):
        user_store.initialize(self.database, "admin", "initial-passphrase")
        self.assertFalse(user_store.get_user_by_username(self.database, "admin")["welcome_completed"])
