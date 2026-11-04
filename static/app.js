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
  updateTimerAvailability();
}

function updateTimerAvailability() {
  const hasDevices = devices.length > 0;
  document.getElementById('timer-empty').hidden = hasDevices;
  for (const id of ['countdown-section', 'schedule-section']) {
    document.getElementById(id).hidden = !hasDevices;
  }
}

function renderDevices() {
  const list = document.getElementById('list');
  list.innerHTML = '';
  if (devices.length === 0) {
    const empty = el('div', 'empty');
    empty.appendChild(el('div', 'empty-title', 'No outlets configured'));
    empty.appendChild(el(
      'div',
      '',
      'Put a Nexa outlet in learning mode, then click "Add outlet" to pair it.'
    ));
    list.appendChild(empty);
    return;
  }
  for (const d of devices) {
    const card = el('div', 'card');
    const left = el('div');
    left.appendChild(el('div', 'name', d.name));
    const status = d.state === true ? 'On' : d.state === false ? 'Off' : 'Unknown';
    left.appendChild(el('div', 'status' + (d.state ? ' on' : ''), status));
    const btns = el('div', 'btns outlet-switch');
    const bOn = el('button', d.state === true ? 'on active' : '', 'On');
    const bOff = el('button', d.state === false ? 'on active' : '', 'Off');
    bOn.setAttribute('aria-pressed', d.state === true);
    bOff.setAttribute('aria-pressed', d.state === false);
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
  const modal = document.getElementById('pair-modal');
  const name = document.getElementById('pair-name');
  name.value = 'Outlet ' + (devices.length + 1);
  modal.hidden = false;
  name.focus();
  name.select();
}

function closePairModal() {
  document.getElementById('pair-modal').hidden = true;
}

async function pairOutlet(event) {
  event.preventDefault();
  const name = document.getElementById('pair-name').value.trim();
  if (!name) return;
  closePairModal();
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
