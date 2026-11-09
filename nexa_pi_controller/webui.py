#!/usr/bin/env python3
# Web UI with outlet pairing and timers for Nexa outlets on a Raspberry Pi 5
# Run from the project root: python -m nexa_pi_controller.webui
# Then open http://<pi-ip>:5000

import re
import os
import atexit
import hmac
import logging
import threading
import time
import uuid
from collections import deque
from datetime import datetime, timedelta

from flask import Flask, jsonify, render_template, request, send_from_directory
from flask import redirect, session, url_for
from flask_wtf.csrf import CSRFProtect

from . import config
from . import radio
from . import receiver
from . import scheduler as scheduler_module
from . import storage

logger = logging.getLogger(__name__)

# Re-export configuration and legacy helpers for callers importing webui.
PORT = config.PORT
HOST = config.HOST
CHIP = config.CHIP
PIN = config.PIN
TX_ID = config.TX_ID
T = config.T
REPEAT = config.REPEAT
GPIO_MODE = config.GPIO_MODE
SECRET_KEY = config.SECRET_KEY
AUTH_USERNAME = config.AUTH_USERNAME
AUTH_PASSWORD = config.AUTH_PASSWORD
PROJECT_DIR = config.PROJECT_DIR
DATA_DIR = config.DATA_DIR
STATE_FILE = config.STATE_FILE
DEVICES_FILE = config.DEVICES_FILE
TIMER_FILE = config.TIMER_FILE

tx_lock = radio.tx_lock
timer_lock = threading.Lock()   # protects the timers dict
CONTROLLER_DIR = os.path.dirname(os.path.abspath(__file__))
app = Flask(
    __name__,
    template_folder=os.path.join(CONTROLLER_DIR, "templates"),
    static_folder=os.path.join(CONTROLLER_DIR, "static"),
)
if not SECRET_KEY:
    raise RuntimeError("SECRET_KEY must be configured")
app.config.update(
    SECRET_KEY=SECRET_KEY,
    PERMANENT_SESSION_LIFETIME=timedelta(days=config.SESSION_LIFETIME_DAYS),
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=config.COOKIE_SECURE,
)
csrf = CSRFProtect()
csrf.init_app(app)
if AUTH_PASSWORD is None:
    raise RuntimeError("AUTH_PASSWORD must be configured")


# ---------- Legacy-compatible storage/radio wrappers ----------
load_devices = storage.load_devices
load_state = storage.load_state
load_timers = storage.load_timers
save_devices = storage.save_devices

configured_devices = storage.load_devices()
state = storage.load_state()
timers = storage.load_timers()
state_lock = threading.Lock()
last_fired = {}   # schedule id -> "YYYY-MM-DD HH:MM" (prevents double firing)
last_sent = {}
receiver_listener = None
receiver_log = deque(maxlen=50)
services_lock = threading.Lock()
services_started = False

def save_state(st):
    storage.save_state(st)


def save_timers():
    storage.save_timers(timers)


def transmit(on, unit, group=0):
    return radio.transmit(on, unit, group)


def apply(unit, on):
    with state_lock:
        result = radio.apply(unit, on, state, save_state, transmit)
    last_sent[unit] = datetime.now().strftime("%H:%M")
    return result


def receive_command(remote, group, on, unit):
    """Apply and record a command observed from another Nexa transmitter."""
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    command = {
        "time": timestamp,
        "transmitter": remote,
        "group": group,
        "on": on,
        "unit": unit,
    }
    with state_lock:
        receiver_log.append(command)
        units = (
            [device["unit"] for device in configured_devices]
            if group else [unit]
        )
        changed = False
        for received_unit in units:
            if valid_unit(received_unit) and state.get(received_unit) != on:
                state[received_unit] = on
                changed = True
        if changed:
            save_state(state)
    target = "ALL units" if group else f"unit {unit}"
    logger.info(
        "remote %s  %s  %s",
        remote,
        target,
        "ON" if on else "OFF",
    )


