'use strict';
/**
 * Один и тот же сценарий на любом профиле: BRAND_CONFIG=<конфиг> node tests/profiles/probe.js
 * Печатает итог одной строкой JSON. Сравнение профилей — в tests/unit/profiles.test.js.
 * Модель не вызывается: подставляется поддельный ответчик.
 */
process.env.STORE_PROVIDER = 'memory';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'profile-probe-secret-0123456789-abcdef';
process.env.MODEL_API_KEY = 'profile-probe-fake-key';
const fs = require('fs');
const path = require('path');
const { config, catalog, stock, orders, importer, sync, agent, auth, marketplace } = require('../../api/server');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'catalog-bundles.csv');
const lvl = id => stock.level(id).stock;
const pair = () => ['IMP-004', 'IMP-005'].map(lvl);

(async () => {
  const out = { profile: {
    instance: config.get('instance.id'), brand: config.get('brand.name'), typography: config.get('brand.typography'),
    accent: config.get('brand.palette.accent'), marketplace: config.get('marketplace.enabled'),
    channels: config.load().channels.filter(c => c.enabled).map(c => c.code), bufferDefault: config.get('stock.bufferDefault')
  } };
  await catalog.init(); await stock.init(); await agent.init();
  config.load().marketplace.syncWindowMs = 30;              // окно пакетирования: проверке не ждать
  sync.start();

  out.import = (await importer.run(fs.readFileSync(FIXTURE))).summary;
  const item = catalog.byId('IMP-004'), kit = catalog.byId('SET-002');
  out.stock = { buffer: stock.bufferFor(item), physical: lvl('IMP-004'),
    site: stock.availableStock(item, 'SITE'), kitSite: stock.availableStock(kit, 'SITE'),
    marketplace: stock.availableStock(item, 'MARKETPLACE') };

  const before = pair();
  const order = await orders.create({ items: [{ id: 'SET-002', qty: 1 }], channel: 'SITE', customer: { name: 'Проверка профиля' } });
  out.order = { lines: order.items.length, total: order.total, reserved: order.reserved.map(r => r.id + '×' + r.qty) };
  out.afterOrder = pair();
  await new Promise(r => setTimeout(r, 200));
  await orders.advance(order.id, 'CANCELLED', 'проверка');
  await new Promise(r => setTimeout(r, 200));
  out.afterCancel = pair();
  out.restored = JSON.stringify(before) === JSON.stringify(out.afterCancel);
  out.stockReasons = [...new Set(stock.log().filter(e => e.reason !== 'seed').map(e => e.reason))].sort();

  const log = await sync.log();
  const run = await sync.run({ preview: true });
  const diff = await sync.diff();
  out.sync = { disabled: !!log.disabled, message: log.message || null, entries: log.entries.length, intents: marketplace.journal.length,
    run: { disabled: !!run.disabled, prices: (run.prices || []).length, stocks: (run.stocks || []).length },
    diff: diff.status || 'OK' };

  agent._setResponder(async () => ({ model: 'fake', stop_reason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 100 },
    content: [{ type: 'text', text: JSON.stringify({ reply: 'Вот подборка.', items: [{ id: 'IMP-004', qty: 1 }, { id: 'НЕТ-ТАКОГО', qty: 2 }] }) }] }));
  const said = await agent.message({ visitorId: 'profile-probe-01', ip: '127.0.0.1', text: 'подберите к чаю' });
  const stats = await agent.stats();
  out.agent = { available: agent.available(), items: said.items.map(i => i.id + '×' + i.qty), total: said.total,
    dropped: stats.recent[0].turns[0].dropped.map(d => d.id), costUsd: stats.recent[0].costUsd,
    limits: stats.limits };

  const session = await auth.register('probe-seller', 'пароль-профиля-1').then(() => auth.login('probe-seller', 'пароль-профиля-1'));
  const seller = await auth.requireSeller({ headers: { authorization: 'Bearer ' + session.token } });
  out.auth = { token: !!session.token, owner: auth.owns(seller), instance: seller.instanceId };

  console.log(JSON.stringify(out));
  process.exit(0);
})().catch(e => { console.error(e.stack); process.exit(1); });
