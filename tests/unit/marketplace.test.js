'use strict';
const test = require('node:test');
const assert = require('node:assert');
const mp = require('../../api/lib/marketplace/client');

test('без ключа клиент в сухом прогоне: запрос не уходит, намерение записано', async () => {
  mp.clearJournal();
  assert.equal(mp.isDry(), true, 'без ключей боевой режим недопустим');
  const res = await mp.pushPrices([{ offer_id: 'SKU-1', price: '355' }]);
  assert.equal(res.dryRun, true);
  assert.equal(mp.journal.length, 1);
  assert.equal(mp.journal[0].endpoint, '/v1/product/import/prices');
});

test('остатки уходят тем же путём и тоже фиксируются', async () => {
  mp.clearJournal();
  await mp.pushStocks([{ offer_id: 'SKU-1', stock: 7 }]);
  await mp.unfulfilled(10);
  assert.equal(mp.journal.length, 2);
  assert.deepEqual(mp.journal.map(e => e.endpoint),
    ['/v2/products/stocks', '/v3/posting/fbs/unfulfilled/list']);
});
