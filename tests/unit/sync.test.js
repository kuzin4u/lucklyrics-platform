'use strict';
/**
 * Синхронизация с площадкой в сухом режиме: что уходит, пакетирование,
 * отказы, предпросмотр, сверка и невозможность боевого вызова без ключей.
 */
const test = require('node:test');
const assert = require('node:assert');

process.env.STORE_PROVIDER = 'memory';
process.env.JWT_SECRET = 'sync-test-secret-0123456789-abcdefghijkl';
const { server, catalog, stock, orders, importer, auth, store, config } = require('../../api/server');
const { createSync } = require('../../api/lib/sync');
const realClient = require('../../api/lib/marketplace/client');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const customer = { name: 'Покупатель' };
let base, token;

/** Поддельная площадка: считает посылки, умеет падать и отвечать как боевая. */
function fakeClient({ live = false, fail = 0, status } = {}) {
  const calls = { prices: [], stocks: [] };
  let left = fail;
  const answer = rows => { if (left > 0) { left--; const e = new Error('площадка недоступна'); if (status) e.status = status; throw e; }
    return live ? { result: rows.map(r => ({ offer_id: r.offer_id, updated: true, errors: [] })) } : { dryRun: true }; };
  return { calls, isDry: () => !live, rejected: realClient.rejected, fetchState: async () => null,
    pushPrices: async rows => { calls.prices.push(rows); return answer(rows); },
    pushStocks: async rows => { calls.stocks.push(rows); return answer(rows); } };
}
async function fresh() {
  catalog.reset(); await store.write('catalog', null); catalog.reset();
  await stock.reset(); await orders.reset(); await store.write('sync', null);
}
const call = async (method, route, tk) => {
  const r = await fetch(base + route, { method, headers: tk ? { Authorization: 'Bearer ' + tk } : {} });
  return { status: r.status, body: await r.json() };
};
const row = (plan, id) => plan.stocks.find(r => r.offer_id === id);

test.before(async () => {
  await auth.register('sync-seller', 'пароль-синхронизации');
  token = (await auth.login('sync-seller', 'пароль-синхронизации')).token;
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + server.address().port;
});
test.after(() => server.close());

test('в остатках на площадку уходит availableStock, а не сырой остаток', async () => {
  await fresh();
  await stock.setMany([{ id: 'SKU-001', field: 'stock', value: 10 }], { reason: 'manual' });
  const p = catalog.byId('SKU-001');
  const sent = row(createSync({ client: fakeClient() }).plan(), 'SKU-001');
  assert.equal(sent.stock, stock.availableStock(p, 'MARKETPLACE'));
  assert.equal(sent.stock, 10 - stock.bufferFor(p), 'страховой запас не уходит на площадку');
  assert.notEqual(sent.stock, 10);
});

test('буфер не вычитается второй раз', async () => {
  await fresh();
  await importer.run('Артикул;Страховой запас\nSKU-002;3\n');
  await stock.setMany([{ id: 'SKU-002', field: 'stock', value: 9 }], { reason: 'manual' });
  const sent = row(createSync({ client: fakeClient() }).plan(), 'SKU-002');
  assert.equal(sent.stock, 6, '9 − буфер позиции 3');
  assert.equal(sent.stock, stock.availableStock(catalog.byId('SKU-002'), 'MARKETPLACE'));
});

test('позиции со склада площадки в выгрузке остатков отсутствуют', async () => {
  await fresh();
  const fbo = catalog.all().find(p => p.fulfillment === 'FBO');
  const plan = createSync({ client: fakeClient() }).plan();
  assert.equal(row(plan, fbo.id), undefined, 'остаток FBO ведёт площадка');
  assert.ok(plan.prices.some(r => r.offer_id === fbo.id), 'а цену задаёт продавец — она уходит');
  assert.deepEqual(plan.skipped.fbo, [fbo.id]);
});

test('наборы не выгружаются', async () => {
  await fresh();
  await importer.run('Артикул;Название;Цена;Состав набора\nKIT-S;Набор;900;SKU-001×2|SKU-002\n');
  const plan = createSync({ client: fakeClient() }).plan();
  assert.ok(!plan.prices.some(r => r.offer_id === 'KIT-S'));
  assert.ok(!plan.stocks.some(r => r.offer_id === 'KIT-S'));
  assert.deepEqual(plan.skipped.bundles, ['KIT-S']);
});

test('десять изменений подряд дают одну посылку, а не десять', async () => {
  await fresh();
  const fake = fakeClient();
  const s = createSync({ client: fake, windowMs: 60 }).start();
  try {
    const ids = ['SKU-001', 'SKU-002', 'SKU-003', 'SKU-004', 'SKU-005'];
    for (let i = 0; i < 10; i++) await orders.create({ items: [{ id: ids[i % 5], qty: 1 }], channel: 'SITE', customer });
    await sleep(200);
    assert.equal(fake.calls.stocks.length, 1, 'одна посылка остатков');
    assert.equal(fake.calls.prices.length, 0, 'цены не менялись — не уходят');
    assert.deepEqual(fake.calls.stocks[0].map(r => r.offer_id).sort(), ids);
    assert.equal(row({ stocks: fake.calls.stocks[0] }, 'SKU-001').stock, stock.availableStock(catalog.byId('SKU-001'), 'MARKETPLACE'), 'значение на момент отправки');
    const log = await s.log();
    assert.equal(log.entries.length, 1);
    assert.deepEqual([log.entries[0].kind, log.entries[0].mode, log.entries[0].reasons], ['stocks', 'dry-run', ['order']]);
  } finally { s.stop(); }
});

