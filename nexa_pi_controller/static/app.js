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
let floors = [];
let currentFloorId = null;
let rooms = [];
let mapEditing = false;
let mapEditingSnapshot = null;
let allowRoomOverlap = false;
let editingRoom = null;
let editingFloorId = null;
let quickRoom = null;
let roomUnits = [];
let mapGesture = null;
let editorUnits = [];
let timerSheetOpen = false;
let settingsPage = location.hash === '#settings';
let appearancePage = location.hash === '#appearance';
let timersPage = location.hash === '#timers';
let suppressTileClick = false;
let allOffTimer = null;
let allCommandInProgress = false;
let appearance = {theme: 'system', custom: null, customEdited: false, savedThemes: []};
const MAP_SIZE = 100;
const MIN_ROOM_SIZE = 10;
const LONG_PRESS_MS = 500;
const ALL_OFF_DOUBLE_PRESS_MS = 400;
const APPEARANCE_STORAGE_KEY = 'nexa-appearance';
const APPEARANCE_THEMES = {
  dark: {background: '#121417', cards: '#1c1f24', text: '#f1f3f5', accent: '#15803d'},
  light: {background: '#f4f5f7', cards: '#ffffff', text: '#1c1e21', accent: '#15803d'},
  ocean: {background: '#10212d', cards: '#1a3040', text: '#e8f4fb', accent: '#0284c7'},
  forest: {background: '#142119', cards: '#1f3025', text: '#edf5ee', accent: '#16803d'},
  sage: {
    background: '#fbf8e8', cards: '#fffdee', text: '#2d3829', accent: '#4a6034',
    muted: '#66715f', btn: '#eeeedb', line: '#899572',
    shadow: '0 12px 30px rgba(45, 56, 41, .12)',
    backgroundImage: 'linear-gradient(180deg, #c5d4c5 0%, #e8e8cb 18%, #fbf8e8 31%, #fbf8e8 100%)',
  },
};
const ICONS = {
  power: [['path', {d: 'M18.36 6.64a9 9 0 1 1-12.73 0'}], ['path', {d: 'M12 2v10'}]],
  clock: [['circle', {cx: 12, cy: 12, r: 10}], ['polyline', {points: '12 6 12 12 16 14'}]],
  list: [['path', {d: 'M4 6h16M4 12h16M4 18h16'}]],
  grid: [['rect', {x: 4, y: 4, width: 6, height: 6, rx: 1}], ['rect', {x: 14, y: 4, width: 6, height: 6, rx: 1}],
    ['rect', {x: 4, y: 14, width: 6, height: 6, rx: 1}], ['rect', {x: 14, y: 14, width: 6, height: 6, rx: 1}]],
  map: [['path', {d: 'M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2z'}], ['path', {d: 'M9 4v14M15 6v14'}]],
  check: [['polyline', {points: '20 6 9 17 4 12'}]],
};

function readView() {
  try {
    const view = localStorage.getItem('nexa-view');
    return ['grid', 'map'].includes(view) ? view : 'list';
  } catch (_) { return 'list'; }
}

function setView(view) {
  viewMode = ['grid', 'map'].includes(view) ? view : 'list';
  if (settingsPage || appearancePage || timersPage) showUtilityPage(null);
  try { localStorage.setItem('nexa-view', viewMode); } catch (_) {}
  if (viewMode !== 'map' && mapEditing) cancelMapEditing();
  renderDevices();
  if (viewMode === 'map') refreshMap().catch(error => showToast(error.message));
}

function showUtilityPage(page) {
  settingsPage = page === 'settings';
  appearancePage = page === 'appearance';
  timersPage = page === 'timers';
  const hash = page ? `#${page}` : '';
  if (location.hash !== hash) {
    if (hash) location.hash = hash;
    else if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  }
  renderDevices();
}

function colorToHex(value, fallback = '#121417') {
  if (typeof value !== 'string') return fallback;
  const hex = value.trim().match(/^#[\da-f]{6}$/i);
  if (hex) return hex[0].toLowerCase();
  const rgb = value.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i);
  if (!rgb) return fallback;
  return `#${rgb.slice(1, 4).map(channel =>
    Number(channel).toString(16).padStart(2, '0')).join('')}`;
}

function readSystemPalette() {
  const styles = getComputedStyle(document.documentElement);
  return {
    background: colorToHex(styles.getPropertyValue('--bg')),
    cards: colorToHex(styles.getPropertyValue('--card'), '#1c1f24'),
    text: colorToHex(styles.getPropertyValue('--text'), '#f1f3f5'),
    accent: colorToHex(styles.getPropertyValue('--primary'), '#15803d'),
  };
}

