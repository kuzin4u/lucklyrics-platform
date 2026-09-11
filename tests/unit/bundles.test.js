'use strict';
/**
 * Наборы: своя карточка и цена, остатка нет, доступность — минимум по составу,
 * списание компонентов атомарное, отмена возвращает ровно списанное.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

process.env.STORE_PROVIDER = 'memory';
const catalog = require('../../api/lib/catalog');
const stock = require('../../api/lib/stock');
const orders = require('../../api/lib/orders');
const importer = require('../../api/lib/import');
const store = require('../../api/lib/store');

const FIXTURE = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'catalog-bundles.csv'));
const customer = { name: 'Покупатель' };
const lvl = id => stock.level(id).stock;

async function fresh() {
  catalog.reset(); await store.write('catalog', null); await stock.reset(); await orders.reset();
  const r = await importer.run(FIXTURE);
  assert.equal(r.summary.errors, 0, JSON.stringify(r.errors));
  return r;
}

test('тридцать позиций и три набора — одним файлом, набор может стоять раньше своих компонентов', async () => {
  const r = await fresh();
  assert.deepEqual([r.summary.rows, r.summary.created], [33, 33]);
  assert.deepEqual(r.created.filter(c => c.kind === 'bundle').map(c => c.id), ['SET-001', 'SET-002', 'SET-003']);
  const set3 = catalog.byId('SET-003');
  assert.deepEqual(set3.components, [{ id: 'IMP-010', qty: 3 }, { id: 'IMP-011', qty: 2 }, { id: 'IMP-012', qty: 1 }]);
  assert.equal(set3.price, 1490, 'цена набора задана, а не сложена из компонентов');
  assert.deepEqual(stock.level('SET-001'), { stock: 0, marketplaceStock: 0 }, 'своего остатка у набора нет');
  assert.equal(catalog.byId('IMP-002').buffer, 3, 'страховой запас позиции из файла');
  const card = catalog.forChannel('SITE').find(p => p.id === 'SET-002');
  assert.deepEqual(card.components, [{ id: 'IMP-004', title: 'Позиция импорта 04', qty: 2 }, { id: 'IMP-005', title: 'Позиция импорта 05', qty: 1 }]);
});

test('доступность набора — минимум по составу с учётом кратности', async () => {
  await fresh();
  // IMP-010: 5, IMP-011: 8, IMP-012: 11 → min(5/3, 8/2, 11/1) = min(1, 4, 11)
  assert.deepEqual(['IMP-010', 'IMP-011', 'IMP-012'].map(lvl), [5, 8, 11]);
  assert.equal(stock.availableStock(catalog.byId('SET-003'), 'SITE'), 1);
  await stock.adjust({ id: 'IMP-010', value: 30, reason: 'приход' });
  assert.equal(stock.availableStock(catalog.byId('SET-003'), 'SITE'), 4, 'теперь узкое место — IMP-011');
  assert.equal(stock.availableStock(catalog.byId('SET-002'), 'SITE'), Math.min(Math.floor(12 / 2), 15));
});

test('буфер не вычитается дважды: набор на площадке — из уже уменьшенных остатков компонентов', async () => {
  await fresh();
  const set = catalog.byId('SET-001');
  const comps = set.components.map(c => catalog.byId(c.id));
  // IMP-001: 3 − буфер 1 (позиция), IMP-002: 6 − 3 (позиция), IMP-003: 9 − 2 (по умолчанию)
  assert.deepEqual(comps.map(p => stock.availableStock(p, 'MARKETPLACE')), [2, 3, 7]);
  const expected = Math.min(...set.components.map((c, i) => Math.floor(stock.availableStock(comps[i], 'MARKETPLACE') / c.qty)));
  assert.equal(stock.availableStock(set, 'MARKETPLACE'), expected);
  assert.equal(expected, 2);
  assert.equal(stock.availableStock(set, 'SITE'), 3, 'на витрине буфер не держится');
});

test('главный: одного компонента не хватает — заказ отбивается, остальные компоненты не списаны', async () => {
  await fresh();
  await stock.adjust({ id: 'IMP-005', value: 0, reason: 'кончился' });
  const before = { a: lvl('IMP-004'), log: stock.log().length };
  await assert.rejects(() => orders.create({ items: [{ id: 'SET-002', qty: 1 }], channel: 'SITE', customer }),
    e => e.code === 'NOT_ENOUGH_STOCK');
  assert.equal(lvl('IMP-004'), before.a, 'второй компонент набора не списан');
  assert.equal(stock.log().length, before.log, 'в журнале ни одного движения');
  assert.equal((await orders.allOrders()).length, 0, 'заказ не создан');

  // то же на уровне склада: первая строка проходит, вторая нет — не списано ничего
  await assert.rejects(() => stock.reserveMany([{ id: 'IMP-004', qty: 2 }, { id: 'IMP-005', qty: 1 }], 'SITE'),
    e => e.code === 'NOT_ENOUGH_STOCK' && e.id === 'IMP-005');
  assert.equal(lvl('IMP-004'), before.a);

  // набор и та же позиция отдельно делят остаток: 2 в наборе + 11 отдельно > 12
  await stock.adjust({ id: 'IMP-005', value: 5, reason: 'приход' });
  await assert.rejects(() => orders.create({ items: [{ id: 'SET-002', qty: 1 }, { id: 'IMP-004', qty: 11 }], channel: 'SITE', customer }),
    e => e.code === 'NOT_ENOUGH_STOCK' && e.id === 'IMP-004');
  assert.deepEqual([lvl('IMP-004'), lvl('IMP-005')], [12, 5]);

  // гонка: корзина проверена у обоих, последний IMP-005 забирает первый заказ — набор не списывает ничего
  await stock.adjust({ id: 'IMP-005', value: 1, reason: 'остался один' });
  const [single, bundle] = await Promise.allSettled([
    orders.create({ items: [{ id: 'IMP-005', qty: 1 }], channel: 'SITE', customer }),
    orders.create({ items: [{ id: 'SET-002', qty: 1 }], channel: 'SITE', customer })
  ]);
  assert.equal(single.status, 'fulfilled');
  assert.equal(bundle.status, 'rejected');
  assert.equal(bundle.reason.code, 'NOT_ENOUGH_STOCK');
  assert.deepEqual([lvl('IMP-004'), lvl('IMP-005')], [12, 0], 'IMP-004 из отбитого набора не списан');
});

test('заказ набора: одна строка со своей ценой, компоненты списаны и записаны в заказ', async () => {
  await fresh();
  const o = await orders.create({ items: [{ id: 'SET-001', qty: 2 }], channel: 'SITE', customer });
  assert.equal(o.items.length, 1, 'покупатель видит набор, а не россыпь');
  assert.deepEqual([o.items[0].id, o.items[0].kind, o.items[0].price, o.items[0].sum], ['SET-001', 'bundle', 999, 1998]);
  assert.deepEqual(o.reserved, [
    { id: 'IMP-001', title: 'Позиция импорта 01', qty: 2 },
    { id: 'IMP-002', title: 'Позиция импорта 02', qty: 2 },
    { id: 'IMP-003', title: 'Позиция импорта 03', qty: 2 }]);
  assert.deepEqual(['IMP-001', 'IMP-002', 'IMP-003'].map(lvl), [1, 4, 7]);
  assert.deepEqual(stock.log({ id: 'IMP-002' })[0], Object.assign({}, stock.log({ id: 'IMP-002' })[0], { reason: 'order', delta: -2, ref: o.id }));
});

test('отмена заказа с набором возвращает все компоненты — ровно списанное, даже если состав с тех пор поменялся', async () => {
  await fresh();
  const o = await orders.create({ items: [{ id: 'SET-002', qty: 2 }], channel: 'SITE', customer });
  assert.deepEqual([lvl('IMP-004'), lvl('IMP-005')], [8, 13]);
  await importer.run('Артикул;Состав набора\nSET-002;IMP-004×1|IMP-006×1\n');
  const imp6 = lvl('IMP-006');
  await orders.advance(o.id, 'CANCELLED', 'owner');
  assert.deepEqual([lvl('IMP-004'), lvl('IMP-005'), lvl('IMP-006')], [12, 15, imp6]);
  const back = stock.log().filter(e => e.reason === 'cancel' && e.ref === o.id);
  assert.deepEqual(back.map(e => [e.id, e.delta, e.by]).sort(), [['IMP-004', 4, 'owner'], ['IMP-005', 2, 'owner']]);
});

test('набор внутри набора не импортируется', async () => {
  await fresh();
  const r = await importer.run([
    'Артикул;Название;Цена;Состав набора',
    'SET-X;В наборе набор;100;SET-001×1|IMP-001×1',
    'SET-Y;Новый набор;200;IMP-002×1',
    'SET-Z;Ссылается на новый набор;300;SET-Y×2',
    'SET-S;Сам в себе;400;SET-S×1'
  ].join('\n'));
  assert.deepEqual(r.errors.map(e => e.message), [
    'строка 2: набор внутри набора запрещён: SET-001 — набор',
    'строка 4: набор внутри набора запрещён: SET-Y — набор',
    'строка 5: набор не может входить в себя'
  ]);
  assert.deepEqual(r.created.map(c => c.id), ['SET-Y']);
  assert.equal(catalog.byId('SET-X'), null);
});

test('ссылка на несуществующий компонент — ошибка строки, остальные строки применяются', async () => {
  await fresh();
  const r = await importer.run([
    'Артикул;Название;Цена;Остаток;Состав набора',
    'SET-N;С дырой;500;;IMP-001×1|НЕТ-ТАКОГО×2',
    'NEW-1;Новая позиция;120;4;',
    'SET-OK;Годный набор;300;;NEW-1×2|IMP-001',
    'SET-B;Битый компонент;300;;NEW-2×1',
    'NEW-2;Позиция с ошибкой;дорого;1;',
    'IMP-001;;;;IMP-002×1'
  ].join('\n'));
  assert.deepEqual(r.errors.map(e => e.message), [
    'строка 2: компонент НЕТ-ТАКОГО не найден в каталоге',
    'строка 5: компонент NEW-2 не импортируется: ошибка в строке 6',
    'строка 6: цена не число («дорого»)',
    'строка 7: позиция уже заведена как товар — набор заводится отдельным артикулом'
  ]);
  assert.deepEqual(r.created.map(c => c.id), ['NEW-1', 'SET-OK']);
  assert.equal(stock.availableStock(catalog.byId('SET-OK'), 'SITE'), 2, 'min(4/2, 3/1)');
  assert.equal(catalog.byId('IMP-001').kind, 'item');
});
