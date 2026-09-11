'use strict';
const test = require('node:test');
const assert = require('node:assert');
const catalog = require('../../api/lib/catalog');

test('каталог читается и содержит позиции с категориями', () => {
  assert.ok(catalog.all().length >= 3);
  assert.ok(catalog.categories().length >= 2);
  assert.ok(catalog.byId(catalog.all()[0].id));
  assert.equal(catalog.byId('НЕТ-ТАКОГО'), null);
});

test('витрина и площадка видят разный доступный остаток', () => {
  const site = catalog.forChannel('SITE');
  const mp = catalog.forChannel('MARKETPLACE');
  const bySite = Object.fromEntries(site.map(p => [p.id, p.available]));
  const byMp = Object.fromEntries(mp.map(p => [p.id, p.available]));
  const fbs = catalog.all().find(p => p.fulfillment === 'FBS' && p.stock > 0);
  assert.ok(bySite[fbs.id] > byMp[fbs.id], 'на площадку уходит остаток минус буфер');
  const fbo = catalog.all().find(p => p.fulfillment === 'FBO');
  if (fbo) assert.equal(bySite[fbo.id], 0, 'товар со склада площадки на витрине не продаётся');
});

test('скидка растёт по ступеням из конфигурации', () => {
  assert.equal(catalog.discountPct(1), 0);
  assert.ok(catalog.discountPct(6) >= catalog.discountPct(3));
  assert.ok(catalog.discountPct(10) >= catalog.discountPct(6));
});

test('расчёт корзины: сумма, скидка, итог сходятся', () => {
  const p = catalog.all().find(x => x.fulfillment !== 'FBO' && x.stock >= 6);
  const q = catalog.quote([{ id: p.id, qty: 6 }], 'SITE');
  assert.equal(q.qty, 6);
  assert.equal(q.goods, p.price * 6);
  assert.equal(q.discount, Math.round(q.goods * q.discountPct / 100));
  assert.equal(q.total, q.goods - q.discount, 'итог равен сумме минус скидка');
});

test('неизвестная позиция и нехватка остатка отбиваются с кодом', () => {
  assert.throws(() => catalog.quote([{ id: 'НЕТ', qty: 1 }], 'SITE'), e => e.code === 'UNKNOWN_SKU');
  const p = catalog.all().find(x => x.fulfillment !== 'FBO');
  assert.throws(() => catalog.quote([{ id: p.id, qty: 9999 }], 'SITE'), e => {
    assert.equal(e.code, 'NOT_ENOUGH_STOCK');
    assert.equal(typeof e.available, 'number');
    return true;
  });
});
