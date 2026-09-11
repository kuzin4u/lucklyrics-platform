'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawnSync } = require('child_process');
const config = require('../../api/lib/config');

const ROOT = path.resolve(__dirname, '..', '..');
/** Отдельный процесс: источник конфига читается при загрузке модуля. */
function start(env, code) {
  return spawnSync(process.execPath, ['-e', code], { cwd: ROOT, encoding: 'utf8',
    env: Object.assign({}, process.env, { BRAND_CONFIG: '', BRAND_CONFIG_JSON: '' }, env) });
}

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

test('на площадке размещения конфиг берётся из BRAND_CONFIG_JSON', () => {
  const json = JSON.stringify(require('../../config/brand.demo.json'));
  const r = start({ BRAND_CONFIG_JSON: json }, "const c=require('./api/lib/config'); console.log(c.load()._source + '|' + c.get('brand.name'))");
  assert.equal(r.stdout.trim(), 'env:BRAND_CONFIG_JSON|' + require('../../config/brand.demo.json').brand.name);
});

test('явно заданный, но негодный конфиг — отказ, а не тихий пример', () => {
  const bad = start({ BRAND_CONFIG_JSON: '{не json' }, "require('./api/lib/config').load()");
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /BRAND_CONFIG_JSON: не разобран JSON/);
  const missing = start({ BRAND_CONFIG: 'config/нет-такого.json' }, "require('./api/lib/config').load()");
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /BRAND_CONFIG: нет файла/);
  const invalid = start({ BRAND_CONFIG_JSON: '{"brand":{}}' }, "require('./api/lib/config').load()");
  assert.match(invalid.stderr, /не прошла проверку/, 'схема проверяется и для переменной');
  // сервер с таким конфигом не поднимается и говорит почему
  const srv = spawnSync(process.execPath, ['api/server.js'], { cwd: ROOT, encoding: 'utf8', timeout: 10000,
    env: Object.assign({}, process.env, { BRAND_CONFIG: 'config/нет-такого.json', JWT_SECRET: 'x'.repeat(40), PORT: '0' }) });
  assert.equal(srv.status, 1);
  assert.match(srv.stderr, /Сервер не запущен: BRAND_CONFIG: нет файла/);
});
