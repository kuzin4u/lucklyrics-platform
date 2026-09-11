'use strict';
/**
 * Артикул площадки и приём заказов площадки на фикстурах — сохранённых
 * ответах площадки в tests/fixtures/.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

process.env.STORE_PROVIDER = 'memory';
process.env.JWT_SECRET = 'mp-orders-test-secret-0123456789-abcdefgh';
const { server, catalog, stock, orders, importer, auth, store } = require('../../api/server');
const mpOrders = require('../../api/lib/marketplace/orders');
const { createSync } = require('../../api/lib/sync');

const fixture = name => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', name), 'utf8'));
const FBS = fixture('ozon-fbs-postings.json');
const FBO = fixture('ozon-fbo-postings.json');
const lvl = id => stock.level(id).stock;
const byPosting = async n => (await orders.allOrders()).find(o => o.external && o.external.postingNumber === n);
const posting = (number, products, extra) => ({ result: { postings: [Object.assign({ posting_number: number, order_number: number.slice(0, -2),
  status: 'awaiting_packaging', in_process_at: '2026-09-11T10:00:00Z', products }, extra)] } });
const fakeClient = () => ({ isDry: () => true, rejected: () => [], pushPrices: async () => ({}), pushStocks: async () => ({}) });
let base, token;

async function fresh() {
  catalog.reset(); await store.write('catalog', null); catalog.reset();
  await stock.reset(); await orders.reset();
  await importer.run('Артикул;Артикул площадки\nSKU-001;OZ-SKU-001\n');   // как в фикстуре
}
async function call(method, route, { body, tk } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (tk) headers.Authorization = 'Bearer ' + tk;
  const r = await fetch(base + route, { method, headers, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}

test.before(async () => {
  await auth.register('mp-seller', 'пароль-площадки-1');
  token = (await auth.login('mp-seller', 'пароль-площадки-1')).token;
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + server.address().port;
});
test.after(() => server.close());

test('артикул площадки: позиция с собственным уходит под ним, без него — под идентификатором', async () => {
  await fresh();
  assert.equal(catalog.byId('SKU-001').offerId, 'OZ-SKU-001', 'колонка импорта');
  const plan = createSync({ client: fakeClient() }).plan();
  const offers = rows => rows.map(r => r.offer_id);
  assert.ok(offers(plan.prices).includes('OZ-SKU-001') && !offers(plan.prices).includes('SKU-001'), 'цена — под артикулом площадки');
  assert.ok(offers(plan.stocks).includes('OZ-SKU-001') && !offers(plan.stocks).includes('SKU-001'), 'остаток — тоже');
  assert.ok(offers(plan.prices).includes('SKU-002'), 'без своего артикула — идентификатор позиции');
  const en = await importer.run('SKU,offer_id\nSKU-003,OZ-3\n');
  assert.equal(en.summary.errors, 0);
  assert.equal(catalog.byId('SKU-003').offerId, 'OZ-3');
  // артикул площадки однозначен: по нему приходят заказы
  const clash = await importer.run('Артикул;Артикул площадки\nSKU-004;SKU-002\nSKU-005;OZ-SKU-001\n');
  assert.deepEqual(clash.errors.map(e => e.message), [
    'строка 2: артикул площадки «SKU-002» уже у позиции SKU-002',
    'строка 3: артикул площадки «OZ-SKU-001» уже у позиции SKU-001']);
});

test('разбор фикстуры создаёт заказ с правильными полями, сумму считает площадка', async () => {
  await fresh();
  const r = await mpOrders.ingest(FBS);
  assert.deepEqual([r.scheme, r.received, r.created, r.duplicates, r.problems], ['FBS', 2, 2, 0, 0]);
  const a = await byPosting('05708065-0029-1');
  assert.deepEqual([a.channel, a.channelTitle, a.status, a.statusTitle], ['MARKETPLACE', 'Маркетплейс', 'NEW', 'Новый']);
  assert.deepEqual(a.external, Object.assign({}, a.external, { source: 'ozon', scheme: 'FBS', postingNumber: '05708065-0029-1', orderNumber: '05708065-0029', status: 'awaiting_packaging' }));
  assert.deepEqual(a.items, [{ id: 'SKU-001', offerId: 'OZ-SKU-001', title: 'Позиция первая', price: 359, qty: 2, sum: 718 }], 'артикул площадки сопоставлен с позицией');
  assert.equal(a.total, 718, 'цена площадки, а не каталожные 390');
  assert.deepEqual([a.customer.name, a.payment.provider, a.at], ['Покупатель площадки', 'marketplace', '2026-09-11T08:12:00Z']);
  const b = await byPosting('05708077-0031-1');
  assert.deepEqual([b.status, b.qty, b.total, b.discount, b.discountPct], ['PACKING', 4, 987.5, 0, 0], 'скидка за количество не пересчитывается');
  assert.equal(b.customer.address, 'г. Тестовый, ул. Примерная, 2');
});

test('повторная доставка того же заказа не создаёт второй', async () => {
  await fresh();
  await mpOrders.ingest(FBS);
  const count = (await orders.allOrders()).length, levels = ['SKU-001', 'SKU-002', 'SKU-004'].map(lvl), moves = stock.log().length;
  const again = await mpOrders.ingest(FBS);
  assert.deepEqual([again.created, again.duplicates], [0, 2]);
  assert.equal((await orders.allOrders()).length, count);
  assert.deepEqual(['SKU-001', 'SKU-002', 'SKU-004'].map(lvl), levels, 'второй раз не списано');
  assert.equal(stock.log().length, moves);
  // запись идемпотентна и сама по себе — страховка на случай гонки мимо очереди приёма
  const dup = await orders.addExternal({ status: 'NEW', items: [], external: { source: 'ozon', postingNumber: '05708065-0029-1' } });
  assert.equal(dup.created, false);
  assert.equal((await orders.allOrders()).length, count);
  // две доставки одновременно — тоже один заказ
  await fresh();
  await Promise.all([mpOrders.ingest(FBS), mpOrders.ingest(FBS)]);
  assert.equal((await orders.allOrders()).length, 2);
  assert.equal(lvl('SKU-001'), 12 - 2);
});

test('заказ со склада площадки наш остаток не трогает', async () => {
  await fresh();
  const before = stock.level('SKU-006'), own = stock.level('SKU-002'), moves = stock.log().length;
  const r = await mpOrders.ingest(FBO);
  assert.deepEqual([r.scheme, r.created, r.problems], ['FBO', 2, 0]);
  const o = await byPosting('05709112-0044-1');
  assert.deepEqual([o.external.scheme, o.status, o.reserved, o.total], ['FBO', 'SHIPPED', [], 1648]);
  assert.deepEqual(stock.level('SKU-006'), before, 'ни свой остаток, ни остаток площадки не изменились');
  assert.deepEqual(stock.level('SKU-002'), own, 'позиция и на своём складе, но продана со склада площадки — наш остаток цел');
  assert.equal(stock.log().length, moves, 'движений нет');
});

test('заказ со своего склада списывает остаток через reserveMany — по физическому остатку', async () => {
  await fresh();
  await mpOrders.ingest(FBS);
  assert.deepEqual(['SKU-001', 'SKU-002', 'SKU-004'].map(lvl), [12 - 2, 8 - 1, 20 - 3]);
  const o = await byPosting('05708077-0031-1');
  assert.deepEqual(o.reserved.map(r => [r.id, r.qty]), [['SKU-002', 1], ['SKU-004', 3]]);
  const e = stock.log({ id: 'SKU-004' })[0];
  assert.deepEqual([e.reason, e.delta, e.channel, e.ref], ['order', -3, 'MARKETPLACE', o.id]);
  // площадка видела остаток минус буфер, а продала больше — буфер для того и держится
  await stock.adjust({ id: 'SKU-005', value: 2, reason: 'проверка' });
  assert.equal(stock.availableStock(catalog.byId('SKU-005'), 'MARKETPLACE'), 0);
  const r = await mpOrders.ingest(posting('09000001-0001-1', [{ offer_id: 'SKU-005', quantity: 2, price: '598.0000' }]));
  assert.deepEqual([r.created, r.problems], [1, 0]);
  assert.equal(lvl('SKU-005'), 0);
});

test('нехватка остатка даёт проблемный заказ, а не отказ; ничего не списано', async () => {
  await fresh();
  const levels = ['SKU-002', 'SKU-004'].map(lvl);
  const r = await mpOrders.ingest(posting('09000002-0002-1', [
    { offer_id: 'SKU-002', quantity: 1, price: '329.0000' },
    { offer_id: 'SKU-004', quantity: 50, price: '219.0000' }]));
  assert.deepEqual([r.created, r.problems], [1, 1], 'заказ создан');
  const o = await byPosting('09000002-0002-1');
  assert.equal(o.problems[0].code, 'NOT_ENOUGH_STOCK');
  assert.match(o.problems[0].message, /не хватает остатка: «Позиция четвёртая» — на складе 20, продано 50/);
  assert.deepEqual(o.reserved, []);
  assert.deepEqual(['SKU-002', 'SKU-004'].map(lvl), levels, 'атомарно: и вторая строка не списана');
  // неизвестная позиция — тоже проблема, а не отказ; известная строка списана
  await mpOrders.ingest(posting('09000003-0003-1', [{ offer_id: 'НЕТ-В-КАТАЛОГЕ', quantity: 1, price: '100' }, { offer_id: 'SKU-002', quantity: 1, price: '329' }]));
  const u = await byPosting('09000003-0003-1');
  assert.deepEqual(u.problems.map(p => p.code), ['UNKNOWN_OFFER']);
  assert.equal(lvl('SKU-002'), levels[0] - 1);
  // отмена проблемного заказа ничего не возвращает — ничего и не списывали
  await orders.advance(o.id, 'CANCELLED', 'mp-seller');
  assert.deepEqual(['SKU-004'].map(lvl), [levels[1]]);
});

test('площадка отменила принятый заказ — повторная доставка возвращает остаток', async () => {
  await fresh();
  await mpOrders.ingest(FBS);
  const cancelled = JSON.parse(JSON.stringify(FBS));
  cancelled.result.postings[1].status = 'cancelled';
  const r = await mpOrders.ingest(cancelled);
  assert.deepEqual([r.cancelled, r.duplicates], [1, 1]);
  assert.equal((await byPosting('05708077-0031-1')).status, 'CANCELLED');
  assert.deepEqual([lvl('SKU-002'), lvl('SKU-004')], [8, 20]);
});

test('заказ площадки виден в кабинете с меткой канала, проблемные — отдельно', async () => {
  await fresh();
  assert.equal((await call('POST', '/api/marketplace/orders', { body: FBS })).status, 401, 'приём — за входом');
  const up = await call('POST', '/api/marketplace/orders', { body: FBS, tk: token });
  assert.deepEqual([up.status, up.body.created], [200, 2]);
  await call('POST', '/api/marketplace/orders', { body: posting('09000004-0004-1', [{ offer_id: 'SKU-004', quantity: 99, price: '1' }]), tk: token });
  const list = await call('GET', '/api/orders', { tk: token });
  const mp = list.body.orders.filter(o => o.channel === 'MARKETPLACE');
  assert.equal(mp.length, 3);
  assert.ok(mp.every(o => o.channelTitle === 'Маркетплейс' && o.external.postingNumber));
  assert.equal(list.body.stats.problems, 1, 'проблемные посчитаны отдельно');
  assert.equal(list.body.stats.byChannel['Маркетплейс'], 3);
  const bad = await call('POST', '/api/marketplace/orders', { body: { что: 'не то' }, tk: token });
  assert.deepEqual([bad.status, bad.body.error], [400, 'BAD_PAYLOAD']);
  // кабинет помечает канал, отправление и проблему
  const tpl = fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'cabinet.template.html'), 'utf8');
  assert.match(tpl, /o\.external\.postingNumber/);
  assert.match(tpl, /Требуют внимания/);
});
