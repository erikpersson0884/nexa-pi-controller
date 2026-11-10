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
let viewMode = readView();
let editorUnits = [];
let timerSheetOpen = false;
let suppressTileClick = false;
let allOffTimer = null;
let allCommandInProgress = false;
const LONG_PRESS_MS = 500;
const ALL_OFF_DOUBLE_PRESS_MS = 400;
const ICONS = {
  power: [['path', {d: 'M18.36 6.64a9 9 0 1 1-12.73 0'}], ['path', {d: 'M12 2v10'}]],
  clock: [['circle', {cx: 12, cy: 12, r: 10}], ['polyline', {points: '12 6 12 12 16 14'}]],
  list: [['path', {d: 'M4 6h16M4 12h16M4 18h16'}]],
  grid: [['rect', {x: 4, y: 4, width: 6, height: 6, rx: 1}], ['rect', {x: 14, y: 4, width: 6, height: 6, rx: 1}],
    ['rect', {x: 4, y: 14, width: 6, height: 6, rx: 1}], ['rect', {x: 14, y: 14, width: 6, height: 6, rx: 1}]],
  check: [['polyline', {points: '20 6 9 17 4 12'}]],
};

function readView() {
  try {
    return localStorage.getItem('nexa-view') === 'grid' ? 'grid' : 'list';
  } catch (_) { return 'list'; }
}

function setView(view) {
  viewMode = view === 'grid' ? 'grid' : 'list';
  try { localStorage.setItem('nexa-view', viewMode); } catch (_) {}
  renderDevices();
}

function icon(name, size = 20) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', 2);
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  ICONS[name].forEach(([tag, attrs]) => {
    const shape = document.createElementNS(ns, tag);
    Object.entries(attrs).forEach(([key, value]) => shape.setAttribute(key, value));
    svg.append(shape);
  });
  return svg;
}

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
  if (id === 'timer-sheet') { timerUnit = null; timerSheetOpen = false; }
  if (id === 'editor-sheet') editing = null;
  if (id === 'rename-modal' || id === 'remove-modal') editingDevice = null;
}

function timerSummary(unit) {
  const schedules = timerData.schedules.filter(s => s.units.includes(unit) && s.enabled);
  const countdowns = timerData.countdowns.filter(c => c.units.includes(unit));
  const countdownParts = countdowns.slice(0, 1).map(c =>
    `${c.action === 'on' ? 'On' : 'Off'} in ${fmtRemaining(c.remaining)}`);
  const parts = [...countdownParts, ...schedules.slice(0, 2).map(s =>
    `${s.action === 'on' ? 'On' : 'Off'} ${s.time}`)];
  if (schedules.length) parts.push(fmtDays(schedules[0].days).toLowerCase());
  return parts.length ? parts.join(' · ') : '+ Add timer';
}

function nextTimerTime(unit) {
  const now = new Date();
  let best = null;
  timerData.schedules.filter(s => s.enabled && s.units.includes(unit)).forEach(schedule => {
    const [hours, minutes] = schedule.time.split(':').map(Number);
    for (let offset = 0; offset < 8; offset += 1) {
      const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, hours, minutes);
      if (candidate > now && schedule.days.includes((candidate.getDay() + 6) % 7)) {
        if (!best || candidate < best) best = candidate;
        break;
      }
    }
  });
  timerData.countdowns.filter(c => c.units.includes(unit)).forEach(countdown => {
    const candidate = new Date(now.getTime() + countdown.remaining * 1000);
    if (!best || candidate < best) best = candidate;
  });
  if (!best) return null;
  return `${String(best.getHours()).padStart(2, '0')}:${String(best.getMinutes()).padStart(2, '0')}`;
}

