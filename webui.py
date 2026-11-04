#!/usr/bin/env python3
# Web UI with outlet pairing and timers for Nexa outlets on a Raspberry Pi 5
# Run: python3 webui.py   then open http://<pi-ip>:8080

import json
import os
import re
import secrets
import threading
import time
import uuid
from datetime import datetime

import lgpio
from dotenv import load_dotenv
from flask import Flask, jsonify, render_template_string, request
from flask_wtf.csrf import CSRFProtect

load_dotenv()


# ---------- Settings ----------
CHIP = 15            # pinctrl-rp1 (from gpiodetect)
PIN = 17             # BCM GPIO17 = physical pin 11
TX_ID = 12345678     # must match the ID your outlets were paired with
T = 260e-6
REPEAT = 6
PORT = int(os.getenv("PORT", 8080))
HOST = os.getenv("HOST", "127.0.0.1")

# Used only the first time, before nexa_devices.json exists.
DEVICES = [
    {"unit": 0, "name": "Outlet 1"},
    {"unit": 1, "name": "Outlet 2"},
]
# ------------------------------

# In Docker, set DATA_DIR=/data and mount a volume there.
DATA_DIR = os.getenv("DATA_DIR", os.path.expanduser("~"))
STATE_FILE = os.path.join(DATA_DIR, "nexa_state.json")
DEVICES_FILE = os.path.join(DATA_DIR, "nexa_devices.json")
TIMER_FILE = os.path.join(DATA_DIR, "nexa_timers.json")

tx_lock = threading.Lock()      # only one radio transmission at a time
timer_lock = threading.Lock()   # protects the timers dict
app = Flask(__name__)
app.config["SECRET_KEY"] = os.getenv("SECRET_KEY", secrets.token_hex(32))
csrf = CSRFProtect()
csrf.init_app(app)


# ---------- Devices ----------
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
        return DEVICES.copy()
    except Exception as e:
        print("Could not read devices file, using defaults:", e, flush=True)
        return DEVICES.copy()


def save_devices(devices):
    with open(DEVICES_FILE, "w") as f:
        json.dump(devices, f, indent=2)


# ---------- State (last command sent per outlet) ----------
def load_state():
    try:
        with open(STATE_FILE) as f:
            return {int(k): v for k, v in json.load(f).items()}
    except Exception:
        return {}


def save_state(st):
    try:
        with open(STATE_FILE, "w") as f:
            json.dump(st, f)
    except Exception:
        pass


# ---------- Timers ----------
def load_timers():
    try:
        with open(TIMER_FILE) as f:
            data = json.load(f)
        return {
            "schedules": data.get("schedules", []),
            "countdowns": data.get("countdowns", []),
        }
    except Exception:
        return {"schedules": [], "countdowns": []}


def save_timers():
    # Call while holding timer_lock
    try:
        with open(TIMER_FILE, "w") as f:
            json.dump(timers, f)
    except Exception:
        pass


configured_devices = load_devices()
state = load_state()
timers = load_timers()
last_fired = {}   # schedule id -> "YYYY-MM-DD HH:MM" (prevents double firing)


# ---------- Radio ----------
def transmit(on, unit, group=0):
    """Send one Nexa command. Opens and closes the GPIO each time."""
    with tx_lock:
        h = lgpio.gpiochip_open(CHIP)
        try:
            lgpio.gpio_claim_output(h, PIN, 0)

            def pulse(level, duration):
                lgpio.gpio_write(h, PIN, level)
                end = time.perf_counter() + duration
                while time.perf_counter() < end:
                    pass

            def send_bit(bit):
                seq = ([(1, T), (0, 5 * T), (1, T), (0, T)] if bit
                       else [(1, T), (0, T), (1, T), (0, 5 * T)])
                for level, duration in seq:
                    pulse(level, duration)

            bits = (format(TX_ID, "026b") + str(group)
                    + ("1" if on else "0") + format(unit, "04b"))
            for _ in range(REPEAT):
                pulse(1, T)
                pulse(0, 10 * T)
                for c in bits:
                    send_bit(c == "1")
                pulse(1, T)
                pulse(0, 40 * T)
        finally:
            lgpio.gpio_write(h, PIN, 0)
            lgpio.gpiochip_close(h)


