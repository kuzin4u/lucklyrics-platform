'use strict';
const test = require('node:test');
const assert = require('node:assert');
process.env.STORE_PROVIDER = 'memory';
const stock = require('../../api/lib/stock');
const catalog = require('../../api/lib/catalog');
const config = require('../../api/lib/config');

const item = () => catalog.all().find(p => p.kind !== 'bundle' && p.fulfillment !== 'FBO');
async function withLevel(n) { await stock.reset(); catalog.reset(); const s = item(); await stock.setMany([{ id: s.id, field: 'stock', value: n }], { reason: 'manual', note: 'тест' }); return s; }

test('буфер: площадка видит остаток минус страховой запас, свои каналы — весь', async () => {
  const s = await withLevel(10);
  assert.equal(stock.availableStock(s, 'SITE'), 10);
  assert.equal(stock.availableStock(s, 'MARKETPLACE'), 10 - stock.bufferFor(s));
});

test('остаток никогда не отрицательный', async () => {
  const s = await withLevel(1);
  assert.ok(stock.availableStock(s, 'MARKETPLACE') >= 0);
  await withLevel(0);
  assert.equal(stock.availableStock(s, 'SITE'), 0);
  await assert.rejects(() => stock.adjust({ id: s.id, delta: -1, reason: 'пересчёт' }), e => e.code === 'NEGATIVE_STOCK');
});

test('товар на складе площадки: наш остаток не участвует', async () => {
  await stock.reset();
  const fbo = catalog.all().find(p => p.fulfillment === 'FBO');
  await stock.setMany([{ id: fbo.id, field: 'stock', value: 10 }, { id: fbo.id, field: 'marketplaceStock', value: 4 }], { reason: 'manual' });
  assert.equal(stock.availableStock(fbo, 'SITE'), 0, 'FBO не продаётся с витрины');
  assert.equal(stock.availableStock(fbo, 'MARKETPLACE'), 4);
});

test('списание уменьшает остаток ровно на количество и не уходит в минус', async () => {
  const s = await withLevel(5);
  await stock.reserveMany([{ id: s.id, qty: 2 }], 'SITE');
  assert.equal(stock.level(s.id).stock, 3);
  await assert.rejects(() => stock.reserveMany([{ id: s.id, qty: 99 }], 'SITE'), e => e.code === 'NOT_ENOUGH_STOCK' && e.available === 3);
  assert.equal(stock.level(s.id).stock, 3, 'неудачное списание не меняет остаток');
});

test('возврат восстанавливает остаток', async () => {
  const s = await withLevel(5);
  const moved = await stock.reserveMany([{ id: s.id, qty: 3 }], 'SITE');
  await stock.releaseMany(moved);
  assert.equal(stock.level(s.id).stock, 5);
});

test('инвариант: сумма продаж по каналам не превышает физический остаток', async () => {
  const s = await withLevel(4);
  let sold = 0;
  for (const ch of ['SITE', 'MARKETPLACE', 'AGENT']) {
    while (stock.canSell(s, ch, 1)) { await stock.reserveMany([{ id: s.id, qty: 1 }], ch); sold++; }
  }
  assert.equal(sold, 4, 'продано ровно столько, сколько было');
  assert.equal(stock.level(s.id).stock, 0);
});

test('параллельные заказы на последние штуки: проходит ровно столько, сколько есть', async () => {
  const s = await withLevel(3);
  const results = await Promise.allSettled(Array.from({ length: 7 }, () => stock.reserveMany([{ id: s.id, qty: 1 }], 'SITE')));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 3);
  assert.equal(stock.level(s.id).stock, 0, 'в минус не ушли');
});

test('резолвер буфера: позиция побеждает конфиг, конфиг побеждает значение по умолчанию', () => {
  const cfg = config.load().stock;
  const saved = cfg.bufferBySku;
  try {
    cfg.bufferBySku = { 'R-1': 4 };
    assert.equal(stock.bufferFor({ id: 'R-1', buffer: 7 }), 7, 'значение у позиции');
    assert.equal(stock.bufferFor({ id: 'R-1', buffer: 0 }), 0, 'ноль у позиции — тоже значение, а не «не задано»');
    assert.equal(stock.bufferFor({ id: 'R-1' }), 4, 'переопределение в конфиге бренда');
    assert.equal(stock.bufferFor({ id: 'R-2' }), cfg.bufferDefault, 'значение по умолчанию');
    assert.equal(cfg.bufferDefault, 2);
  } finally { cfg.bufferBySku = saved; }
});
