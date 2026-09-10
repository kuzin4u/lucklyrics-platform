'use strict';
const test = require('node:test');
const assert = require('node:assert');
const payments = require('../../api/lib/payments');

test('каждый адаптер реализует все четыре операции', () => {
  for (const [name, a] of Object.entries(payments._adapters)) {
    payments.OPERATIONS.forEach(op =>
      assert.equal(typeof a[op], 'function', 'адаптер ' + name + ' без операции ' + op));
  }
});

test('способ расчёта у заказа выбирает адаптер', () => {
  assert.equal(payments.adapterFor({ settlement: 'DIRECT' }).name, 'yookassa');
  assert.equal(payments.adapterFor({ settlement: 'SYSTEM' }).name, 'system');
});

test('без ключей провайдер работает в сухом прогоне и возвращает предсказуемый ответ', async () => {
  const a = payments.adapterFor({ settlement: 'DIRECT' });
  const pay = await a.create({ id: 'ORD-1', total: 1500 });
  assert.ok(pay.paymentId);
  assert.equal(pay.dryRun, true);
  const ref = await a.refund(pay.paymentId, { amount: 1500, reason: 'тест' });
  assert.equal(ref.status, 'succeeded');
});

test('внешняя система расчётов отвечает понятной ошибкой, а не тишиной', async () => {
  const a = payments.adapterFor({ settlement: 'SYSTEM' });
  await assert.rejects(() => a.create({ id: 'ORD-2' }), err => {
    assert.equal(err.code, 'SETTLEMENT_SYSTEM_NOT_CONNECTED');
    return true;
  });
});