def apply(unit, on):
    transmit(on, unit)
    state[unit] = on
    save_state(state)


# ---------- Scheduler thread ----------
def scheduler():
    while True:
        try:
            now = datetime.now()
            hhmm = now.strftime("%H:%M")
            stamp = now.strftime("%Y-%m-%d %H:%M")
            due = []

            with timer_lock:
                for s in timers["schedules"]:
                    if (s["enabled"] and s["time"] == hhmm
                            and now.weekday() in s["days"]
                            and last_fired.get(s["id"]) != stamp):
                        last_fired[s["id"]] = stamp
                        due.append((s["unit"], s["action"] == "on"))

                keep = []
                for c in timers["countdowns"]:
                    late = time.time() - c["run_at"]
                    if late < 0:
                        keep.append(c)          # not due yet
                    elif late <= 60:
                        due.append((c["unit"], c["action"] == "on"))
                    # else: missed by over a minute (Pi was off), drop it
                if len(keep) != len(timers["countdowns"]):
                    timers["countdowns"] = keep
                    save_timers()

            for unit, on in due:
                try:
                    apply(unit, on)
                except Exception as e:
                    print("Timer failed to send:", e, flush=True)
                time.sleep(0.2)
        except Exception as e:
            print("Scheduler error:", e, flush=True)
        time.sleep(1)


