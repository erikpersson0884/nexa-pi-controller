"""SQLite-backed local user accounts."""

import os
import sqlite3
import threading
from contextlib import contextmanager

from werkzeug.security import check_password_hash, generate_password_hash


class BootstrapRequiredError(RuntimeError):
    """Raised when an empty account store has no configured bootstrap admin."""


class DuplicateUsernameError(ValueError):
    """Raised when a username is already in use."""


class LastAdminError(ValueError):
    """Raised when an operation would remove the last active administrator."""


class UserNotFoundError(ValueError):
    """Raised when an account does not exist."""


_initialized_paths = set()
_initialize_lock = threading.Lock()
_USER_COLUMNS = (
    "id, username, password_hash, role, is_active, must_change_password, "
    "session_version, created_at"
)


@contextmanager
def _connect(database_path):
    path = os.path.abspath(os.fspath(database_path))
    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    connection = sqlite3.connect(path, timeout=5)
    connection.row_factory = sqlite3.Row
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def _user_from_row(row):
    if row is None:
        return None
    return {
        "id": row["id"],
        "username": row["username"],
        "password_hash": row["password_hash"],
        "role": row["role"],
        "is_active": bool(row["is_active"]),
        "must_change_password": bool(row["must_change_password"]),
        "session_version": row["session_version"],
        "created_at": row["created_at"],
    }


def initialize(database_path, bootstrap_username, bootstrap_password):
    path = os.path.abspath(os.fspath(database_path))
    if path in _initialized_paths and os.path.isfile(path):
        return
    with _initialize_lock:
        if path in _initialized_paths and os.path.isfile(path):
            return
        with _connect(path) as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    username TEXT NOT NULL COLLATE NOCASE UNIQUE,
                    password_hash TEXT NOT NULL,
                    role TEXT NOT NULL CHECK (role IN ('admin', 'operator')),
                    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
                    must_change_password INTEGER NOT NULL DEFAULT 0
                        CHECK (must_change_password IN (0, 1)),
                    session_version INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );
                CREATE TABLE IF NOT EXISTS auth_meta (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
                """
            )
            connection.execute("BEGIN IMMEDIATE")
            initialized = connection.execute(
                "SELECT value FROM auth_meta WHERE key = 'bootstrap_complete'"
            ).fetchone()
            if initialized is None:
                user_count = connection.execute("SELECT COUNT(*) FROM users").fetchone()[0]
                if user_count == 0:
                    username = bootstrap_username.strip() if isinstance(
                        bootstrap_username, str
                    ) else ""
                    if not username or not bootstrap_password:
                        raise BootstrapRequiredError(
                            "Configure AUTH_USERNAME and AUTH_PASSWORD to bootstrap the first admin"
                        )
                    connection.execute(
                        """
                        INSERT INTO users (username, password_hash, role)
                        VALUES (?, ?, 'admin')
                        """,
                        (username, generate_password_hash(bootstrap_password)),
                    )
                connection.execute(
                    "INSERT INTO auth_meta (key, value) VALUES ('bootstrap_complete', '1')"
                )
            active_admin = connection.execute(
                "SELECT 1 FROM users WHERE role = 'admin' AND is_active = 1 LIMIT 1"
            ).fetchone()
            if active_admin is None:
                raise LastAdminError("The user store has no active administrator")
            connection.commit()
        os.chmod(path, 0o600)
        _initialized_paths.add(path)


def get_user_by_id(database_path, user_id):
    with _connect(database_path) as connection:
        row = connection.execute(
            f"SELECT {_USER_COLUMNS} FROM users WHERE id = ?", (user_id,)
        ).fetchone()
    return _user_from_row(row)


def get_user_by_username(database_path, username):
    with _connect(database_path) as connection:
        row = connection.execute(
            f"SELECT {_USER_COLUMNS} FROM users WHERE username = ? COLLATE NOCASE",
            (username,),
        ).fetchone()
    return _user_from_row(row)


def list_users(database_path):
    with _connect(database_path) as connection:
        rows = connection.execute(
            f"SELECT {_USER_COLUMNS} FROM users ORDER BY username COLLATE NOCASE"
        ).fetchall()
    return [_user_from_row(row) for row in rows]


def verify_password(user, password):
    try:
        return check_password_hash(user["password_hash"], password)
    except (TypeError, ValueError):
        return False


def create_user(database_path, username, password, role, *, must_change_password=True):
    try:
        with _connect(database_path) as connection:
            cursor = connection.execute(
                """
                INSERT INTO users (
                    username, password_hash, role, must_change_password
                ) VALUES (?, ?, ?, ?)
                """,
                (username, generate_password_hash(password), role, int(must_change_password)),
            )
            user_id = cursor.lastrowid
    except sqlite3.IntegrityError as error:
        if "users.username" in str(error).lower() or "unique" in str(error).lower():
            raise DuplicateUsernameError(username) from error
        raise
    return get_user_by_id(database_path, user_id)


def set_username(database_path, user_id, username):
    try:
        with _connect(database_path) as connection:
            cursor = connection.execute(
                "UPDATE users SET username = ? WHERE id = ?", (username, user_id)
            )
            if cursor.rowcount == 0:
                raise UserNotFoundError(user_id)
    except sqlite3.IntegrityError as error:
        if "users.username" in str(error).lower() or "unique" in str(error).lower():
            raise DuplicateUsernameError(username) from error
        raise
    return get_user_by_id(database_path, user_id)


def update_user(database_path, user_id, role=None, is_active=None):
    with _connect(database_path) as connection:
        connection.execute("BEGIN IMMEDIATE")
        row = connection.execute(
            "SELECT id, role, is_active FROM users WHERE id = ?", (user_id,)
        ).fetchone()
        if row is None:
            raise UserNotFoundError(user_id)
        next_role = role if role is not None else row["role"]
        next_active = int(is_active) if is_active is not None else row["is_active"]
        removes_admin = (
            row["role"] == "admin"
            and row["is_active"]
            and (next_role != "admin" or not next_active)
        )
        if removes_admin:
            count = connection.execute(
                "SELECT COUNT(*) FROM users WHERE role = 'admin' AND is_active = 1"
            ).fetchone()[0]
            if count <= 1:
                raise LastAdminError("At least one active administrator is required")
        changed = next_role != row["role"] or next_active != row["is_active"]
        connection.execute(
            """
            UPDATE users
            SET role = ?, is_active = ?, session_version = session_version + ?
            WHERE id = ?
            """,
            (next_role, next_active, int(changed), user_id),
        )
    return get_user_by_id(database_path, user_id)


def set_password(database_path, user_id, password, must_change_password=False):
    with _connect(database_path) as connection:
        cursor = connection.execute(
            """
            UPDATE users
            SET password_hash = ?, must_change_password = ?,
                session_version = session_version + 1
            WHERE id = ?
            """,
            (generate_password_hash(password), int(must_change_password), user_id),
        )
        if cursor.rowcount == 0:
            raise UserNotFoundError(user_id)
    return get_user_by_id(database_path, user_id)
