'use strict';
const test = require('node:test');
const assert = require('node:assert');
const stock = require('../../api/lib/stock');

const sku = (over) => Object.assign({ id: 'SKU-1', stock: 10, fulfillment: 'FBS' }, over || {});

test('буфер: площадка видит остаток минус страховой запас, свои каналы — весь', () => {
  const s = sku();
  assert.equal(stock.availableStock(s, 'SITE'), 10);
  assert.equal(stock.availableStock(s, 'MARKETPLACE'), 10 - stock.bufferFor(s));
});

test('остаток никогда не отрицательный', () => {
  const s = sku({ stock: 1 });
  assert.ok(stock.availableStock(s, 'MARKETPLACE') >= 0);
  const z = sku({ stock: 0 });
  assert.equal(stock.availableStock(z, 'SITE'), 0);
});

test('товар на складе площадки: наш остаток не участвует', () => {
  const s = sku({ fulfillment: 'FBO', stock: 10, marketplaceStock: 4 });
  assert.equal(stock.availableStock(s, 'SITE'), 0, 'FBO не продаётся с витрины по умолчанию');
  assert.equal(stock.availableStock(s, 'MARKETPLACE'), 4);
});

test('списание уменьшает остаток ровно на количество и не уходит в минус', () => {
  const s = sku({ stock: 5 });
  stock.reserve(s, 'SITE', 2);
  assert.equal(s.stock, 3);
  assert.throws(() => stock.reserve(s, 'SITE', 99), /NOT_ENOUGH_STOCK/);
  assert.equal(s.stock, 3, 'неудачное списание не меняет остаток');
});

test('возврат восстанавливает остаток', () => {
  const s = sku({ stock: 5 });
  stock.reserve(s, 'SITE', 3);
  stock.release(s, 3);
  assert.equal(s.stock, 5);
});

test('инвариант: сумма продаж по каналам не превышает физический остаток', () => {
  const s = sku({ stock: 4 });
  let sold = 0;
  for (const ch of ['SITE', 'MARKETPLACE', 'AGENT']) {
    while (stock.canSell(s, ch, 1)) { stock.reserve(s, ch, 1); sold++; }
  }
  assert.equal(sold, 4, 'продано ровно столько, сколько было');
  assert.equal(s.stock, 0);
});
