"""Start a mock-GPIO development instance with isolated example data."""

import json
import os
import secrets
import time
from datetime import datetime, timedelta
from pathlib import Path

DEV_DATA_DIR = Path(__file__).resolve().parent.parent / ".dev-data"


def seed_data(data_dir):
    data_dir = Path(data_dir)
    paths = {
        "devices": data_dir / "nexa_devices.json",
        "state": data_dir / "nexa_state.json",
        "timers": data_dir / "nexa_timers.json",
        "rooms": data_dir / "nexa_rooms.json",
    }
    if any(path.exists() for path in paths.values()):
        return False

    data = {
        "devices": [
            {"unit": 0, "name": "Living room lamp"},
            {"unit": 1, "name": "Window lights"},
            {"unit": 2, "name": "Kitchen lamp"},
            {"unit": 3, "name": "Bedroom lamp"},
        ],
        "state": {0: True, 1: False, 2: True, 3: False},
        "timers": {
            "schedules": [
                {"id": "evening-on", "units": [0, 1], "action": "on",
                 "time": "18:00", "days": [0, 1, 2, 3, 4, 5, 6], "enabled": True},
                {"id": "night-off", "units": [0, 1, 2], "action": "off",
                 "time": "23:00", "days": [0, 1, 2, 3, 4], "enabled": False},
            ],
            "countdowns": [
                {"id": "example-countdown", "units": [2], "action": "off",
                 "run_at": time.time() + 3600},
            ],
        },
        "rooms": {
            "floors": [
                {"id": "ground-floor", "name": "Ground floor"},
                {"id": "upper-floor", "name": "Upper floor"},
            ],
            "rooms": [
                {"id": "living-room", "floor_id": "ground-floor", "name": "Living room",
                 "x": 5, "y": 5, "w": 45, "h": 40, "units": [0, 1]},
                {"id": "kitchen", "floor_id": "ground-floor", "name": "Kitchen",
                 "x": 55, "y": 5, "w": 35, "h": 40, "units": [2]},
                {"id": "bedroom", "floor_id": "upper-floor", "name": "Bedroom",
                 "x": 5, "y": 5, "w": 45, "h": 40, "units": [3]},
            ],
        },
    }
    data_dir.mkdir(parents=True, exist_ok=True)
    for key, path in paths.items():
        with path.open("x", encoding="utf-8") as file:
            json.dump(data[key], file, indent=2)
    return True


def seed_users(data_dir, bootstrap_username, bootstrap_password):
    from . import user_store

    data_dir = Path(data_dir)
    marker = data_dir / ".users-seeded"
    if marker.exists():
        return False

    users_file = data_dir / "nexa_users.sqlite3"
    user_store.initialize(users_file, bootstrap_username, bootstrap_password)
    sample_users = (
        ("demo-admin-1", "admin", True),
        ("demo-admin-2", "admin", False),
        ("demo-operator-1", "operator", True),
        ("demo-operator-2", "operator", False),
    )
    for username, role, must_change_password in sample_users:
        if user_store.get_user_by_username(users_file, username):
            print(f"Existing development user {username} was not changed.", flush=True)
            continue
        password = secrets.token_urlsafe(18)
        user_store.create_user(
            users_file, username, password, role, must_change_password=must_change_password
        )
        password_type = "temporary password" if must_change_password else "password"
        print(f"Development user {username} ({role}) {password_type}: {password}", flush=True)
    with marker.open("x", encoding="utf-8") as file:
        file.write("Development users seeded.\n")
    return True


def main():
    os.environ["DATA_DIR"] = str(DEV_DATA_DIR)
    os.environ["GPIO_MODE"] = "mock"
    if seed_data(DEV_DATA_DIR):
        print(f"Created example development data in {DEV_DATA_DIR}", flush=True)
    else:
        print(f"Using existing development data in {DEV_DATA_DIR}; seeding skipped", flush=True)

    from . import user_store
    from .webui import (
        AUTH_PASSWORD, AUTH_USERNAME, HOST, PORT, app, receiver_log,
        start_background_services,
    )

    try:
        seed_users(DEV_DATA_DIR, AUTH_USERNAME, AUTH_PASSWORD)
    except user_store.BootstrapRequiredError as error:
        print(f"Development users not seeded: {error}", flush=True)

    now = datetime.now()
    if not receiver_log:
        for minutes_ago, group, on, unit in (
            (5, True, False, 0),
            (3, False, True, 0),
            (1, False, False, 1),
        ):
            receiver_log.append({
                "time": (now - timedelta(minutes=minutes_ago)).strftime("%Y-%m-%d %H:%M:%S"),
                "transmitter": 987654,
                "group": group,
                "on": on,
                "unit": unit,
            })

    start_background_services()
    app.run(host=HOST, port=PORT)


if __name__ == "__main__":
    main()
