'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { routes } = require('../../api/server');

function invoke(key) {
  return new Promise(resolve => {
    const res = {
      writeHead() {},
      end(body) { resolve(JSON.parse(body)); }
    };
    routes[key]({}, res);
  });
}

test('проверка живости сообщает режимы, а не только «ок»', async () => {
  const h = await invoke('GET /api/health');
  assert.equal(h.ok, true);
  assert.equal(h.marketplace, 'dry-run', 'без ключа режим должен быть сухим');
  assert.ok(h.payments.endsWith(':dry'));
  assert.ok(h.stockScheme);
});

test('витрине отдаётся только публичная часть конфигурации', async () => {
  const c = await invoke('GET /api/config');
  assert.ok(c.theme && c.theme.name);
  assert.ok(!('marketplace' in c) && !('payments' in c), 'служебные секции наружу не уходят');
});
