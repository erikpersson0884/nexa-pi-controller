const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
let devices = [];
let timerData = {countdowns: [], schedules: []};
let timerUnit = null;
let editing = null;
let editingDevice = null;
let toastTimer;
let reorderMode = false;
let reorderDevices = [];
let dragged = null;

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
  document.getElementById('page-title').textContent = reorderMode ? 'Reorder' : 'Nexa Control';
  document.getElementById('summary').textContent = reorderMode
    ? 'Drag the handle or use the arrows'
    : `${devices.length} outlet${devices.length === 1 ? '' : 's'} · ${onCount} on`;
  document.getElementById('all-off').hidden = reorderMode;
  document.getElementById('reorder-done').hidden = !reorderMode;
  document.getElementById('add-outlet').hidden = reorderMode;
  if (!devices.length) {
    const empty = el('div', 'empty');
    empty.append(el('strong', '', 'No outlets configured'));
    empty.append(el('div', '', 'Add an outlet below to get started.'));
    list.append(empty);
    return;
  }
  const visibleDevices = reorderMode ? reorderDevices : devices;
  visibleDevices.forEach((device, index) => {
    const card = el('article', 'outlet-card');
    card.dataset.unit = device.unit;
    if (reorderMode) {
      card.classList.add('reorder-card');
      const name = el('div', 'reorder-name', device.name);
      const controls = el('div', 'reorder-controls');
      const up = reorderButton('⌃', `Move ${device.name} up`, index === 0,
        () => moveReorderDevice(index, -1));
      const down = reorderButton('⌄', `Move ${device.name} down`,
        index === visibleDevices.length - 1, () => moveReorderDevice(index, 1));
      const handle = reorderButton('⠿', `Drag ${device.name}`, false);
      handle.classList.add('drag-handle');
      handle.addEventListener('pointerdown', event => startDragging(event, card, index));
      controls.append(up, down, handle);
      card.append(name, controls);
      list.append(card);
      return;
    }
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

function reorderButton(text, label, disabled, onclick) {
  const button = el('button', '', text);
  button.type = 'button';
  button.setAttribute('aria-label', label);
  button.disabled = disabled;
  button.onclick = onclick;
  return button;
}

function announceReorder(device, index) {
  document.getElementById('reorder-announcement').textContent =
    `${device.name} moved to position ${index + 1} of ${reorderDevices.length}`;
}

function moveReorderDevice(index, direction) {
  const target = index + direction;
  if (target < 0 || target >= reorderDevices.length) return;
  const moved = reorderDevices[index];
  [reorderDevices[index], reorderDevices[target]] =
    [reorderDevices[target], reorderDevices[index]];
  renderDevices();
  announceReorder(moved, target);
  const button = document.querySelector(`[data-unit="${moved.unit}"] .reorder-controls button`);
  if (button) button.focus();
}

function enterReorderMode(device) {
  reorderMode = true;
  reorderDevices = devices.map(device => ({...device}));
  renderDevices();
}

async function leaveReorderMode(save) {
  if (!reorderMode) return;
  if (!save) {
    reorderMode = false;
    reorderDevices = [];
    renderDevices();
    return;
  }
  try {
    await api('PUT', '/api/devices/order', {order: reorderDevices.map(device => device.unit)});
    reorderMode = false;
    reorderDevices = [];
    await refresh();
    showToast('Order saved');
  } catch (error) {
    showToast(`Failed: ${error.message}`);
  }
}

function updateDragTransforms() {
  if (!dragged) return;
  const cards = [...document.querySelectorAll('.reorder-card')];
  cards.forEach((card, index) => {
    if (card !== dragged.card) card.style.transform = '';
  });
}

function finishDragging(cancelled = false) {
  if (!dragged) return;
  const {card, index, placeholderIndex, pointerId} = dragged;
  card.releasePointerCapture?.(pointerId);
  if (!cancelled && placeholderIndex !== index) {
    const [moved] = reorderDevices.splice(index, 1);
    reorderDevices.splice(placeholderIndex, 0, moved);
    announceReorder(moved, placeholderIndex);
  }
  dragged.placeholder?.remove();
  dragged = null;
  renderDevices();
}

function startDragging(event, card, index) {
  if (!reorderMode || event.button !== 0) return;
  event.preventDefault();
  const rect = card.getBoundingClientRect();
  const height = card.offsetHeight;
  const placeholder = el('div', 'reorder-placeholder');
  placeholder.style.height = `${height}px`;
  card.before(placeholder);
  dragged = {
    card, index, placeholderIndex: index, height, pointerId: event.pointerId,
    startY: event.clientY, offsetY: event.clientY - rect.top, placeholder
  };
  card.style.width = `${rect.width}px`;
  card.style.left = `${rect.left}px`;
  card.style.top = `${rect.top}px`;
  card.classList.add('dragging');
  card.setPointerCapture(event.pointerId);
  const move = moveEvent => {
    if (!dragged) return;
    if (Math.abs(moveEvent.clientY - dragged.startY) < 10) return;
    dragged.card.style.transform =
      `translateY(0)`;
    dragged.card.style.top =
      `${moveEvent.clientY - dragged.offsetY}px`;
    const edge = 60;
    if (moveEvent.clientY < edge) window.scrollBy(0, -8);
    else if (moveEvent.clientY > window.innerHeight - edge) window.scrollBy(0, 8);
    const cards = [...document.querySelectorAll('.reorder-card:not(.dragging)')];
    const target = cards.findIndex(other =>
      moveEvent.clientY < other.getBoundingClientRect().top + other.offsetHeight / 2);
    const nextIndex = target === -1 ? cards.length : target;
    const targetCard = cards[nextIndex];
    if (targetCard) targetCard.before(dragged.placeholder);
    else document.getElementById('outlet-list').append(dragged.placeholder);
    dragged.placeholderIndex = Math.max(
      0, Math.min(reorderDevices.length - 1, nextIndex));
    updateDragTransforms();
  };
  card.onpointermove = move;
  card.onpointerup = () => finishDragging();
  card.onpointercancel = () => finishDragging(true);
}

function showDeviceMenu(card, device) {
  const existing = card.querySelector('.menu');
  document.querySelectorAll('.menu').forEach(menu => menu.remove());
  if (existing) return;
  const menu = el('div', 'menu');
  const rename = el('button', '', 'Edit');
  rename.onclick = () => renameDevice(device);
  const remove = el('button', 'danger', 'Remove');
  remove.onclick = () => removeDevice(device);
  menu.append(rename);
  if (devices.length > 1) {
    const reorder = el('button', '', 'Reorder outlets');
    reorder.onclick = () => enterReorderMode(device);
    menu.append(reorder);
  }
  menu.append(remove);
  card.append(menu);
}

async function renameDevice(device) {
  editingDevice = device;
  const input = document.getElementById('rename-name');
  input.value = device.name;
  populateUnitOptions('rename-unit', device.unit);
  document.getElementById('rename-modal').hidden = false;
  input.focus();
}

function populateUnitOptions(id, selectedUnit = null) {
  const select = document.getElementById(id);
  while (select.firstChild) select.removeChild(select.firstChild);
  const used = new Set(devices.map(device => device.unit));
  for (let unit = 0; unit < 16; unit += 1) {
    if (used.has(unit) && unit !== selectedUnit) continue;
    const option = el('option', '', `Unit ${unit}`);
    option.value = unit;
    option.selected = unit === selectedUnit;
    select.append(option);
  }
}

async function saveDeviceName(event) {
  event.preventDefault();
  const name = document.getElementById('rename-name').value.trim();
  if (!name || !editingDevice) return;
  const unit = Number.parseInt(document.getElementById('rename-unit').value, 10);
  try {
    await api('PATCH', `/api/devices/${editingDevice.unit}`, {name, unit});
    closeOverlay('rename-modal');
    showToast('Outlet updated');
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
      await api('POST', '/api/countdowns', {unit: editing.unit, action, minutes: Number.parseInt(document.getElementById('timer-minutes').value, 10)});
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
  input.placeholder = `Outlet ${devices.length + 1}`;
  populateUnitOptions('pair-unit', null);
  const firstAvailable = document.getElementById('pair-unit').options[0];
  if (firstAvailable) firstAvailable.selected = true;
  document.getElementById('pair-modal').hidden = false;
  input.focus();
  input.select();
}

async function pairOutlet(event) {
  event.preventDefault();
  try {
    await api('POST', '/api/pair', {
      name: document.getElementById('pair-name').value.trim(),
      unit: Number.parseInt(document.getElementById('pair-unit').value, 10),
    });
    closeOverlay('pair-modal');
    await refresh();
    showToast('Outlet paired');
  } catch (error) { showToast(error.message); }
}

async function refreshTimers() {
  if (reorderMode) return;
  timerData = await api('GET', '/api/timers');
  renderDevices();
  if (!document.getElementById('timer-sheet').hidden) renderTimerSheet();
}

async function refresh() {
  if (reorderMode) return;
  devices = await api('GET', '/api/devices');
  timerData = await api('GET', '/api/timers');
  renderDevices();
  if (!document.getElementById('timer-sheet').hidden) renderTimerSheet();
}

document.getElementById('add-outlet').onclick = openPairModal;
document.getElementById('all-off').onclick = allOff;
document.getElementById('reorder-done').onclick = () => leaveReorderMode(true);
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
  if (event.key === 'Escape' && reorderMode) {
    leaveReorderMode(false).catch(error => showToast(`Failed: ${error.message}`));
    return;
  }
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
