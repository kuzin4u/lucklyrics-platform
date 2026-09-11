'use strict';
/**
 * Смена пароля: из кабинета — старый, новый, подтверждение; скрипт с --force.
 * Файловое хранилище во временной папке: скрипт — отдельный процесс.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'password-test-'));
process.env.STORE_PROVIDER = 'file';
process.env.DATA_DIR = DATA_DIR;
process.env.JWT_SECRET = 'password-test-secret-0123456789-abcdefgh';
const { server, auth } = require('../../api/server');

let base;
const A = { login: 'owner-a', password: 'старый-пароль-А' };
const B = { login: 'owner-b', password: 'пароль-продавца-Б' };
async function call(method, route, { body, tk } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (tk) headers.Authorization = 'Bearer ' + tk;
  const r = await fetch(base + route, { method, headers, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}
const login = (l, p) => call('POST', '/api/auth/login', { body: { login: l, password: p } });
const script = (...args) => spawnSync(process.execPath, ['api/scripts/add-seller.js', ...args], { cwd: ROOT, encoding: 'utf8', env: process.env });

test.before(async () => {
  await auth.register(A.login, A.password);
  await auth.register(B.login, B.password);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + server.address().port;
});
test.after(() => { server.close(); fs.rmSync(DATA_DIR, { recursive: true, force: true }); });

test('смена пароля с верным старым проходит, старый после этого не работает', async () => {
  const s = (await login(A.login, A.password)).body.token;
  const other = (await login(A.login, A.password)).body.token;          // вторая открытая сессия
  const r = await call('POST', '/api/auth/password', { tk: s, body: { oldPassword: A.password, newPassword: 'новый-пароль-А', confirm: 'новый-пароль-А' } });
  assert.equal(r.status, 200);
  assert.ok(r.body.token, 'в ответ — новая сессия');
  assert.equal((await login(A.login, A.password)).status, 401, 'старый пароль больше не входит');
  assert.equal((await login(A.login, 'новый-пароль-А')).status, 200);
  assert.equal((await call('GET', '/api/orders', { tk: r.body.token })).status, 200, 'текущая страница продолжает работать');
  const stale = await call('GET', '/api/orders', { tk: other });
  assert.deepEqual([stale.status, stale.body.reason], [401, 'PASSWORD_CHANGED'], 'другие сессии оборваны');
  assert.equal((await call('GET', '/api/orders', { tk: s })).status, 401, 'и та, из которой меняли, — тоже');
  A.password = 'новый-пароль-А';
});

test('с неверным старым паролем — отказ, пароль прежний', async () => {
  const tk = (await login(A.login, A.password)).body.token;
  const r = await call('POST', '/api/auth/password', { tk, body: { oldPassword: 'не-тот-пароль', newPassword: 'другой-пароль-1', confirm: 'другой-пароль-1' } });
  assert.deepEqual([r.status, r.body.error], [400, 'WRONG_PASSWORD']);
  assert.equal(r.body.message, 'старый пароль неверен');
  assert.equal((await login(A.login, A.password)).status, 200);
  assert.equal((await call('GET', '/api/orders', { tk })).status, 200, 'неудачная попытка сессию не обрывает');
  assert.equal((await call('POST', '/api/auth/password', { body: { oldPassword: A.password, newPassword: 'x'.repeat(10), confirm: 'x'.repeat(10) } })).status, 401, 'без входа — 401');
});

test('короткий новый пароль и несовпадающее подтверждение — отказ', async () => {
  const tk = (await login(A.login, A.password)).body.token;
  const short = await call('POST', '/api/auth/password', { tk, body: { oldPassword: A.password, newPassword: 'коротк', confirm: 'коротк' } });
  assert.deepEqual([short.status, short.body.error], [400, 'WEAK_PASSWORD']);
  const mismatch = await call('POST', '/api/auth/password', { tk, body: { oldPassword: A.password, newPassword: 'длинный-пароль-1', confirm: 'длинный-пароль-2' } });
  assert.deepEqual([mismatch.status, mismatch.body.error], [400, 'PASSWORD_MISMATCH']);
  const same = await call('POST', '/api/auth/password', { tk, body: { oldPassword: A.password, newPassword: A.password, confirm: A.password } });
  assert.deepEqual([same.status, same.body.error], [400, 'SAME_PASSWORD']);
  assert.equal((await login(A.login, A.password)).status, 200, 'пароль не изменился');
});

test('чужой продавец сменить не может: логин — только из токена', async () => {
  const tkB = (await login(B.login, B.password)).body.token;
  const r = await call('POST', '/api/auth/password', { tk: tkB, body: { login: A.login, oldPassword: A.password, newPassword: 'захват-пароля-1', confirm: 'захват-пароля-1' } });
  assert.deepEqual([r.status, r.body.error], [400, 'WRONG_PASSWORD'], 'пароль А не подходит к Б — смена идёт для Б');
  assert.equal((await login(A.login, A.password)).status, 200, 'пароль А не тронут');
  assert.equal((await login(A.login, 'захват-пароля-1')).status, 401);
  // продавец другого экземпляра до смены пароля не допускается вовсе
  await auth.register('stranger', 'пароль-чужака-1', { instanceId: 'other-shop' });
  const tkS = (await login('stranger', 'пароль-чужака-1')).body.token;
  const f = await call('POST', '/api/auth/password', { tk: tkS, body: { oldPassword: 'пароль-чужака-1', newPassword: 'новый-чужак-1', confirm: 'новый-чужак-1' } });
  assert.equal(f.status, 403);
});

test('скрипт без --force отказывается перезаписывать, с ключом — перезаписывает', async () => {
  const before = (await login(B.login, B.password)).body.token;
  const refuse = script(B.login, 'сброшенный-пароль-1');
  assert.equal(refuse.status, 1);
  assert.match(refuse.stderr, /уже заведён; перезаписать — ключ --force/);
  assert.equal((await login(B.login, B.password)).status, 200, 'без ключа пароль прежний');
  const force = script(B.login, 'сброшенный-пароль-1', '--force');
  assert.equal(force.status, 0, force.stderr);
  assert.match(force.stdout, /Пароль продавца перезаписан: owner-b/);
  assert.equal((await login(B.login, B.password)).status, 401, 'старый не входит');
  assert.equal((await login(B.login, 'сброшенный-пароль-1')).status, 200, 'новый входит');
  assert.equal((await call('GET', '/api/orders', { tk: before })).status, 401, 'сессии до сброса оборваны');
  const sellers = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'auth.json'), 'utf8')).sellers;
  assert.equal(sellers.filter(s => s.login === B.login).length, 1, 'запись одна, не дубль');
  assert.ok(!JSON.stringify(sellers).includes('сброшенный-пароль-1'), 'в открытом виде не хранится');
  assert.match(script('new-seller', 'пароль-нового-1', '--force').stdout, /Продавец добавлен/, 'с ключом новый логин заводится как обычно');
});
