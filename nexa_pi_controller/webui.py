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
from functools import wraps

from flask import Flask, abort, flash, g, jsonify, render_template, request, send_from_directory
from flask import redirect, session, url_for
from flask_wtf.csrf import CSRFProtect

from . import config
from . import radio
from . import receiver
from . import scheduler as scheduler_module
from . import storage
from . import user_store

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
API_KEY = config.API_KEY
USERS_FILE = config.USERS_FILE
PROJECT_DIR = config.PROJECT_DIR
DATA_DIR = config.DATA_DIR
STATE_FILE = config.STATE_FILE
DEVICES_FILE = config.DEVICES_FILE
TIMER_FILE = config.TIMER_FILE
ROOMS_FILE = config.ROOMS_FILE

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
    WTF_CSRF_CHECK_DEFAULT=False,
)
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
configured_floors, configured_rooms = storage.load_map()
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

def admin_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if (
            getattr(g, "api_key_authenticated", False)
            or getattr(g, "current_user", None) is None
            or g.current_user["role"] != "admin"
        ):
            abort(403)
        return view(*args, **kwargs)

    return wrapped


@app.before_request
def initialize_user_store():
    if request.endpoint in {"static", "service_worker"}:
        return None
    try:
        user_store.initialize(USERS_FILE, AUTH_USERNAME, AUTH_PASSWORD)
    except user_store.BootstrapRequiredError as error:
        logger.error("User account bootstrap is required: %s", error)
        if request.path.startswith("/api/"):
            return jsonify(error="Initial administrator setup is required"), 503
        return render_template("setup_required.html"), 503
    except user_store.LastAdminError:
        logger.exception("The account store has no active administrator")
        if request.path.startswith("/api/"):
            return jsonify(error="No active administrator is configured"), 503
        return render_template("setup_required.html"), 503


@app.context_processor
def inject_current_user():
    return {"current_user": getattr(g, "current_user", None)}


@app.before_request
def authenticate_api_key():
    if not request.path.startswith("/api/"):
        return None

    authorization = request.headers.get("Authorization")
    if authorization is not None:
        scheme, separator, token = authorization.partition(" ")
        if (
            API_KEY
            and separator
            and scheme.lower() == "bearer"
            and hmac.compare_digest(token, API_KEY)
        ):
            g.api_key_authenticated = True
            return None
        return jsonify(error="invalid API key"), 401

    if not session.get("user_id"):
        return jsonify(error="authentication required"), 401
    return None


@app.before_request
def load_current_user():
    g.current_user = None
    if request.endpoint in {"static", "service_worker"}:
        return None
    user_id = session.get("user_id")
    if user_id is None:
        return None
    if not isinstance(user_id, int):
        session.clear()
        return None
    user = user_store.get_user_by_id(USERS_FILE, user_id)
    if (
        user is None
        or not user["is_active"]
        or user["session_version"] != session.get("session_version")
    ):
        session.clear()
        return None
    g.current_user = user
    return None


@app.before_request
def protect_csrf():
    if (
        app.config.get("WTF_CSRF_ENABLED", True)
        and not getattr(g, "api_key_authenticated", False)
    ):
        csrf.protect()


@app.before_request
def require_login():
    if request.endpoint in {
        "login", "login_submit", "logout", "static", "service_worker",
    }:
        return None
    if getattr(g, "api_key_authenticated", False):
        return None
    if getattr(g, "current_user", None) is None:
        if request.path.startswith("/api/"):
            return jsonify(error="authentication required"), 401
        return redirect(url_for("login", next=request.full_path))
    if (
        g.current_user["must_change_password"]
        and request.endpoint != "change_password"
    ):
        if request.path.startswith("/api/"):
            return jsonify(error="password change required"), 403
        return redirect(url_for("change_password"))
    return None


@app.get("/login")
def login():
    if getattr(g, "current_user", None):
        return redirect(url_for("index"))
    return render_template("login.html")


@app.post("/login")
def login_submit():
    username = request.form.get("username", "")
    password = request.form.get("password", "")
    user = user_store.get_user_by_username(USERS_FILE, username.strip())
    if user is None or not user["is_active"] or not user_store.verify_password(
        user, password
    ):
        return render_template("login.html", error="Invalid username or password", username=username), 401
    session.clear()
    session.permanent = True
    session["user_id"] = user["id"]
    session["session_version"] = user["session_version"]
    if user["must_change_password"]:
        return redirect(url_for("change_password"))
    next_url = request.form.get("next", "")
    destination = next_url if next_url.startswith("/") and not next_url.startswith("//") else url_for("index")
    return redirect(destination)


