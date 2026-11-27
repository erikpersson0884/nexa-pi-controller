const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const {JSDOM} = require('jsdom');

const root = path.join(__dirname, '..');
const scriptPath = path.join(root, 'nexa_pi_controller/static/app.js');
const script = new vm.Script(fs.readFileSync(scriptPath, 'utf8'), {filename: scriptPath});
const i18nPath = path.join(root, 'nexa_pi_controller/static/i18n.js');
const i18nScript = new vm.Script(fs.readFileSync(i18nPath, 'utf8'), {filename: i18nPath});
const themePath = path.join(root, 'nexa_pi_controller/static/theme.js');
const themeScript = new vm.Script(fs.readFileSync(themePath, 'utf8'), {filename: themePath});
const template = fs.readFileSync(path.join(root, 'nexa_pi_controller/templates/index.html'), 'utf8')
  .replace('{{ csrf_token() }}', 'test-csrf');

async function setup(t, {
  devices = [], timers = {schedules: [], countdowns: []}, fail, view, language, rooms = [],
  floors = [{id: 'ground-floor', name: 'Ground floor'}], welcomePending = false, appearance,
  footerViews,
} = {}) {
  devices = devices.map(device => ({...device}));
  const dom = new JSDOM(template.replace(
    "{{ 'false' if current_user.welcome_completed else 'true' }}", String(welcomePending),
  ), {
    url: 'http://localhost/',
    runScripts: 'outside-only',
    beforeParse(window) {
      if (view) window.localStorage.setItem('nexa-view', view);
      if (language) window.localStorage.setItem('nexa-language', language);
      if (appearance) window.localStorage.setItem('nexa-appearance', JSON.stringify(appearance));
      if (footerViews) window.localStorage.setItem('nexa-footer-views', JSON.stringify(footerViews));
    },
  });
  const {window} = dom;
  const welcome = window.document.getElementById('welcome-dialog');
  welcome.showModal = () => { welcome.open = true; };
  welcome.close = () => { welcome.open = false; };
  const requests = [];
  let mapState = {
    floors,
    rooms: rooms.map(room => ({...room, floor_id: room.floor_id || 'ground-floor'})),
  };
  t.after(() => window.close());
  window.setInterval = () => 0;
  window.fetch = async (url, options) => {
    const body = options.body === undefined ? undefined : JSON.parse(options.body);
    requests.push({url, method: options.method, body, headers: options.headers});
    if (fail && fail(url, options)) {
      return {ok: false, json: async () => ({error: 'Request denied'})};
    }
    let response = {};
    if (url === '/api/devices' && options.method === 'GET') response = devices;
    if (url === '/api/timers' && options.method === 'GET') response = timers;
    if (url === '/api/map' && options.method === 'GET') response = mapState;
    if (url === '/account/welcome/complete' && options.method === 'POST') response = {ok: true};
    if (url === '/api/map' && options.method === 'PUT') {
      mapState = body;
    }
    const deviceSwitch = url.match(/^\/api\/(\d+)\/(on|off)$/);
    if (deviceSwitch && options.method === 'POST') {
      const device = devices.find(item => item.unit === Number(deviceSwitch[1]));
      if (device) device.state = deviceSwitch[2] === 'on';
    }
    return {ok: true, json: async () => response};
  };
  window.confirm = () => true;
  i18nScript.runInContext(dom.getInternalVMContext());
  themeScript.runInContext(dom.getInternalVMContext());
  script.runInContext(dom.getInternalVMContext());
  await settle();
  return {window, document: window.document, requests};
}

test('language preference translates the dashboard and persists on this device', async t => {
  const {window, document} = await setup(t, {
    devices: [{unit: 0, name: 'Off', state: false}],
  });
  const toggle = document.getElementById('language-toggle');
  const english = toggle.querySelector('[data-language="en"]');
  const swedish = toggle.querySelector('[data-language="sv"]');
  assert.equal(toggle.hidden, true);
  document.getElementById('open-settings').click();
  assert.equal(toggle.hidden, false);
  assert.equal(english.getAttribute('aria-pressed'), 'true');
  assert.equal(swedish.getAttribute('aria-pressed'), 'false');
  swedish.querySelector('svg').dispatchEvent(new window.MouseEvent('click', {bubbles: true}));
  await settle();
  assert.equal(window.localStorage.getItem('nexa-language'), 'sv');
  assert.equal(document.documentElement.lang, 'sv');
  assert.match(document.getElementById('all-off').textContent, /Stäng av alla/);
  assert.equal(document.querySelector('.settings-group-title').textContent, 'Anpassning');
  assert.equal(english.getAttribute('aria-pressed'), 'false');
  assert.equal(swedish.getAttribute('aria-pressed'), 'true');
  document.querySelector('[data-view="list"]').click();
  await settle();
  assert.equal(toggle.hidden, true);
  assert.equal(document.querySelector('.outlet-name').textContent, 'Off');
  assert.match(document.getElementById('summary').textContent, /1 uttag · 0 på/);

  const reloaded = await setup(t, {language: window.localStorage.getItem('nexa-language')});
  assert.equal(reloaded.document.querySelector('[data-language="sv"]').getAttribute('aria-pressed'), 'true');
  assert.match(reloaded.document.getElementById('all-off').textContent, /Stäng av alla/);

  document.getElementById('open-settings').click();
  english.click();
  await settle();
  assert.equal(window.localStorage.getItem('nexa-language'), 'en');
  assert.equal(document.documentElement.lang, 'en');
  assert.match(document.getElementById('all-off').textContent, /All off/);
  assert.equal(document.querySelector('.settings-group-title').textContent, 'Personalization');
  assert.equal(english.getAttribute('aria-pressed'), 'true');
  document.getElementById('settings-appearance-link').click();
  assert.equal(toggle.hidden, true);
  document.querySelector('[data-view="list"]').click();
  await settle();
  assert.match(document.getElementById('summary').textContent, /1 outlet · 0 on/);
});

test('welcome setup saves choices and offers the existing pairing flow', async t => {
  const {window, document, requests} = await setup(t, {welcomePending: true});
  const dialog = document.getElementById('welcome-dialog');
  assert.equal(dialog.open, true);
  const language = document.getElementById('welcome-language');
  language.value = 'sv';
  language.dispatchEvent(new window.Event('change', {bubbles: true}));
  assert.equal(document.documentElement.lang, 'sv');
  assert.equal(document.getElementById('welcome-title').textContent, 'Välkommen till Nexa Control');
  document.getElementById('welcome-next').click();
  document.getElementById('welcome-theme').value = 'ocean';
  document.getElementById('welcome-next').click();
  assert.equal(JSON.parse(window.localStorage.getItem('nexa-appearance')).theme, 'ocean');
  document.getElementById('welcome-view').value = 'grid';
  document.getElementById('welcome-next').click();
  assert.equal(window.localStorage.getItem('nexa-view'), 'grid');
  document.getElementById('welcome-pair').checked = true;
  document.getElementById('welcome-finish').click();
  await settle();
  assert.equal(dialog.open, false);
  assert.equal(document.getElementById('pair-modal').hidden, false);
  const complete = requests.find(request => request.url === '/account/welcome/complete');
  assert.equal(complete.method, 'POST');
  assert.equal(complete.headers['X-CSRFToken'], 'test-csrf');
});

