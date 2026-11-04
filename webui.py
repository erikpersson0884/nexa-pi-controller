#!/usr/bin/env python3
# Simple web UI for Nexa outlets on a Raspberry Pi 5
# Run: python3 webui.py   then open http://<pi-ip>:8080

import json
import os
import threading
import time

import lgpio
from flask import Flask, jsonify, render_template_string, request
from dotenv import load_dotenv

load_dotenv()

# ---------- Settings ----------
CHIP = 15            # pinctrl-rp1 (from gpiodetect)
PIN = 17             # BCM GPIO17 = physical pin 11
TX_ID = 12345678     # must match the ID your outlets were paired with
T = 260e-6
REPEAT = 6
PORT = int(os.getenv('PORT', 8080))

# Add one entry per paired outlet. "unit" is the number you paired it with.
DEVICES = [
    {"unit": 0, "name": "Outlet 1"},
    {"unit": 1, "name": "Outlet 2"},
]
# ------------------------------

STATE_FILE = os.path.expanduser("~/nexa_state.json")
DEVICES_FILE = os.path.expanduser("~/nexa_devices.json")
lock = threading.Lock()
app = Flask(__name__)


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


def save_devices(devices):
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
        with open(STATE_FILE, "w") as f:
            json.dump(state, f)
    except Exception:
        pass


configured_devices = load_devices()
state = load_state()


def transmit(on, unit, group=0):
    """Send one Nexa command. Opens and closes the GPIO each time."""
    with lock:
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


PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nexa Control</title>
<style>
  :root { --bg:#f4f5f7; --card:#fff; --text:#1c1e21; --muted:#6b7280;
          --on:#16a34a; --off:#6b7280; --btn:#e5e7eb; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#121417; --card:#1c1f24; --text:#f1f3f5; --muted:#9aa3ad;
            --btn:#2a2f36; }
  }
  * { box-sizing: border-box; }
  body { margin:0; padding:20px; background:var(--bg); color:var(--text);
         font-family: system-ui, sans-serif; }
  main { max-width:480px; margin:0 auto; }
  h1 { font-size:1.4rem; margin:0 0 16px; }
  .card { background:var(--card); border-radius:14px; padding:16px;
          margin-bottom:12px; display:flex; align-items:center;
          justify-content:space-between; gap:12px; }
  .name { font-weight:600; }
  .status { font-size:.85rem; color:var(--muted); }
  .status.on { color:var(--on); }
  .btns { display:flex; gap:8px; }
  button { border:0; border-radius:10px; padding:12px 18px; font-size:1rem;
           background:var(--btn); color:var(--text); cursor:pointer; }
  button.on { background:var(--on); color:#fff; }
  button:disabled { opacity:.5; }
  .all { width:100%; margin-top:6px; }
  #msg { text-align:center; color:var(--muted); font-size:.85rem; margin-top:10px; min-height:1.2em; }
</style>
</head>
<body>
<main>
  <h1>Nexa Control</h1>
  <div id="list"></div>
  <button class="all" onclick="addOutlet()">Add outlet</button>
  <button class="all" onclick="allOff()">All off</button>
  <div id="msg"></div>
</main>
<script>
let devices = [];

async function load() {
  const r = await fetch('/api/devices');
  devices = await r.json();
  render();
}

function render() {
  const list = document.getElementById('list');
  list.innerHTML = '';
  for (const d of devices) {
    const card = document.createElement('div');
    card.className = 'card';
    const status = d.state === true ? 'On' : d.state === false ? 'Off' : 'Unknown';
    card.innerHTML =
      '<div><div class="name"></div><div class="status ' + (d.state ? 'on' : '') +
      '">' + status + '</div></div>' +
      '<div class="btns"><button class="on">On</button><button>Off</button></div>';
    card.querySelector('.name').textContent = d.name;
    const [bOn, bOff] = card.querySelectorAll('button');
    bOn.onclick = () => send(d.unit, 'on', bOn, bOff);
    bOff.onclick = () => send(d.unit, 'off', bOn, bOff);
    list.appendChild(card);
  }
}

async function addOutlet() {
  const name = prompt('Name for the new outlet:', 'Outlet ' + (devices.length + 1));
  if (name === null) return;
  if (!name.trim()) {
    setMsg('Please enter a name');
    return;
  }
  if (!confirm('Press the outlet\\'s learn button, then click OK to pair it.')) return;

  setMsg('Pairing...');
  try {
    const r = await fetch('/api/pair', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({name: name.trim()})
    });
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      throw new Error(body.error || 'Pairing failed');
    }
    setMsg('Outlet paired');
  } catch (e) {
    setMsg(e.message || 'Failed to pair outlet');
  }
  await load();
}

async function send(unit, action, ...btns) {
  btns.forEach(b => b.disabled = true);
  setMsg('Sending...');
  try {
    const r = await fetch('/api/' + unit + '/' + action, {method: 'POST'});
    if (!r.ok) throw new Error();
    setMsg('Sent');
  } catch (e) {
    setMsg('Failed to send');
  }
  await load();
}

async function allOff() {
  setMsg('Sending...');
  try {
    const r = await fetch('/api/all/off', {method: 'POST'});
    if (!r.ok) throw new Error();
    setMsg('All off');
  } catch (e) {
    setMsg('Failed to send');
  }
  await load();
}

function setMsg(t) { document.getElementById('msg').textContent = t; }
load();
</script>
</body>
</html>
"""


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
    if action not in ("on", "off") or unit not in [d["unit"] for d in configured_devices]:
        return jsonify(error="bad request"), 400
    try:
        transmit(action == "on", unit)
    except Exception as e:
        return jsonify(error=str(e)), 500
    state[unit] = action == "on"
    save_state(state)
    return jsonify(ok=True)


@app.post("/api/pair")
def pair():
    data = request.get_json(silent=True) or {}
    name = data.get("name")
    if not isinstance(name, str) or not name.strip():
        return jsonify(error="name is required"), 400

    used_units = {d["unit"] for d in configured_devices}
    available_units = [unit for unit in range(16) if unit not in used_units]
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
            transmit(False, d["unit"])
            state[d["unit"]] = False
            time.sleep(0.2)
    except Exception as e:
        return jsonify(error=str(e)), 500
    save_state(state)
    return jsonify(ok=True)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=PORT)