@app.post("/logout")
def logout():
    session.clear()
    return redirect(url_for("login"))


@app.route("/account/password", methods=["GET", "POST"])
def change_password():
    user = g.current_user
    forced = user["must_change_password"]
    if request.method == "GET":
        return render_template("change_password.html", forced=forced)
    current_password = request.form.get("current_password", "")
    new_password = request.form.get("new_password", "")
    confirmation = request.form.get("confirm_password", "")
    error = None
    if not forced and not user_store.verify_password(user, current_password):
        error = "Current password is incorrect"
    elif len(new_password) < 6:
        error = "Password must be at least 6 characters"
    elif new_password != confirmation:
        error = "Passwords do not match"
    if error:
        return render_template(
            "change_password.html", forced=forced, error=error
        ), 400
    updated = user_store.set_password(
        USERS_FILE, user["id"], new_password, must_change_password=False
    )
    session.clear()
    session.permanent = True
    session["user_id"] = updated["id"]
    session["session_version"] = updated["session_version"]
    return redirect(url_for("index"))


@app.get("/admin/users")
@admin_required
def admin_users():
    users = user_store.list_users(USERS_FILE)
    users.sort(key=lambda user: (
        user["id"] != g.current_user["id"],
        not user["is_active"],
    ))
    return render_template(
        "users.html",
        users=users,
        account_count=len(users),
        active_account_count=sum(user["is_active"] for user in users),
        current_user=g.current_user,
    )


@app.post("/admin/users")
@admin_required
def create_account():
    username = request.form.get("username", "").strip()
    password = request.form.get("temporary_password", "")
    role = request.form.get("role", "")
    reopen_dialog = False
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{2,31}", username):
        flash("Username must be 3–32 letters, numbers, dots, underscores or hyphens.")
        reopen_dialog = True
    elif len(password) < 6:
        flash("Temporary passwords must be at least 6 characters.")
        reopen_dialog = True
    elif role not in {"admin", "operator"}:
        flash("Choose a valid account role.")
        reopen_dialog = True
    else:
        try:
            user_store.create_user(USERS_FILE, username, password, role)
            flash(f"Created {username}. They must change the temporary password at sign-in.")
        except user_store.DuplicateUsernameError:
            flash("That username is already in use.")
            reopen_dialog = True
    return redirect(url_for("admin_users", create="1" if reopen_dialog else None))


@app.post("/admin/users/<int:user_id>/role")
@admin_required
def change_account_role(user_id):
    role = request.form.get("role", "")
    if role not in {"admin", "operator"}:
        flash("Choose a valid account role.")
    elif user_id == g.current_user["id"]:
        flash("You cannot change your own role.")
    else:
        try:
            user_store.update_user(USERS_FILE, user_id, role=role)
            flash("Account role updated.")
        except user_store.LastAdminError as error:
            flash(str(error))
        except user_store.UserNotFoundError:
            abort(404)
    return redirect(url_for("admin_users"))


@app.post("/admin/users/<int:user_id>/active")
@admin_required
def change_account_status(user_id):
    active_value = request.form.get("active")
    if active_value not in {"true", "false"}:
        flash("Choose a valid account status.")
    elif user_id == g.current_user["id"] and active_value == "false":
        flash("You cannot deactivate your own account.")
    else:
        active = active_value == "true"
        try:
            user_store.update_user(USERS_FILE, user_id, is_active=active)
            flash("Account activated." if active else "Account deactivated.")
        except user_store.LastAdminError as error:
            flash(str(error))
        except user_store.UserNotFoundError:
            abort(404)
    return redirect(url_for("admin_users"))


@app.post("/admin/users/<int:user_id>/reset-password")
@admin_required
def reset_account_password(user_id):
    password = request.form.get("temporary_password", "")
    if user_id == g.current_user["id"]:
        flash("Use Change password to update your own password.")
    elif len(password) < 6:
        flash("Temporary passwords must be at least 6 characters.")
    else:
        try:
            user_store.set_password(
                USERS_FILE, user_id, password, must_change_password=True
            )
            flash("Temporary password set. The user must change it at sign-in.")
        except user_store.UserNotFoundError:
            abort(404)
    return redirect(url_for("admin_users"))


# ---------- Helpers ----------
def device_name(unit):
    for d in configured_devices:
        if d["unit"] == unit:
            return d["name"]
    return "Unit " + str(unit)