test('welcome skips preserve existing preferences and completion failures can be retried', async t => {
  let failCompletion = true;
  const {window, document} = await setup(t, {
    welcomePending: true, view: 'grid', appearance: {theme: 'forest'},
    fail: url => url === '/account/welcome/complete' && failCompletion,
  });
  document.getElementById('welcome-next').click();
  document.getElementById('welcome-skip-step').click();
  document.getElementById('welcome-skip-step').click();
  assert.equal(JSON.parse(window.localStorage.getItem('nexa-appearance')).theme, 'forest');
  assert.equal(window.localStorage.getItem('nexa-view'), 'grid');
  document.getElementById('welcome-finish').click();
  await settle();
  assert.equal(document.getElementById('welcome-dialog').open, true);
  assert.equal(document.getElementById('welcome-error').hidden, false);
  failCompletion = false;
  document.getElementById('welcome-finish').click();
  await settle();
  assert.equal(document.getElementById('welcome-dialog').open, false);
  assert.equal(document.getElementById('pair-modal').hidden, true);
});

test('welcome can be skipped and is absent for completed accounts', async t => {
  const pending = await setup(t, {welcomePending: true});
  pending.document.getElementById('welcome-skip').click();
  await settle();
  assert.equal(pending.document.getElementById('welcome-dialog').open, false);
  assert.equal(pending.requests.filter(request => request.url === '/account/welcome/complete').length, 1);
  const complete = await setup(t);
  assert.equal(complete.document.getElementById('welcome-dialog').open, false);
});

async function settle() {
  for (let i = 0; i < 4; i += 1) await new Promise(resolve => setImmediate(resolve));
}

function submit(window, form) {
  form.dispatchEvent(new window.Event('submit', {bubbles: true, cancelable: true}));
}

function openTimersFromSettings(document) {
  document.getElementById('open-settings').click();
  document.getElementById('settings-timers-link').click();
}

function controlAllOffTimer(window) {
  const setTimeout = window.setTimeout.bind(window);
  const clearTimeout = window.clearTimeout.bind(window);
  let pending = null;
  window.setTimeout = (callback, delay, ...args) => {
    if (delay !== 400) return setTimeout(callback, delay, ...args);
    pending = callback;
    return -1;
  };
  window.clearTimeout = id => {
    if (id === -1) pending = null;
    else clearTimeout(id);
  };
  return {
    fire() {
      assert.ok(pending, 'expected a 400 ms all-off timer');
      const callback = pending;
      pending = null;
      callback();
    },
    isPending: () => pending !== null,
  };
}

test('renders devices and sends switch commands with CSRF protection', async t => {
  const {document, requests} = await setup(t, {devices: [
    {unit: 2, name: 'Desk lamp', state: false},
    {unit: 3, name: 'Window', state: true},
  ]});
  assert.equal(document.querySelectorAll('.outlet-card').length, 2);
  assert.match(document.getElementById('summary').textContent, /2 outlets.*1 on/);
  const button = document.querySelector('[data-unit="2"] .switch');
  assert.equal(button.getAttribute('aria-label'), 'Turn on Desk lamp');
  button.click();
  await settle();
  const request = requests.find(item => item.url === '/api/2/on');
  assert.equal(request.method, 'POST');
  assert.equal(request.headers['X-CSRFToken'], 'test-csrf');
  assert.equal(document.getElementById('toast').textContent, 'Command sent');
});

for (const [view, buttonId] of [['list', 'all-off'], ['grid', 'all-off']]) {
  test(`single and double All Off presses in ${view} view`, async t => {
    const {window, document, requests} = await setup(t, {view});
    const timer = controlAllOffTimer(window);
    const button = document.getElementById(buttonId);
    const commands = () => requests.filter(item => item.url.startsWith('/api/all/'));
    const powerIcon = button.querySelector('.material-symbols-outlined');
    assert.equal(powerIcon.textContent, 'power_settings_new');
    assert.equal(powerIcon.getAttribute('aria-hidden'), 'true');

    button.click();
    assert.equal(commands().length, 0);
    timer.fire();
    await settle();
    assert.deepEqual(commands().map(item => item.url), ['/api/all/off']);
    assert.equal(document.getElementById('toast').textContent, 'All off');

    button.click();
    button.click();
    await settle();
    assert.equal(timer.isPending(), false);
    assert.deepEqual(commands().map(item => item.url), ['/api/all/off', '/api/all/on']);
    assert.equal(commands()[1].headers['X-CSRFToken'], 'test-csrf');
    assert.equal(document.getElementById('toast').textContent, 'All on');
  });
}

test('all-outlet commands cannot overlap and failures allow retrying', async t => {
  const {window, document, requests} = await setup(t);
  const timer = controlAllOffTimer(window);
  const originalFetch = window.fetch;
  let finishRequest;
  window.fetch = (url, options) => {
    if (url === '/api/all/on') {
      return new Promise(resolve => { finishRequest = resolve; });
    }
    return originalFetch(url, options);
  };
  const button = document.getElementById('all-off');
  button.click();
  button.click();
  assert.equal(button.disabled, true);
  button.click();
  assert.equal(timer.isPending(), false);
  finishRequest({ok: false, json: async () => ({error: 'Radio failed'})});
  await settle();
  assert.equal(document.getElementById('toast').textContent, 'Failed: Radio failed');
  assert.equal(button.disabled, false);
  button.click();
  timer.fire();
  await settle();
  assert.equal(requests.filter(item => item.url === '/api/all/off').length, 1);
});

test('pairs an outlet and sends the selected available unit', async t => {
  const {window, document, requests} = await setup(t, {
    devices: [{unit: 0, name: 'Existing', state: false}],
  });
  document.getElementById('add-outlet').click();
  assert.equal(document.getElementById('pair-modal').hidden, false);
  assert.equal(document.getElementById('pair-unit').value, '1');
  document.getElementById('pair-name').value = '  Kitchen  ';
  submit(window, document.getElementById('pair-form'));
  await settle();
  const request = requests.find(item => item.url === '/api/pair');
  assert.deepEqual(request.body, {name: 'Kitchen', unit: 1});
  assert.equal(request.headers['Content-Type'], 'application/json');
  assert.equal(document.getElementById('pair-modal').hidden, true);
  assert.equal(document.getElementById('toast').textContent, 'Outlet paired');
});

test('shows a server error without closing the pair dialog', async t => {
  const {window, document} = await setup(t, {fail: url => url === '/api/pair'});
  document.getElementById('add-outlet').click();
  document.getElementById('pair-name').value = 'Kitchen';
  submit(window, document.getElementById('pair-form'));
  await settle();
  assert.equal(document.getElementById('pair-modal').hidden, false);
  assert.equal(document.getElementById('toast').textContent, 'Request denied');
});