def start_receiver():
    global receiver_listener
    if receiver_listener is not None:
        return receiver_listener
    try:
        listener = receiver.Receiver(receive_command)
        listener.start()
    except Exception as exc:
        logger.warning("Nexa receiver unavailable; continuing without it: %s", exc)
        if "listener" in locals():
            try:
                listener.stop()
            except Exception:
                logger.exception("Failed to clean up unavailable Nexa receiver")
        return None
    receiver_listener = listener
    return listener


def stop_receiver():
    global receiver_listener
    if receiver_listener is not None:
        receiver_listener.stop()
        receiver_listener = None


def start_background_services():
    global services_started
    with services_lock:
        if services_started:
            return
        services_started = True
    threading.Thread(target=scheduler, name="nexa-scheduler", daemon=True).start()
    start_receiver()
    atexit.register(stop_receiver)


def scheduler():
    return scheduler_module.scheduler(
        timers, apply, save_timers, timer_lock, last_fired
    )


@app.get("/api/remote/log")
def remote_log():
    with state_lock:
        return jsonify(list(receiver_log))


if GPIO_MODE == "mock":
    @app.post("/api/debug/remote")
    def debug_remote():
        data = request.get_json(silent=True) or {}
        transmitter = data.get("transmitter")
        group = data.get("group")
        on = data.get("on")
        unit = data.get("unit")
        if (
            not isinstance(transmitter, int)
            or not isinstance(group, bool)
            or not isinstance(on, bool)
            or not isinstance(unit, int)
            or not 0 <= unit <= 15
        ):
            return jsonify(error="invalid remote command"), 400
        if receiver_listener is None:
            return jsonify(error="receiver is not running"), 503
        receiver_listener.simulate(transmitter, group, on, unit)
        return jsonify(ok=True)


# ---------- Web page ----------

@app.before_request
def require_login():
    if request.endpoint in {"login", "login_submit", "static", "service_worker"}:
        return None
    if not session.get("authenticated"):
        if request.path.startswith("/api/"):
            return jsonify(error="authentication required"), 401
        return redirect(url_for("login", next=request.full_path))
    return None


@app.get("/login")
def login():
    if session.get("authenticated"):
        return redirect(url_for("index"))
    return render_template("login.html")


@app.post("/login")
def login_submit():
    username = request.form.get("username", "")
    password = request.form.get("password", "")
    try:
        valid = (
            username == AUTH_USERNAME
            and hmac.compare_digest(password, AUTH_PASSWORD)
        )
    except TypeError:
        valid = False
    if not valid:
        return render_template("login.html", error="Invalid username or password", username=username), 401
    session.clear()
    session.permanent = True
    session["authenticated"] = True
    next_url = request.form.get("next", "")
    destination = next_url if next_url.startswith("/") and not next_url.startswith("//") else url_for("index")
    return redirect(destination)


@app.post("/logout")
def logout():
    session.clear()
    return redirect(url_for("login"))

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


@app.get("/sw.js")
def service_worker():
    return send_from_directory(app.static_folder, "sw.js")


@app.get("/api/devices")
def device_list():
    devices = []
    for device in configured_devices:
        result = {
            "unit": device["unit"],
            "name": device["name"],
            "state": state.get(device["unit"]),
        }
        if device["unit"] in last_sent:
            result["last_sent"] = last_sent[device["unit"]]
        devices.append(result)
    return jsonify(devices)


@app.put("/api/devices/order")
def update_device_order():
    data = request.get_json(silent=True) or {}
    order = data.get("order")
    current_units = [device["unit"] for device in configured_devices]
    if not isinstance(order, list):
        return jsonify(error="order must be a list"), 400
    if any(not isinstance(unit, int) for unit in order):
        return jsonify(error="order must contain integer unit numbers"), 400
    if len(order) != len(current_units):
        return jsonify(error="order must contain every configured outlet exactly once"), 400
    if len(set(order)) != len(order):
        return jsonify(error="order must not contain duplicate units"), 400
    if set(order) != set(current_units):
        return jsonify(error="order contains an unknown or missing unit"), 400
    devices_by_unit = {device["unit"]: device for device in configured_devices}
    configured_devices[:] = [devices_by_unit[unit] for unit in order]
    save_devices(configured_devices)
    return jsonify(ok=True)