def valid_unit(unit):
    return unit in [d["unit"] for d in configured_devices]


def parse_units(data):
    """Return a de-duplicated list of valid units from a request body.

    Accepts the legacy single "unit" key as well as "units". Returns
    (units, error_message).
    """
    units = data.get("units")
    if units is None and "unit" in data:
        units = [data["unit"]]
    if (not isinstance(units, list) or not units
            or not all(isinstance(u, int) and not isinstance(u, bool) for u in units)):
        return None, "Select at least one outlet"
    if not all(valid_unit(u) for u in units):
        return None, "Unknown outlet"
    return list(dict.fromkeys(units)), None


def device_names(units):
    return [device_name(u) for u in units]


# ---------- Routes: switching and pairing ----------
@app.get("/")
def index():
    return render_template("index.html")


@app.get("/receiver-log")
def receiver_log_page():
    with state_lock:
        commands = list(reversed(receiver_log))
        outlet_names = {device["unit"]: device["name"] for device in configured_devices}
    return render_template(
        "receiver_log.html", commands=commands, outlet_names=outlet_names
    )


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
                timer["units"] = [new_unit if u == unit else u for u in timer["units"]]
        for room in configured_rooms:
            room["units"] = [new_unit if u == unit else u for u in room["units"]]
        storage.save_map(configured_floors, configured_rooms)
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
    for room in configured_rooms:
        room["units"] = [u for u in room["units"] if u != unit]
    storage.save_map(configured_floors, configured_rooms)
    save_devices(configured_devices)
    save_state(state)
    with timer_lock:
        for collection in ("countdowns", "schedules"):
            remaining = []
            for timer in timers[collection]:
                timer["units"] = [u for u in timer["units"] if u != unit]
                if timer["units"]:
                    remaining.append(timer)
            timers[collection] = remaining
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


def switch_all(on):
    try:
        for d in configured_devices:
            apply(d["unit"], on)
            time.sleep(0.2)
    except Exception as e:
        return jsonify(error=str(e)), 500
    return jsonify(ok=True)


@app.post("/api/all/off")
def all_off():
    return switch_all(False)


@app.post("/api/all/on")
def all_on():
    return switch_all(True)


# ---------- Routes: rooms (map view) ----------
ROOM_GRID = 100   # rooms live on a ROOM_GRID x ROOM_GRID coordinate plane


def parse_rooms(data, floor_ids=None, default_floor_id=None):
    """Validate a list of rooms; return (rooms, error_message)."""
    if not isinstance(data, list):
        return None, "rooms must be a list"
    if floor_ids is None:
        floor_ids = {floor["id"] for floor in configured_floors}
    if default_floor_id is None:
        default_floor_id = configured_floors[0]["id"] if configured_floors else "ground-floor"
    rooms = []
    ids = set()
    for item in data:
        if not isinstance(item, dict):
            return None, "invalid room"
        room_id = item.get("id")
        name = item.get("name")
        if not isinstance(room_id, str) or not room_id.strip() or room_id in ids:
            return None, "each room needs a unique id"
        if not isinstance(name, str) or not name.strip():
            return None, "room name is required"
        floor_id = item.get("floor_id", default_floor_id)
        if not isinstance(floor_id, str) or floor_id not in floor_ids:
            return None, "room needs a valid floor"
        geometry = []
        for key in ("x", "y", "w", "h"):
            value = item.get(key)
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                return None, f"{key} must be a number"
            geometry.append(float(value))
        x, y, w, h = geometry
        if w < 1 or h < 1 or x < 0 or y < 0 or x + w > ROOM_GRID or y + h > ROOM_GRID:
            return None, "room must fit inside the map"
        units = item.get("units", [])
        if (not isinstance(units, list)
                or not all(isinstance(u, int) and not isinstance(u, bool) for u in units)):
            return None, "units must be a list of integers"
        if not all(valid_unit(u) for u in units):
            return None, "Unknown outlet"
        ids.add(room_id)
        rooms.append({"id": room_id, "floor_id": floor_id, "name": name.strip()[:80], "x": x, "y": y,
                      "w": w, "h": h, "units": list(dict.fromkeys(units))})
    return rooms, None


