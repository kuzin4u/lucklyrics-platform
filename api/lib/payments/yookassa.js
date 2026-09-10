'use strict';
/**
 * Адаптер провайдера. Без боевых ключей работает в режиме сухого прогона:
 * возвращает предсказуемые ответы и пишет намерение в журнал.
 * Ключи берутся только из окружения и в браузер не попадают.
 */
const SHOP_ID = process.env.PAYMENT_SHOP_ID;
const SECRET  = process.env.PAYMENT_SECRET_KEY;
const live = () => Boolean(SHOP_ID && SECRET);
const log = (op, data) => console.log('[payments:' + (live() ? 'live' : 'dry') + '] ' + op, JSON.stringify(data));
const id = p => p + '-' + Math.random().toString(16).slice(2, 10);

async function create(order) {
  log('create', { orderId: order && order.id, amount: order && order.total });
  if (!live()) return { paymentId: id('PAY'), url: null, status: 'pending', dryRun: true };
  throw new Error('NOT_IMPLEMENTED: боевой вызов подключается на этапе платежей');
}
async function confirm(paymentId) {
  log('confirm', { paymentId });
  if (!live()) return { paymentId, status: 'succeeded', paid: true, dryRun: true };
  throw new Error('NOT_IMPLEMENTED');
}
async function refund(paymentId, opts) {
  opts = opts || {};
  log('refund', { paymentId, amount: opts.amount, reason: opts.reason });
  if (!live()) return { refundId: id('REF'), status: 'succeeded', amount: opts.amount, dryRun: true };
  throw new Error('NOT_IMPLEMENTED');
}
async function status(paymentId) {
  log('status', { paymentId });
  if (!live()) return { paymentId, status: 'pending', paid: false, dryRun: true };
  throw new Error('NOT_IMPLEMENTED');
}
module.exports = { name: 'yookassa', live, create, confirm, refund, status };
