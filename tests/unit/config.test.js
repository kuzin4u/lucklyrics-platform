'use strict';
const test = require('node:test');
const assert = require('node:assert');
const config = require('../../api/lib/config');

test('конфиг загружается и содержит обязательные секции', () => {
  const c = config.load();
  ['brand','catalog','stock','payments','marketplace','channels','agent'].forEach(k =>
    assert.ok(c[k], 'нет секции ' + k));
});

test('get читает вложенные значения и отдаёт значение по умолчанию', () => {
  assert.equal(typeof config.get('brand.name'), 'string');
  assert.equal(config.get('нет.такого.пути', 'дефолт'), 'дефолт');
});

test('свойства канала описывают, кто считает сумму и чей остаток', () => {
  const site = config.channel('SITE');
  const mp = config.channel('MARKETPLACE');
  assert.equal(site.ownSum, true);
  assert.equal(mp.ownSum, false, 'сумму заказа площадки считает площадка');
  assert.throws(() => config.channel('НЕТ_ТАКОГО'), /неизвестный канал/);
});

test('публичная конфигурация не содержит секретов и служебных полей', () => {
  const pub = JSON.stringify(config.publicConfig());
  ['apiKey','secret','token','baseUrl','dryRun','bufferDefault'].forEach(word =>
    assert.ok(!pub.toLowerCase().includes(word.toLowerCase()), 'в публичный конфиг попало: ' + word));
});
