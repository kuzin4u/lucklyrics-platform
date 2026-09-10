'use strict';
/**
 * Платёжный слой. Единственная точка выбора провайдера.
 *
 * Любой адаптер реализует четыре операции:
 *   create(order)                       -> {paymentId, url, status}
 *   confirm(paymentId)                  -> {paymentId, status, paid}
 *   refund(paymentId, {amount, reason}) -> {refundId, status, amount}
 *   status(paymentId)                   -> {paymentId, status, paid}
 *
 * Витрина, корзина и кабинет провайдера НЕ знают: они работают с интерфейсом.
 * Способ расчёта — поле у заказа (settlement: DIRECT | SYSTEM).
 */
const config = require('../config');

const OPERATIONS = ['create', 'confirm', 'refund', 'status'];

const adapters = {
  yookassa: require('./yookassa'),
  system:   require('./system')
};

/** Проверка полноты адаптера: даже заглушка обязана реализовать все операции. */
function assertAdapter(a, name) {
  const missing = OPERATIONS.filter(op => typeof a[op] !== 'function');
  if (missing.length) throw new Error('адаптер ' + name + ': не реализованы ' + missing.join(', '));
  return a;
}

function adapterFor(order) {
  order = order || {};
  const settlement = order.settlement || config.get('payments.settlementDefault', 'DIRECT');
  if (settlement === 'SYSTEM') return assertAdapter(adapters.system, 'system');
  const name = config.get('payments.provider', 'yookassa');
  const a = adapters[name];
  if (!a) throw new Error('неизвестный платёжный провайдер: ' + name);
  return assertAdapter(a, name);
}

module.exports = { adapterFor, OPERATIONS, _adapters: adapters };
