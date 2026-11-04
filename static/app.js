const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
let devices = [];
let timerData = {countdowns: [], schedules: []};
let timerUnit = null;
let editing = null;
let editingDevice = null;
let toastTimer;

async function api(method, url, body) {
  const options = {method};
  if (method !== 'GET') {
    options.headers = {'X-CSRFToken': document.querySelector('meta[name="csrf-token"]').content};
  }
  if (body !== undefined) {
    options.headers = {...options.headers, 'Content-Type': 'application/json'};
    options.body = JSON.stringify(body);
  }
  const response = await fetch(url, options);
  let data = {};
  try { data = await response.json(); } catch (_) {}
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3500);
}

function closeOverlay(id) {
  document.getElementById(id).hidden = true;
  if (id === 'timer-sheet') timerUnit = null;
  if (id === 'editor-sheet') editing = null;
  if (id === 'rename-modal' || id === 'remove-modal') editingDevice = null;
}

function timerSummary(unit) {
  const schedules = timerData.schedules.filter(s => s.unit === unit && s.enabled);
  const countdowns = timerData.countdowns.filter(c => c.unit === unit);
  const countdownParts = countdowns.slice(0, 1).map(c =>
    `${c.action === 'on' ? 'On' : 'Off'} in ${fmtRemaining(c.remaining)}`);
  const parts = [...countdownParts, ...schedules.slice(0, 2).map(s =>
    `${s.action === 'on' ? 'On' : 'Off'} ${s.time}`)];
  if (schedules.length) parts.push(fmtDays(schedules[0].days).toLowerCase());
  return parts.length ? parts.join(' · ') : '+ Add timer';
}

function renderDevices() {
  const list = document.getElementById('outlet-list');
  while (list.firstChild) list.removeChild(list.firstChild);
  const onCount = devices.filter(d => d.state === true).length;
  document.getElementById('summary').textContent = `${devices.length} outlet${devices.length === 1 ? '' : 's'} · ${onCount} on`;
  if (!devices.length) {
    const empty = el('div', 'empty');
    empty.append(el('strong', '', 'No outlets configured'));
    empty.append(el('div', '', 'Add an outlet below to get started.'));
    list.append(empty);
    return;
  }
  devices.forEach(device => {
    const card = el('article', 'outlet-card');
    const head = el('div', 'outlet-head');
    const info = el('div');
    info.append(el('h2', 'outlet-name', device.name));
    const status = device.state === true ? 'On' : device.state === false ? 'Off' : 'Unknown';
    const sent = device.last_sent ? ` ${device.last_sent}` : '';
    info.append(el('div', `subline status${device.state === true ? ' on' : ''}`,
      `${status} · last sent${sent}`));
    const toggle = el('button', 'switch');
    toggle.type = 'button';
    toggle.role = 'switch';
    toggle.setAttribute('aria-checked', String(device.state === true));
    toggle.setAttribute('aria-label', `Turn ${device.state === true ? 'off' : 'on'} ${device.name}`);
    toggle.onclick = () => send(device.unit, device.state === true ? 'off' : 'on');
    const menuButton = el('button', 'menu-button', '⋯');
    menuButton.type = 'button';
    menuButton.setAttribute('aria-label', `Options for ${device.name}`);
    menuButton.onclick = () => showDeviceMenu(card, device);
    head.append(info, toggle);
    card.append(head);
    card.append(menuButton);
    const timerButton = el('button', 'timer-link');
    timerButton.type = 'button';
    const timerText = el('span', '');
    timerText.append(el('span', 'timer-icon', '◷'), document.createTextNode(` ${timerSummary(device.unit)}`));
    timerButton.append(timerText, el('span', 'chevron', '›'));
    timerButton.onclick = () => openTimerSheet(device);
    card.append(timerButton);
    list.append(card);
  });
}

function showDeviceMenu(card, device) {
  const existing = card.querySelector('.menu');
  document.querySelectorAll('.menu').forEach(menu => menu.remove());
  if (existing) return;
  const menu = el('div', 'menu');
  const rename = el('button', '', 'Rename');
  rename.onclick = () => renameDevice(device);
  const remove = el('button', 'danger', 'Remove');
  remove.onclick = () => removeDevice(device);
  menu.append(rename, remove);
  card.append(menu);
}

async function renameDevice(device) {
  editingDevice = device;
  const input = document.getElementById('rename-name');
  input.value = device.name;
  document.getElementById('rename-modal').hidden = false;
  input.focus();
  input.select();
}

async function saveDeviceName(event) {
  event.preventDefault();
  const name = document.getElementById('rename-name').value.trim();
  if (!name || !editingDevice) return;
  try {
    await api('PATCH', `/api/devices/${editingDevice.unit}`, {name});
    closeOverlay('rename-modal');
    showToast('Outlet renamed');
    await refresh();
  } catch (error) { showToast(error.message); }
}

async function removeDevice(device) {
  editingDevice = device;
  document.getElementById('remove-message').textContent =
    `Remove ${device.name} and all of its timers?`;
  document.getElementById('remove-modal').hidden = false;
}

