'use strict';
/**
 * Остаток. Единственная точка чтения и изменения.
 *
 * Остаток — факт склада, каталог — описание товара: у них разная частота
 * изменений и разные источники правды. Поэтому остаток — своя запись в хранилище
 * (stock): уровни по позициям и журнал движений в одной записи, чтобы движение
 * и его запись в журнале не могли разойтись.
 *
 * Весь остальной код — витрина, кабинет, синхронизация с площадкой, оформление
 * заказа — спрашивает availableStock() и bufferFor() и НЕ смотрит на поля товара.
 *
 * Схемы (config.stock.scheme):
 *   buffer — на площадку отдаём остаток минус страховой запас (по умолчанию)
 *   shared — общий пул: все каналы видят весь остаток
 *   split  — раздельные квоты по каналам
 *
 * Режим исполнения (у SKU, поле fulfillment):
 *   FBS — товар на нашем складе, остаток наш
 *   FBO — товар на складе площадки, наш остаток не участвует
 *
 * Набор своего остатка не имеет: доступность — минимум по составу из доступности
 * компонентов, делённой на кратность. Буфер учтён внутри доступности компонентов,
 * набор про него не знает.
 *
 * Изменения — только через store.update: проверка и списание в одной операции,
 * два заказа на последнюю штуку не проходят оба.
 */
const config = require('./config');
const store = require('./store');
const catalog = () => require('./catalog');   // взаимная зависимость: каталог спрашивает доступность

const NAME = 'stock';
const FIELDS = ['stock', 'marketplaceStock'];
const REASONS = { seed: 'начальный остаток', order: 'заказ', cancel: 'отмена', import: 'импорт', manual: 'ручная правка' };

let mem = null;   // копия записи: { levels: { id: { stock, marketplaceStock } }, log: [...] }

const clampNonNegative = n => (n > 0 ? n : 0);
const has = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);
const isBundle = sku => !!sku && sku.kind === 'bundle';
function fail(code, extra) {
  const e = new Error(code); e.code = code;
  throw Object.assign(e, extra);
}

/** Начальный остаток — из стартового каталога, один раз, пока записи нет. */
function seed() {
  const at = new Date().toISOString();
  const levels = {}, log = [];
  for (const p of catalog().all()) {
    if (isBundle(p)) continue;
    const lv = { stock: Number(p.stock) || 0, marketplaceStock: Number(p.marketplaceStock) || 0 };
    levels[p.id] = lv;
    for (const f of FIELDS) if (lv[f]) log.push({ at, id: p.id, field: f, delta: lv[f], before: 0, after: lv[f], reason: 'seed', by: null });
  }
  return { levels, log };
}

const state = () => mem || (mem = seed());
const levelIn = (s, id) => Object.assign({ stock: 0, marketplaceStock: 0 }, s.levels[id]);

/** При старте: остаток из хранилища, а если его ещё нет — записать начальный. */
async function init() {
  mem = (await store.read(NAME)) || await store.update(NAME, cur => cur || seed());
  return mem;
}

/** Изменение остатка: fn меняет запись s и журнал, всё — одной операцией хранилища. */
async function change(fn) {
  let out;
  mem = await store.update(NAME, cur => { const s = cur || seed(); out = fn(s, new Date().toISOString()); return s; });
  return out;
}

/* ---------- чтение ---------- */

/** Страховой запас. Приоритет: позиция в каталоге → stock.bufferBySku → stock.bufferDefault. */
function bufferFor(sku) {
  if (has(sku, 'buffer') && sku.buffer !== null && sku.buffer !== '') return Number(sku.buffer) || 0;
  const bySku = config.get('stock.bufferBySku', {}) || {};
  if (has(bySku, sku.id)) return Number(bySku[sku.id]) || 0;
  return Number(config.get('stock.bufferDefault', 0)) || 0;
}

function fulfillmentOf(sku) {
  return sku.fulfillment || config.get('stock.fulfillmentDefault', 'FBS');
}

/** Доступность физической позиции при заданном уровне — без обращения к хранилищу. */
function availableFrom(sku, lv, channelCode) {
  const ch = config.channel(channelCode);
  const scheme = config.get('stock.scheme', 'buffer');

  // Товар на складе площадки: своим остатком не распоряжаемся.
  if (fulfillmentOf(sku) === 'FBO') return ch.code === 'MARKETPLACE' ? clampNonNegative(lv.marketplaceStock) : 0;

  if (!ch.ownStock) return 0;

  if (scheme === 'shared') return clampNonNegative(lv.stock);

  if (scheme === 'split') {
    const q = (sku.quotas || {})[ch.code];
    return clampNonNegative(q === undefined ? 0 : Number(q));
  }

  // buffer: страховой запас не уходит на площадку, свои каналы видят весь остаток
  if (ch.code === 'MARKETPLACE') return clampNonNegative(lv.stock - bufferFor(sku));
  return clampNonNegative(lv.stock);
}

/**
 * Доступный остаток в канале. Для набора — минимум по составу:
 * доступность компонента, делённая на кратность, с округлением вниз.
 * @param {{id:string, kind?:string, components?:{id:string, qty:number}[], fulfillment?:string}} sku
 * @param {string} channelCode SITE | MARKETPLACE | AGENT | BOT | VK
 */
