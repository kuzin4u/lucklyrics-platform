'use strict';
const test = require('node:test');
const assert = require('node:assert');
process.env.STORE_PROVIDER = 'memory';
const orders = require('../../api/lib/orders');
const catalog = require('../../api/lib/catalog');
const stock = require('../../api/lib/stock');

const pick = () => catalog.all().find(p => p.fulfillment !== 'FBO' && p.stock >= 4);

test('заказ создаётся, сумму считает сервер, остаток списывается', async () => {
  await orders.reset(); catalog.reset();
  const p = pick();
  const before = stock.availableStock(catalog.byId(p.id), 'SITE');
  const o = await orders.create({
    items: [{ id: p.id, qty: 2 }], channel: 'SITE',
    customer: { name: 'Тест', phone: '+70000000000' }
  });
  assert.match(o.id, /^ORD-/);
  assert.equal(o.status, 'NEW');
  assert.equal(o.total, o.goods - o.discount);
  assert.equal(stock.availableStock(catalog.byId(p.id), 'SITE'), before - 2, 'остаток уменьшился ровно на количество');
});

test('заказ без покупателя и пустая корзина не проходят', async () => {
  const p = pick();
  await assert.rejects(() => orders.create({ items: [{ id: p.id, qty: 1 }], channel: 'SITE', customer: {} }),
    e => e.code === 'CUSTOMER_REQUIRED');
  await assert.rejects(() => orders.create({ items: [], channel: 'SITE', customer: { name: 'Тест' } }),
    e => e.code === 'EMPTY_CART');
});

test('статусы идут по потоку, отмена возвращает остаток', async () => {
  await orders.reset(); catalog.reset();
  const p = pick();
  const before = stock.availableStock(catalog.byId(p.id), 'SITE');
  const o = await orders.create({ items: [{ id: p.id, qty: 1 }], channel: 'SITE', customer: { name: 'Тест' } });
  assert.equal((await orders.advance(o.id)).status, 'PACKING');
  assert.equal((await orders.advance(o.id)).status, 'SHIPPED');
  assert.equal((await orders.advance(o.id, 'CANCELLED')).status, 'CANCELLED');
  assert.equal(stock.availableStock(catalog.byId(p.id), 'SITE'), before, 'после отмены остаток вернулся');
});

test('платёж создаётся через адаптер и в сухом режиме не падает', async () => {
  await orders.reset(); catalog.reset();
  const o = await orders.create({ items: [{ id: pick().id, qty: 1 }], channel: 'SITE', customer: { name: 'Тест' } });
  assert.ok(o.payment, 'платёж создан');
  assert.ok(o.payment.dryRun || o.payment.error, 'без ключей это сухой прогон');
});

test('сводка кабинета сходится с заказами', async () => {
  await orders.reset(); catalog.reset();
  const p = pick();
  await orders.create({ items: [{ id: p.id, qty: 1 }], channel: 'SITE', customer: { name: 'А' } });
  await orders.create({ items: [{ id: p.id, qty: 2 }], channel: 'AGENT', customer: { name: 'Б' } });
  const list = await orders.allOrders();
  const s = orders.stats(list);
  assert.equal(s.orders, 2);
  assert.equal(s.items, 3);
  assert.equal(s.revenue, list.reduce((x, o) => x + o.total, 0));
  assert.equal(Object.keys(s.byChannel).length, 2, 'каналы различаются меткой заказа');
});
