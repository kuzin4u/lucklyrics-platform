'use strict';
/**
 * Расчёты через внешнюю систему (эскроу и клиринг). В периметр первой волны
 * не входят. Заглушка существует не «на будущее», а как доказательство того,
 * что абстракция не дырявая: реализует тот же интерфейс из четырёх операций.
 */
const notConnected = op => {
  const e = new Error('SETTLEMENT_SYSTEM_NOT_CONNECTED');
  e.code = 'SETTLEMENT_SYSTEM_NOT_CONNECTED';
  e.operation = op;
  return e;
};
module.exports = {
  name: 'system',
  live: () => false,
  async create()  { throw notConnected('create'); },
  async confirm() { throw notConnected('confirm'); },
  async refund()  { throw notConnected('refund'); },
  async status()  { throw notConnected('status'); }
};
