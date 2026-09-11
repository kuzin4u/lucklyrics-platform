'use strict';
/**
 * Импорт каталога: тридцать позиций за проход, идемпотентность, русские
 * и английские колонки, построчные ошибки, предпросмотр без записи, вход.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

process.env.STORE_PROVIDER = 'memory';
process.env.JWT_SECRET = 'import-test-secret-0123456789-abcdefghij';
const { server, catalog, store, importer, auth, stock } = require('../../api/server');

const FIXTURE = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'catalog-30.csv'));
const SEED = catalog.all().length;
let base, token;

async function fresh() { catalog.reset(); await store.write('catalog', { items: null }); catalog.reset(); await stock.reset(); }
const csv = rows => rows.join('\n') + '\n';
async function call(method, route, { body, type, auth: tk } = {}) {
  const headers = { 'Content-Type': type || 'application/json' };
  if (tk) headers.Authorization = 'Bearer ' + tk;
  const r = await fetch(base + route, { method, headers, body });
  return { status: r.status, body: await r.json() };
}

test.before(async () => {
  await auth.register('importer', 'пароль-импорта-1');
  token = (await auth.login('importer', 'пароль-импорта-1')).token;
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + server.address().port;
});
test.after(() => server.close());

test('тридцать позиций импортируются из файла за один проход', async () => {
  await fresh();
  const r = await importer.run(FIXTURE, { format: 'text/csv' });
  assert.deepEqual(r.summary, { rows: 30, created: 30, updated: 0, unchanged: 0, stock: 29, errors: 0 });
  assert.equal(r.applied, true);
  assert.equal(catalog.all().length, SEED + 30);
  const p = catalog.byId('IMP-005');
  assert.equal(p.price, 235.5, 'дробная цена с запятой');
  assert.equal(p.categoryTitle, 'Категория Б');
  assert.deepEqual(p.features, ['Признак один', 'Признак два'], 'список через |');
  assert.equal(catalog.byId('IMP-006').description, 'Позиция 06; описание с разделителем внутри', 'разделитель внутри кавычек');
  assert.equal(catalog.byId('IMP-001').attrs['Производитель'], 'Поставщик 2', 'неизвестная колонка создана полем');
  assert.deepEqual(r.columns.created, ['Производитель']);
  const site = catalog.forChannel('SITE').find(x => x.id === 'IMP-004');
  assert.equal(site.available, 12, 'витрина видит позицию и остаток из файла');
  assert.equal(stock.level('IMP-004').stock, 12, 'остаток — в записи склада');
  assert.ok(!('stock' in catalog.byId('IMP-004')), 'в описании товара остатка нет');
  assert.equal((await store.read('catalog')).items.length, SEED + 30, 'каталог записан в хранилище');
});

test('повторная загрузка того же файла не плодит дубли, изменения — обновляют', async () => {
  await fresh();
  await importer.run(FIXTURE);
  const again = await importer.run(FIXTURE);
  assert.deepEqual(again.summary, { rows: 30, created: 0, updated: 0, unchanged: 30, stock: 0, errors: 0 });
  assert.equal(again.applied, false, 'нечего писать — запись не делается');
  assert.equal(catalog.all().length, SEED + 30);
  const changed = FIXTURE.toString('utf8').replace('IMP-007;Позиция импорта 07;269;', 'IMP-007;Позиция импорта 07;299;');
  const third = await importer.run(changed);
  assert.deepEqual(third.summary, { rows: 30, created: 0, updated: 1, unchanged: 29, stock: 0, errors: 0 });
  assert.deepEqual(third.updated[0].changes, [{ field: 'price', title: 'цена', from: 269, to: 299 }]);
  assert.equal(catalog.byId('IMP-007').price, 299);
  assert.equal(catalog.all().filter(p => p.id === 'IMP-007').length, 1);
});

test('колонки узнаются по русским и английским названиям, регистр и пробелы не мешают', async () => {
  const pick = p => ({ id: p.id, title: p.title, price: p.price, stock: stock.level(p.id).stock, category: p.category });
  const results = [];
  const files = [
    csv(['Артикул;Наименование;Цена;Остаток;Категория', 'X-1;Первая;100;4;CAT-A', 'X-2;Вторая;200;0;CAT-B']),
    csv(['SKU,Name,Price,Stock,Category', 'X-1,Первая,100,4,CAT-A', 'X-2,Вторая,200,0,CAT-B']),
    csv(['  ID\t НАЗВАНИЕ \tPRICE\tКоличество\tcategory', 'X-1\tПервая\t100\t4\tCAT-A', 'X-2\tВторая\t200\t0\tCAT-B']),
    JSON.stringify([{ id: 'X-1', title: 'Первая', price: 100, stock: 4, category: 'CAT-A' },
      { id: 'X-2', title: 'Вторая', price: 200, stock: 0, category: 'CAT-B' }]),
    JSON.stringify({ items: [{ 'Артикул': 'X-1', 'Название': 'Первая', 'Цена': '100', 'Остаток': '4', 'Категория': 'CAT-A' },
      { 'Артикул': 'X-2', 'Название': 'Вторая', 'Цена': '200', 'Остаток': '0', 'Категория': 'CAT-B' }] })
  ];
  for (const f of files) {
    await fresh();
    const r = await importer.run(f);
    assert.equal(r.summary.errors, 0, JSON.stringify(r.errors));
    results.push(['X-1', 'X-2'].map(id => pick(catalog.byId(id))));
  }
  results.forEach(r => assert.deepEqual(r, results[0]));
  assert.deepEqual(results[0][0], { id: 'X-1', title: 'Первая', price: 100, stock: 4, category: 'CAT-A' });

  // файл из Excel в Windows-1251 — та же таблица
  const cp1251 = s => Buffer.from([...s].map(ch => {
    const c = ch.charCodeAt(0);
    if (c < 0x80) return c;
    if (c >= 0x410 && c <= 0x44f) return c - 0x350;
    if (c === 0x451) return 0xb8;
    if (c === 0x401) return 0xa8;
    throw new Error('нет в таблице: ' + ch);
  }));
  await fresh();
  await importer.run(cp1251(files[0]));
  assert.deepEqual(['X-1', 'X-2'].map(id => pick(catalog.byId(id))), results[0]);
});

test('ошибки собираются построчно и не прерывают разбор', async () => {
  await fresh();
  const r = await importer.run(csv([
    'Артикул;Название;Цена;Остаток;Рейтинг',
    'E-1;Годная первая;100;5;4.5',
    'E-2;Цена словами;сто;5;',
    'E-3;Годная вторая;200;1;',
    'E-4;Отрицательный остаток;50;-2;',
    'E-5;Годная третья;300;2;',
    ';Без артикула;10;1;',
    'E-1;Повтор артикула;100;5;',
    'E-6;Две ошибки;abc;1.5;9',
    'E-7;;;;',
    ';;;;'
  ]));
  assert.deepEqual(r.errors.map(e => e.message), [
    'строка 3: цена не число («сто»)',
    'строка 5: остаток — нужно целое число от нуля («-2»)',
    'строка 7: нет артикула',
    'строка 8: артикул E-1 уже был в строке 2',
    'строка 9: цена не число («abc»)',
    'строка 9: остаток — нужно целое число от нуля («1.5»)',
    'строка 9: рейтинг — нужно число от 0 до 5 («9»)',
    'строка 10: нет названия — у новой позиции оно обязательно',
    'строка 10: нет цены — у новой позиции она обязательна'
  ]);
  assert.deepEqual(r.created.map(c => c.id), ['E-1', 'E-3', 'E-5'], 'годные строки после ошибочных применены');
  assert.equal(catalog.byId('E-2'), null, 'строка с ошибкой пропущена');
  assert.equal(r.summary.rows, 10);
});

test('предпросмотр показывает план и ничего не пишет', async () => {
  await fresh();
  const before = await store.read('catalog');
  const preview = await importer.run(FIXTURE, { dryRun: true });
  assert.equal(preview.dryRun, true);
  assert.equal(preview.applied, false);
  assert.equal(preview.summary.created, 30);
  assert.equal(catalog.all().length, SEED, 'каталог в памяти не изменился');
  assert.deepEqual(await store.read('catalog'), before, 'в хранилище ничего не записано');
  assert.equal(catalog.byId('IMP-001'), null);
  const real = await importer.run(FIXTURE);
  assert.deepEqual(real.summary, preview.summary, 'предпросмотр совпадает с настоящим импортом');
});

test('импорт закрыт авторизацией кабинета', async () => {
  await fresh();
  const anon = await call('POST', '/api/catalog/import?dryRun=1', { body: FIXTURE, type: 'text/csv' });
  assert.deepEqual([anon.status, anon.body.error], [401, 'UNAUTHORIZED']);
  const bad = await call('POST', '/api/catalog/import', { body: FIXTURE, type: 'text/csv', auth: 'a.b.c' });
  assert.equal(bad.status, 401);
  assert.equal(catalog.byId('IMP-001'), null, 'без входа ничего не импортировано');

  const stranger = await auth.register('other-shop-seller', 'пароль-чужого-1', { instanceId: 'other-shop' })
    .then(() => auth.login('other-shop-seller', 'пароль-чужого-1'));
  assert.equal((await call('POST', '/api/catalog/import', { body: FIXTURE, type: 'text/csv', auth: stranger.token })).status, 403);

  const preview = await call('POST', '/api/catalog/import?dryRun=1', { body: FIXTURE, type: 'text/csv', auth: token });
  assert.deepEqual([preview.status, preview.body.summary.created, preview.body.dryRun], [200, 30, true]);
  assert.equal(catalog.byId('IMP-001'), null, 'предпросмотр по HTTP тоже не пишет');
  const done = await call('POST', '/api/catalog/import', { body: FIXTURE, type: 'text/csv', auth: token });
  assert.deepEqual([done.status, done.body.applied], [200, true]);
  const shop = await call('GET', '/api/catalog');
  assert.ok(shop.body.items.some(p => p.id === 'IMP-030'), 'витрина видит импортированное');
  const broken = await call('POST', '/api/catalog/import', { body: 'Название;Цена\nБез артикула;10\n', type: 'text/csv', auth: token });
  assert.deepEqual([broken.status, broken.body.error], [400, 'BAD_FILE']);
  assert.match(broken.body.message, /нет колонки с артикулом/);
});