function renderGrid(list) {
  if (!devices.length) {
    const empty = el('div', 'empty');
    empty.append(el('strong', '', 'No outlets configured'));
    empty.append(el('div', '', 'Add an outlet below to get started.'));
    list.append(empty);
  }
  devices.forEach(device => {
    const on = device.state === true;
    const wrap = el('div', 'tile-wrap');
    wrap.dataset.unit = device.unit;
    const tile = el('button', `tile${on ? ' on' : ''}`);
    tile.type = 'button';
    tile.role = 'switch';
    tile.setAttribute('aria-checked', String(on));
    tile.setAttribute('aria-label', device.name);
    const top = el('div', 'tile-top');
    const badge = el('span', 'tile-icon');
    badge.append(icon('power', 20));
    top.append(badge);
    const next = nextTimerTime(device.unit);
    if (next) {
      const nextTimer = el('span', 'tile-next');
      nextTimer.append(icon('clock', 14), document.createTextNode(next));
      top.append(nextTimer);
    }
    const bottom = el('div', 'tile-bottom');
    bottom.append(el('div', 'tile-name', device.name));
    const status = on ? 'On' : device.state === false ? 'Off' : 'Unknown';
    bottom.append(el('div', 'tile-status',
      device.last_sent ? `${status} · sent ${device.last_sent}` : status));
    tile.append(top, bottom);
    tile.onclick = event => {
      if (suppressTileClick) {
        suppressTileClick = false;
        event.stopPropagation();
        return;
      }
      send(device.unit, on ? 'off' : 'on');
    };
    attachLongPress(tile, () => showDeviceMenu(wrap, device));
    const menuButton = el('button', 'menu-button tile-menu', '⋯');
    menuButton.type = 'button';
    menuButton.setAttribute('aria-label', `Options for ${device.name}`);
    menuButton.onclick = () => showDeviceMenu(wrap, device);
    wrap.append(tile, menuButton);
    list.append(wrap);
  });
  const add = el('button', 'tile-add');
  add.type = 'button';
  add.append(el('span', 'tile-add-plus', '+'), document.createTextNode(' Add outlet'));
  add.onclick = openPairModal;
  list.append(add);
}

function attachLongPress(node, onLongPress) {
  let timer = null;
  let startX = 0;
  let startY = 0;
  const cancel = () => { clearTimeout(timer); timer = null; };
  node.addEventListener('pointerdown', event => {
    if (event.button > 0) return;
    startX = event.clientX;
    startY = event.clientY;
    suppressTileClick = false;
    cancel();
    timer = setTimeout(() => {
      timer = null;
      suppressTileClick = true;
      onLongPress();
    }, LONG_PRESS_MS);
  });
  node.addEventListener('pointermove', event => {
    if (timer && Math.hypot(event.clientX - startX, event.clientY - startY) > 10) cancel();
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(type => node.addEventListener(type, cancel));
  node.addEventListener('contextmenu', event => event.preventDefault());
}

function renderDevices() {
  const list = document.getElementById('outlet-list');
  while (list.firstChild) list.removeChild(list.firstChild);
  const grid = viewMode === 'grid' && !reorderMode;
  list.classList.toggle('grid', grid);
  document.body.classList.toggle('view-grid', grid);
  const onCount = devices.filter(d => d.state === true).length;
  document.getElementById('page-title').textContent = reorderMode ? 'Reorder' : 'Nexa Control';
  document.getElementById('summary').textContent = reorderMode
    ? 'Drag the handle or use the arrows'
    : `${devices.length} outlet${devices.length === 1 ? '' : 's'} · ${onCount} on`;
  document.getElementById('all-off').hidden = reorderMode || grid;
  document.getElementById('reorder-done').hidden = !reorderMode;
  document.getElementById('view-switch').hidden = reorderMode;
  document.querySelectorAll('[data-view]').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.view === viewMode));
  });
  document.getElementById('add-outlet').hidden = reorderMode || grid;
  document.getElementById('bottom-bar').hidden = !grid;
  document.getElementById('timer-count').textContent =
    timerData.schedules.length + timerData.countdowns.length;
  if (grid) {
    renderGrid(list);
    return;
  }
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

async function switchAll(action) {
  allCommandInProgress = true;
  const buttons = [document.getElementById('all-off'), document.getElementById('all-off-bar')];
  buttons.forEach(button => { button.disabled = true; });
  try {
    showToast('Sending...');
    await api('POST', `/api/all/${action}`);
    showToast(action === 'on' ? 'All on' : 'All off');
    await refresh();
  } catch (error) {
    showToast(`Failed: ${error.message}`);
  } finally {
    allCommandInProgress = false;
    buttons.forEach(button => { button.disabled = false; });
  }
}