def parse_map(data):
    """Validate all floor metadata and rooms; return (floors, rooms, error_message)."""
    if not isinstance(data, dict):
        return None, None, "map must be an object"
    floor_data = data.get("floors")
    if not isinstance(floor_data, list) or not floor_data:
        return None, None, "at least one floor is required"
    floors = []
    floor_ids = set()
    for item in floor_data:
        if not isinstance(item, dict):
            return None, None, "invalid floor"
        floor_id = item.get("id")
        name = item.get("name")
        if not isinstance(floor_id, str) or not floor_id.strip() or floor_id in floor_ids:
            return None, None, "each floor needs a unique id"
        if not isinstance(name, str) or not name.strip():
            return None, None, "floor name is required"
        floors.append({"id": floor_id, "name": name.strip()[:80]})
        floor_ids.add(floor_id)
    rooms, error = parse_rooms(data.get("rooms"), floor_ids, floors[0]["id"])
    if error:
        return None, None, error
    return floors, rooms, None


@app.get("/api/map")
def get_map():
    return jsonify(floors=configured_floors, rooms=configured_rooms)


@app.put("/api/map")
def update_map():
    floors, rooms, error = parse_map(request.get_json(silent=True))
    if error:
        return jsonify(error=error), 400
    configured_floors[:] = floors
    configured_rooms[:] = rooms
    storage.save_map(configured_floors, configured_rooms)
    return jsonify(ok=True)


@app.get("/api/rooms")
def get_rooms():
    return jsonify(configured_rooms)


@app.put("/api/rooms")
def update_rooms():
    rooms, error = parse_rooms(request.get_json(silent=True))
    if error:
        return jsonify(error=error), 400
    configured_rooms[:] = rooms
    storage.save_map(configured_floors, configured_rooms)
    return jsonify(ok=True)


@app.post("/api/rooms/<room_id>/<action>")
def switch_room(room_id, action):
    room = next((r for r in configured_rooms if r["id"] == room_id), None)
    if room is None:
        return jsonify(error="Unknown room"), 404
    if action not in ("on", "off"):
        return jsonify(error="bad request"), 400
    try:
        for unit in room["units"]:
            if valid_unit(unit):
                apply(unit, action == "on")
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
            {**s, "names": device_names(s["units"])} for s in timers["schedules"]
        ]
        countdowns = [
            {**c, "names": device_names(c["units"]),
             "remaining": max(0, int(c["run_at"] - now))}
            for c in timers["countdowns"]
        ]
    schedules.sort(key=lambda s: s["time"])
    countdowns.sort(key=lambda c: c["run_at"])
    return jsonify(schedules=schedules, countdowns=countdowns)


@app.post("/api/countdowns")
def add_countdown():
    data = request.get_json(silent=True) or {}
    action, minutes = data.get("action"), data.get("minutes")
    units, error = parse_units(data)
    if error:
        return jsonify(error=error), 400
    if action not in ("on", "off"):
        return jsonify(error="Action must be on or off"), 400
    if not isinstance(minutes, int) or not 1 <= minutes <= 1440:
        return jsonify(error="Minutes must be between 1 and 1440"), 400
    with timer_lock:
        timers["countdowns"].append({
            "id": uuid.uuid4().hex[:8],
            "units": units,
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


def parse_schedule(data):
    """Validate a schedule body; returns (fields, error_message)."""
    action = data.get("action")
    schedule_time, days = data.get("time"), data.get("days")
    units, error = parse_units(data)
    if error:
        return None, error
    if action not in ("on", "off"):
        return None, "Action must be on or off"
    if (not isinstance(schedule_time, str)
            or not re.fullmatch(r"([01]\d|2[0-3]):[0-5]\d", schedule_time)):
        return None, "Time must look like 18:30"
    if (not isinstance(days, list) or not days
            or not all(isinstance(d, int) and 0 <= d <= 6 for d in days)):
        return None, "Pick at least one day"
    return {
        "units": units,
        "action": action,
        "time": schedule_time,
        "days": sorted(set(days)),
    }, None


@app.post("/api/schedules")
def add_schedule():
    fields, error = parse_schedule(request.get_json(silent=True) or {})
    if error:
        return jsonify(error=error), 400
    with timer_lock:
        timers["schedules"].append({
            "id": uuid.uuid4().hex[:8],
            **fields,
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


@app.route("/api/schedules/<sid>", methods=["PUT", "PATCH"])
def update_schedule(sid):
    fields, error = parse_schedule(request.get_json(silent=True) or {})
    if error:
        return jsonify(error=error), 400
    with timer_lock:
        for schedule in timers["schedules"]:
            if schedule["id"] == sid:
                schedule.update(fields)
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