test('reorders outlets and saves the new order', async t => {
  const {document, requests} = await setup(t, {devices: [
    {unit: 1, name: 'First', state: false},
    {unit: 2, name: 'Second', state: false},
  ]});
  document.querySelector('[data-unit="1"] .menu-button').click();
  [...document.querySelectorAll('.menu button')]
    .find(button => button.textContent === 'Reorder outlets').click();
  document.querySelector('[data-unit="2"] .reorder-controls button').click();
  assert.match(document.getElementById('reorder-announcement').textContent, /Second moved to position 1/);
  document.getElementById('reorder-done').click();
  await settle();
  assert.deepEqual(requests.find(item => item.url === '/api/devices/order').body, {order: [2, 1]});
  assert.equal(document.getElementById('toast').textContent, 'Order saved');
});

test('creates a countdown with the chosen action and minutes', async t => {
  const {window, document, requests} = await setup(t, {
    devices: [{unit: 3, name: 'Lamp', state: false}],
  });
  document.querySelector('.timer-link').click();
  assert.equal(document.getElementById('timer-sheet-title').textContent, 'Lamp timers');
  assert.match(document.getElementById('timer-list').textContent, /No timers yet/);
  document.getElementById('sheet-add-timer').click();
  document.querySelector('[data-action="off"]').click();
  document.querySelector('[data-minutes="60"]').click();
  submit(window, document.getElementById('timer-form'));
  await settle();
  assert.deepEqual(requests.find(item => item.url === '/api/countdowns').body,
    {units: [3], action: 'off', minutes: 60});
  assert.equal(document.getElementById('editor-sheet').hidden, true);
  assert.equal(document.getElementById('toast').textContent, 'Timer saved');
});

test('creates a weekday schedule and shows existing timers', async t => {
  const {window, document, requests} = await setup(t, {
    devices: [{unit: 3, name: 'Lamp', state: true}],
    timers: {countdowns: [{id: 'c1', units: [3], action: 'off', remaining: 120}],
      schedules: [{id: 's1', units: [3], action: 'on', time: '18:00', days: [5, 6], enabled: true}]},
  });
  document.querySelector('.timer-link').click();
  assert.match(document.getElementById('timer-list').textContent, /Turns off in 2 min/);
  assert.match(document.getElementById('timer-list').textContent, /weekends/);
  document.getElementById('sheet-add-timer').click();
  document.querySelector('[data-mode="schedule"]').click();
  document.querySelector('[data-days="weekdays"]').click();
  document.getElementById('timer-time').value = '07:45';
  submit(window, document.getElementById('timer-form'));
  await settle();
  assert.deepEqual(requests.find(item => item.url === '/api/schedules').body,
    {units: [3], action: 'on', time: '07:45', days: [0, 1, 2, 3, 4]});
});

