'use strict';
/**
 * Синхронизация с площадкой: цены и остатки. Единственная точка.
 *
 * Что уходит. Цены — из каталога. Остатки — только availableStock для канала
 * площадки: буфер уже вычтен там и второй раз не вычитается. Позиции со склада
 * площадки (FBO) в остатках не участвуют — их остаток ведёт она. Наборы не
 * выгружаются вовсе: своего остатка у них нет, раскрывать их площадка не умеет.
 *
 * Когда. Изменение остатка (заказ, отмена, правка, импорт) и каталога (цена,
 * страховой запас, режим исполнения) — по событиям stock.js и catalog.js;
 * ручной запуск. Не по расписанию. Изменения копятся окном в несколько секунд
 * и уходят одной посылкой: десять заказов подряд — одно обращение.
 *
 * Отказ. Повтор с нарастающей паузой, ограниченное число попыток, затем запись
 * в журнал, уведомление в кабинете, а позиции остаются в очереди до следующего
 * повода или ручного запуска. Витрина и заказы синхронизацию не ждут.
 *
 * Режим — у клиента площадки: без ключей только сухой прогон.
 */
const config = require('./config');
const catalog = require('./catalog');
const stock = require('./stock');
const store = require('./store');
const defaultClient = require('./marketplace/client');

const NAME = 'sync';
const LOG_LIMIT = 300;                       // журнал оперативный, не учётный: хранятся последние
const CHUNK = { prices: 1000, stocks: 100 }; // пределы площадки на одну посылку
const sleep = ms => new Promise(r => setTimeout(r, ms));
const KIND_TITLE = { prices: 'цены', stocks: 'остатки' };

