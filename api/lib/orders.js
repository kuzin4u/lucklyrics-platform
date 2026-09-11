'use strict';
/**
 * Заказы. Создание, статусы, отмена.
 *
 * Сумма считается сервером через catalog.quote — витрине не доверяем.
 * Остаток списывается через stock.js, платёж создаётся через адаптер.
 * Хранилище файловое: на площадке размещения диск эфемерный, поэтому на этапе
 * данных заменяется постоянным. Интерфейс модуля при этом не меняется.
 */
const fs = require('fs');
const path = require('path');
const catalog = require('./catalog');
const stock = require('./stock');
const config = require('./config');
const payments = require('./payments');

const ROOT = path.resolve(__dirname, '..', '..');
const FILE = process.env.ORDERS_FILE
  ? path.resolve(ROOT, process.env.ORDERS_FILE)
  : path.join(ROOT, 'data', 'orders.json');

const FLOW = { NEW: 'PACKING', PACKING: 'SHIPPED', SHIPPED: 'DONE', DONE: null, CANCELLED: null };
const TITLES = { NEW: 'Новый', PACKING: 'Собирается', SHIPPED: 'Доставляется', DONE: 'Доставлен', CANCELLED: 'Отменён' };

let list = null;

function load() {
  if (list) return list;
  try { list = JSON.parse(fs.readFileSync(FILE, 'utf8')); }
  catch { list = []; }
  return list;
}
function save() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(list, null, 2));
  } catch (e) { console.warn('[orders] не сохранено:', e.message); }
}
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

  load().unshift(order); save();
  return order;
}

const allOrders = () => load();
const byId = id => load().find(o => o.id === id) || null;

/** Следующий статус по потоку. Возврат остатка при отмене. */
function advance(id, to) {
  const o = byId(id);
  if (!o) { const e = new Error('ORDER_NOT_FOUND'); e.code = 'ORDER_NOT_FOUND'; throw e; }
  const next = to || FLOW[o.status];
  if (!next || !(next in TITLES)) { const e = new Error('BAD_STATUS'); e.code = 'BAD_STATUS'; throw e; }
  if (next === 'CANCELLED' && o.status !== 'CANCELLED') {
    const ch = config.channel(o.channel);
    if (ch.ownStock) for (const l of o.items) stock.release(catalog.byId(l.id), l.qty);
  }
  o.status = next; o.statusTitle = TITLES[next]; save();
  return o;
}

/** Сводка для кабинета: считается здесь, чтобы витрина и кабинет не расходились. */
function stats() {
  const os = load().filter(o => o.status !== 'CANCELLED');
  const revenue = os.reduce((s, o) => s + o.total, 0);
  const byChannel = {};
  for (const o of os) byChannel[o.channelTitle || o.channel] = (byChannel[o.channelTitle || o.channel] || 0) + 1;
  const byStatus = {};
  for (const o of load()) byStatus[o.status] = (byStatus[o.status] || 0) + 1;
  return {
    orders: os.length, revenue,
    avgCheck: os.length ? Math.round(revenue / os.length) : 0,
    items: os.reduce((s, o) => s + o.qty, 0),
    byChannel, byStatus
  };
}

function reset() { list = []; save(); }

module.exports = { create, allOrders, byId, advance, stats, reset, FLOW, TITLES };