function availableStock(sku, channelCode) {
  if (!isBundle(sku)) return availableFrom(sku, levelIn(state(), sku.id), channelCode);
  const comps = sku.components || [];
  if (!comps.length) return 0;
  return Math.min(...comps.map(c => {
    const p = catalog().byId(c.id);
    if (!p || isBundle(p)) return 0;                    // набор в наборе не считается
    return Math.floor(availableStock(p, channelCode) / c.qty);
  }));
}

/** Можно ли продать qty штук в этом канале. */
function canSell(sku, channelCode, qty) {
  return qty > 0 && availableStock(sku, channelCode) >= qty;
}

const level = id => levelIn(state(), id);

/** Журнал движений, новые сверху. */
function log({ id, limit } = {}) {
  const list = state().log.filter(e => !id || e.id === id);
  return list.slice(-(Number(limit) || 200)).reverse();
}

/* ---------- изменение ---------- */

function aggregate(lines) {
  const need = new Map();
  for (const l of lines || []) need.set(String(l.id), (need.get(String(l.id)) || 0) + (Number(l.qty) || 0));
  return need;
}

/**
 * Списание по заказу. Сначала проверяются все строки, потом списываются все:
 * если хоть одна не проходит — не списывается ничего.
 * lines — физические позиции (наборы уже раскрыты). Возвращает то, что ушло со склада.
 */
function reserveMany(lines, channelCode, { ref, by } = {}) {
  const need = aggregate(lines);
  return change((s, at) => {
    for (const [id, qty] of need) {
      const sku = catalog().byId(id);
      if (!sku) fail('UNKNOWN_SKU', { id });
      if (isBundle(sku)) fail('BUNDLE_NOT_EXPANDED', { id });
      const lv = levelIn(s, id);
      const available = availableFrom(sku, lv, channelCode);
      // квота split может превышать физический остаток — в минус не уходим и тогда
      const physical = fulfillmentOf(sku) === 'FBO' ? available : Math.min(available, lv.stock);
      if (!(qty > 0) || physical < qty) fail('NOT_ENOUGH_STOCK', { id, available: clampNonNegative(physical) });
    }
    const moved = [];
    for (const [id, qty] of need) {
      if (fulfillmentOf(catalog().byId(id)) === 'FBO') continue;   // склад площадки списывает площадка
      const lv = s.levels[id] = levelIn(s, id);
      const before = lv.stock;
      lv.stock = before - qty;
      s.log.push({ at, id, field: 'stock', delta: -qty, before, after: lv.stock, reason: 'order', ref, by: by || null, channel: channelCode });
      moved.push({ id, qty });
    }
    return moved;
  });
}

/** Возврат по отмене: всё, что было списано, одной операцией. */
function releaseMany(lines, { ref, by } = {}) {
  const back = aggregate(lines);
  return change((s, at) => {
    for (const [id, qty] of back) {
      if (!(qty > 0)) continue;
      const lv = s.levels[id] = levelIn(s, id);
      const before = lv.stock;
      lv.stock = before + qty;
      s.log.push({ at, id, field: 'stock', delta: qty, before, after: lv.stock, reason: 'cancel', ref, by: by || null });
    }
  });
}

/** Установка значений (импорт): [{id, field, value}]. В журнал — только то, что изменилось. */
function setMany(changes, { reason, by, note } = {}) {
  if (!has(REASONS, reason)) fail('BAD_REASON');
  return change((s, at) => {
    const done = [];
    for (const c of changes) {
      if (!FIELDS.includes(c.field) || !Number.isInteger(c.value) || c.value < 0) fail('BAD_VALUE', { id: c.id });
      const lv = s.levels[c.id] = levelIn(s, c.id);
      const before = lv[c.field];
      if (before === c.value) continue;
      lv[c.field] = c.value;
      const entry = { at, id: c.id, field: c.field, delta: c.value - before, before, after: c.value, reason, by: by || null };
      if (note) entry.note = note;
      s.log.push(entry); done.push(entry);
    }
    return done;
  });
}

/**
 * Ручная правка из кабинета: новое значение (value) или дельта (delta), причина
 * обязательна. by — продавец из токена.
 */
function adjust({ id, value, delta, reason, by }) {
  const note = typeof reason === 'string' ? reason.trim() : '';
  if (!note) fail('REASON_REQUIRED');
  const sku = catalog().byId(id);
  if (!sku) fail('UNKNOWN_SKU', { id });
  if (isBundle(sku)) fail('BUNDLE_HAS_NO_STOCK', { id });
  const given = v => v !== undefined && v !== null && v !== '';
  if (given(value) === given(delta)) fail('VALUE_OR_DELTA');
  const n = Number(given(value) ? value : delta);
  if (!Number.isInteger(n) || (given(value) && n < 0)) fail('BAD_VALUE', { id });
  return change((s, at) => {
    const lv = s.levels[id] = levelIn(s, id);
    const before = lv.stock;
    const after = given(value) ? n : before + n;
    if (after < 0) fail('NEGATIVE_STOCK', { id, available: before });
    lv.stock = after;
    const entry = { at, id, field: 'stock', delta: after - before, before, after, reason: 'manual', note, by: by || null };
    s.log.push(entry);
    return entry;
  });
}

/** Для тестов: забыть копию и запись. */
async function reset() { mem = null; await store.write(NAME, null); }

module.exports = {
  availableStock, canSell, bufferFor, fulfillmentOf, level, log,
  reserveMany, releaseMany, setMany, adjust, init, reset, REASONS
};