test('Escape cancels reorder without saving', async t => {
  const {window, document, requests} = await setup(t, {devices: [
    {unit: 1, name: 'First', state: false},
    {unit: 2, name: 'Second', state: false},
  ]});
  document.querySelector('.menu-button').click();
  [...document.querySelectorAll('.menu button')]
    .find(button => button.textContent === 'Reorder outlets').click();
  document.dispatchEvent(new window.KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
  await settle();
  assert.equal(document.getElementById('page-title').textContent, 'Nexa Control');
  assert.equal(requests.some(item => item.url === '/api/devices/order'), false);
});

test('edits an outlet name and unit', async t => {
  const {window, document, requests} = await setup(t, {
    devices: [{unit: 1, name: 'Lamp', state: false}],
  });
  document.querySelector('.menu-button').click();
  [...document.querySelectorAll('.menu button')]
    .find(button => button.textContent === 'Edit').click();
  assert.equal(document.getElementById('rename-name').value, 'Lamp');
  document.getElementById('rename-name').value = 'Bedroom';
  document.getElementById('rename-unit').value = '2';
  submit(window, document.getElementById('rename-form'));
  await settle();
  assert.deepEqual(requests.find(item => item.url === '/api/devices/1').body,
    {name: 'Bedroom', unit: 2});
  assert.equal(document.getElementById('rename-modal').hidden, true);
  assert.equal(document.getElementById('toast').textContent, 'Outlet updated');
});

test('confirms outlet removal', async t => {
  const {document, requests} = await setup(t, {
    devices: [{unit: 1, name: 'Lamp', state: false}],
  });
  document.querySelector('.menu-button').click();
  [...document.querySelectorAll('.menu button')]
    .find(button => button.textContent === 'Remove').click();
  assert.match(document.getElementById('remove-message').textContent, /Remove Lamp/);
  document.getElementById('confirm-remove').click();
  await settle();
  assert.equal(requests.find(item => item.url === '/api/devices/1').method, 'DELETE');
  assert.equal(document.getElementById('remove-modal').hidden, true);
});

test('toggles and deletes an existing schedule', async t => {
  const {document, requests} = await setup(t, {
    devices: [{unit: 3, name: 'Lamp', state: true}],
    timers: {countdowns: [], schedules: [
      {id: 's1', units: [3], action: 'on', time: '18:00', days: [0], enabled: true},
    ]},
  });
  document.querySelector('.timer-link').click();
  document.querySelector('#timer-list .switch').click();
  await settle();
  assert.equal(requests.find(item => item.url === '/api/schedules/s1/toggle').method, 'POST');
  document.querySelector('#timer-list .timer-row').click();
  assert.equal(document.getElementById('editor-title').textContent, 'Edit timer');
  document.getElementById('delete-timer').click();
  await settle();
  assert.equal(requests.find(item => item.url === '/api/schedules/s1').method, 'DELETE');
  assert.equal(document.getElementById('toast').textContent, 'Timer deleted');
});

const lamps = [
  {unit: 1, name: 'Lamp', state: true, last_sent: '21:04'},
  {unit: 2, name: 'Fan', state: false},
  {unit: 3, name: 'Heater', state: null},
];

test('defaults to list view and remembers the chosen view', async t => {
  const {window, document} = await setup(t, {devices: lamps});
  assert.equal(document.querySelectorAll('.outlet-card').length, 3);
  assert.equal(document.getElementById('view-bar').hidden, false);
  document.querySelector('[data-view="grid"]').click();
  assert.equal(window.localStorage.getItem('nexa-view'), 'grid');
  assert.equal(document.querySelector('[data-view="grid"]').getAttribute('aria-pressed'), 'true');
  assert.equal(document.querySelector('[data-view="list"]').getAttribute('aria-label'), 'List view');
  assert.equal(document.querySelectorAll('.outlet-card').length, 0);
});

test('applies the stored grid view on load and renders tiles', async t => {
  const {document} = await setup(t, {devices: lamps, view: 'grid'});
  assert.ok(document.getElementById('outlet-list').classList.contains('grid'));
  const tiles = document.querySelectorAll('.tile');
  assert.equal(tiles.length, 3);
  assert.equal(tiles[0].getAttribute('role'), 'switch');
  assert.equal(tiles[0].getAttribute('aria-checked'), 'true');
  assert.equal(tiles[0].getAttribute('aria-label'), 'Lamp');
  assert.equal(tiles[0].querySelector('.tile-status').textContent, 'On · sent 21:04');
  assert.equal(tiles[1].querySelector('.tile-status').textContent, 'Off');
  assert.ok(document.querySelector('.tile-add'));
  assert.equal(document.getElementById('all-off').hidden, false);
});

test('falls back to list view when localStorage is unavailable', async t => {
  const {window, document} = await setup(t, {devices: lamps});
  window.Storage.prototype.getItem = () => { throw new Error('denied'); };
  window.Storage.prototype.setItem = () => { throw new Error('denied'); };
  document.querySelector('[data-view="grid"]').click();
  assert.equal(document.querySelectorAll('.tile').length, 3);
});

test('tapping a tile toggles the outlet and the add tile opens pairing', async t => {
  const {document, requests} = await setup(t, {devices: lamps, view: 'grid'});
  document.querySelector('[data-unit="2"] .tile').click();
  await settle();
  assert.equal(requests.some(item => item.url === '/api/2/on' && item.method === 'POST'), true);
  document.querySelector('[data-unit="1"] .tile').click();
  await settle();
  assert.equal(requests.some(item => item.url === '/api/1/off'), true);
  document.querySelector('.tile-add').click();
  assert.equal(document.getElementById('pair-modal').hidden, false);
});

test('long press opens the tile menu without toggling', async t => {
  const {window, document, requests} = await setup(t, {devices: lamps, view: 'grid'});
  const tile = document.querySelector('[data-unit="2"] .tile');
  tile.dispatchEvent(new window.MouseEvent('pointerdown', {bubbles: true}));
  await new Promise(resolve => setTimeout(resolve, 600));
  tile.dispatchEvent(new window.MouseEvent('pointerup', {bubbles: true}));
  tile.click();
  await settle();
  assert.ok(document.querySelector('[data-unit="2"] .menu'));
  assert.equal(requests.some(item => item.url.startsWith('/api/2/')), false);
  tile.click();
  await settle();
  assert.equal(requests.some(item => item.url === '/api/2/on'), true);
});

test('menu button works in grid view and reorder mode shows compact rows', async t => {
  const {document} = await setup(t, {devices: lamps, view: 'grid'});
  document.querySelector('[data-unit="1"] .tile-menu').click();
  [...document.querySelectorAll('.menu button')]
    .find(button => button.textContent === 'Reorder outlets').click();
  assert.equal(document.querySelectorAll('.reorder-card').length, 3);
  assert.equal(document.querySelectorAll('.tile').length, 0);
  assert.equal(document.getElementById('view-bar').hidden, true);
});

test('tile shows the next timer time and the bottom bar counts timers', async t => {
  const {document} = await setup(t, {
    devices: lamps, view: 'grid',
    timers: {countdowns: [], schedules: [
      {id: 's1', units: [1, 2], action: 'off', time: '22:00', days: [0, 1, 2, 3, 4, 5, 6], enabled: true},
      {id: 's2', units: [3], action: 'on', time: '06:00', days: [0, 1, 2, 3, 4, 5, 6], enabled: false},
    ]},
  });
  assert.equal(document.querySelector('[data-unit="1"] .tile-next').textContent, '22:00');
  assert.equal(document.querySelector('[data-unit="3"] .tile-next'), null);
});

test('settings links to the existing timers page', async t => {
  const {document} = await setup(t, {devices: lamps});
  document.getElementById('open-settings').click();
  assert.equal(document.getElementById('settings-page').hidden, false);
  assert.equal(document.getElementById('timers-page').hidden, true);
  assert.equal(document.getElementById('page-title').textContent, 'Settings');
  assert.equal(document.getElementById('all-off').hidden, true);
  assert.equal(document.getElementById('settings-timers-link').getAttribute('href'), '#timers');
  assert.deepEqual(
    [...document.querySelectorAll('.settings-group-title')].map(title => title.textContent),
    ['Personalization', 'Automation', 'Account & access'],
  );

  document.getElementById('settings-timers-link').click();
  assert.equal(document.getElementById('settings-page').hidden, true);
  assert.equal(document.getElementById('timers-page').hidden, false);
  assert.equal(document.getElementById('page-title').textContent, 'Timers');

  assert.equal(document.getElementById('timers-settings-back').getAttribute('href'), '#settings');
  document.getElementById('timers-settings-back').click();
  assert.equal(document.getElementById('settings-page').hidden, false);
  assert.equal(document.getElementById('timers-page').hidden, true);
});

test('settings navigation uses Material Symbols icons', async t => {
  const {document} = await setup(t);
  const names = [...document.querySelectorAll('.settings-link .material-symbols-outlined')]
    .map(icon => icon.textContent);
  assert.deepEqual(names, [
    'palette', 'chevron_right', 'schedule', 'chevron_right', 'group', 'chevron_right',
    'logout', 'chevron_right',
  ]);
  assert.equal(document.querySelector('#open-settings .material-symbols-outlined').textContent, 'settings');
  assert.equal(document.querySelector('.settings-back-link .material-symbols-outlined').textContent, 'arrow_back');
});

test('appearance settings apply and save preset and custom palettes', async t => {
  const {document} = await setup(t, {devices: lamps});
  document.getElementById('open-settings').click();
  document.getElementById('settings-appearance-link').click();
  assert.equal(document.getElementById('appearance-page').hidden, false);
  assert.equal(document.getElementById('settings-page').hidden, true);
  assert.equal(document.getElementById('save-custom-theme-panel').hidden, true);

  const theme = document.getElementById('appearance-theme');
  theme.value = 'sage';
  theme.dispatchEvent(new document.defaultView.Event('change', {bubbles: true}));
  assert.equal(document.documentElement.style.getPropertyValue('--bg'), '#fbf8e8');
  assert.equal(document.documentElement.style.getPropertyValue('--line'), '#899572');
  assert.match(document.body.style.backgroundImage, /linear-gradient/);

  theme.value = 'ocean';
  theme.dispatchEvent(new document.defaultView.Event('change', {bubbles: true}));
  assert.equal(document.documentElement.style.getPropertyValue('--bg'), '#10212d');
  assert.equal(document.body.style.backgroundImage, '');

  theme.value = 'custom';
  theme.dispatchEvent(new document.defaultView.Event('change', {bubbles: true}));
  const saveThemePanel = document.getElementById('save-custom-theme-panel');
  assert.equal(saveThemePanel.hidden, false);
  assert.equal(saveThemePanel.parentElement.id, 'appearance-page');
  assert.notEqual(saveThemePanel.parentElement, document.getElementById('custom-palette'));
  const background = document.getElementById('appearance-background');
  background.value = '#123456';
  background.dispatchEvent(new document.defaultView.Event('input', {bubbles: true}));
  assert.equal(document.documentElement.style.getPropertyValue('--bg'), '#123456');
  const accent = document.getElementById('appearance-accent');
  accent.value = '#ffaa00';
  accent.dispatchEvent(new document.defaultView.Event('input', {bubbles: true}));
  assert.equal(document.documentElement.style.getPropertyValue('--primary'), '#ffaa00');
  assert.equal(document.documentElement.style.getPropertyValue('--accent-contrast'), '#121417');
  const saved = JSON.parse(document.defaultView.localStorage.getItem('nexa-appearance'));
  assert.equal(saved.theme, 'custom');
  assert.equal(saved.custom.background, '#123456');
  assert.equal(saved.custom.accent, '#ffaa00');

  document.getElementById('appearance-theme-name').value = 'My olive';
  document.getElementById('save-custom-theme').click();
  const savedThemeOption = [...theme.options].find(option => option.value.startsWith('saved:'));
  assert.equal(savedThemeOption.textContent, 'My olive');
  const savedThemes = JSON.parse(document.defaultView.localStorage.getItem('nexa-appearance')).savedThemes;
  assert.equal(savedThemes.length, 1);
  assert.equal(savedThemes[0].palette.background, '#123456');

  theme.value = savedThemeOption.value;
  theme.dispatchEvent(new document.defaultView.Event('change', {bubbles: true}));
  assert.equal(document.documentElement.style.getPropertyValue('--bg'), '#123456');

  document.getElementById('appearance-reset').click();
  assert.equal(theme.value, 'system');
  assert.equal(saveThemePanel.hidden, true);
  assert.equal(document.documentElement.style.getPropertyValue('--bg'), '');
  assert.equal(document.body.style.backgroundImage, '');
  document.getElementById('appearance-settings-back').click();
  assert.equal(document.getElementById('settings-page').hidden, false);
});

test('shared theme loader applies the saved theme without the dashboard script', async t => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost/admin/users',
    runScripts: 'outside-only',
    beforeParse(window) {
      window.localStorage.setItem('nexa-appearance', JSON.stringify({
        theme: 'ocean',
        custom: {},
        savedThemes: [],
      }));
    },
  });
  t.after(() => dom.window.close());
  themeScript.runInContext(dom.getInternalVMContext());
  dom.window.NexaAppearance.applyStored();

  assert.equal(dom.window.document.documentElement.style.getPropertyValue('--bg'), '#10212d');
  assert.equal(dom.window.document.documentElement.style.getPropertyValue('--primary'), '#0284c7');
});