function paletteForTheme(theme) {
  if (theme === 'system') return readSystemPalette();
  if (theme === 'custom') return {...appearance.custom};
  if (theme.startsWith('saved:')) {
    const savedTheme = appearance.savedThemes.find(item => item.id === theme.slice(6));
    if (savedTheme) return {...savedTheme.palette};
  }
  return {...APPEARANCE_THEMES[theme]};
}

function applyAppearance() {
  const root = document.documentElement;
  const variables = ['--bg', '--card', '--text', '--muted', '--on', '--primary',
    '--btn', '--line', '--shadow', '--accent-contrast'];
  if (appearance.theme === 'system') {
    variables.forEach(name => root.style.removeProperty(name));
    document.body.style.removeProperty('background-image');
    return;
  }
  const palette = paletteForTheme(appearance.theme);
  root.style.setProperty('--bg', palette.background);
  root.style.setProperty('--card', palette.cards);
  root.style.setProperty('--text', palette.text);
  root.style.setProperty('--primary', palette.accent);
  root.style.setProperty('--on', palette.accent);
  root.style.setProperty('--btn', palette.btn || 'color-mix(in srgb, var(--card) 88%, var(--text))');
  root.style.setProperty('--line', palette.line || 'color-mix(in srgb, var(--card) 78%, var(--text))');
  root.style.setProperty('--muted', palette.muted || 'color-mix(in srgb, var(--text) 62%, var(--bg))');
  if (palette.shadow) root.style.setProperty('--shadow', palette.shadow);
  else root.style.removeProperty('--shadow');
  if (palette.backgroundImage) document.body.style.backgroundImage = palette.backgroundImage;
  else document.body.style.removeProperty('background-image');
  const channels = [1, 3, 5].map(index => parseInt(palette.accent.slice(index, index + 2), 16) / 255);
  const luminance = channels.reduce((sum, channel, index) => {
    const linear = channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    return sum + linear * [0.2126, 0.7152, 0.0722][index];
  }, 0);
  root.style.setProperty('--accent-contrast', luminance > 0.45 ? '#121417' : '#ffffff');
}

function saveAppearance() {
  try {
    localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(appearance));
  } catch (error) {
    showToast(`Could not save appearance: ${error.message}`);
  }
}

function syncAppearanceControls() {
  const select = document.getElementById('appearance-theme');
  select.querySelectorAll('option[data-saved-theme]').forEach(option => option.remove());
  const customOption = select.querySelector('option[value="custom"]');
  appearance.savedThemes.forEach(savedTheme => {
    const option = el('option', '', savedTheme.name);
    option.value = `saved:${savedTheme.id}`;
    option.dataset.savedTheme = 'true';
    select.insertBefore(option, customOption);
  });
  select.value = appearance.theme;
  document.getElementById('custom-palette').hidden = appearance.theme !== 'custom';
  document.getElementById('save-custom-theme-panel').hidden = appearance.theme !== 'custom';
  const palette = paletteForTheme(appearance.theme);
  document.getElementById('appearance-background').value = palette.background;
  document.getElementById('appearance-cards').value = palette.cards;
  document.getElementById('appearance-text').value = palette.text;
  document.getElementById('appearance-accent').value = palette.accent;
}

function initializeAppearance() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(APPEARANCE_STORAGE_KEY) || '{}') || {};
  } catch (_) {}
  const system = readSystemPalette();
  const storedPalette = saved.custom || {};
  const usedIds = new Set();
  const savedThemes = Array.isArray(saved.savedThemes)
    ? saved.savedThemes.filter(item => {
      if (!item || typeof item.id !== 'string' || !/^[a-z\d_-]+$/i.test(item.id)
          || typeof item.name !== 'string' || !item.name.trim() || usedIds.has(item.id)) return false;
      usedIds.add(item.id);
      return true;
    }).map(item => ({
      id: item.id,
      name: item.name.trim().slice(0, 40),
      palette: {
        background: colorToHex(item.palette?.background, system.background),
        cards: colorToHex(item.palette?.cards, system.cards),
        text: colorToHex(item.palette?.text, system.text),
        accent: colorToHex(item.palette?.accent, system.accent),
      },
    }))
    : [];
  const builtInThemes = ['system', 'dark', 'light', 'ocean', 'forest', 'sage', 'custom'];
  appearance = {
    theme: (builtInThemes.includes(saved.theme)
      || savedThemes.some(item => saved.theme === `saved:${item.id}`)) ? saved.theme : 'system',
    custom: {
      background: colorToHex(storedPalette.background, system.background),
      cards: colorToHex(storedPalette.cards, system.cards),
      text: colorToHex(storedPalette.text, system.text),
      accent: colorToHex(storedPalette.accent, system.accent),
    },
    customEdited: saved.customEdited === true || saved.theme === 'custom',
    savedThemes,
  };
  applyAppearance();
  syncAppearanceControls();
}

