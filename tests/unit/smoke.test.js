'use strict';
/**
 * Приёмка контура (npm run smoke): проходит на исправном контуре, ловит
 * открытый кабинет и несписанный остаток, ничего не оставляет после себя.
 */
const test = require('node:test');
const assert = require('node:assert');

process.env.STORE_PROVIDER = 'memory';
process.env.JWT_SECRET = 'smoke-test-secret-0123456789-abcdefghijk';
const { server, routes, orders, stock, catalog, auth, sync, config } = require('../../api/server');
const { run } = require('../../api/scripts/smoke');

const CREDS = { login: 'smoke-check', password: 'пароль-проверки-1' };
let base;
const failed = res => res.steps.flatMap(s => s.checks.filter(c => c.status === 'fail').map(c => s.title + ': ' + c.text));
const levels = () => Object.fromEntries(catalog.all().map(p => [p.id, stock.level(p.id).stock]));
function patch(obj, key, value) { const saved = obj[key]; obj[key] = value; return () => { obj[key] = saved; }; }

test.before(async () => {
  await orders.reset(); catalog.reset(); await stock.reset();
  await auth.register(CREDS.login, CREDS.password);
  config.load().marketplace.syncWindowMs = 50;   // как на сервере: синхронизация слушает движения
  sync.start();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + server.address().port;
});
test.after(() => { server.close(); sync.stop(); });

test('исправный контур: приёмка проходит целиком, заказ отменён, остаток на месте', async () => {
  const before = levels();
  const res = await run(base, CREDS);
  assert.deepEqual(failed(res), []);
  assert.equal(res.ok, true);
  assert.deepEqual(res.steps.map(s => s.title.replace(/^\d\. /, '')), ['Живость и режимы', 'Витрина открыта покупателю',
    'Кабинет закрыт без входа', 'Вход в кабинет', 'Сделка: каталог → корзина → заказ', 'Списание остатка',
    'Кабинет: заказ и смена статуса', 'Отмена и возврат остатка', 'Синхронизация с площадкой']);
  const o = await orders.byId(res.order);
  assert.equal(o.status, 'CANCELLED', 'тестовый заказ отменён');
  assert.match(o.customer.name, /SMOKE/, 'помечен как тестовый');
  assert.deepEqual(levels(), before, 'остаток как был');
});

test('без учётных данных — провал и ни одного созданного заказа', async () => {
  const count = (await orders.allOrders()).length;
  const res = await run(base, {});
  assert.equal(res.ok, false);
  assert.match(failed(res).join('\n'), /нет учётных данных/);
  assert.equal((await orders.allOrders()).length, count, 'заказ не создавался');
  const wrong = await run(base, { login: CREDS.login, password: 'не-тот' });
  assert.match(failed(wrong).join('\n'), /вход «smoke-check» → 401/);
  assert.equal((await orders.allOrders()).length, count);
});

test('открытый кабинет ловится', async () => {
  const restore = patch(routes, 'GET /api/orders', (req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"orders":[]}'); });
  try {
    const res = await run(base, CREDS);
    assert.match(failed(res).join('\n'), /GET \/api\/orders → 200 — ОТКРЫТО БЕЗ ВХОДА/);
  } finally { restore(); }
});

test('несписанный остаток ловится', async () => {
  const restore = patch(stock, 'reserveMany', async () => []);
  try {
    const res = await run(base, CREDS);
    assert.match(failed(res).join('\n'), /Списание остатка: остаток .*стало (\d+) \(ожидается/);
    assert.equal((await orders.byId(res.order)).status, 'CANCELLED', 'и в этом случае заказ отменён');
  } finally { restore(); }
});

test('сбой посреди сценария: тестовый заказ всё равно отменяется', async () => {
  const original = routes['GET /api/product'];
  let calls = 0;
  const restore = patch(routes, 'GET /api/product', (req, res, q) => {
    // первые обращения — витрина и выбор позиции; после заказа связь рвётся
    if (++calls > 2) return res.destroy();
    return original(req, res, q);
  });
  try {
    const res = await run(base, CREDS);
    assert.equal(res.ok, false);
    assert.ok(res.order, 'заказ успел создаться');
    const cleanup = res.steps.find(s => s.title === 'Уборка');
    assert.ok(cleanup, 'шаг уборки выполнен');
    assert.equal((await orders.byId(res.order)).status, 'CANCELLED');
  } finally { restore(); }
});