test('account pages automatically apply the saved custom palette', t => {
  for (const page of ['account.html', 'change_password.html', 'change_username.html']) {
    const markup = fs.readFileSync(path.join(root, 'nexa_pi_controller/templates', page), 'utf8');
    const dom = new JSDOM(markup, {url: 'http://localhost/account', runScripts: 'outside-only'});
    t.after(() => dom.window.close());
    const {window} = dom;
    window.localStorage.setItem('nexa-appearance', JSON.stringify({
      theme: 'custom',
      custom: {background: '#123456', cards: '#abcdef', text: '#112233', accent: '#aabbcc'},
    }));
    const scriptElement = window.document.querySelector('script[data-autoload="true"]');
    assert.ok(scriptElement, `${page} should load the saved theme`);
    Object.defineProperty(window.document, 'currentScript', {value: scriptElement});
    themeScript.runInContext(dom.getInternalVMContext());
    const style = window.document.documentElement.style;
    assert.equal(style.getPropertyValue('--bg'), '#123456');
    assert.equal(style.getPropertyValue('--card'), '#abcdef');
    assert.equal(style.getPropertyValue('--text'), '#112233');
  }
});

test('appearance settings control and persist visible footer views', async t => {
  const {window, document} = await setup(t, {view: 'grid'});
  const footerButtons = [...document.querySelectorAll('[data-view]')];
  assert.deepEqual(footerButtons.map(button => button.hidden), [false, false, false]);

  document.getElementById('open-settings').click();
  document.getElementById('settings-appearance-link').click();
  const grid = document.getElementById('footer-view-grid');
  grid.checked = false;
  grid.dispatchEvent(new window.Event('change', {bubbles: true}));

  assert.deepEqual(JSON.parse(window.localStorage.getItem('nexa-footer-views')), ['list', 'map']);
  assert.equal(document.querySelector('[data-view="grid"]').hidden, true);
  assert.equal(window.localStorage.getItem('nexa-view'), 'list');
  assert.equal(document.getElementById('appearance-page').hidden, false);

  const reloaded = await setup(t, {
    view: window.localStorage.getItem('nexa-view'),
    footerViews: JSON.parse(window.localStorage.getItem('nexa-footer-views')),
  });
  assert.deepEqual(
    [...reloaded.document.querySelectorAll('[data-view]')].map(button => button.hidden),
    [false, true, false],
  );
  assert.equal(reloaded.document.querySelector('[data-view="list"]').getAttribute('aria-pressed'), 'true');
});

test('All timers page lists timers sorted with tags and adds with no preselection', async t => {
  const {document} = await setup(t, {
    devices: lamps, view: 'grid',
    timers: {
      countdowns: [{id: 'c1', units: [1], action: 'off', remaining: 1440}],
      schedules: [
        {id: 's2', units: [1, 2, 3], action: 'on', time: '22:00', days: [0, 1, 2, 3, 4], enabled: false},
        {id: 's1', units: [2], action: 'off', time: '07:30', days: [0, 1, 2, 3, 4, 5, 6], enabled: true},
      ],
    },
  });
  openTimersFromSettings(document);
  assert.equal(document.getElementById('timers-page').hidden, false);
  assert.equal(document.getElementById('timer-sheet').hidden, true);
  assert.equal(document.getElementById('page-title').textContent, 'Timers');
  const rows = [...document.querySelectorAll('#timers-page-list .timer-row')];
  assert.match(rows[0].textContent, /COUNTDOWN.*Turns off in 24 min/);
  assert.match(rows[1].textContent, /07:30.*Turns off · every day/);
  assert.match(rows[2].textContent, /22:00.*Turns on · weekdays.*Lamp.*Fan.*\+1/);
  assert.equal([...rows[2].querySelectorAll('.tag')].length, 3);
  assert.ok(rows[2].classList.contains('is-off'));
  document.getElementById('page-add-timer').click();
  assert.equal(document.getElementById('save-timer').disabled, true);
  assert.equal(document.getElementById('outlets-hint').hidden, false);
});

test('outlet-specific timer sheet filters timers and preselects the outlet', async t => {
  const {document} = await setup(t, {
    devices: lamps,
    timers: {countdowns: [], schedules: [
      {id: 's1', units: [2], action: 'off', time: '07:30', days: [0], enabled: true},
      {id: 's2', units: [1, 2], action: 'on', time: '09:00', days: [0], enabled: true},
    ]},
  });
  document.querySelector('[data-unit="1"] .timer-link').click();
  assert.equal(document.getElementById('timer-sheet-title').textContent, 'Lamp timers');
  assert.equal(document.querySelectorAll('#timer-list .timer-row').length, 1);
  document.getElementById('sheet-add-timer').click();
  assert.equal(document.getElementById('outlets-count').textContent, '1 selected');
  assert.equal(document.getElementById('save-timer').textContent, 'Save timer · 1 outlet');
});

test('editor chooses outlets, select all toggles, and saves units', async t => {
  const {window, document, requests} = await setup(t, {devices: lamps, view: 'grid'});
  openTimersFromSettings(document);
  document.getElementById('page-add-timer').click();
  const chips = () => [...document.querySelectorAll('#timer-outlets .outlet-chip')];
  assert.equal(chips().length, 4);
  chips().find(chip => chip.textContent.includes('Fan')).click();
  chips().find(chip => chip.textContent.includes('Heater')).click();
  assert.equal(document.getElementById('save-timer').textContent, 'Save timer · 2 outlets');
  assert.equal(document.getElementById('outlets-count').textContent, '2 selected');
  chips()[0].click();
  assert.equal(document.getElementById('outlets-count').textContent, '3 selected');
  assert.equal(chips()[0].getAttribute('aria-pressed'), 'true');
  chips()[0].click();
  assert.equal(document.getElementById('save-timer').disabled, true);
  chips()[0].click();
  chips().find(chip => chip.textContent.includes('Lamp')).click();
  document.querySelector('[data-mode="schedule"]').click();
  document.getElementById('timer-time').value = '21:15';
  submit(window, document.getElementById('timer-form'));
  await settle();
  assert.deepEqual(requests.find(item => item.url === '/api/schedules').body,
    {units: [2, 3], action: 'on', time: '21:15', days: [0, 1, 2, 3, 4, 5, 6]});
});

