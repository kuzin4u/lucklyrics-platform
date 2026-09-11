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
async function create({ items, customer, channel, settlement }) {
  const ch = config.channel(channel || 'SITE');
  if (!customer || !(customer.name || customer.phone)) {
    const e = new Error('CUSTOMER_REQUIRED'); e.code = 'CUSTOMER_REQUIRED'; throw e;
  }
  const q = catalog.quote(items, ch.code);
  if (!q.lines.length) { const e = new Error('EMPTY_CART'); e.code = 'EMPTY_CART'; throw e; }

  // остаток списывается только если канал работает с нашим складом
  if (ch.ownStock) for (const l of q.lines) stock.reserve(catalog.byId(l.id), ch.code, l.qty);

  const order = {
    id: genId(), at: new Date().toISOString(), channel: ch.code, channelTitle: ch.title,
    settlement: settlement || config.get('payments.settlementDefault', 'DIRECT'),
    customer: { name: customer.name || '', phone: customer.phone || '', address: customer.address || '' },
    items: q.lines, qty: q.qty, goods: q.goods, discountPct: q.discountPct, discount: q.discount,
    total: q.total, status: 'NEW', statusTitle: TITLES.NEW, payment: null
  };

  try {
    order.payment = await payments.adapterFor(order).create(order);
  } catch (e) {
    order.payment = { error: e.code || e.message };
  }

  await store.update(NAME, list => [order].concat(list || []));
  return order;
}

const allOrders = async () => (await store.read(NAME)) || [];
const byId = async id => (await allOrders()).find(o => o.id === id) || null;

/** Следующий статус по потоку. Возврат остатка при отмене. by — кто перевёл, из токена. */
async function advance(id, to, by) {
  let changed;
  await store.update(NAME, list => {
    const o = (list || []).find(x => x.id === id);
    if (!o) { const e = new Error('ORDER_NOT_FOUND'); e.code = 'ORDER_NOT_FOUND'; throw e; }
    const next = to || FLOW[o.status];
    if (!next || !(next in TITLES)) { const e = new Error('BAD_STATUS'); e.code = 'BAD_STATUS'; throw e; }
    if (next === 'CANCELLED' && o.status !== 'CANCELLED') {
      const ch = config.channel(o.channel);
      if (ch.ownStock) for (const l of o.items) stock.release(catalog.byId(l.id), l.qty);
    }
    o.status = next; o.statusTitle = TITLES[next];
    o.history = (o.history || []).concat({ at: new Date().toISOString(), status: next, by: by || null });
    changed = o;
    return list;
  });
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
    byChannel, byStatus
  };
}

const reset = () => store.write(NAME, []);

module.exports = { create, allOrders, byId, advance, stats, reset, FLOW, TITLES };
