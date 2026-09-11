'use strict';
/**
 * Остаток как состояние: переживает перезапуск, журнал движений с причинами,
 * ручная правка с причиной, импорт не трогает остаток молча.
 * Файловое хранилище во временной папке; запросы кабинета — по HTTP.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'stock-state-'));
process.env.STORE_PROVIDER = 'file';
process.env.DATA_DIR = DATA_DIR;
process.env.JWT_SECRET = 'stock-state-test-secret-0123456789-abcdef';
const { server, catalog, stock, orders, auth } = require('../../api/server');

let base, token;
const SELLER = 'stock-seller';
async function call(method, route, { body, type, tk } = {}) {
  const headers = { 'Content-Type': type || 'application/json' };
  if (tk) headers.Authorization = 'Bearer ' + tk;
  const r = await fetch(base + route, { method, headers, body: typeof body === 'string' ? body : body && JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}
const moves = id => stock.log({ id }).filter(e => e.reason !== 'seed');

test.before(async () => {
  await catalog.init(); await stock.init();
  await auth.register(SELLER, 'пароль-склада-1');
  token = (await auth.login(SELLER, 'пароль-склада-1')).token;
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + server.address().port;
});
test.after(() => { server.close(); fs.rmSync(DATA_DIR, { recursive: true, force: true }); });

test('остаток переживает перезапуск: заказ, перезапуск, остаток на месте', async () => {
  const before = stock.level('SKU-001').stock;
  await orders.create({ items: [{ id: 'SKU-001', qty: 3 }], channel: 'SITE', customer: { name: 'Покупатель' } });
  assert.equal(stock.level('SKU-001').stock, before - 3);
  // новый процесс с тем же хранилищем — как перезапуск сервера
  const after = JSON.parse(execFileSync(process.execPath, ['-e', `
    const catalog = require('./api/lib/catalog'), stock = require('./api/lib/stock');
    (async () => { await catalog.init(); await stock.init();
      console.log(JSON.stringify({ level: stock.level('SKU-001').stock, last: stock.log({ id: 'SKU-001' })[0] })); })();`],
    { cwd: ROOT, env: process.env, encoding: 'utf8' }));
  assert.equal(after.level, before - 3, 'остаток не откатился к стартовому');
  assert.deepEqual([after.last.reason, after.last.delta], ['order', -3], 'журнал тоже на месте');
});

test('импорт без колонки остатка не меняет остаток', async () => {
  const before = stock.level('SKU-002').stock;
  await orders.create({ items: [{ id: 'SKU-002', qty: 1 }], channel: 'SITE', customer: { name: 'Покупатель' } });
  const logBefore = stock.log().length;
  const r = await call('POST', '/api/catalog/import', { body: 'Артикул;Цена\nSKU-002;777\n', type: 'text/csv', tk: token });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.summary.updated, r.body.summary.stock, r.body.stock], [1, 0, []]);
  assert.equal(catalog.byId('SKU-002').price, 777, 'описание обновилось');
  assert.equal(stock.level('SKU-002').stock, before - 1, 'остаток после заказа не перезаписан');
  assert.equal(stock.log().length, logBefore, 'движений склада нет');
});

test('импорт с колонкой остатка меняет его и показывает это в предпросмотре отдельно', async () => {
  const was = stock.level('SKU-003').stock;
  const file = 'Артикул;Цена;Остаток\nSKU-003;500;' + (was + 10) + '\n';
  const preview = await call('POST', '/api/catalog/import?dryRun=1', { body: file, type: 'text/csv', tk: token });
  assert.deepEqual(preview.body.stock, [{ line: 2, id: 'SKU-003', title: catalog.byId('SKU-003').title, field: 'stock', fieldTitle: 'остаток', from: was, to: was + 10 }]);
  assert.deepEqual(preview.body.updated[0].changes.map(c => c.field), ['price'], 'остаток не смешан с описанием');
  assert.equal(stock.level('SKU-003').stock, was, 'предпросмотр склад не трогает');
  const done = await call('POST', '/api/catalog/import', { body: file, type: 'text/csv', tk: token });
  assert.equal(done.body.summary.stock, 1);
  assert.equal(stock.level('SKU-003').stock, was + 10);
  const e = moves('SKU-003')[0];
  assert.deepEqual([e.reason, e.delta, e.before, e.after, e.by], ['import', 10, was, was + 10, SELLER]);
});

test('журнал: заказ, отмена и правка — три записи с причинами, у правки продавец из токена', async () => {
  const id = 'SKU-004';
  const o = await call('POST', '/api/orders', { body: { items: [{ id, qty: 2 }], channel: 'SITE', customer: { name: 'Покупатель' } } });
  assert.equal(o.status, 201);
  await call('POST', '/api/orders/status', { body: { id: o.body.id, status: 'CANCELLED' }, tk: token });
  const adj = await call('POST', '/api/stock/adjust', { body: { id, delta: -1, reason: 'бой при упаковке', by: 'чужое-имя' }, tk: token });
  assert.equal(adj.status, 200);
  const log = await call('GET', '/api/stock/log?id=' + id, { tk: token });
  const entries = log.body.entries.filter(e => e.reason !== 'seed');
  assert.deepEqual(entries.map(e => [e.reason, e.delta]), [['manual', -1], ['cancel', 2], ['order', -2]]);
  assert.equal(entries[0].by, SELLER, 'правка — от продавца из токена, не из тела');
  assert.equal(entries[0].note, 'бой при упаковке');
  assert.equal(entries[1].by, SELLER, 'отмену тоже сделал продавец');
  assert.deepEqual([entries[1].ref, entries[2].ref], [o.body.id, o.body.id], 'движения привязаны к заказу');
  assert.equal((await call('GET', '/api/stock/log')).status, 401, 'журнал закрыт входом');
});

test('правка без причины отбивается', async () => {
  const id = 'SKU-005';
  const was = stock.level(id).stock, logs = stock.log().length;
  for (const reason of [undefined, '', '   ']) {
    const r = await call('POST', '/api/stock/adjust', { body: { id, value: 99, reason }, tk: token });
    assert.deepEqual([r.status, r.body.error], [400, 'REASON_REQUIRED']);
  }
  assert.equal((await call('POST', '/api/stock/adjust', { body: { id, value: 99, reason: 'пересчёт' } })).status, 401, 'без входа — 401');
  const both = await call('POST', '/api/stock/adjust', { body: { id, value: 5, delta: 1, reason: 'пересчёт' }, tk: token });
  assert.deepEqual([both.status, both.body.error], [400, 'VALUE_OR_DELTA']);
  assert.equal(stock.level(id).stock, was);
  assert.equal(stock.log().length, logs, 'в журнал ничего не попало');
  const ok = await call('POST', '/api/stock/adjust', { body: { id, value: 11, reason: 'пересчёт склада' }, tk: token });
  assert.deepEqual([ok.status, ok.body.after, stock.level(id).stock], [200, 11, 11]);
});