test('editing a schedule prefills fields and saves with PUT', async t => {
  const {window, document, requests} = await setup(t, {
    devices: lamps, view: 'grid',
    timers: {countdowns: [], schedules: [
      {id: 's1', units: [1, 2], action: 'off', time: '22:00', days: [5, 6], enabled: true},
    ]},
  });
  openTimersFromSettings(document);
  document.querySelector('#timers-page-list .timer-row').click();
  assert.equal(document.getElementById('editor-title').textContent, 'Edit timer');
  assert.equal(document.getElementById('timer-time').value, '22:00');
  assert.equal(document.getElementById('save-timer').textContent, 'Save timer · 2 outlets');
  assert.equal(document.getElementById('delete-timer').textContent, 'Delete timer');
  document.getElementById('timer-time').value = '23:00';
  submit(window, document.getElementById('timer-form'));
  await settle();
  const request = requests.find(item => item.url === '/api/schedules/s1');
  assert.equal(request.method, 'PUT');
  assert.deepEqual(request.body, {units: [1, 2], action: 'off', time: '23:00', days: [5, 6]});
});

test('outlet names are rendered as text, not markup', async t => {
  const {document} = await setup(t, {
    devices: [{unit: 1, name: '<img src=x onerror=alert(1)>', state: false}], view: 'grid',
  });
  assert.equal(document.querySelector('.tile-name').textContent, '<img src=x onerror=alert(1)>');
  assert.equal(document.querySelector('.tile img'), null);
});

test('map view toggles all outlets in a room', async t => {
  const {document, requests} = await setup(t, {
    view: 'map',
    devices: [{unit: 1, name: 'A', state: true}, {unit: 2, name: 'B', state: false}],
    rooms: [{id: 'r1', name: 'Hall', x: 0, y: 0, w: 40, h: 40, units: [1, 2]}],
  });
  const room = document.querySelector('.room');
  assert.equal(room.parentElement.className, 'map-layout');
  assert.match(room.textContent, /Hall/);
  assert.match(room.textContent, /1\/2 on/);
  room.click();
  await settle();
  assert.ok(requests.some(r => r.url === '/api/rooms/r1/off' && r.method === 'POST'));
});

test('long pressing a room opens individual outlet switches', async t => {
  const {window, document, requests} = await setup(t, {
    view: 'map',
    devices: [{unit: 1, name: 'Lamp', state: false}, {unit: 2, name: 'Radio', state: true}],
    rooms: [{id: 'r1', name: 'Living room', x: 0, y: 0, w: 40, h: 40, units: [1, 2]}],
  });
  const room = document.querySelector('.room');
  room.dispatchEvent(new window.MouseEvent('pointerdown', {
    bubbles: true, cancelable: true, clientX: 10, clientY: 10,
  }));
  await new Promise(resolve => setTimeout(resolve, 550));
  assert.equal(document.getElementById('room-outlet-sheet').hidden, false);
  window.dispatchEvent(new window.MouseEvent('pointerup'));
  room.click();
  await settle();
  assert.equal(requests.some(request => request.url === '/api/rooms/r1/on'), false);

  const switches = document.querySelectorAll('#room-outlet-controls [role="switch"]');
  assert.equal(switches.length, 2);
  assert.equal(switches[0].getAttribute('aria-checked'), 'false');
  switches[0].click();
  await settle();
  assert.ok(requests.some(request => request.url === '/api/1/on' && request.method === 'POST'));
  assert.equal(document.querySelector('#room-outlet-controls [role="switch"]')
    .getAttribute('aria-checked'), 'true');
});

test('floors have separate rooms and can be added, renamed, and deleted', async t => {
  const {window, document, requests} = await setup(t, {
    view: 'map',
    rooms: [{id: 'r1', name: 'Hall', x: 0, y: 0, w: 30, h: 30, units: []}],
  });
  const floorSelect = document.getElementById('floor-select');
  assert.equal(floorSelect.disabled, false);
  assert.equal(floorSelect.options[0].textContent, 'Ground floor');
  assert.equal(document.querySelector('.room-name').textContent, 'Hall');

  document.getElementById('floor-menu-toggle').click();
  document.getElementById('add-floor').click();
  document.getElementById('floor-name').value = 'Second floor';
  submit(window, document.getElementById('floor-form'));
  await settle();
  const secondFloorId = floorSelect.value;
  assert.equal(floorSelect.selectedOptions[0].textContent, 'Second floor');
  document.getElementById('add-room').click();
  document.querySelector('#room-form [data-close="room-modal"]').click();

  document.getElementById('done-map-edit').click();
  await settle();
  let savedMap = requests.find(request => request.url === '/api/map' && request.method === 'PUT').body;
  assert.deepEqual(savedMap.floors.map(floor => floor.name), ['Ground floor', 'Second floor']);
  assert.deepEqual(savedMap.rooms.map(room => room.floor_id), ['ground-floor', secondFloorId]);

  floorSelect.value = 'ground-floor';
  floorSelect.dispatchEvent(new window.Event('change', {bubbles: true}));
  assert.equal(document.querySelector('.room-name').textContent, 'Hall');
  floorSelect.value = secondFloorId;
  floorSelect.dispatchEvent(new window.Event('change', {bubbles: true}));
  assert.equal(document.querySelector('.room-name').textContent, 'Room 1');

  document.getElementById('floor-menu-toggle').click();
  document.getElementById('rename-floor').click();
  document.getElementById('floor-name').value = 'Top floor';
  submit(window, document.getElementById('floor-form'));
  document.getElementById('done-map-edit').click();
  await settle();
  savedMap = requests.filter(request => request.url === '/api/map' && request.method === 'PUT').at(-1).body;
  assert.equal(savedMap.floors[1].name, 'Top floor');

  document.getElementById('floor-menu-toggle').click();
  document.getElementById('delete-floor').click();
  document.getElementById('done-map-edit').click();
  await settle();
  savedMap = requests.filter(request => request.url === '/api/map' && request.method === 'PUT').at(-1).body;
  assert.deepEqual(savedMap.floors.map(floor => floor.id), ['ground-floor']);
  assert.deepEqual(savedMap.rooms.map(room => room.id), ['r1']);
});

