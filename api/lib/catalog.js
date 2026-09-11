'use strict';
/**
 * Каталог. Единственная точка чтения товаров.
 *
 * Витрина, кабинет и синхронизация спрашивают отсюда и не знают, откуда взялось.
 *
 * Источник: каталог в хранилище (store.js, имя catalog), его пишет импорт.
 * Пока импорта не было — стартовый файл config/catalog.json.
 * Чтение синхронное: хранилище читается один раз при старте (init),
 * дальше работает копия в памяти. Остаток здесь не хранится — его ведёт stock.js.
 *
 * Вид позиции (kind): обычный товар (item) или набор (bundle). У набора — состав
 * [{id, qty}] и своя заданная цена, своего остатка нет.
 */
const fs = require('fs');
const path = require('path');
const config = require('./config');
const stock = require('./stock');
const store = require('./store');

const ROOT = path.resolve(__dirname, '..', '..');
const NAME = 'catalog';
let cache = null;
let saving = Promise.resolve();

function file() {
  return process.env.CATALOG_FILE
    ? path.resolve(ROOT, process.env.CATALOG_FILE)
    : path.join(ROOT, 'config', 'catalog.json');
}

const normalize = it => Object.assign({
  kind: 'item', fulfillment: config.get('stock.fulfillmentDefault', 'FBS'),
  oldPrice: 0, photos: [], features: []
}, it);
const isBundle = p => !!p && p.kind === 'bundle';
const titleOf = id => (byId(id) || {}).title || id;

function all() {
  if (cache) return cache;
  cache = JSON.parse(fs.readFileSync(file(), 'utf8')).items.map(normalize);
  return cache;
}

/** При старте: каталог из хранилища, если его уже загружали импортом. */
async function init() {
  const saved = await store.read(NAME);
  if (saved && Array.isArray(saved.items)) cache = saved.items.map(normalize);
  return all();
}

/**
 * Замена каталога: mutator получает текущие позиции и возвращает новые, не меняя
 * старых на месте. Сохранения идут по очереди, копия в памяти обновляется после записи.
 */
function save(mutator) {
  const run = saving.then(async () => {
    const next = mutator(all());
    await store.write(NAME, { items: next, savedAt: new Date().toISOString() });
    cache = next.map(normalize);
    return cache;
  });
  saving = run.catch(() => {});
  return run;
}

const byId = id => all().find(p => String(p.id) === String(id)) || null;

const categories = () => {
  const seen = new Map();
  for (const p of all()) if (p.category && !seen.has(p.category)) seen.set(p.category, p.categoryTitle || p.category);
  return [...seen].map(([code, title]) => ({ code, title }));
};

/** Витринное представление: остаток считает stock.js, цены — из каталога. */
function forChannel(channelCode) {
  return all().map(p => ({
    id: p.id, kind: p.kind, title: p.title, price: p.price, oldPrice: p.oldPrice || 0,
    components: isBundle(p) ? p.components.map(c => ({ id: c.id, title: titleOf(c.id), qty: c.qty })) : undefined,
    unit: p.unit || '', weight: p.weight || '', emoji: p.emoji || '',
    category: p.category || '', categoryTitle: p.categoryTitle || p.category || '',
    description: p.description || '', features: p.features || [],
    rating: p.rating || 0, reviews: p.reviews || 0,
    available: stock.availableStock(p, channelCode)
  }));
}

/** Ступенчатая скидка за количество — пороги из конфигурации. */
function discountPct(qty) {
  const tiers = config.get('catalog.discountTiers', []).slice().sort((a, b) => b.min - a.min);
  const hit = tiers.find(t => qty >= t.min);
  return hit ? hit.pct : 0;
}

/** Расчёт корзины. Одна точка: витрина и заказ считают одинаково. */
function quote(items, channelCode) {
  const lines = [];
  let goods = 0, qty = 0;
  for (const it of items || []) {
    const p = byId(it.id);
    if (!p) { const e = new Error('UNKNOWN_SKU'); e.code = 'UNKNOWN_SKU'; e.id = it.id; throw e; }
    const n = Math.max(0, parseInt(it.qty, 10) || 0);
    if (!n) continue;
    if (!stock.canSell(p, channelCode, n)) {
      const e = new Error('NOT_ENOUGH_STOCK'); e.code = 'NOT_ENOUGH_STOCK'; e.id = p.id;
      e.available = stock.availableStock(p, channelCode); throw e;
    }
    const sum = p.price * n;
    const line = { id: p.id, title: p.title, price: p.price, qty: n, sum };
    // набор — одна строка со своей ценой; состав раскрыт рядом для склада
    if (isBundle(p)) Object.assign(line, { kind: 'bundle', components: p.components.map(c => ({ id: c.id, title: titleOf(c.id), qty: c.qty * n })) });
    lines.push(line);
    goods += sum; qty += n;
  }
  // общий спрос по складу: набор и та же позиция отдельно делят один остаток
  for (const r of expand(lines)) {
    const p = byId(r.id);
    if (!p || !stock.canSell(p, channelCode, r.qty)) {
      const e = new Error('NOT_ENOUGH_STOCK'); e.code = 'NOT_ENOUGH_STOCK'; e.id = r.id;
      e.available = p ? stock.availableStock(p, channelCode) : 0; throw e;
    }
  }
  const pct = discountPct(qty);
  const discount = Math.round(goods * pct / 100);
  return { lines, qty, goods, discountPct: pct, discount, total: goods - discount };
}

/** Строки заказа → физические позиции для склада: наборы раскрыты, одинаковые сложены. */
function expand(lines) {
  const need = new Map();
  for (const l of lines) {
    for (const c of l.kind === 'bundle' ? l.components : [l]) {
      const cur = need.get(c.id);
      need.set(c.id, { id: c.id, title: c.title, qty: (cur ? cur.qty : 0) + c.qty });
    }
  }
  return [...need.values()];
}

function reset() { cache = null; }

module.exports = { all, byId, categories, forChannel, quote, expand, discountPct, init, save, reset, file };