@app.patch("/api/devices/<int:unit>")
def rename_device(unit):
    device = next((d for d in configured_devices if d["unit"] == unit), None)
    if device is None:
        return jsonify(error="Unknown outlet"), 404
    data = request.get_json(silent=True) or {}
    name = data.get("name")
    if not isinstance(name, str) or not name.strip():
        return jsonify(error="name is required"), 400
    new_unit = data.get("unit", unit)
    if not isinstance(new_unit, int) or not 0 <= new_unit <= 15:
        return jsonify(error="unit must be an integer between 0 and 15"), 400
    if new_unit != unit and any(d["unit"] == new_unit for d in configured_devices):
        return jsonify(error="That outlet number is already in use"), 409
    device["name"] = name.strip()
    if new_unit != unit:
        device["unit"] = new_unit
        if unit in state:
            state[new_unit] = state.pop(unit)
        if unit in last_sent:
            last_sent[new_unit] = last_sent.pop(unit)
        for collection in ("schedules", "countdowns"):
            for timer in timers[collection]:
                if timer["unit"] == unit:
                    timer["unit"] = new_unit
    save_devices(configured_devices)
    save_state(state)
    save_timers()
    return jsonify(ok=True)


@app.delete("/api/devices/<int:unit>")
def remove_device(unit):
    if not valid_unit(unit):
        return jsonify(error="Unknown outlet"), 404
    configured_devices[:] = [d for d in configured_devices if d["unit"] != unit]
    state.pop(unit, None)
    save_devices(configured_devices)
    save_state(state)
    with timer_lock:
        timers["countdowns"] = [
            c for c in timers["countdowns"] if c["unit"] != unit
        ]
        timers["schedules"] = [
            s for s in timers["schedules"] if s["unit"] != unit
        ]
        save_timers()
    return jsonify(ok=True)


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

    requested_unit = data.get("unit")
    if requested_unit is None:
        unit = available_units[0]
    elif (not isinstance(requested_unit, int)
          or requested_unit not in available_units):
        return jsonify(error="unit must be an available integer between 0 and 15"), 400
    else:
        unit = requested_unit
    try:
        transmit(True, unit)
        configured_devices.append({"unit": unit, "name": name.strip()})
        save_devices(configured_devices)
        state[unit] = True
        last_sent[unit] = datetime.now().strftime("%H:%M")
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


@app.patch("/api/schedules/<sid>")
def update_schedule(sid):
    data = request.get_json(silent=True) or {}
    unit, action = data.get("unit"), data.get("action")
    schedule_time, days = data.get("time"), data.get("days")
    if not isinstance(unit, int) or not valid_unit(unit):
        return jsonify(error="Unknown outlet"), 400
    if action not in ("on", "off"):
        return jsonify(error="Action must be on or off"), 400
    if (not isinstance(schedule_time, str)
            or not re.fullmatch(r"([01]\d|2[0-3]):[0-5]\d", schedule_time)):
        return jsonify(error="Time must look like 18:30"), 400
    if (not isinstance(days, list) or not days
            or not all(isinstance(d, int) and 0 <= d <= 6 for d in days)):
        return jsonify(error="Pick at least one day"), 400
    with timer_lock:
        for schedule in timers["schedules"]:
            if schedule["id"] == sid:
                schedule.update({
                    "unit": unit,
                    "action": action,
                    "time": schedule_time,
                    "days": sorted(set(days)),
                })
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
    if not app.debug or os.environ.get("WERKZEUG_RUN_MAIN") == "true":
        start_background_services()
    app.run(host=HOST, port=PORT)