function chooseAppearanceTheme(theme) {
  if (theme === 'custom' && appearance.theme !== 'custom' && !appearance.customEdited) {
    const palette = paletteForTheme(appearance.theme);
    appearance.custom = {
      background: palette.background,
      cards: palette.cards,
      text: palette.text,
      accent: palette.accent,
    };
  }
  appearance.theme = theme;
  applyAppearance();
  syncAppearanceControls();
  saveAppearance();
}

function updateCustomAppearance() {
  appearance.theme = 'custom';
  appearance.customEdited = true;
  appearance.custom = {
    background: document.getElementById('appearance-background').value,
    cards: document.getElementById('appearance-cards').value,
    text: document.getElementById('appearance-text').value,
    accent: document.getElementById('appearance-accent').value,
  };
  applyAppearance();
  syncAppearanceControls();
  saveAppearance();
}

function saveCustomTheme() {
  const nameInput = document.getElementById('appearance-theme-name');
  const name = nameInput.value.trim().slice(0, 40);
  if (!name) {
    showToast('Enter a theme name');
    nameInput.focus();
    return;
  }
  const builtInNames = ['system default', 'dark', 'light', 'ocean', 'forest', 'sage & cream', 'custom'];
  if (builtInNames.includes(name.toLowerCase())
      || appearance.savedThemes.some(theme => theme.name.toLowerCase() === name.toLowerCase())) {
    showToast('A theme with that name already exists');
    nameInput.focus();
    return;
  }
  appearance.savedThemes.push({
    id: createId('theme'),
    name: name.slice(0, 40),
    palette: {...appearance.custom},
  });
  appearance.customEdited = true;
  syncAppearanceControls();
  saveAppearance();
  showToast(`Saved "${name}" as a theme`);
}

