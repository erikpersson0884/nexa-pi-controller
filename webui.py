#!/usr/bin/env python3
# Web UI with outlet pairing and timers for Nexa outlets on a Raspberry Pi 5
# Run: python3 webui.py   then open http://<pi-ip>:8080

import re
import os
import secrets
import threading
import time
import uuid

from flask import Flask, jsonify, render_template, request
from flask_wtf.csrf import CSRFProtect

import config
import radio
import scheduler as scheduler_module
import storage

# Re-export configuration and legacy helpers for callers importing webui.
PORT = config.PORT
HOST = config.HOST
CHIP = config.CHIP
PIN = config.PIN
TX_ID = config.TX_ID
T = config.T
REPEAT = config.REPEAT
PROJECT_DIR = config.PROJECT_DIR
DATA_DIR = config.DATA_DIR
STATE_FILE = config.STATE_FILE
DEVICES_FILE = config.DEVICES_FILE
TIMER_FILE = config.TIMER_FILE

tx_lock = radio.tx_lock
timer_lock = threading.Lock()   # protects the timers dict
app = Flask(__name__)
app.config["SECRET_KEY"] = os.getenv("SECRET_KEY", secrets.token_hex(32))
csrf = CSRFProtect()
csrf.init_app(app)


# ---------- Legacy-compatible storage/radio wrappers ----------
load_devices = storage.load_devices
load_state = storage.load_state
load_timers = storage.load_timers
save_devices = storage.save_devices

configured_devices = storage.load_devices()
state = storage.load_state()
timers = storage.load_timers()
last_fired = {}   # schedule id -> "YYYY-MM-DD HH:MM" (prevents double firing)

def save_state(st):
    storage.save_state(st)


def save_timers():
    storage.save_timers(timers)


def transmit(on, unit, group=0):
    return radio.transmit(on, unit, group)


def apply(unit, on):
    return radio.apply(unit, on, state, save_state, transmit)


def scheduler():
    return scheduler_module.scheduler(
        timers, apply, save_timers, timer_lock, last_fired
    )


# ---------- Web page ----------



# ---------- Helpers ----------
def device_name(unit):
    for d in configured_devices:
        if d["unit"] == unit:
            return d["name"]
    return "Unit " + str(unit)


def valid_unit(unit):
    return unit in [d["unit"] for d in configured_devices]


# ---------- Routes: switching and pairing ----------
@app.get("/")
def index():
    return render_template("index.html")


@app.get("/api/devices")
def device_list():
    return jsonify([
        {"unit": d["unit"], "name": d["name"], "state": state.get(d["unit"])}
        for d in configured_devices
    ])


@app.post("/api/<int:unit>/<action>")
def switch(unit, action):
    if action not in ("on", "off") or not valid_unit(unit):
        return jsonify(error="bad request"), 400
    try:
        apply(unit, action == "on")
    except Exception as e:
        return jsonify(error=str(e)), 500
    return jsonify(ok=True)


@app.post("/api/pair")
def pair():
    data = request.get_json(silent=True) or {}
    name = data.get("name")
    if not isinstance(name, str) or not name.strip():
        return jsonify(error="name is required"), 400

    used_units = {d["unit"] for d in configured_devices}
    available_units = [u for u in range(16) if u not in used_units]
    if not available_units:
        return jsonify(error="all 16 Nexa units are already in use"), 409

    unit = available_units[0]
    try:
        transmit(True, unit)
        configured_devices.append({"unit": unit, "name": name.strip()})
        save_devices(configured_devices)
        state[unit] = True
        save_state(state)
    except Exception as e:
        return jsonify(error=str(e)), 500
    return jsonify(ok=True, unit=unit)


@app.post("/api/all/off")
def all_off():
    try:
        for d in configured_devices:
            apply(d["unit"], False)
            time.sleep(0.2)
    except Exception as e:
        return jsonify(error=str(e)), 500
    return jsonify(ok=True)


# ---------- Routes: timers ----------
@app.get("/api/timers")
def get_timers():
    now = time.time()
    with timer_lock:
        schedules = [
            {**s, "name": device_name(s["unit"])} for s in timers["schedules"]
        ]
        countdowns = [
            {**c, "name": device_name(c["unit"]),
             "remaining": max(0, int(c["run_at"] - now))}
            for c in timers["countdowns"]
        ]
    schedules.sort(key=lambda s: s["time"])
    countdowns.sort(key=lambda c: c["run_at"])
    return jsonify(schedules=schedules, countdowns=countdowns)


@app.post("/api/countdowns")
def add_countdown():
    data = request.get_json(silent=True) or {}
    unit, action, minutes = data.get("unit"), data.get("action"), data.get("minutes")
    if not isinstance(unit, int) or not valid_unit(unit):
        return jsonify(error="Unknown outlet"), 400
    if action not in ("on", "off"):
        return jsonify(error="Action must be on or off"), 400
    if not isinstance(minutes, int) or not 1 <= minutes <= 1440:
        return jsonify(error="Minutes must be between 1 and 1440"), 400
    with timer_lock:
        timers["countdowns"].append({
            "id": uuid.uuid4().hex[:8],
            "unit": unit,
            "action": action,
            "run_at": time.time() + minutes * 60,
        })
        save_timers()
    return jsonify(ok=True)


@app.delete("/api/countdowns/<cid>")
def delete_countdown(cid):
    with timer_lock:
        timers["countdowns"] = [c for c in timers["countdowns"] if c["id"] != cid]
        save_timers()
    return jsonify(ok=True)


@app.post("/api/schedules")
def add_schedule():
    data = request.get_json(silent=True) or {}
    unit, action = data.get("unit"), data.get("action")
    t, days = data.get("time"), data.get("days")
    if not isinstance(unit, int) or not valid_unit(unit):
        return jsonify(error="Unknown outlet"), 400
    if action not in ("on", "off"):
        return jsonify(error="Action must be on or off"), 400
    if not isinstance(t, str) or not re.fullmatch(r"([01]\d|2[0-3]):[0-5]\d", t):
        return jsonify(error="Time must look like 18:30"), 400
    if (not isinstance(days, list) or not days
            or not all(isinstance(d, int) and 0 <= d <= 6 for d in days)):
        return jsonify(error="Pick at least one day"), 400
    with timer_lock:
        timers["schedules"].append({
            "id": uuid.uuid4().hex[:8],
            "unit": unit,
            "action": action,
            "time": t,
            "days": sorted(set(days)),
            "enabled": True,
        })
        save_timers()
    return jsonify(ok=True)


@app.post("/api/schedules/<sid>/toggle")
def toggle_schedule(sid):
    with timer_lock:
        for s in timers["schedules"]:
            if s["id"] == sid:
                s["enabled"] = not s["enabled"]
                save_timers()
                return jsonify(ok=True)
    return jsonify(error="Not found"), 404


@app.delete("/api/schedules/<sid>")
def delete_schedule(sid):
    with timer_lock:
        timers["schedules"] = [s for s in timers["schedules"] if s["id"] != sid]
        last_fired.pop(sid, None)
        save_timers()
    return jsonify(ok=True)


if __name__ == "__main__":
    threading.Thread(target=scheduler, daemon=True).start()
    app.run(host=HOST, port=PORT)
