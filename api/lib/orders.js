'use strict';
/**
 * Заказы. Создание, статусы, отмена.
 *
 * Сумма считается сервером через catalog.quote — витрине не доверяем.
 * Остаток списывается через stock.js, платёж создаётся через адаптер.
 * Данные — через store.js: где они лежат, модуль не знает.
 */
const store = require('./store');
const catalog = require('./catalog');
const stock = require('./stock');
const config = require('./config');
const payments = require('./payments');

const FLOW = { NEW: 'PACKING', PACKING: 'SHIPPED', SHIPPED: 'DONE', DONE: null, CANCELLED: null };
const TITLES = { NEW: 'Новый', PACKING: 'Собирается', SHIPPED: 'Доставляется', DONE: 'Доставлен', CANCELLED: 'Отменён' };

const NAME = 'orders';
const genId = () => 'ORD-' + Date.now().toString(36).toUpperCase().slice(-5) +
  Math.random().toString(36).slice(2, 5).toUpperCase();

/**
 * Создание заказа. channel определяет, кто считает сумму и чей остаток списывается.
 */
async function create({ items, customer, channel, settlement, agent }) {
  const ch = config.channel(channel || 'SITE');
  if (!customer || !(customer.name || customer.phone)) {
    const e = new Error('CUSTOMER_REQUIRED'); e.code = 'CUSTOMER_REQUIRED'; throw e;
  }
  const q = catalog.quote(items, ch.code);
  if (!q.lines.length) { const e = new Error('EMPTY_CART'); e.code = 'EMPTY_CART'; throw e; }

  const id = genId();
  // остаток списывается только если канал работает с нашим складом; атомарно, все или ничего
  let reserved = [];
  if (ch.ownStock) {
    const lines = catalog.expand(q.lines);
    const moved = await stock.reserveMany(lines, ch.code, { ref: id });
    reserved = moved.map(m => ({ id: m.id, title: lines.find(l => l.id === m.id).title, qty: m.qty }));
  }

  // два представления: строки как видел покупатель (набор — одной строкой) и что ушло со склада
  const order = {
    id, at: new Date().toISOString(), channel: ch.code, channelTitle: ch.title,
    settlement: settlement || config.get('payments.settlementDefault', 'DIRECT'),
    customer: { name: customer.name || '', phone: customer.phone || '', address: customer.address || '' },
    items: q.lines, qty: q.qty, goods: q.goods, discountPct: q.discountPct, discount: q.discount,
    total: q.total, status: 'NEW', statusTitle: TITLES.NEW, payment: null, reserved
  };
  if (agent && agent.dialogId) order.agent = { dialogId: agent.dialogId };   // заказ с участием помощника

  try {
    order.payment = await payments.adapterFor(order).create(order);
  } catch (e) {
    order.payment = { error: e.code || e.message };
  }

  await store.update(NAME, list => [order].concat(list || []));
  return order;
}

/**
 * Заказ площадки. Сумму посчитала она: наш расчёт и скидки не применяются.
 * Идемпотентность по номеру отправления: повторная доставка не записывается,
 * возвращается уже записанный заказ. → { order, created }
 */
async function addExternal(draft) {
  let result;
  await store.update(NAME, list => {
    list = list || [];
    const same = list.find(o => o.external && o.external.source === draft.external.source && o.external.postingNumber === draft.external.postingNumber);
    if (same) { result = { order: same, created: false }; return list; }
    const order = Object.assign({ id: genId(), at: new Date().toISOString() }, draft, { statusTitle: TITLES[draft.status] });
    result = { order, created: true };
    return [order].concat(list);
  });
  return result;
}
const byExternal = async (source, postingNumber) =>
  (await allOrders()).find(o => o.external && o.external.source === source && o.external.postingNumber === postingNumber) || null;

const allOrders = async () => (await store.read(NAME)) || [];
const byId = async id => (await allOrders()).find(o => o.id === id) || null;

/** Следующий статус по потоку. Возврат остатка при отмене. by — кто перевёл, из токена. */
async function advance(id, to, by) {
  let changed, giveBack = null;
  await store.update(NAME, list => {
    const o = (list || []).find(x => x.id === id);
    if (!o) { const e = new Error('ORDER_NOT_FOUND'); e.code = 'ORDER_NOT_FOUND'; throw e; }
    const next = to || FLOW[o.status];
    if (!next || !(next in TITLES)) { const e = new Error('BAD_STATUS'); e.code = 'BAD_STATUS'; throw e; }
    if (next === 'CANCELLED' && o.status !== 'CANCELLED' && config.channel(o.channel).ownStock) {
      // возвращается ровно списанное, а не состав набора на сегодня; у старых заказов — строки
      giveBack = o.reserved || o.items.map(l => ({ id: l.id, qty: l.qty }));
    }
    o.status = next; o.statusTitle = TITLES[next];
    o.history = (o.history || []).concat({ at: new Date().toISOString(), status: next, by: by || null });
    changed = o;
    return list;
  });
  // остаток возвращается после записи статуса: сбой не вернёт товар дважды
  if (giveBack) await stock.releaseMany(giveBack, { ref: id, by });
  return changed;
}

/** Сводка для кабинета: считается здесь, чтобы витрина и кабинет не расходились. */
function stats(list) {
  const all = list || [];
  const os = all.filter(o => o.status !== 'CANCELLED');
  const revenue = os.reduce((s, o) => s + o.total, 0);
  const byChannel = {};
  for (const o of os) byChannel[o.channelTitle || o.channel] = (byChannel[o.channelTitle || o.channel] || 0) + 1;
  const byStatus = {};
  for (const o of all) byStatus[o.status] = (byStatus[o.status] || 0) + 1;
  return {
    orders: os.length, revenue,
    avgCheck: os.length ? Math.round(revenue / os.length) : 0,
    items: os.reduce((s, o) => s + o.qty, 0),
    problems: all.filter(o => o.problems && o.problems.length && o.status !== 'CANCELLED').length,
    byChannel, byStatus
  };
}

const reset = () => store.write(NAME, []);

module.exports = { create, addExternal, byExternal, newId: genId, allOrders, byId, advance, stats, reset, FLOW, TITLES };
