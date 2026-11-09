const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const {JSDOM} = require('jsdom');

const root = path.join(__dirname, '..');
const scriptPath = path.join(root, 'nexa_pi_controller/static/app.js');
const script = new vm.Script(fs.readFileSync(scriptPath, 'utf8'), {filename: scriptPath});
const template = fs.readFileSync(path.join(root, 'nexa_pi_controller/templates/index.html'), 'utf8')
  .replace('{{ csrf_token() }}', 'test-csrf');

async function setup(t, {devices = [], timers = {schedules: [], countdowns: []}, fail} = {}) {
  const dom = new JSDOM(template, {url: 'http://localhost/', runScripts: 'outside-only'});
  const {window} = dom;
  const requests = [];
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
    return {ok: true, json: async () => response};
  };
  window.confirm = () => true;
  script.runInContext(dom.getInternalVMContext());
  await settle();
  return {window, document: window.document, requests};
}

async function settle() {
  for (let i = 0; i < 4; i += 1) await new Promise(resolve => setImmediate(resolve));
}

function submit(window, form) {
  form.dispatchEvent(new window.Event('submit', {bubbles: true, cancelable: true}));
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
    {unit: 3, action: 'off', minutes: 60});
  assert.equal(document.getElementById('editor-sheet').hidden, true);
  assert.equal(document.getElementById('toast').textContent, 'Timer saved');
});

test('creates a weekday schedule and shows existing timers', async t => {
  const {window, document, requests} = await setup(t, {
    devices: [{unit: 3, name: 'Lamp', state: true}],
    timers: {countdowns: [{id: 'c1', unit: 3, action: 'off', remaining: 120}],
      schedules: [{id: 's1', unit: 3, action: 'on', time: '18:00', days: [5, 6], enabled: true}]},
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
    {unit: 3, action: 'on', time: '07:45', days: [0, 1, 2, 3, 4]});
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
      {id: 's1', unit: 3, action: 'on', time: '18:00', days: [0], enabled: true},
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