function createSync(opts = {}) {
  const client = opts.client || defaultClient;
  // конфиг читается при использовании, а не при подключении модуля: негодный конфиг
  // должен остановить сервер понятным сообщением, а не трассировкой
  const mp = () => config.get('marketplace', {}) || {};
  const windowMs = () => (opts.windowMs !== undefined ? opts.windowMs : Number(mp().syncWindowMs || 3000));
  const attemptsMax = () => (opts.retries !== undefined ? opts.retries : Number(mp().syncRetries || 4));
  const baseDelay = opts.baseDelayMs !== undefined ? opts.baseDelayMs : 1000;
  const pending = new Map();      // id → { price, stock, reasons: Set }
  let timer = null, running = Promise.resolve(), listeners = null;

  const mode = () => (client.isDry() ? 'dry-run' : 'live');
  const active = () => {
    const ch = (config.load().channels || []).find(c => c.code === 'MARKETPLACE');
    return !!(mp().enabled && ch && ch.enabled);
  };

  /* ---------- очередь ---------- */

  function mark(id, kinds, reason) {
    const cur = pending.get(id) || { price: false, stock: false, reasons: new Set() };
    if (kinds.price) cur.price = true;
    if (kinds.stock) cur.stock = true;
    if (reason) cur.reasons.add(reason);
    pending.set(id, cur);
  }
  function notify(id, kinds, reason) {
    if (!active()) return;
    mark(String(id), kinds, reason);
    if (!timer) timer = setTimeout(() => { timer = null; flush(); }, windowMs());
  }

  /* ---------- что уходит ---------- */

  const priceRow = p => ({ offer_id: String(p.id), price: String(p.price),
    old_price: String(p.oldPrice > p.price ? p.oldPrice : 0), currency_code: config.get('catalog.currency', 'RUB') });
  const stockRow = p => ({ offer_id: String(p.id), stock: stock.availableStock(p, 'MARKETPLACE'),
    warehouse_id: mp().warehouseId || null });

  /** Посылки по выбранным позициям. Наборы и склад площадки — в skipped с причиной. */
  function plan(selection) {
    const prices = [], stocks = [], skipped = { bundles: [], fbo: [], unknown: [] };
    for (const [id, k] of selection) {
      const p = catalog.byId(id);
      if (!p) { skipped.unknown.push(id); continue; }
      if (p.kind === 'bundle') { skipped.bundles.push(id); continue; }
      if (k.price) prices.push(priceRow(p));
      if (k.stock) {
        if (stock.fulfillmentOf(p) === 'FBO') skipped.fbo.push(id);
        else stocks.push(stockRow(p));
      }
    }
    return { prices, stocks, skipped };
  }
  const everything = reason => new Map(catalog.all().map(p => [String(p.id), { price: true, stock: true, reasons: new Set([reason]) }]));

  /* ---------- отправка ---------- */

  const retryable = e => !e.status || e.status >= 500 || e.status === 429;
  const describe = e => (e.status ? 'площадка ответила ' + e.status : e.code === 'ETIMEDOUT' || e.name === 'AbortError' ? 'нет ответа' : 'нет связи') +
    (e.message ? ': ' + String(e.message).slice(0, 200) : '');

  async function sendOne(kind, rows, reasons) {
    const base = { at: null, kind, mode: mode(), reasons, count: rows.length, rows };
    if (base.mode === 'live' && kind === 'stocks' && !mp().warehouseId) {
      return Object.assign(base, { at: new Date().toISOString(), ok: false, attempts: 0, error: 'не задан marketplace.warehouseId — остатки некуда отправить' });
    }
    const push = kind === 'prices' ? client.pushPrices : client.pushStocks;
    let lastErr = null, attempt = 0;
    while (attempt < attemptsMax()) {
      attempt++;
      try {
        const res = await push(rows);
        const bad = base.mode === 'live' ? client.rejected(res) : [];
        return Object.assign(base, { at: new Date().toISOString(), ok: !bad.length, attempts: attempt, rejected: bad,
          response: base.mode === 'dry-run' ? 'сухой прогон: запрос записан в журнал намерений, на площадку не ушёл'
            : bad.length ? 'не приняты: ' + bad.map(b => b.offer_id).join(', ') : 'принято' });
      } catch (e) {
        lastErr = e;
        if (!retryable(e) || attempt >= attemptsMax()) break;
        await sleep(baseDelay * 2 ** (attempt - 1));
      }
    }
    return Object.assign(base, { at: new Date().toISOString(), ok: false, attempts: attempt, error: describe(lastErr || {}) });
  }

  async function send(kind, rows, reasons) {
    const out = [];
    for (let i = 0; i < rows.length; i += CHUNK[kind]) out.push(await sendOne(kind, rows.slice(i, i + CHUNK[kind]), reasons));
    return out;
  }

  /** Журнал, уведомление и последнее известное состояние площадки — одной записью. */
  function record(entries) {
    return store.update(NAME, s => {
      s = s || { log: [], alert: null, remote: null };
      s.log = (s.log || []).concat(entries).slice(-LOG_LIMIT);
      for (const e of entries) {
        if (!e.ok) {
          s.alert = { at: e.at, kind: e.kind, message: 'Площадка не приняла ' + KIND_TITLE[e.kind] + ': ' + (e.error || e.response) +
            '. Витрина и заказы работают; позиции уйдут со следующим изменением или по кнопке «Отправить сейчас».' };
        } else if (s.alert && s.alert.kind === e.kind) s.alert = null;
        if (e.mode === 'live') {
          const refused = new Set((e.rejected || []).map(r => r.offer_id));
          s.remote = s.remote || { at: null, source: 'accepted', items: {} };
          for (const r of e.ok || refused.size ? e.rows : []) {
            if (refused.has(r.offer_id)) continue;
            const cur = s.remote.items[r.offer_id] || {};
            s.remote.items[r.offer_id] = Object.assign(cur, e.kind === 'prices' ? { price: r.price } : { stock: r.stock });
          }
          if (e.ok || refused.size) s.remote.at = e.at;
        }
      }
      return s;
    });
  }

  /** Отправить накопленное. Не ушедшее возвращается в очередь без нового таймера. */
  function flush() {
    const run = running.then(async () => {
      if (timer) { clearTimeout(timer); timer = null; }
      const selection = new Map(pending); pending.clear();
      if (!selection.size) return [];
      const p = plan(selection);
      const reasons = [...new Set([...selection.values()].flatMap(k => [...k.reasons]))];
      const entries = [];
      if (p.prices.length) entries.push(...await send('prices', p.prices, reasons));
      if (p.stocks.length) entries.push(...await send('stocks', p.stocks, reasons));
      for (const e of entries) {
        if (e.ok) continue;
        const refused = e.rejected && e.rejected.length ? new Set(e.rejected.map(r => r.offer_id)) : null;
        for (const r of e.rows) if (!refused || refused.has(r.offer_id)) mark(r.offer_id, e.kind === 'prices' ? { price: true } : { stock: true }, 'повтор');
      }
      if (entries.length) await record(entries);
      return entries;
    });
    running = run.catch(() => {});
    return run;
  }

  /* ---------- снаружи ---------- */

  /** Ручной запуск: всё сразу. preview — только показать, что уйдёт, ничего не отправляя. */
  async function run({ preview, by } = {}) {
    if (!active()) return { preview: !!preview, mode: mode(), disabled: true, message: 'площадка выключена в конфигурации (marketplace.enabled или канал MARKETPLACE)' };
    const all = everything(by ? 'вручную: ' + by : 'вручную');
    if (preview) return Object.assign({ preview: true, mode: mode() }, plan(all));
    for (const [id, k] of all) mark(id, k, [...k.reasons][0]);
    return { preview: false, mode: mode(), entries: await flush() };
  }

  async function log({ limit } = {}) {
    const s = (await store.read(NAME)) || {};
    const n = Number(limit) || 100;
    return { mode: mode(), active: active(), pending: pending.size, alert: s.alert || null, windowMs: windowMs(),
      entries: (s.log || []).slice(-n).reverse() };
  }

  /**
   * Сверка нашего представления с последним известным состоянием площадки. Нет
   * данных площадки — так и отвечает: пустой список значил бы «всё сходится».
   */
  async function diff() {
    let s = (await store.read(NAME)) || {};
    let readError = null;
    if (mode() === 'live' && client.fetchState) {
      try {
        const items = await client.fetchState();
        if (items) s = await store.update(NAME, cur => Object.assign(cur || { log: [], alert: null },
          { remote: { at: new Date().toISOString(), source: 'marketplace', items } }));
      } catch (e) { readError = describe(e); }
    }
    const remote = s.remote;
    if (!remote || !remote.items || !Object.keys(remote.items).length) {
      return { status: 'NO_DATA', mode: mode(), readError,
        message: 'Данных площадки ещё не было: ' + (mode() === 'dry-run'
          ? 'работает сухой прогон, на площадку ничего не уходит и с неё ничего не читается'
          : 'ни одной принятой выгрузки и ни одного чтения') + '. Сравнивать не с чем — это не значит, что расхождений нет.' };
    }
    const ours = plan(everything('сверка'));
    const mismatches = [];
    const cmp = (rows, field) => rows.forEach(r => {
      const theirs = remote.items[r.offer_id];
      const value = field === 'price' ? r.price : r.stock;
      if (!theirs || theirs[field] === undefined) mismatches.push({ offer_id: r.offer_id, field, ours: value, theirs: null, note: 'площадка этого не подтверждала' });
      else if (String(theirs[field]) !== String(value)) mismatches.push({ offer_id: r.offer_id, field, ours: value, theirs: theirs[field] });
    });
    cmp(ours.prices, 'price'); cmp(ours.stocks, 'stock');
    return { status: mismatches.length ? 'MISMATCH' : 'OK', mode: mode(), source: remote.source, remoteAt: remote.at, readError,
      checked: ours.prices.length + ours.stocks.length, mismatches };
  }

  /** Подписка на изменения остатка и каталога. */
  function start() {
    if (listeners) return api;
    listeners = {
      stock: entries => entries.forEach(e => { if (e.field === 'stock') notify(e.id, { stock: true }, e.reason); }),
      catalog: (prev, next) => {
        const before = new Map(prev.map(p => [String(p.id), p]));
        for (const p of next) {
          const o = before.get(String(p.id));
          const price = !o || o.price !== p.price || o.oldPrice !== p.oldPrice || o.kind !== p.kind;
          const stk = !o || o.buffer !== p.buffer || o.fulfillment !== p.fulfillment || o.kind !== p.kind;
          if (price || stk) notify(p.id, { price, stock: stk }, 'каталог');
        }
      }
    };
    stock.events.on('change', listeners.stock);
    catalog.events.on('change', listeners.catalog);
    return api;
  }
  function stop() {
    if (!listeners) return;
    stock.events.off('change', listeners.stock);
    catalog.events.off('change', listeners.catalog);
    listeners = null;
    if (timer) { clearTimeout(timer); timer = null; }
  }

  const api = { start, stop, notify, flush, run, log, diff, plan: sel => plan(sel || everything('план')), pendingSize: () => pending.size };
  return api;
}

module.exports = Object.assign(createSync(), { createSync });
