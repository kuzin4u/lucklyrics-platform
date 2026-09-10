'use strict';
const test = require('node:test');
const assert = require('node:assert');
const config = require('../../api/lib/config');

test('предпросмотр открывает чужой конфиг по имени', () => {
  const cfg = config.loadNamed('demo');
  assert.ok(cfg.brand.name);
  assert.ok(config.listPreviews().includes('demo'));
});

test('имя предпросмотра ограничено: выход за папку невозможен', () => {
  ['../secret', '/etc/passwd', 'brand.json', 'a'.repeat(50), ''].forEach(bad => {
    assert.throws(() => config.loadNamed(bad), err => {
      assert.ok(['BAD_PREVIEW_NAME','PREVIEW_NOT_FOUND'].includes(err.code), 'код ошибки: ' + err.code);
      return true;
    }, 'принято недопустимое имя: ' + bad);
  });
});

test('предпросмотр не подменяет активный конфиг', () => {
  const before = config.load().brand.name;
  config.loadNamed('demo');
  assert.equal(config.load().brand.name, before);
});

test('в публичной части предпросмотра тоже нет секретов', () => {
  const pub = JSON.stringify(config.publicConfig(config.loadNamed('demo')));
  ['apiKey','secret','dryRun','baseUrl','bufferDefault'].forEach(w =>
    assert.ok(!pub.toLowerCase().includes(w.toLowerCase()), 'утекло: ' + w));
});
