"""Persistence for configured devices, outlet state, and timers."""

import json
import os

from .config import DEVICES_FILE, STATE_FILE, TIMER_FILE


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