test('map view and editing center each floor without saving changes on cancel', async t => {
  const {window, document, requests} = await setup(t, {
    view: 'map',
    floors: [{id: 'ground-floor', name: 'Ground floor'}, {id: 'upstairs', name: 'Upstairs'}],
    rooms: [
      {id: 'r1', name: 'Hall', x: 10, y: 5, w: 20, h: 30, units: []},
      {id: 'r2', name: 'Kitchen', x: 40, y: 15, w: 30, h: 25, units: []},
      {id: 'r3', floor_id: 'upstairs', name: 'Office', x: 80, y: 60, w: 20, h: 30, units: []},
    ],
  });
  assert.equal(document.querySelector('.map-layout').style.transform, 'translate(10%, 27.5%)');
  assert.equal(document.querySelector('[data-room="r1"]').style.left, '10%');
  const floor = document.getElementById('floor-select');
  floor.value = 'upstairs';
  floor.dispatchEvent(new window.Event('change', {bubbles: true}));
  assert.equal(document.querySelector('.map-layout').style.transform, 'translate(-40%, -25%)');
  document.getElementById('edit-map').click();
  assert.equal(document.querySelector('.map-layout').style.transform, '');
  assert.equal(document.querySelector('[data-room="r3"]').style.left, '40%');
  assert.equal(document.querySelector('[data-room="r3"]').style.top, '35%');
  document.getElementById('cancel-map-edit').click();
  assert.equal(document.querySelector('.map-layout').style.transform, 'translate(-40%, -25%)');
  assert.equal(requests.some(request => request.url === '/api/map' && request.method === 'PUT'), false);
});

test('editing stays stable while dragging and centers rooms after saving', async t => {
  const {window, document, requests} = await setup(t, {
    view: 'map',
    rooms: [
      {id: 'r1', name: 'Hall', x: 0, y: 0, w: 20, h: 20, units: []},
      {id: 'r2', name: 'Kitchen', x: 40, y: 0, w: 20, h: 20, units: []},
    ],
  });
  document.getElementById('edit-map').click();
  const layout = document.querySelector('.map-layout');
  layout.getBoundingClientRect = () => ({width: 100, height: 100});
  const room = document.querySelector('[data-room="r1"]');
  assert.equal(room.style.left, '20%');
  room.dispatchEvent(new window.MouseEvent('pointerdown', {
    bubbles: true, cancelable: true, clientX: 0, clientY: 0,
  }));
  window.dispatchEvent(new window.MouseEvent('pointermove', {clientX: 10, clientY: 0}));
  window.dispatchEvent(new window.MouseEvent('pointerup'));
  assert.equal(room.style.left, '30%');
  assert.equal(document.querySelector('.map-layout'), layout);
  document.getElementById('done-map-edit').click();
  await settle();
  const saved = requests.find(request => request.url === '/api/map' && request.method === 'PUT').body.rooms;
  assert.deepEqual(saved.map(item => [item.x, item.y]), [[25, 40], [55, 40]]);
  document.getElementById('edit-map').click();
  assert.equal(document.querySelector('[data-room="r1"]').style.left, '25%');
  assert.equal(document.querySelector('[data-room="r2"]').style.left, '55%');
});

test('new rooms are placed without overlapping existing rooms', async t => {
  const {document, requests} = await setup(t, {
    view: 'map',
    rooms: [{id: 'r1', name: 'Hall', x: 10, y: 10, w: 30, h: 30, units: []}],
  });
  document.getElementById('edit-map').click();
  await settle();
  document.getElementById('add-room').click();
  await settle();
  assert.equal(requests.some(request => request.url === '/api/map' && request.method === 'PUT'), false);
  document.querySelector('#room-form [data-close="room-modal"]').click();
  document.getElementById('done-map-edit').click();
  await settle();
  const savedRooms = requests.find(request => request.url === '/api/map' && request.method === 'PUT').body.rooms;
  assert.equal(savedRooms.length, 2);
  assert.equal(savedRooms[1].w, 30);
  assert.equal(savedRooms[1].h, 30);
  assert.ok(savedRooms[1].x + savedRooms[1].w <= savedRooms[0].x
    || savedRooms[1].y + savedRooms[1].h <= savedRooms[0].y);
});

test('rooms cannot be moved or resized into another room', async t => {
  const {window, document, requests} = await setup(t, {
    view: 'map',
    rooms: [
      {id: 'r1', name: 'Hall', x: 0, y: 0, w: 30, h: 30, units: []},
      {id: 'r2', name: 'Kitchen', x: 40, y: 0, w: 30, h: 30, units: []},
    ],
  });
  document.getElementById('edit-map').click();
  await settle();
  document.querySelector('.map-layout').getBoundingClientRect = () => ({width: 100});
  const room = document.querySelector('[data-room="r1"]');
  room.dispatchEvent(new window.MouseEvent('pointerdown', {
    bubbles: true, cancelable: true, clientX: 0, clientY: 0,
  }));
  window.dispatchEvent(new window.MouseEvent('pointermove', {clientX: 15, clientY: 0}));
  window.dispatchEvent(new window.MouseEvent('pointerup'));
  await settle();
  assert.equal(room.style.left, '15%');

  room.querySelector('.room-resize').dispatchEvent(new window.MouseEvent('pointerdown', {
    bubbles: true, cancelable: true, clientX: 0, clientY: 0,
  }));
  window.dispatchEvent(new window.MouseEvent('pointermove', {clientX: 15, clientY: 0}));
  window.dispatchEvent(new window.MouseEvent('pointerup'));
  await settle();
  assert.equal(room.style.width, '30%');
  assert.equal(requests.some(request => request.url === '/api/map' && request.method === 'PUT'), false);
});

test('overlap toggle allows rooms to be moved over each other', async t => {
  const {window, document, requests} = await setup(t, {
    view: 'map',
    rooms: [
      {id: 'r1', name: 'Hall', x: 0, y: 0, w: 30, h: 30, units: []},
      {id: 'r2', name: 'Kitchen', x: 40, y: 0, w: 30, h: 30, units: []},
    ],
  });
  document.getElementById('edit-map').click();
  await settle();
  const overlapToggle = document.getElementById('toggle-room-overlap');
  assert.equal(overlapToggle.getAttribute('aria-pressed'), 'false');
  overlapToggle.click();
  assert.equal(overlapToggle.getAttribute('aria-pressed'), 'true');

  document.querySelector('.map-layout').getBoundingClientRect = () => ({width: 100});
  const room = document.querySelector('[data-room="r1"]');
  room.dispatchEvent(new window.MouseEvent('pointerdown', {
    bubbles: true, cancelable: true, clientX: 0, clientY: 0,
  }));
  window.dispatchEvent(new window.MouseEvent('pointermove', {clientX: 15, clientY: 0}));
  window.dispatchEvent(new window.MouseEvent('pointerup'));
  await settle();
  assert.equal(room.style.left, '30%');

  document.getElementById('done-map-edit').click();
  await settle();
  const savedRooms = requests.find(request => request.url === '/api/map' && request.method === 'PUT').body.rooms;
  assert.equal(savedRooms[1].x - savedRooms[0].x, 25);
});

