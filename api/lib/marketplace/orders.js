'use strict';
/**
 * Приём заказов площадки в нашу очередь.
 *
 * Вход — ответ площадки со списком отправлений: FBS (свой склад) —
 * result.postings[], FBO (склад площадки) — result[]. Пока ключа нет, источник —
 * сохранённые ответы (tests/fixtures/ozon-*.json) и загрузка из кабинета;
 * с ключом сюда же передаётся ответ клиента площадки.
 *
 * Правила:
 * - идемпотентность по номеру отправления: повторная доставка второй заказ не создаёт;
 * - сумму считает площадка: берутся её цены, наш расчёт и скидки не применяются;
 * - FBO — наш остаток не трогается, его ведёт площадка;
 * - FBS — списание через reserveMany по физическому остатку (буфер для того
 *   и держится). Не хватает — заказ всё равно создаётся, но помечается проблемным:
 *   отказать площадке нельзя, она уже продала;
 * - позиция, которой нет в каталоге, — тоже проблема заказа, а не отказ.
 * Доставки обрабатываются строго по очереди: одно отправление не спишется дважды.
 */
const catalog = require('../catalog');
const stock = require('../stock');
const orders = require('../orders');
const config = require('../config');

const SOURCE = 'ozon';

/** Статусы площадки → наш поток. Незнакомый — «Новый», исходный хранится в external.status. */
const STATUS = {
  awaiting_registration: 'NEW', acceptance_in_progress: 'NEW', awaiting_approve: 'NEW', awaiting_packaging: 'NEW',
  awaiting_deliver: 'PACKING',
  delivering: 'SHIPPED', driver_pickup: 'SHIPPED', sent_by_seller: 'SHIPPED',
  delivered: 'DONE',
  cancelled: 'CANCELLED', not_accepted: 'CANCELLED'
};

function fail(code, message) { const e = new Error(message); e.code = code; throw e; }

/** Отправления из ответа площадки и схема исполнения. */
function postingsOf(payload, scheme) {
  const r = payload && payload.result;
  if (r && Array.isArray(r.postings)) return { scheme: scheme || 'FBS', list: r.postings };
  if (Array.isArray(r)) return { scheme: scheme || 'FBO', list: r };
  fail('BAD_PAYLOAD', 'не похоже на ответ площадки: нужен result.postings[] (FBS) или result[] (FBO)');
}

const money = v => Math.round(Number(v) * 100) / 100;

async function ingestPosting(posting, scheme) {
  const postingNumber = String(posting.posting_number || '');
  if (!postingNumber) return { status: 'skipped', reason: 'нет номера отправления' };
  const status = STATUS[posting.status] || 'NEW';

  const existing = await orders.byExternal(SOURCE, postingNumber);
  if (existing) {
    // площадка отменила уже принятое — возвращаем списанное, иначе остаток потерян
    if (status === 'CANCELLED' && existing.status !== 'CANCELLED') {
      await orders.advance(existing.id, 'CANCELLED', 'площадка');
      return { status: 'cancelled', id: existing.id, postingNumber };
    }
    return { status: 'duplicate', id: existing.id, postingNumber };
  }

  const problems = [];
  const lines = (posting.products || []).map(pr => {
    const p = catalog.byOfferId(pr.offer_id);
    const qty = Math.max(0, parseInt(pr.quantity, 10) || 0);
    const price = money(pr.price);
    if (!p) problems.push({ code: 'UNKNOWN_OFFER', offerId: String(pr.offer_id), message: 'позиции с артикулом площадки «' + pr.offer_id + '» нет в каталоге' });
    const line = { id: p ? p.id : null, offerId: String(pr.offer_id), title: p ? p.title : String(pr.name || pr.offer_id), price, qty, sum: money(price * qty) };
    if (p && p.kind === 'bundle') Object.assign(line, { kind: 'bundle', components: p.components.map(c => ({ id: c.id, title: (catalog.byId(c.id) || {}).title || c.id, qty: c.qty * qty })) });
    return line;
  });

  const id = orders.newId();
  let reserved = [];
  if (scheme === 'FBS' && status !== 'CANCELLED') {
    const physical = catalog.expand(lines.filter(l => l.id));
    try {
      const moved = await stock.reserveMany(physical, 'MARKETPLACE', { ref: id, physical: true });
      reserved = moved.map(m => ({ id: m.id, title: physical.find(l => l.id === m.id).title, qty: m.qty }));
    } catch (e) {
      if (e.code !== 'NOT_ENOUGH_STOCK') throw e;
      const need = physical.find(l => l.id === e.id);
      problems.push({ code: 'NOT_ENOUGH_STOCK', id: e.id, available: e.available,
        message: 'не хватает остатка: «' + (need ? need.title : e.id) + '» — на складе ' + e.available + ', продано ' + (need ? need.qty : '?') +
          '. Ничего не списано: пополните остаток или отмените заказ на площадке' });
    }
  }

  const ch = config.channel('MARKETPLACE');
  const c = posting.customer || {};
  const total = money(lines.reduce((s, l) => s + l.sum, 0));
  const { order, created } = await orders.addExternal({
    id, at: posting.in_process_at || posting.created_at || new Date().toISOString(),
    channel: ch.code, channelTitle: ch.title, settlement: 'MARKETPLACE',
    customer: { name: c.name || 'Покупатель площадки', phone: c.phone || '', address: (c.address && c.address.address_tail) || '' },
    items: lines, qty: lines.reduce((s, l) => s + l.qty, 0),
    goods: total, discountPct: 0, discount: 0, total,
    status, payment: { provider: 'marketplace', note: 'оплата на стороне площадки' },
    reserved, problems,
    external: { source: SOURCE, scheme, postingNumber, orderNumber: String(posting.order_number || ''), status: posting.status || '', receivedAt: new Date().toISOString() }
  });
  // гонка: то же отправление записали раньше — списанное возвращается
  if (!created && reserved.length) await stock.releaseMany(reserved, { ref: id });
  return { status: created ? 'created' : 'duplicate', id: order.id, postingNumber, problems: order.problems };
}

let chain = Promise.resolve();

/**
 * Принять ответ площадки. scheme — FBS или FBO; по умолчанию — по форме ответа.
 * → { scheme, received, created, duplicates, cancelled, problems, results }
 */
function ingest(payload, { scheme } = {}) {
  const run = chain.then(async () => {
    const { scheme: sch, list } = postingsOf(payload, scheme);
    const results = [];
    for (const posting of list) results.push(await ingestPosting(posting, sch));
    const count = st => results.filter(r => r.status === st).length;
    return { scheme: sch, received: list.length, created: count('created'), duplicates: count('duplicate'), cancelled: count('cancelled'),
      problems: results.filter(r => r.problems && r.problems.length).length, results };
  });
  chain = run.catch(() => {});
  return run;
}

module.exports = { ingest, STATUS, SOURCE };