async function confirmRemoveDevice() {
  if (!editingDevice) return;
  try {
    await api('DELETE', `/api/devices/${editingDevice.unit}`);
    closeOverlay('remove-modal');
    showToast('Outlet removed');
    await refresh();
  } catch (error) { showToast(error.message); }
}

async function send(unit, action) {
  try {
    showToast('Sending...');
    await api('POST', `/api/${unit}/${action}`);
    showToast('Command sent');
    await refresh();
  } catch (error) { showToast(`Failed: ${error.message}`); }
}

async function allOff() {
  try {
    showToast('Sending...');
    await api('POST', '/api/all/off');
    showToast('All off');
    await refresh();
  } catch (error) { showToast(`Failed: ${error.message}`); }
}

function fmtRemaining(seconds) {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

function fmtDays(days) {
  if (days.length === 7) return 'Every day';
  const sorted = [...days].sort((a, b) => a - b).join(',');
  if (sorted === '0,1,2,3,4') return 'Weekdays';
  if (sorted === '5,6') return 'Weekends';
  return days.map(day => DAY_NAMES[day]).join(', ');
}

function openTimerSheet(device) {
  timerUnit = device.unit;
  document.getElementById('timer-sheet-title').textContent = `${device.name} timers`;
  renderTimerSheet();
  document.getElementById('timer-sheet').hidden = false;
}

function renderTimerSheet() {
  const list = document.getElementById('timer-list');
  while (list.firstChild) list.removeChild(list.firstChild);
  const countdowns = timerData.countdowns.filter(c => c.unit === timerUnit);
  const schedules = timerData.schedules.filter(s => s.unit === timerUnit);
  if (!countdowns.length && !schedules.length) {
    list.append(el('div', 'empty', 'No timers yet'));
    return;
  }
  countdowns.forEach(countdown => {
    const row = el('div', 'timer-row');
    const info = el('div');
    info.append(el('div', 'timer-time', `Turns ${countdown.action === 'on' ? 'on' : 'off'} in ${fmtRemaining(countdown.remaining)}`));
    info.append(el('div', 'timer-action', 'Countdown'));
    const cancel = el('button', 'secondary', 'Cancel');
    cancel.onclick = async () => {
      await api('DELETE', `/api/countdowns/${countdown.id}`);
      await refreshTimers();
      showToast('Timer cancelled');
    };
    row.append(info, cancel);
    row.onclick = () => openEditor('countdown', countdown);
    list.append(row);
  });
  schedules.forEach(schedule => {
    const row = el('div', `timer-row ${schedule.enabled ? '' : 'muted'}`);
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    const info = el('div');
    info.append(el('div', 'timer-time', schedule.time));
    info.append(el('div', 'timer-action', `Turns ${schedule.action === 'on' ? 'on' : 'off'} · ${fmtDays(schedule.days).toLowerCase()}`));
    const toggle = el('button', 'switch');
    toggle.type = 'button';
    toggle.role = 'switch';
    toggle.setAttribute('aria-checked', String(schedule.enabled));
    toggle.setAttribute('aria-label', `${schedule.enabled ? 'Disable' : 'Enable'} schedule`);
    toggle.onclick = async event => {
      event.stopPropagation();
      await api('POST', `/api/schedules/${schedule.id}/toggle`);
      await refreshTimers();
    };
    row.append(info, toggle);
    row.onclick = () => openEditor('schedule', schedule);
    row.onkeydown = event => {
      if (event.key === 'Enter' || event.key === ' ') openEditor('schedule', schedule);
    };
    list.append(row);
  });
}

function openEditor(mode, timer = null) {
  editing = timer ? {...timer, mode} : {unit: timerUnit, mode};
  document.getElementById('editor-title').textContent = timer ? 'Edit timer' : 'Add timer';
  setSegment('mode', mode);
  setSegment('action', timer?.action || 'on');
  document.getElementById('timer-minutes').value =
    timer?.minutes || (timer ? Math.max(1, Math.ceil(timer.remaining / 60)) : 30);
  document.getElementById('timer-time').value = timer?.time || '18:00';
  setDays(timer?.days || [0, 1, 2, 3, 4, 5, 6]);
  document.getElementById('delete-timer').hidden = !timer;
  document.getElementById('editor-sheet').hidden = false;
}

function setSegment(type, value) {
  document.querySelectorAll(`[data-${type}]`).forEach(button => {
    button.setAttribute('aria-pressed', button.dataset[type] === value);
  });
  if (type === 'mode') {
    document.getElementById('countdown-editor').hidden = value !== 'countdown';
    document.getElementById('schedule-editor').hidden = value !== 'schedule';
  }
}

function setDays(days) {
  document.querySelectorAll('#timer-days button').forEach((button, index) => {
    button.setAttribute('aria-pressed', days.includes(index));
  });
}

function buildDays() {
  const box = document.getElementById('timer-days');
  DAY_NAMES.forEach((name, index) => {
    const button = el('button', '', name[0]);
    button.type = 'button';
    button.setAttribute('aria-label', `${name} day`);
    button.dataset.day = index;
    button.onclick = () => button.setAttribute('aria-pressed', button.getAttribute('aria-pressed') !== 'true');
    box.append(button);
  });
  setDays([0, 1, 2, 3, 4, 5, 6]);
}

async function saveTimer(event) {
  event.preventDefault();
  const mode = document.querySelector('[data-mode][aria-pressed="true"]').dataset.mode;
  const action = document.querySelector('[data-action][aria-pressed="true"]').dataset.action;
  try {
    if (mode === 'countdown') {
      if (editing.id) await api('DELETE', `/api/countdowns/${editing.id}`);
      await api('POST', '/api/countdowns', {unit: editing.unit, action, minutes: parseInt(document.getElementById('timer-minutes').value, 10)});
    } else {
      const days = [...document.querySelectorAll('#timer-days button')].map((button, index) => button.getAttribute('aria-pressed') === 'true' ? index : null).filter(index => index !== null);
      const payload = {unit: editing.unit, action, time: document.getElementById('timer-time').value, days};
      if (editing.id) await api('PATCH', `/api/schedules/${editing.id}`, payload);
      else await api('POST', '/api/schedules', payload);
    }
    closeOverlay('editor-sheet');
    await refreshTimers();
    showToast('Timer saved');
  } catch (error) { showToast(`Failed: ${error.message}`); }
}

async function deleteTimer() {
  if (!editing?.id || !window.confirm('Delete this timer?')) return;
  const endpoint = editing.mode === 'schedule' ? `/api/schedules/${editing.id}` : `/api/countdowns/${editing.id}`;
  await api('DELETE', endpoint);
  closeOverlay('editor-sheet');
  await refreshTimers();
  showToast('Timer deleted');
}

function openPairModal() {
  const input = document.getElementById('pair-name');
  input.value = `Outlet ${devices.length + 1}`;
  document.getElementById('pair-modal').hidden = false;
  input.focus();
  input.select();
}

async function pairOutlet(event) {
  event.preventDefault();
  try {
    await api('POST', '/api/pair', {name: document.getElementById('pair-name').value.trim()});
    closeOverlay('pair-modal');
    await refresh();
    showToast('Outlet paired');
  } catch (error) { showToast(error.message); }
}

async function refreshTimers() {
  timerData = await api('GET', '/api/timers');
  renderDevices();
  if (!document.getElementById('timer-sheet').hidden) renderTimerSheet();
}

async function refresh() {
  devices = await api('GET', '/api/devices');
  timerData = await api('GET', '/api/timers');
  renderDevices();
  if (!document.getElementById('timer-sheet').hidden) renderTimerSheet();
}

document.getElementById('add-outlet').onclick = openPairModal;
document.getElementById('all-off').onclick = allOff;
document.getElementById('pair-form').onsubmit = pairOutlet;
document.getElementById('rename-form').onsubmit = saveDeviceName;
document.getElementById('confirm-remove').onclick = confirmRemoveDevice;
document.getElementById('timer-form').onsubmit = saveTimer;
document.getElementById('delete-timer').onclick = deleteTimer;
document.getElementById('sheet-add-timer').onclick = () => openEditor('countdown');
document.querySelectorAll('[data-close]').forEach(button => {
  button.onclick = () => closeOverlay(button.dataset.close);
});
document.querySelectorAll('[data-mode]').forEach(button => button.onclick = () => setSegment('mode', button.dataset.mode));
document.querySelectorAll('[data-action]').forEach(button => button.onclick = () => setSegment('action', button.dataset.action));
document.querySelectorAll('[data-minutes]').forEach(button => button.onclick = () => {
  document.getElementById('timer-minutes').value = button.dataset.minutes;
});
document.querySelectorAll('[data-days]').forEach(button => button.onclick = () => {
  const days = button.dataset.days === 'every' ? [0,1,2,3,4,5,6] : button.dataset.days === 'weekdays' ? [0,1,2,3,4] : [5,6];
  setDays(days);
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    document.querySelectorAll('.menu').forEach(menu => menu.remove());
  }
  if (event.key === 'Escape') document.querySelectorAll('.overlay:not([hidden])').forEach(sheet => closeOverlay(sheet.id));
});
document.addEventListener('click', event => {
  if (!event.target.closest('.menu') && !event.target.closest('.menu-button')) {
    document.querySelectorAll('.menu').forEach(menu => menu.remove());
  }
});
document.querySelectorAll('.overlay').forEach(overlay => {
  overlay.onclick = event => { if (event.target === overlay) closeOverlay(overlay.id); };
});
document.querySelectorAll('.sheet').forEach(sheet => {
  let startY = 0;
  sheet.ontouchstart = event => { startY = event.touches[0].clientY; };
  sheet.ontouchend = event => {
    if (event.changedTouches[0].clientY - startY > 60) closeOverlay(sheet.parentElement.id);
  };
});

buildDays();
refresh().catch(error => showToast(error.message));
setInterval(refreshTimers, 15000);
setInterval(refresh, 15000);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