function resetAppearance() {
  appearance.theme = 'system';
  applyAppearance();
  appearance.custom = readSystemPalette();
  appearance.customEdited = false;
  syncAppearanceControls();
  saveAppearance();
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

function materialIcon(name, size = 24) {
  const span = document.createElement('span');
  span.className = 'material-symbols-outlined';
  span.setAttribute('aria-hidden', 'true');
  span.style.fontSize = `${size}px`;
  span.textContent = name;
  return span;
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
  if (id === 'room-modal') editingRoom = null;
  if (id === 'floor-modal') editingFloorId = null;
  if (id === 'room-outlet-sheet') quickRoom = null;
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

function roomOutletStats(room) {
  const known = room.units.map(unit => devices.find(d => d.unit === unit)).filter(Boolean);
  return {total: known.length, on: known.filter(d => d.state === true).length};
}

function attachRoomActions(node, room) {
  let longPressTimer = null;
  let longPressed = false;
  const stopTimer = () => {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  };
  node.addEventListener('pointerdown', event => {
    if (event.button > 0) return;
    longPressed = false;
    stopTimer();
    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      longPressed = true;
      openRoomOutletSheet(room);
    }, LONG_PRESS_MS);
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(type =>
    node.addEventListener(type, stopTimer));
  node.addEventListener('contextmenu', event => event.preventDefault());
  node.addEventListener('click', event => {
    if (longPressed) {
      event.preventDefault();
      longPressed = false;
      return;
    }
    toggleRoom(room);
  });
}

function renderRoomOutletControls() {
  const box = document.getElementById('room-outlet-controls');
  while (box.firstChild) box.removeChild(box.firstChild);
  const room = rooms.find(item => item.id === quickRoom?.id) || quickRoom;
  if (!room) return;
  document.getElementById('room-outlet-title').textContent = room.name;
  const roomDevices = devices.filter(device => room.units.includes(device.unit));
  if (!roomDevices.length) {
    box.append(el('p', 'muted', 'No outlets assigned to this room.'));
    return;
  }
  roomDevices.forEach(device => {
    const row = el('div', 'room-outlet-row');
    row.append(el('span', 'room-outlet-name', device.name));
    const control = el('button', 'switch');
    control.type = 'button';
    control.setAttribute('role', 'switch');
    control.setAttribute('aria-checked', String(device.state === true));
    control.setAttribute('aria-label', `${device.state ? 'Turn off' : 'Turn on'} ${device.name}`);
    control.onclick = () => send(device.unit, device.state ? 'off' : 'on');
    row.append(control);
    box.append(row);
  });
}

function openRoomOutletSheet(room) {
  quickRoom = room;
  renderRoomOutletControls();
  document.getElementById('room-outlet-sheet').hidden = false;
}

function renderFloorSelector() {
  const select = document.getElementById('floor-select');
  while (select.firstChild) select.removeChild(select.firstChild);
  floors.forEach(floor => {
    const option = el('option', '', floor.name);
    option.value = floor.id;
    select.append(option);
  });
  select.value = currentFloorId || floors[0]?.id || '';
}

function renderMap() {
  if (mapGesture) return;
  renderFloorSelector();
  const map = document.getElementById('map');
  while (map.firstChild) map.removeChild(map.firstChild);
  map.classList.toggle('editing', mapEditing);
  document.getElementById('edit-map').hidden = mapEditing;
  document.getElementById('map-edit-toolbar').hidden = !mapEditing;
  document.getElementById('map-hint').hidden = !mapEditing;
  const overlapToggle = document.getElementById('toggle-room-overlap');
  overlapToggle.textContent = `Overlap: ${allowRoomOverlap ? 'On' : 'Off'}`;
  overlapToggle.setAttribute('aria-pressed', String(allowRoomOverlap));
  document.getElementById('floor-menu').hidden = true;
  document.getElementById('floor-menu-toggle').setAttribute('aria-expanded', 'false');
  document.getElementById('map-hint').textContent =
    'Drag to move · Corner handle to resize · Tap room to edit';
  const floorRooms = rooms.filter(room => room.floor_id === currentFloorId);
  if (!floorRooms.length) {
    map.append(el('div', 'map-empty', mapEditing
      ? 'Add a room to start drawing your apartment.'
    : 'No rooms yet. Press Edit to draw your apartment.'));
    return;
  }
  const layout = el('div', 'map-layout');
  map.append(layout);
  floorRooms.forEach(room => {
    const {total, on} = roomOutletStats(room);
    const node = el('button', `room${on > 0 ? ' on' : ''}`);
    node.type = 'button';
    node.dataset.room = room.id;
    Object.assign(node.style, {
      left: `${room.x}%`, top: `${room.y}%`, width: `${room.w}%`, height: `${room.h}%`,
    });
    node.append(el('span', 'room-name', room.name),
      el('span', 'room-status', total ? `${on}/${total} on` : '0 outlets'));
    if (mapEditing) {
      node.setAttribute('aria-label', `Edit ${room.name}`);
      node.addEventListener('pointerdown', event => startRoomGesture(event, room, 'move'));
      const handle = el('span', 'room-resize');
      handle.setAttribute('aria-hidden', 'true');
      handle.addEventListener('pointerdown', event => startRoomGesture(event, room, 'resize'));
      node.append(handle);
    } else {
      node.setAttribute('aria-label', `Toggle ${room.name}; hold to control outlets individually`);
      node.setAttribute('aria-pressed', String(on > 0));
      attachRoomActions(node, room);
    }
    layout.append(node);
  });
}

function clampRoom(room) {
  room.w = Math.min(MAP_SIZE, Math.max(MIN_ROOM_SIZE, room.w));
  room.h = Math.min(MAP_SIZE, Math.max(MIN_ROOM_SIZE, room.h));
  room.x = Math.min(MAP_SIZE - room.w, Math.max(0, room.x));
  room.y = Math.min(MAP_SIZE - room.h, Math.max(0, room.y));
}

function overlapsRoom(room, ignoredId = room.id) {
  return !allowRoomOverlap && rooms.some(other => other.id !== ignoredId
    && other.floor_id === room.floor_id
    && room.x < other.x + other.w && room.x + room.w > other.x
    && room.y < other.y + other.h && room.y + room.h > other.y);
}

function findRoomPosition() {
  for (let size = 30; size >= MIN_ROOM_SIZE; size -= 5) {
    const preferred = {floor_id: currentFloorId, x: 10, y: 10, w: size, h: size};
    if (!overlapsRoom(preferred)) return preferred;
    for (let y = 0; y <= MAP_SIZE - size; y += 5) {
      for (let x = 0; x <= MAP_SIZE - size; x += 5) {
        const candidate = {floor_id: currentFloorId, x, y, w: size, h: size};
        if (!overlapsRoom(candidate)) return candidate;
      }
    }
  }
  return null;
}

function startRoomGesture(event, room, type) {
  event.preventDefault();
  event.stopPropagation();
  const bounds = event.currentTarget.closest('.map-layout').getBoundingClientRect();
  mapGesture = {
    room, type, moved: false, startX: event.clientX, startY: event.clientY,
    origin: {x: room.x, y: room.y, w: room.w, h: room.h},
    scaleX: MAP_SIZE / (bounds.width || 1),
    scaleY: MAP_SIZE / (bounds.height || 1),
    node: event.currentTarget.closest('.room'),
  };
  window.addEventListener('pointermove', moveRoomGesture);
  window.addEventListener('pointerup', endRoomGesture);
  window.addEventListener('pointercancel', endRoomGesture);
}

function moveRoomGesture(event) {
  const g = mapGesture;
  if (!g) return;
  const dx = event.clientX - g.startX;
  const dy = event.clientY - g.startY;
  if (!g.moved && Math.hypot(dx, dy) < 5) return;
  g.moved = true;
  const room = g.room;
  const candidate = {...room};
  if (g.type === 'move') {
    candidate.x = Math.round(g.origin.x + dx * g.scaleX);
    candidate.y = Math.round(g.origin.y + dy * g.scaleY);
  } else {
    candidate.w = Math.round(g.origin.w + dx * g.scaleX);
    candidate.h = Math.round(g.origin.h + dy * g.scaleY);
  }
  clampRoom(candidate);
  if (overlapsRoom(candidate)) return;
  if (candidate.x === room.x && candidate.y === room.y
      && candidate.w === room.w && candidate.h === room.h) return;
  Object.assign(room, candidate);
  Object.assign(g.node.style, {
    left: `${room.x}%`, top: `${room.y}%`, width: `${room.w}%`, height: `${room.h}%`,
  });
}

async function endRoomGesture(event) {
  const g = mapGesture;
  mapGesture = null;
  window.removeEventListener('pointermove', moveRoomGesture);
  window.removeEventListener('pointerup', endRoomGesture);
  window.removeEventListener('pointercancel', endRoomGesture);
  if (!g) return;
  if (event.type === 'pointercancel') {
    Object.assign(g.room, g.origin);
    renderMap();
  } else if (!g.moved) {
    openRoomModal(g.room);
  }
}

async function saveMap() {
  await api('PUT', '/api/map', {floors, rooms});
}

async function refreshMap(force = false) {
  if (mapEditing && !force) return;
  const data = await api('GET', '/api/map');
  floors = Array.isArray(data.floors) && data.floors.length
    ? data.floors
    : [{id: 'ground-floor', name: 'Ground floor'}];
  rooms = Array.isArray(data.rooms) ? data.rooms : [];
  if (!floors.some(floor => floor.id === currentFloorId)) currentFloorId = floors[0].id;
  if (viewMode === 'map') renderMap();
}

function toggleRoom(room) {
  const {total, on} = roomOutletStats(room);
  if (!total) {
    showToast('No outlets in this room');
    return;
  }
  sendRoom(room, on > 0 ? 'off' : 'on');
}

async function sendRoom(room, action) {
  try {
    showToast('Sending...');
    await api('POST', `/api/rooms/${encodeURIComponent(room.id)}/${action}`);
    showToast('Command sent');
    await refresh();
  } catch (error) { showToast(`Failed: ${error.message}`); }
}

async function toggleMapEditing() {
  if (mapEditing) {
    try {
      await saveMap();
    } catch (error) {
      showToast(`Failed: ${error.message}`);
      return;
    }
    mapEditing = false;
    mapEditingSnapshot = null;
    await refreshMap(true).catch(error => showToast(error.message));
    renderMap();
  } else {
    startMapEditing();
  }
}

function startMapEditing() {
  if (mapEditing) return;
  closeFloorMenu();
  mapEditingSnapshot = {
    floors: floors.map(floor => ({...floor})),
    rooms: rooms.map(room => ({...room, units: [...room.units]})),
    floorId: currentFloorId,
  };
  mapEditing = true;
  renderMap();
}

function cancelMapEditing() {
  if (!mapEditing) return;
  if (mapEditingSnapshot) {
    floors = mapEditingSnapshot.floors;
    rooms = mapEditingSnapshot.rooms;
    currentFloorId = mapEditingSnapshot.floorId;
  }
  mapEditingSnapshot = null;
  mapEditing = false;
  renderMap();
}

function toggleRoomOverlap() {
  allowRoomOverlap = !allowRoomOverlap;
  const button = document.getElementById('toggle-room-overlap');
  button.textContent = `Overlap: ${allowRoomOverlap ? 'On' : 'Off'}`;
  button.setAttribute('aria-pressed', String(allowRoomOverlap));
}

function closeFloorMenu() {
  document.getElementById('floor-menu').hidden = true;
  document.getElementById('floor-menu-toggle').setAttribute('aria-expanded', 'false');
}

function toggleFloorMenu() {
  const menu = document.getElementById('floor-menu');
  const open = menu.hidden;
  menu.hidden = !open;
  document.getElementById('floor-menu-toggle').setAttribute('aria-expanded', String(open));
}

async function addRoom() {
  const position = findRoomPosition();
  if (!position) {
    showToast('No room space available');
    return;
  }
  const floorRoomCount = rooms.filter(room => room.floor_id === currentFloorId).length;
  const room = {
    id: createId('r'), name: `Room ${floorRoomCount + 1}`, ...position, units: [],
  };
  rooms.push(room);
  renderMap();
  openRoomModal(room);
}

function createId(prefix) {
  return crypto.randomUUID ? crypto.randomUUID() : `${prefix}${Date.now()}${Math.random().toString(16).slice(2)}`;
}

function openFloorEditor(floor = null) {
  editingFloorId = floor?.id || null;
  document.getElementById('floor-modal-title').textContent = floor ? 'Rename floor' : 'Add floor';
  document.getElementById('floor-name').value = floor?.name || `Floor ${floors.length + 1}`;
  document.getElementById('floor-modal').hidden = false;
  document.getElementById('floor-name').focus();
  document.getElementById('floor-name').select();
}

function addFloor() {
  closeFloorMenu();
  startMapEditing();
  openFloorEditor();
}

function renameFloor() {
  const floor = floors.find(item => item.id === currentFloorId);
  if (!floor) return;
  closeFloorMenu();
  startMapEditing();
  openFloorEditor(floor);
}

function saveFloor(event) {
  event.preventDefault();
  const name = document.getElementById('floor-name').value.trim();
  if (!name) return;
  if (editingFloorId) {
    const floor = floors.find(item => item.id === editingFloorId);
    if (!floor) return;
    floor.name = name;
  } else {
    const floor = {id: createId('f'), name};
    floors.push(floor);
    currentFloorId = floor.id;
  }
  closeOverlay('floor-modal');
  renderMap();
}

function deleteFloor() {
  const floor = floors.find(item => item.id === currentFloorId);
  if (!floor) return;
  if (floors.length < 2) {
    showToast('At least one floor is required');
    return;
  }
  if (!window.confirm(`Delete ${floor.name} and all its rooms?`)) return;
  closeFloorMenu();
  startMapEditing();
  floors = floors.filter(item => item.id !== floor.id);
  rooms = rooms.filter(room => room.floor_id !== floor.id);
  currentFloorId = floors[0].id;
  renderMap();
}

function openRoomModal(room) {
  editingRoom = room;
  roomUnits = [...room.units];
  document.getElementById('room-name').value = room.name;
  const box = document.getElementById('room-outlets');
  while (box.firstChild) box.removeChild(box.firstChild);
  if (!devices.length) box.append(el('p', 'hint', 'No outlets configured yet.'));
  devices.forEach(device => {
    const chip = el('button', 'outlet-chip');
    chip.type = 'button';
    const check = el('span', 'chip-check');
    check.append(icon('check', 16));
    chip.append(check, el('span', 'chip-label', device.name));
    const update = () => {
      const selected = roomUnits.includes(device.unit);
      chip.setAttribute('aria-pressed', String(selected));
      check.hidden = !selected;
    };
    chip.onclick = () => {
      roomUnits = roomUnits.includes(device.unit)
        ? roomUnits.filter(unit => unit !== device.unit)
        : [...roomUnits, device.unit];
      update();
    };
    update();
    box.append(chip);
  });
  document.getElementById('room-modal').hidden = false;
  document.getElementById('room-name').focus();
}

async function saveRoom(event) {
  event.preventDefault();
  const name = document.getElementById('room-name').value.trim();
  if (!name || !editingRoom) return;
  editingRoom.name = name;
  editingRoom.units = [...roomUnits];
  closeOverlay('room-modal');
  renderMap();
}

async function deleteRoom() {
  if (!editingRoom) return;
  rooms = rooms.filter(room => room.id !== editingRoom.id);
  closeOverlay('room-modal');
  renderMap();
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
  const utilityPage = settingsPage || appearancePage || timersPage;
  const grid = viewMode === 'grid' && !reorderMode;
  const mapView = viewMode === 'map' && !reorderMode && !utilityPage;
  list.hidden = mapView || utilityPage;
  document.getElementById('map-view').hidden = !mapView || utilityPage;
  document.getElementById('settings-page').hidden = !settingsPage;
  document.getElementById('language-toggle').hidden = !settingsPage;
  document.getElementById('appearance-page').hidden = !appearancePage;
  document.getElementById('timers-page').hidden = !timersPage;
  document.getElementById('open-settings').setAttribute('aria-pressed', String(utilityPage));
  list.classList.toggle('grid', grid);
  document.body.classList.toggle('view-grid', grid);
  const onCount = devices.filter(d => d.state === true).length;
  document.getElementById('page-title').textContent = reorderMode
    ? 'Reorder' : settingsPage ? 'Settings' : appearancePage ? 'Appearance'
      : 'Nexa Control';
  document.getElementById('summary').textContent = reorderMode
    ? 'Drag the handle or use the arrows'
    : settingsPage ? 'Manage Nexa Control'
      : appearancePage ? 'Customize page colors'
        : `${devices.length} outlet${devices.length === 1 ? '' : 's'} · ${onCount} on`;
  document.getElementById('all-off').hidden = reorderMode || utilityPage;
  document.getElementById('reorder-done').hidden = !reorderMode;
  document.getElementById('view-bar').hidden = reorderMode;
  document.querySelectorAll('[data-view]').forEach(button => {
    button.setAttribute('aria-pressed', String(!utilityPage && button.dataset.view === viewMode));
  });
  document.getElementById('add-outlet').hidden = reorderMode || utilityPage || grid || mapView;
  if (settingsPage || appearancePage) {
    return;
  }
  if (timersPage) {
    const count = timerData.schedules.length + timerData.countdowns.length;
    document.getElementById('page-title').textContent = 'Timers';
    document.getElementById('summary').textContent = `${count} timer${count === 1 ? '' : 's'}`;
    document.getElementById('all-off').hidden = true;
    document.getElementById('add-outlet').hidden = true;
    renderTimerList(document.getElementById('timers-page-list'), null);
    return;
  }
  if (mapView) {
    renderMap();
    return;
  }
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
  const buttons = [document.getElementById('all-off')];
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
  renderTimerList(document.getElementById('timer-list'), timerUnit);
}

function renderTimerList(list, scopeUnit) {
  while (list.firstChild) list.removeChild(list.firstChild);
  const inScope = timer => scopeUnit === null || timer.units.includes(scopeUnit);
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

function initializeWelcome() {
  if (document.body.dataset.welcomePending !== 'true') return;
  const dialog = document.getElementById('welcome-dialog');
  const language = document.getElementById('welcome-language');
  const theme = document.getElementById('welcome-theme');
  const view = document.getElementById('welcome-view');
  const error = document.getElementById('welcome-error');
  const next = document.getElementById('welcome-next');
  const back = document.getElementById('welcome-back');
  const skipStep = document.getElementById('welcome-skip-step');
  const finish = document.getElementById('welcome-finish');
  const pair = document.getElementById('welcome-pair');
  let step = 0;
  language.value = document.documentElement.lang;
  if ([...theme.options].some(option => option.value === appearance.theme)) {
    theme.value = appearance.theme;
  }
  view.value = viewMode;

  function showStep() {
    dialog.querySelectorAll('[data-welcome-step]').forEach(section => {
      section.hidden = Number(section.dataset.welcomeStep) !== step;
    });
    back.hidden = step === 0;
    skipStep.hidden = step !== 1 && step !== 2;
    next.hidden = step === 3;
    finish.hidden = step !== 3;
    error.hidden = true;
    if (dialog.open) [language, theme, view, finish][step].focus();
  }

  function preferenceSaved(key, expected) {
    try {
      if (localStorage.getItem(key) === expected) {
        error.hidden = true;
        return true;
      }
    } catch (storageError) {
      console.error('Could not save welcome preference:', storageError);
    }
    error.textContent = 'Could not save your preference on this browser.';
    error.hidden = false;
    return false;
  }

  language.onchange = () => {
    window.NexaI18n.setLanguage(language.value);
    preferenceSaved('nexa-language', language.value);
  };
  back.onclick = () => { step -= 1; showStep(); };
  skipStep.onclick = () => { step += 1; showStep(); };
  next.onclick = () => {
    if (step === 1) {
      chooseAppearanceTheme(theme.value);
      if (!preferenceSaved(APPEARANCE_STORAGE_KEY, JSON.stringify(appearance))) return;
    } else if (step === 2) {
      setView(view.value);
      if (!preferenceSaved('nexa-view', view.value)) return;
    }
    step += 1;
    showStep();
  };
  async function complete(pairOutletAfter) {
    const buttons = dialog.querySelectorAll('button');
    buttons.forEach(button => { button.disabled = true; });
    pair.disabled = true;
    error.hidden = true;
    try {
      if (pairOutletAfter) await refresh();
      const result = await api('POST', '/account/welcome/complete');
      if (result.ok !== true) throw new Error('Unexpected setup response');
      document.body.dataset.welcomePending = 'false';
      dialog.close();
      if (pairOutletAfter) openPairModal();
    } catch (completionError) {
      console.error('Could not complete welcome setup:', completionError);
      error.textContent = 'Could not complete setup. Please try again.';
      error.hidden = false;
    } finally {
      buttons.forEach(button => { button.disabled = false; });
      pair.disabled = false;
    }
  }
  document.getElementById('welcome-skip').onclick = () => complete(false);
  finish.onclick = () => complete(pair.checked);
  dialog.addEventListener('cancel', event => event.preventDefault());
  showStep();
  dialog.showModal();
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
  if (viewMode === 'map') await refreshMap();
  renderDevices();
  if (!document.getElementById('timer-sheet').hidden) renderTimerSheet();
  if (quickRoom && !document.getElementById('room-outlet-sheet').hidden) {
    quickRoom = rooms.find(room => room.id === quickRoom.id) || quickRoom;
    renderRoomOutletControls();
  }
}

document.getElementById('add-outlet').onclick = openPairModal;
document.getElementById('all-off').onclick = allOff;
document.getElementById('open-settings').onclick = () => showUtilityPage('settings');
document.getElementById('settings-timers-link').onclick = event => {
  event.preventDefault();
  showUtilityPage('timers');
};
document.getElementById('timers-settings-back').onclick = event => {
  event.preventDefault();
  showUtilityPage('settings');
};
document.getElementById('settings-appearance-link').onclick = event => {
  event.preventDefault();
  showUtilityPage('appearance');
};
document.getElementById('appearance-settings-back').onclick = event => {
  event.preventDefault();
  showUtilityPage('settings');
};
document.getElementById('appearance-theme').onchange = event =>
  chooseAppearanceTheme(event.target.value);
['appearance-background', 'appearance-cards', 'appearance-text', 'appearance-accent']
  .forEach(id => {
    document.getElementById(id).oninput = updateCustomAppearance;
  });
document.getElementById('save-custom-theme').onclick = saveCustomTheme;
document.getElementById('appearance-reset').onclick = resetAppearance;
document.getElementById('page-add-timer').onclick = () => openEditor('countdown');
window.addEventListener('hashchange', () => {
  settingsPage = location.hash === '#settings';
  appearancePage = location.hash === '#appearance';
  timersPage = location.hash === '#timers';
  renderDevices();
});
document.querySelectorAll('[data-view]').forEach(button => {
  button.onclick = () => setView(button.dataset.view);
});
document.querySelector('[data-view="list"]').append(icon('list', 22));
document.querySelector('[data-view="grid"]').append(icon('grid', 22));
document.querySelector('[data-view="map"]').append(icon('map', 22));
document.getElementById('edit-map').onclick = toggleMapEditing;
document.getElementById('cancel-map-edit').onclick = cancelMapEditing;
document.getElementById('done-map-edit').onclick = toggleMapEditing;
document.getElementById('toggle-room-overlap').onclick = toggleRoomOverlap;
document.getElementById('add-room').onclick = addRoom;
document.getElementById('floor-menu-toggle').onclick = toggleFloorMenu;
document.getElementById('floor-select').onchange = event => {
  currentFloorId = event.target.value;
  renderMap();
};
document.getElementById('add-floor').onclick = addFloor;
document.getElementById('rename-floor').onclick = renameFloor;
document.getElementById('delete-floor').onclick = deleteFloor;
document.getElementById('floor-form').onsubmit = saveFloor;
document.getElementById('room-form').onsubmit = saveRoom;
document.getElementById('delete-room').onclick = deleteRoom;
document.getElementById('settings-icon').append(materialIcon('settings', 20));
document.getElementById('settings-appearance-icon').append(materialIcon('palette', 20));
document.getElementById('settings-timers-icon').append(materialIcon('schedule', 20));
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
    closeFloorMenu();
  }
  if (event.key === 'Escape') document.querySelectorAll('.overlay:not([hidden])').forEach(sheet => closeOverlay(sheet.id));
});
document.addEventListener('click', event => {
  if (!event.target.closest('.menu') && !event.target.closest('.menu-button')) {
    document.querySelectorAll('.menu').forEach(menu => menu.remove());
  }
  if (!event.target.closest('.floor-menu-wrap')) closeFloorMenu();
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

initializeAppearance();
buildDays();
renderDevices();
initializeWelcome();
if (viewMode === 'map') refreshMap().catch(error => showToast(error.message));
refresh().catch(error => showToast(error.message));
setInterval(refreshTimers, 15000);
setInterval(refresh, 15000);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