test('canceling map editing discards layout changes', async t => {
  const {window, document, requests} = await setup(t, {
    view: 'map',
    rooms: [{id: 'r1', name: 'Hall', x: 0, y: 0, w: 30, h: 30, units: []}],
  });
  document.getElementById('edit-map').click();
  await settle();
  document.querySelector('.map-layout').getBoundingClientRect = () => ({width: 100});
  const room = document.querySelector('.room');
  room.dispatchEvent(new window.MouseEvent('pointerdown', {
    bubbles: true, cancelable: true, clientX: 0, clientY: 0,
  }));
  window.dispatchEvent(new window.MouseEvent('pointermove', {clientX: 10, clientY: 0}));
  window.dispatchEvent(new window.MouseEvent('pointerup'));
  await settle();
  assert.equal(room.style.left, '45%');
  assert.equal(requests.some(request => request.url === '/api/map' && request.method === 'PUT'), false);

  document.getElementById('cancel-map-edit').click();
  assert.equal(document.querySelector('.room').style.left, '0%');
  assert.equal(document.getElementById('edit-map').textContent, 'Edit');
  assert.equal(requests.some(request => request.url === '/api/map' && request.method === 'PUT'), false);
});

test('failed map saves keep editing open so changes can be canceled or retried', async t => {
  const {document, requests} = await setup(t, {
    view: 'map',
    fail: (url, options) => url === '/api/map' && options.method === 'PUT',
    rooms: [{id: 'r1', name: 'Hall', x: 0, y: 0, w: 30, h: 30, units: []}],
  });
  document.getElementById('edit-map').click();
  document.querySelector('.map-layout').getBoundingClientRect = () => ({width: 100, height: 100});
  document.querySelector('.room').dispatchEvent(new document.defaultView.MouseEvent('pointerdown', {
    bubbles: true, cancelable: true, clientX: 0, clientY: 0,
  }));
  document.defaultView.dispatchEvent(new document.defaultView.MouseEvent('pointermove', {clientX: 10, clientY: 0}));
  document.defaultView.dispatchEvent(new document.defaultView.MouseEvent('pointerup'));
  document.getElementById('done-map-edit').click();
  await settle();

  assert.equal(document.getElementById('map-edit-toolbar').hidden, false);
  assert.equal(document.getElementById('edit-map').hidden, true);
  assert.match(document.getElementById('toast').textContent, /Failed: Request denied/);
  assert.equal(requests.filter(request => request.url === '/api/map' && request.method === 'PUT').length, 1);
  document.getElementById('cancel-map-edit').click();
  assert.equal(document.querySelector('.room').style.left, '0%');
});

test('canceling room details discards unsaved name and outlet changes', async t => {
  const {window, document, requests} = await setup(t, {
    view: 'map',
    devices: [{unit: 1, name: 'Lamp', state: false}],
    rooms: [{id: 'r1', name: 'Hall', x: 0, y: 0, w: 30, h: 30, units: []}],
  });
  document.getElementById('edit-map').click();
  await settle();
  const openRoom = () => {
    document.querySelector('.room').dispatchEvent(new window.MouseEvent('pointerdown', {
      bubbles: true, cancelable: true, clientX: 0, clientY: 0,
    }));
    window.dispatchEvent(new window.MouseEvent('pointerup'));
  };
  openRoom();
  document.getElementById('room-name').value = 'Bedroom';
  document.querySelector('#room-outlets .outlet-chip').click();
  document.querySelector('#room-form [data-close="room-modal"]').click();

  openRoom();
  assert.equal(document.getElementById('room-name').value, 'Hall');
  assert.equal(document.querySelector('#room-outlets .outlet-chip').getAttribute('aria-pressed'), 'false');
  assert.equal(requests.some(request => request.url === '/api/map' && request.method === 'PUT'), false);
  document.querySelector('#room-form [data-close="room-modal"]').click();
  document.getElementById('cancel-map-edit').click();
});

test('leaving the timers page by choosing a view shows outlets again', async t => {
  const {document} = await setup(t, {devices: lamps});
  openTimersFromSettings(document);
  assert.equal(document.getElementById('outlet-list').hidden, true);
  document.querySelector('[data-view="list"]').click();
  assert.equal(document.getElementById('timers-page').hidden, true);
  assert.equal(document.getElementById('outlet-list').hidden, false);
  assert.equal(document.getElementById('page-title').textContent, 'Nexa Control');
});

test('user account actions open dialogs and submit role changes immediately', t => {
  const dom = new JSDOM(`
    <article class="user-panel">
      <div class="user-card-menu">
        <button id="menu-toggle" class="user-menu-toggle" aria-controls="user-menu"
                aria-expanded="false"></button>
        <div id="user-menu" hidden>
          <button id="reset-trigger" class="user-dialog-trigger" data-dialog="reset-dialog"></button>
          <button id="rename-trigger" class="user-dialog-trigger" data-dialog="rename-user-dialog-2"></button>
        </div>
      </div>
    </article>
    <dialog id="reset-dialog"></dialog>
    <dialog id="rename-user-dialog-2"></dialog>
    <form id="role-form"><select class="user-role-select"></select></form>
  `, {runScripts: 'outside-only'});
  const {window} = dom;
  const {document} = window;
  t.after(() => window.close());

  const roleForm = document.getElementById('role-form');
  let roleSubmitCount = 0;
  roleForm.requestSubmit = () => { roleSubmitCount += 1; };
  const resetDialog = document.getElementById('reset-dialog');
  resetDialog.showModal = () => { resetDialog.open = true; };
  const renameDialog = document.getElementById('rename-user-dialog-2');
  renameDialog.showModal = () => { renameDialog.open = true; };

  const usersScriptPath = path.join(root, 'nexa_pi_controller/static/users.js');
  new vm.Script(fs.readFileSync(usersScriptPath, 'utf8'), {filename: usersScriptPath})
    .runInContext(dom.getInternalVMContext());

  const toggle = document.getElementById('menu-toggle');
  const menu = document.getElementById('user-menu');
  toggle.click();
  assert.equal(menu.hidden, false);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');

  document.getElementById('reset-trigger').click();
  assert.equal(menu.hidden, true);
  assert.equal(resetDialog.open, true);

  toggle.click();
  document.getElementById('rename-trigger').click();
  assert.equal(menu.hidden, true);
  assert.equal(renameDialog.open, true);

  document.querySelector('.user-role-select')
    .dispatchEvent(new window.Event('change', {bubbles: true}));
  assert.equal(roleSubmitCount, 1);
});

test('username dialog reopens after a validation error', t => {
  const dom = new JSDOM('<dialog id="rename-user-dialog-2"></dialog>', {
    url: 'http://localhost/admin/users?rename=2', runScripts: 'outside-only',
  });
  t.after(() => dom.window.close());
  const dialog = dom.window.document.getElementById('rename-user-dialog-2');
  dialog.showModal = () => { dialog.open = true; };
  const usersScriptPath = path.join(root, 'nexa_pi_controller/static/users.js');
  new vm.Script(fs.readFileSync(usersScriptPath, 'utf8'), {filename: usersScriptPath})
    .runInContext(dom.getInternalVMContext());
  assert.equal(dialog.open, true);
});

test('usernames are not translated', t => {
  const dom = new JSDOM('<h3 class="user-account-name">Off</h3>', {
    url: 'http://localhost/', runScripts: 'outside-only',
    beforeParse(window) { window.localStorage.setItem('nexa-language', 'sv'); },
  });
  t.after(() => dom.window.close());
  i18nScript.runInContext(dom.getInternalVMContext());
  assert.equal(dom.window.document.querySelector('h3').textContent, 'Off');
});
