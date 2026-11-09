const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(
  path.join(__dirname, '../nexa_pi_controller/static/sw.js'), 'utf8'
);

function setup({fetch, caches, errors = []}) {
  const handlers = {};
  vm.runInNewContext(source, {
    self: {addEventListener: (type, handler) => { handlers[type] = handler; }},
    fetch,
    caches,
    URL,
    console: {error: (...args) => errors.push(args)},
  });
  return handlers;
}

function fetchEvent(url) {
  return {
    request: {url},
    respondWith(promise) { this.response = promise; },
    waitUntil(promise) { this.lifetime = promise; },
  };
}

test('returns the network response while waiting for the cache write', async () => {
  let finishWrite;
  const write = new Promise(resolve => { finishWrite = resolve; });
  const copy = {};
  const response = {clone: () => copy};
  let cached;
  const handlers = setup({
    fetch: async () => response,
    caches: {open: async () => ({put: (request, value) => {
      cached = [request, value];
      return write;
    }})},
  });
  const event = fetchEvent('https://example.test/static/app.js');
  handlers.fetch(event);
  assert.equal(await event.response, response);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(cached, [event.request, copy]);
  let finished = false;
  event.lifetime.then(() => { finished = true; });
  await Promise.resolve();
  assert.equal(finished, false);
  finishWrite();
  await event.lifetime;
});

test('logs cache write failures without failing the network response', async () => {
  const errors = [];
  const response = {clone: () => ({})};
  const handlers = setup({
    fetch: async () => response,
    caches: {open: async () => { throw new Error('cache unavailable'); }},
    errors,
  });
  const event = fetchEvent('https://example.test/static/app.js');
  handlers.fetch(event);
  assert.equal(await event.response, response);
  await event.lifetime;
  assert.equal(errors.length, 1);
  assert.equal(errors[0][1].message, 'cache unavailable');
});

test('clones the response before the asynchronous cache opens', async () => {
  let openCache;
  const cacheReady = new Promise(resolve => { openCache = resolve; });
  let consumed = false;
  let cloned = false;
  const response = {clone: () => {
    assert.equal(consumed, false);
    cloned = true;
    return {};
  }};
  const handlers = setup({
    fetch: async () => response,
    caches: {open: () => cacheReady},
  });
  const event = fetchEvent('https://example.test/static/app.js');
  handlers.fetch(event);
  assert.equal(await event.response, response);
  consumed = true;
  assert.equal(cloned, true);
  openCache({put: async () => {}});
  await event.lifetime;
});

test('uses the cached asset when the network fails', async () => {
  const cached = {};
  const handlers = setup({
    fetch: async () => { throw new Error('offline'); },
    caches: {match: async () => cached},
  });
  const event = fetchEvent('https://example.test/static/app.js');
  handlers.fetch(event);
  assert.equal(await event.response, cached);
  await event.lifetime;
});

test('does not intercept non-static requests', () => {
  const handlers = setup({fetch: () => assert.fail('unexpected fetch'), caches: {}});
  const event = fetchEvent('https://example.test/api/devices');
  handlers.fetch(event);
  assert.equal(event.response, undefined);
  assert.equal(event.lifetime, undefined);
});