# ---------- Web page ----------
PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" type="image/svg+xml" href="/static/logo.svg">
<link rel="icon" type="image/png" href="/static/logo.png">
<meta name="csrf-token" content="{{ csrf_token() }}">
<title>Nexa Control</title>
<style>
  :root { --bg:#f4f5f7; --card:#fff; --text:#1c1e21; --muted:#6b7280;
          --on:#16a34a; --btn:#e5e7eb; --danger:#dc2626; --line:#d1d5db; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#121417; --card:#1c1f24; --text:#f1f3f5; --muted:#9aa3ad;
            --btn:#2a2f36; --line:#3a4048; }
  }
  * { box-sizing: border-box; }
  body { margin:0; padding:20px; background:var(--bg); color:var(--text);
         font-family: system-ui, sans-serif; }
  main { max-width:520px; margin:0 auto; }
  h1 { font-size:1.4rem; margin:0 0 16px; }
  h2 { font-size:1.15rem; margin:28px 0 12px; }
  h3 { font-size:.95rem; margin:14px 0 8px; color:var(--muted); font-weight:600; }
  .card { background:var(--card); border-radius:14px; padding:16px;
          margin-bottom:12px; display:flex; align-items:center;
          justify-content:space-between; gap:12px; }
  .panel { background:var(--card); border-radius:14px; padding:16px; }
  .timers { margin-top:20px; }
  .timers summary { cursor:pointer; color:var(--muted); font-size:.95rem;
                    font-weight:600; padding:4px 0; }
  .timers summary::marker { color:var(--muted); }
  .timer-panel { margin-top:10px; padding:14px; }
  .timer-section + .timer-section { border-top:1px solid var(--line);
                                    margin-top:18px; padding-top:4px; }
  .timer-section h3 { color:var(--text); margin-top:10px; }
  .active-timers { margin-top:18px; }
  .name { font-weight:600; }
  .status { font-size:.85rem; color:var(--muted); }
  .status.on { color:var(--on); }
  .btns, .row { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
  button { border:0; border-radius:10px; padding:12px 18px; font-size:1rem;
           background:var(--btn); color:var(--text); cursor:pointer; }
  button.on { background:var(--on); color:#fff; }
  button.small { padding:8px 12px; font-size:.85rem; }
  button.danger { color:var(--danger); }
  button:disabled { opacity:.5; }
  select, input[type=number], input[type=time] {
    font-size:1rem; padding:10px; border-radius:10px; color:var(--text);
    border:1px solid var(--line); background:var(--bg); }
  input[type=number] { width:80px; }
  .days { display:flex; gap:6px; flex-wrap:wrap; margin:10px 0; }
  .days label { display:flex; align-items:center; gap:4px; font-size:.85rem;
                background:var(--btn); border-radius:8px; padding:6px 8px; }
  .all { width:100%; margin-top:6px; }
  .timer { display:flex; justify-content:space-between; align-items:center;
           gap:10px; padding:10px 0; border-top:1px solid var(--line); }
  .timer .desc { font-size:.95rem; }
  .timer .sub { font-size:.8rem; color:var(--muted); }
  .timer.disabled .desc { opacity:.5; }
  .empty { color:var(--muted); font-size:.9rem; padding:8px 0; }
  #msg { text-align:center; color:var(--muted); font-size:.85rem;
         margin-top:10px; min-height:1.2em; }
</style>
</head>
<body>
<main>
  <h1>Nexa Control</h1>
  <div id="list"></div>
  <button class="all" onclick="addOutlet()">Add outlet</button>
  <button class="all" onclick="allOff()">All off</button>

  <details class="timers">
    <summary>Timers</summary>
    <div class="panel timer-panel">
      <section class="timer-section">
        <h3>Countdown</h3>
        <div class="row">
          <select id="cd-unit"></select>
          <select id="cd-action">
            <option value="off">Turn off</option>
            <option value="on">Turn on</option>
          </select>
          <span>in</span>
          <input id="cd-min" type="number" min="1" max="1440" value="30">
          <span>min</span>
          <button onclick="addCountdown()">Start</button>
        </div>
      </section>

      <section class="timer-section">
        <h3>Weekly schedule</h3>
        <div class="row">
          <select id="sc-unit"></select>
          <select id="sc-action">
            <option value="on">Turn on</option>
            <option value="off">Turn off</option>
          </select>
          <span>at</span>
          <input id="sc-time" type="time" value="18:00">
        </div>
        <div class="days" id="sc-days"></div>
        <button onclick="addSchedule()">Add schedule</button>
      </section>

      <section class="timer-section active-timers">
        <h3>Active timers</h3>
        <div id="timer-list"></div>
      </section>
    </div>
  </details>

  <div id="msg"></div>
</main>
<script>
const DAY_NAMES = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
let devices = [];

async function api(method, url, body) {
  const opts = {method: method};
  if (method !== 'GET') {
    opts.headers = {'X-CSRFToken':
      document.querySelector('meta[name="csrf-token"]').content};
  }
  if (body !== undefined) {
    opts.headers = {...opts.headers, 'Content-Type': 'application/json'};
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(url, opts);
  let data = {};
  try { data = await r.json(); } catch (e) {}
  if (!r.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function setMsg(t) { document.getElementById('msg').textContent = t; }

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

// ----- Devices -----
async function loadDevices() {
  devices = await api('GET', '/api/devices');
  renderDevices();
  fillSelects();
}

function renderDevices() {
  const list = document.getElementById('list');
  list.innerHTML = '';
  for (const d of devices) {
    const card = el('div', 'card');
    const left = el('div');
    left.appendChild(el('div', 'name', d.name));
    const status = d.state === true ? 'On' : d.state === false ? 'Off' : 'Unknown';
    left.appendChild(el('div', 'status' + (d.state ? ' on' : ''), status));
    const btns = el('div', 'btns');
    const bOn = el('button', 'on', 'On');
    const bOff = el('button', '', 'Off');
    bOn.onclick = () => send(d.unit, 'on', [bOn, bOff]);
    bOff.onclick = () => send(d.unit, 'off', [bOn, bOff]);
    btns.append(bOn, bOff);
    card.append(left, btns);
    list.appendChild(card);
  }
}

function fillSelects() {
  for (const id of ['cd-unit', 'sc-unit']) {
    const sel = document.getElementById(id);
    const keep = sel.value;
    sel.innerHTML = '';
    for (const d of devices) {
      const o = el('option', '', d.name);
      o.value = d.unit;
      sel.appendChild(o);
    }
    if (keep) sel.value = keep;
  }
}

async function addOutlet() {
  const name = prompt('Name for the new outlet:', 'Outlet ' + (devices.length + 1));
  if (name === null) return;
  if (!name.trim()) {
    setMsg('Please enter a name');
    return;
  }
  if (!confirm('Put the outlet in learning mode (press its learn button), then click OK to pair it.')) return;

  setMsg('Pairing...');
  try {
    await api('POST', '/api/pair', {name: name.trim()});
    setMsg('Outlet paired');
  } catch (e) {
    setMsg(e.message || 'Failed to pair outlet');
  }
  await loadDevices();
  loadTimers();
}

async function send(unit, action, btns) {
  btns.forEach(b => b.disabled = true);
  setMsg('Sending...');
  try {
    await api('POST', '/api/' + unit + '/' + action);
    setMsg('Sent');
  } catch (e) {
    setMsg('Failed: ' + e.message);
  }
  await loadDevices();
}

async function allOff() {
  setMsg('Sending...');
  try {
    await api('POST', '/api/all/off');
    setMsg('All off');
  } catch (e) {
    setMsg('Failed: ' + e.message);
  }
  await loadDevices();
}

// ----- Timers -----
function buildDayBoxes() {
  const box = document.getElementById('sc-days');
  DAY_NAMES.forEach((n, i) => {
    const lab = el('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = i;
    cb.checked = true;
    lab.append(cb, document.createTextNode(n));
    box.appendChild(lab);
  });
}

function fmtRemaining(sec) {
  const m = Math.max(1, Math.ceil(sec / 60));
  if (m < 60) return m + ' min';
  return Math.floor(m / 60) + ' h ' + (m % 60) + ' min';
}

function fmtDays(days) {
  if (days.length === 7) return 'Every day';
  return days.map(d => DAY_NAMES[d]).join(', ');
}

async function loadTimers() {
  let data;
  try { data = await api('GET', '/api/timers'); } catch (e) { return; }
  const list = document.getElementById('timer-list');
  list.innerHTML = '';

  if (!data.countdowns.length && !data.schedules.length) {
    list.appendChild(el('div', 'empty', 'No timers set.'));
    return;
  }

  for (const c of data.countdowns) {
    const row = el('div', 'timer');
    const info = el('div');
    info.appendChild(el('div', 'desc',
      'Turn ' + c.name + ' ' + c.action + ' in ' + fmtRemaining(c.remaining)));
    info.appendChild(el('div', 'sub', 'Countdown'));
    const del = el('button', 'small danger', 'Cancel');
    del.onclick = async () => {
      await api('DELETE', '/api/countdowns/' + c.id);
      loadTimers();
    };
    row.append(info, del);
    list.appendChild(row);
  }

  for (const s of data.schedules) {
    const row = el('div', 'timer' + (s.enabled ? '' : ' disabled'));
    const info = el('div');
    info.appendChild(el('div', 'desc',
      'Turn ' + s.name + ' ' + s.action + ' at ' + s.time));
    info.appendChild(el('div', 'sub', fmtDays(s.days)));
    const btns = el('div', 'btns');
    const tog = el('button', 'small', s.enabled ? 'Disable' : 'Enable');
    tog.onclick = async () => {
      await api('POST', '/api/schedules/' + s.id + '/toggle');
      loadTimers();
    };
    const del = el('button', 'small danger', 'Delete');
    del.onclick = async () => {
      await api('DELETE', '/api/schedules/' + s.id);
      loadTimers();
    };
    btns.append(tog, del);
    row.append(info, btns);
    list.appendChild(row);
  }
}

async function addCountdown() {
  const unit = parseInt(document.getElementById('cd-unit').value, 10);
  const action = document.getElementById('cd-action').value;
  const minutes = parseInt(document.getElementById('cd-min').value, 10);
  try {
    await api('POST', '/api/countdowns', {unit, action, minutes});
    setMsg('Countdown started');
  } catch (e) {
    setMsg('Failed: ' + e.message);
  }
  loadTimers();
}

async function addSchedule() {
  const unit = parseInt(document.getElementById('sc-unit').value, 10);
  const action = document.getElementById('sc-action').value;
  const time = document.getElementById('sc-time').value;
  const days = [...document.querySelectorAll('#sc-days input:checked')]
    .map(c => parseInt(c.value, 10));
  try {
    await api('POST', '/api/schedules', {unit, action, time, days});
    setMsg('Schedule added');
  } catch (e) {
    setMsg('Failed: ' + e.message);
  }
  loadTimers();
}

buildDayBoxes();
loadDevices();
loadTimers();
setInterval(loadTimers, 15000);
setInterval(loadDevices, 15000);
</script>
</body>
</html>
"""


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
    return render_template_string(PAGE)


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