function allOff() {
  if (allCommandInProgress) return;
  if (allOffTimer !== null) {
    clearTimeout(allOffTimer);
    allOffTimer = null;
    switchAll('on');
  } else {
    allOffTimer = setTimeout(() => {
      allOffTimer = null;
      switchAll('off');
    }, ALL_OFF_DOUBLE_PRESS_MS);
  }
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

function unitNames(units) {
  return units.map(unit => devices.find(d => d.unit === unit)?.name || `Unit ${unit}`);
}

function tagRow(units) {
  const tags = el('div', 'tags');
  const names = unitNames(units);
  names.slice(0, 2).forEach(name => tags.append(el('span', 'tag', name)));
  if (names.length > 2) tags.append(el('span', 'tag', `+${names.length - 2}`));
  return tags;
}

function openTimerSheet(device = null) {
  timerUnit = device ? device.unit : null;
  timerSheetOpen = true;
  document.getElementById('timer-sheet-title').textContent =
    device ? `${device.name} timers` : 'All timers';
  renderTimerSheet();
  document.getElementById('timer-sheet').hidden = false;
}

function renderTimerSheet() {
  const list = document.getElementById('timer-list');
  while (list.firstChild) list.removeChild(list.firstChild);
  const inScope = timer => timerUnit === null || timer.units.includes(timerUnit);
  const countdowns = timerData.countdowns.filter(inScope);
  const schedules = timerData.schedules.filter(inScope)
    .sort((a, b) => a.time.localeCompare(b.time));
  if (!countdowns.length && !schedules.length) {
    list.append(el('div', 'empty', 'No timers yet'));
    return;
  }
  countdowns.forEach(countdown => {
    const row = el('div', 'timer-row');
    const info = el('div', 'timer-info');
    info.append(el('div', 'timer-label', 'COUNTDOWN'));
    info.append(el('div', 'timer-time countdown-text',
      `Turns ${countdown.action === 'on' ? 'on' : 'off'} in ${fmtRemaining(countdown.remaining)}`));
    info.append(tagRow(countdown.units));
    const cancel = el('button', 'secondary', 'Cancel');
    cancel.type = 'button';
    cancel.onclick = async event => {
      event.stopPropagation();
      try {
        await api('DELETE', `/api/countdowns/${countdown.id}`);
        await refreshTimers();
        showToast('Timer cancelled');
      } catch (error) { showToast(`Failed: ${error.message}`); }
    };
    row.append(info, cancel);
    row.onclick = () => openEditor('countdown', countdown);
    list.append(row);
  });
  schedules.forEach(schedule => {
    const row = el('div', `timer-row${schedule.enabled ? '' : ' is-off'}`);
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    const info = el('div', 'timer-info');
    info.append(el('div', 'timer-time', schedule.time));
    info.append(el('div', 'timer-action', `Turns ${schedule.action === 'on' ? 'on' : 'off'} · ${fmtDays(schedule.days).toLowerCase()}`));
    info.append(tagRow(schedule.units));
    const toggle = el('button', 'switch');
    toggle.type = 'button';
    toggle.role = 'switch';
    toggle.setAttribute('aria-checked', String(schedule.enabled));
    toggle.setAttribute('aria-label', `${schedule.enabled ? 'Disable' : 'Enable'} schedule`);
    toggle.onclick = async event => {
      event.stopPropagation();
      try {
        await api('POST', `/api/schedules/${schedule.id}/toggle`);
        await refreshTimers();
      } catch (error) { showToast(`Failed: ${error.message}`); }
    };
    row.append(info, toggle);
    row.onclick = () => openEditor('schedule', schedule);
    row.onkeydown = event => {
      if (event.target === row && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault();
        openEditor('schedule', schedule);
      }
    };
    list.append(row);
  });
}

function openEditor(mode, timer = null) {
  editing = timer ? {...timer, mode} : {mode};
  editorUnits = timer
    ? timer.units.filter(unit => devices.some(d => d.unit === unit))
    : timerUnit !== null ? [timerUnit] : devices.length === 1 ? [devices[0].unit] : [];
  document.getElementById('editor-title').textContent = timer ? 'Edit timer' : 'Add timer';
  setSegment('mode', mode);
  document.querySelectorAll('[data-mode]').forEach(button => { button.disabled = Boolean(timer); });
  setSegment('action', timer?.action || 'on');
  document.getElementById('timer-minutes').value =
    timer?.minutes || (timer ? Math.max(1, Math.ceil(timer.remaining / 60)) : 30);
  document.getElementById('timer-time').value = timer?.time || '18:00';
  setDays(timer?.days || [0, 1, 2, 3, 4, 5, 6]);
  renderOutletChips();
  document.getElementById('delete-timer').hidden = !timer;
  document.getElementById('editor-sheet').hidden = false;
}

function renderOutletChips() {
  const box = document.getElementById('timer-outlets');
  while (box.firstChild) box.removeChild(box.firstChild);
  const makeChip = (label, onclick) => {
    const chip = el('button', 'outlet-chip');
    chip.type = 'button';
    const check = el('span', 'chip-check');
    check.append(icon('check', 16));
    chip.append(check, el('span', 'chip-label', label));
    chip.onclick = onclick;
    box.append(chip);
    return chip;
  };
  const allChip = makeChip('Select all', () => {
    editorUnits = editorUnits.length === devices.length ? [] : devices.map(d => d.unit);
    updateOutletChips();
  });
  allChip.dataset.all = 'true';
  devices.forEach(device => {
    const chip = makeChip(device.name, () => {
      editorUnits = editorUnits.includes(device.unit)
        ? editorUnits.filter(unit => unit !== device.unit)
        : [...editorUnits, device.unit];
      updateOutletChips();
    });
    chip.dataset.unit = device.unit;
  });
  updateOutletChips();
}

function updateOutletChips() {
  const allSelected = devices.length > 0 && editorUnits.length === devices.length;
  document.querySelectorAll('#timer-outlets .outlet-chip').forEach(chip => {
    const selected = chip.dataset.all ? allSelected : editorUnits.includes(Number(chip.dataset.unit));
    chip.setAttribute('aria-pressed', String(selected));
    chip.querySelector('.chip-check').hidden = !selected;
  });
  const count = editorUnits.length;
  document.getElementById('outlets-count').textContent = `${count} selected`;
  document.getElementById('outlets-hint').hidden = count > 0;
  const save = document.getElementById('save-timer');
  save.disabled = count === 0;
  save.textContent = count ? `Save timer · ${count} outlet${count === 1 ? '' : 's'}` : 'Save timer';
}

function setSegment(type, value) {
  document.querySelectorAll(`[data-${type}]`).forEach(button => {
    button.setAttribute('aria-pressed', button.dataset[type] === value);
  });
  if (type === 'mode') {
    document.getElementById('countdown-editor').hidden = value !== 'countdown';
    document.getElementById('schedule-time-editor').hidden = value !== 'schedule';
    document.getElementById('schedule-days-editor').hidden = value !== 'schedule';
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
  const units = [...editorUnits];
  if (!units.length) return;
  try {
    if (mode === 'countdown') {
      if (editing.id) await api('DELETE', `/api/countdowns/${editing.id}`);
      await api('POST', '/api/countdowns', {units, action, minutes: Number.parseInt(document.getElementById('timer-minutes').value, 10)});
    } else {
      const days = [...document.querySelectorAll('#timer-days button')].map((button, index) => button.getAttribute('aria-pressed') === 'true' ? index : null).filter(index => index !== null);
      const payload = {units, action, time: document.getElementById('timer-time').value, days};
      if (editing.id) await api('PUT', `/api/schedules/${editing.id}`, payload);
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
document.getElementById('all-off-bar').onclick = allOff;
document.getElementById('open-timers').onclick = () => openTimerSheet();
document.querySelectorAll('[data-view]').forEach(button => {
  button.onclick = () => setView(button.dataset.view);
});
document.querySelector('[data-view="list"]').append(icon('list', 22));
document.querySelector('[data-view="grid"]').append(icon('grid', 22));
document.getElementById('timers-icon').append(icon('clock', 20));
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
  sheet.ontouchstart = event => { startY = sheet.scrollTop > 0 ? Infinity : event.touches[0].clientY; };
  sheet.ontouchend = event => {
    if (event.changedTouches[0].clientY - startY > 60) closeOverlay(sheet.parentElement.id);
  };
});

buildDays();
renderDevices();
refresh().catch(error => showToast(error.message));
setInterval(refreshTimers, 15000);
setInterval(refresh, 15000);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