test('отказ площадки: повторы, затем журнал; витрина и заказы работают', async () => {
  await fresh();
  const fake = fakeClient({ fail: Infinity });
  const s = createSync({ client: fake, windowMs: 20, retries: 3, baseDelayMs: 15 }).start();
  try {
    const t0 = Date.now();
    const o = await orders.create({ items: [{ id: 'SKU-004', qty: 1 }], channel: 'SITE', customer });
    assert.match(o.id, /^ORD-/, 'заказ создан, не дожидаясь площадки');
    const shop = await call('GET', '/api/catalog');
    assert.equal(shop.status, 200, 'витрина работает, пока площадка отказывает');
    await sleep(200);
    assert.equal(fake.calls.stocks.length, 3, 'три попытки');
    assert.ok(Date.now() - t0 >= 15 + 30, 'паузы между попытками нарастают');
    const log = await s.log();
    assert.deepEqual([log.entries[0].ok, log.entries[0].attempts], [false, 3]);
    assert.match(log.entries[0].error, /нет связи: площадка недоступна/);
    assert.match(log.alert.message, /Площадка не приняла остатки.*Витрина и заказы работают/);
    assert.equal(log.pending, 1, 'позиция осталась в очереди на следующий раз');
    // отказ «плохой запрос» не повторяется
    const bad = fakeClient({ fail: Infinity, status: 400 });
    const s2 = createSync({ client: bad, windowMs: 10, retries: 3, baseDelayMs: 1 });
    await s2.run();
    assert.equal(bad.calls.prices.length, 1, '400 — без повторов');
  } finally { s.stop(); }
  // следующая удачная отправка снимает уведомление
  const ok = createSync({ client: fakeClient(), windowMs: 10 });
  await ok.run();
  assert.equal((await ok.log()).alert, null);
});

test('ручной запуск в режиме предпросмотра ничего не отправляет', async () => {
  await fresh();
  const fake = fakeClient();
  const before = realClient.journal.length;
  const p = await createSync({ client: fake }).run({ preview: true });
  assert.equal(p.preview, true);
  assert.ok(p.prices.length && p.stocks.length, 'показано, что уйдёт');
  assert.deepEqual([fake.calls.prices.length, fake.calls.stocks.length], [0, 0]);
  const http = await call('POST', '/api/sync/run?dryRun=1', token);
  assert.deepEqual([http.status, http.body.preview], [200, true]);
  assert.equal(realClient.journal.length, before, 'даже в журнал намерений ничего не записано');
  assert.equal((await call('POST', '/api/sync/run?dryRun=1')).status, 401, 'ручной запуск — за входом');
  const log = await call('GET', '/api/sync/log', token);
  assert.equal(log.status, 200);
  assert.equal((await call('GET', '/api/sync/log')).status, 401, 'журнал — за входом');
});

test('сверка без данных площадки отвечает «нет данных», а не «расхождений нет»', async () => {
  await fresh();
  const d = await call('GET', '/api/sync/diff', token);
  assert.equal(d.status, 200);
  assert.equal(d.body.status, 'NO_DATA');
  assert.ok(!('mismatches' in d.body), 'пустой список расхождений не отдаётся');
  assert.match(d.body.message, /это не значит, что расхождений нет/);
  assert.equal((await call('GET', '/api/sync/diff')).status, 401);
  // сухой прогон тоже не даёт данных площадки
  const dry = createSync({ client: fakeClient(), windowMs: 10 });
  await dry.run();
  assert.equal((await dry.diff()).status, 'NO_DATA');
  // когда площадка приняла выгрузку — есть с чем сравнивать
  const mp = config.load().marketplace;
  const live = createSync({ client: fakeClient({ live: true }), windowMs: 10 });
  const noWarehouse = await live.run();
  assert.match(noWarehouse.entries.find(e => e.kind === 'stocks').error, /не задан marketplace.warehouseId/, 'без склада остатки в бой не уходят');
  assert.ok((await live.diff()).mismatches.every(m => m.field === 'stock' && m.theirs === null), 'и сверка это показывает');
  mp.warehouseId = 'WH-1';
  try {
    await live.run();
    const ok = await live.diff();
    assert.deepEqual([ok.status, ok.mismatches.length, ok.source], ['OK', 0, 'accepted']);
    await importer.run('Артикул;Цена\nSKU-003;999\n');
    const d2 = await live.diff();
    assert.equal(d2.status, 'MISMATCH');
    assert.deepEqual(d2.mismatches.map(m => [m.offer_id, m.field, m.ours, m.theirs]), [['SKU-003', 'price', '999', '413']]);
  } finally { mp.warehouseId = ''; }
});

test('без ключей всё идёт в сухой прогон, боевой вызов невозможен', async () => {
  await fresh();
  const cfg = config.load().marketplace;
  const savedDry = cfg.dryRun, savedFetch = global.fetch;
  let called = 0;
  cfg.dryRun = false;                                   // даже если в конфиге сняли сухой режим
  global.fetch = async () => { called++; throw new Error('боевой вызов'); };
  try {
    assert.equal(realClient.isDry(), true, 'ключей нет — режим сухой');
    const before = realClient.journal.length;
    const r = await createSync({ windowMs: 10 }).run();
    assert.ok(r.entries.length && r.entries.every(e => e.mode === 'dry-run' && e.ok));
    assert.ok(realClient.journal.length > before, 'намерения записаны в журнал');
    assert.equal(called, 0, 'сеть не трогалась');
    assert.equal(await realClient.fetchState(), null, 'и читать с площадки нечего');
  } finally { cfg.dryRun = savedDry; global.fetch = savedFetch; }
});
