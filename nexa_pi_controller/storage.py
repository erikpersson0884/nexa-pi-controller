"""Persistence for configured devices, outlet state, and timers."""

import json
import os

from .config import DEVICES_FILE, ROOMS_FILE, STATE_FILE, TIMER_FILE

DEFAULT_FLOOR = {"id": "ground-floor", "name": "Ground floor"}


def _ensure_data_dir():
    os.makedirs(os.path.dirname(DEVICES_FILE), exist_ok=True)


def load_devices():
    try:
        with open(DEVICES_FILE) as f:
            devices = json.load(f)
        if not isinstance(devices, list):
            raise ValueError("device configuration must be a list")
        return [
            {"unit": int(d["unit"]), "name": str(d["name"])}
            for d in devices
            if 0 <= int(d["unit"]) <= 15 and str(d["name"]).strip()
        ]
    except FileNotFoundError:
        return []
    except Exception as e:
        print("Could not read devices file, using no devices:", e, flush=True)
        return []


def save_devices(devices):
    _ensure_data_dir()
    with open(DEVICES_FILE, "w") as f:
        json.dump(devices, f, indent=2)


def load_state():
    try:
        with open(STATE_FILE) as f:
            return {int(k): v for k, v in json.load(f).items()}
    except Exception:
        return {}


def save_state(state):
    try:
        _ensure_data_dir()
        with open(STATE_FILE, "w") as f:
            json.dump(state, f)
    except Exception:
        pass


def _migrate_units(entries):
    """Convert legacy single-"unit" entries to "units" lists in place."""
    migrated = False
    for entry in entries:
        if "units" not in entry and "unit" in entry:
            entry["units"] = [entry["unit"]]
            migrated = True
        if "unit" in entry:
            del entry["unit"]
            migrated = True
    return migrated


def load_timers():
    try:
        with open(TIMER_FILE) as f:
            data = json.load(f)
        timers = {
            "schedules": data.get("schedules", []),
            "countdowns": data.get("countdowns", []),
        }
    except Exception:
        return {"schedules": [], "countdowns": []}
    migrated = _migrate_units(timers["schedules"])
    migrated = _migrate_units(timers["countdowns"]) or migrated
    if migrated:
        save_timers(timers)
    return timers


def save_timers(timers):
    try:
        _ensure_data_dir()
        with open(TIMER_FILE, "w") as f:
            json.dump(timers, f)
    except Exception:
        pass


def load_map():
    try:
        with open(ROOMS_FILE) as f:
            data = json.load(f)
        if isinstance(data, list):
            floors = [dict(DEFAULT_FLOOR)]
            rooms = data
        elif isinstance(data, dict):
            floors = data.get("floors")
            rooms = data.get("rooms")
            if not isinstance(floors, list) or not isinstance(rooms, list):
                raise ValueError("map configuration must contain floor and room lists")
            if not floors:
                floors = [dict(DEFAULT_FLOOR)]
        else:
            raise ValueError("map configuration must be a list or object")
        floor_ids = {floor.get("id") for floor in floors if isinstance(floor, dict)}
        default_floor_id = floors[0].get("id") if floors and isinstance(floors[0], dict) else None
        for room in rooms:
            if isinstance(room, dict) and room.get("floor_id") not in floor_ids:
                room["floor_id"] = default_floor_id
        return floors, rooms
    except FileNotFoundError:
        return [dict(DEFAULT_FLOOR)], []
    except Exception as e:
        print("Could not read map file, using a default floor:", e, flush=True)
        return [dict(DEFAULT_FLOOR)], []


def save_map(floors, rooms):
    _ensure_data_dir()
    with open(ROOMS_FILE, "w") as f:
        json.dump({"floors": floors, "rooms": rooms}, f, indent=2)


def load_rooms():
    return load_map()[1]


def save_rooms(rooms):
    floors, _ = load_map()
    save_map(floors, rooms)
