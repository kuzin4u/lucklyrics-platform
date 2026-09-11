'use strict';
/**
 * Хранилище: обе реализации проходят один и тот же набор проверок,
 * update не теряет параллельную запись.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const store = require('../../api/lib/store');
const dirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'store-test-')); dirs.push(d); return d; };
test.after(() => dirs.forEach(d => fs.rmSync(d, { recursive: true, force: true })));
const IMPLS = {
  memory: () => require('../../api/lib/store/memory').create(),
  file:   () => require('../../api/lib/store/file').create({ dir: tmp() })
};
const tick = () => new Promise(r => setImmediate(r));

test('каждая реализация хранилища даёт все три операции', () => {
  for (const [name, make] of Object.entries(IMPLS)) {
    const s = make();
    store.OPERATIONS.forEach(op => assert.equal(typeof s[op], 'function', name + ' без операции ' + op));
    assert.doesNotThrow(() => store.assertAdapter(s, name));
  }
  assert.deepEqual(Object.keys(store._drivers).sort(), Object.keys(IMPLS).sort(), 'каждая реализация покрыта тестами');
});

/** Один сценарий на обе реализации: протоколы должны совпасть. */
async function scenario(s) {
  const log = [];
  log.push(['нет записи', await s.read('orders')]);
  await s.write('orders', [{ id: 1, items: ['a'] }]);
  const got = await s.read('orders');
  log.push(['после записи', got]);
  got[0].items.push('изменено снаружи');
  log.push(['чтение отдаёт копию', await s.read('orders')]);
  log.push(['update возвращает новое', await s.update('orders', list => list.concat({ id: 2 }))]);
  log.push(['update с нуля', await s.update('counter', v => (v || 0) + 1)]);
  const failed = await s.update('orders', () => { throw new Error('отказ'); }).catch(e => e.message);
  log.push(['ошибка в update', failed, await s.read('orders')]);
  const undef = await s.update('orders', () => undefined).catch(e => /вернуть новое значение/.test(e.message));
  log.push(['update без результата — ошибка', undef, await s.read('orders')]);
  const bad = await s.read('../секреты').catch(e => e.code);
  log.push(['чужое имя', bad]);
  return log;
}

test('обе реализации ведут себя одинаково', async () => {
  const [mem, file] = await Promise.all([scenario(IMPLS.memory()), scenario(IMPLS.file())]);
  assert.deepEqual(file, mem);
  assert.deepEqual(mem[0], ['нет записи', null]);
  assert.deepEqual(mem[2][1], [{ id: 1, items: ['a'] }], 'снаружи хранилище не меняется');
  assert.deepEqual(mem[5][1], 'отказ');
  assert.equal(mem[5][2].length, 2, 'после ошибки в update данные прежние');
  assert.deepEqual(mem[7], ['чужое имя', 'BAD_STORE_NAME']);
});

for (const [name, make] of Object.entries(IMPLS)) {
  test(name + ': параллельные update не теряют записи', async () => {
    const s = make();
    await Promise.all(Array.from({ length: 50 }, (_, i) =>
      s.update('orders', async list => { await tick(); return (list || []).concat(i); })));
    const list = await s.read('orders');
    assert.equal(list.length, 50, 'ни одна запись не потеряна');
    assert.deepEqual([...list].sort((a, b) => a - b), Array.from({ length: 50 }, (_, i) => i));
  });
}

test('файловое хранилище пишет атомарно в свою папку и закрывает файл от чужих', async () => {
  const dir = tmp();
  const s = require('../../api/lib/store/file').create({ dir });
  await s.write('auth', { sellers: [] });
  assert.deepEqual(fs.readdirSync(dir), ['auth.json'], 'временных файлов не осталось');
  assert.equal(fs.statSync(path.join(dir, 'auth.json')).mode & 0o777, 0o600);
});

test('реализация выбирается конфигурацией, окружение перекрывает, неизвестная — отказ', () => {
  const name = env => execFileSync(process.execPath, ['-e', "console.log(require('./api/lib/store').name())"],
    { cwd: ROOT, env: Object.assign({}, process.env, { STORE_PROVIDER: '' }, env), encoding: 'utf8', stdio: 'pipe' }).trim();
  assert.equal(name({}), 'file', 'по умолчанию — из конфигурации');
  assert.equal(name({ STORE_PROVIDER: 'memory' }), 'memory');
  assert.throws(() => name({ STORE_PROVIDER: 'нет-такого' }), /неизвестное хранилище/);
});
