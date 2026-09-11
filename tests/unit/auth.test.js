'use strict';
/**
 * Вход в кабинет и защита записи. Сервер поднимается на свободном порту,
 * запросы идут по HTTP — проверяется весь путь, а не только модуль.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..');
// файловое хранилище во временной папке: проверяется то, что реально лежит на диске
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-test-'));
process.env.STORE_PROVIDER = 'file';
process.env.DATA_DIR = DATA_DIR;
const SECRET = 'test-secret-for-cabinet-tokens-0123456789';
const OTHER_SECRET = 'another-instance-secret-9876543210-abcdef';
process.env.JWT_SECRET = SECRET;

const { server, config, catalog, orders, auth } = require('../../api/server');

const A = { login: 'seller-a', password: 'пароль-продавца-А' };
const STRANGER = { login: 'stranger', password: 'пароль-чужого-экземпляра' };
const AUTH_PATH = path.join(DATA_DIR, 'auth.json');
let base;

async function call(method, route, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(base + route, { method, headers, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}
async function newOrder() {
  const p = catalog.all().find(x => x.fulfillment !== 'FBO' && x.stock >= 4);
  const r = await call('POST', '/api/orders', { body: { items: [{ id: p.id, qty: 1 }], channel: 'SITE', customer: { name: 'Покупатель' } } });
  assert.equal(r.status, 201, 'покупатель оформляет заказ без входа');
  return r.body;
}
function withSecret(value, fn) {
  const saved = process.env.JWT_SECRET;
  if (value === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = value;
  return Promise.resolve().then(fn).finally(() => { process.env.JWT_SECRET = saved; });
}
const payloadOf = token => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));

test.before(async () => {
  await orders.reset(); catalog.reset();
  await auth.register(A.login, A.password);
  await auth.register(STRANGER.login, STRANGER.password, { instanceId: 'someone-else' });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + server.address().port;
});
test.after(() => {
  server.close();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

test('пароль в хранилище не хранится в открытом виде', async () => {
  await auth.register('twin-one', 'одинаковый-пароль');
  await auth.register('twin-two', 'одинаковый-пароль');
  const raw = fs.readFileSync(AUTH_PATH, 'utf8');
  for (const pw of [A.password, STRANGER.password, 'одинаковый-пароль']) assert.ok(!raw.includes(pw), 'пароль лежит в файле');
  const sellers = JSON.parse(raw).sellers;
  assert.ok(sellers.every(s => /^scrypt\$/.test(s.password)), 'хранится хеш scrypt');
  const [one, two] = ['twin-one', 'twin-two'].map(l => sellers.find(s => s.login === l).password);
  assert.notEqual(one, two, 'соль случайная: одинаковые пароли дают разные хеши');
});

test('верный логин и пароль дают токен на 12 часов, verify возвращает продавца', async () => {
  const s = await auth.login(A.login, A.password);
  assert.equal(s.token.split('.').length, 3, 'формат заголовок.нагрузка.подпись');
  const claims = payloadOf(s.token);
  assert.equal(claims.exp - claims.iat, 12 * 60 * 60);
  const seller = auth.verify(s.token);
  assert.deepEqual(seller, { login: A.login, instanceId: config.get('instance.id') });
  assert.ok(!('password' in s.seller) && !JSON.stringify(s).includes('scrypt'), 'хеш наружу не уходит');
});

test('неверный пароль и несуществующий логин дают одинаковую ошибку', async () => {
  const wrong = await auth.login(A.login, 'не-тот-пароль').catch(e => e);
  const nobody = await auth.login('nobody-here', 'не-тот-пароль').catch(e => e);
  assert.equal(wrong.code, 'INVALID_CREDENTIALS');
  assert.deepEqual([nobody.code, nobody.message], [wrong.code, wrong.message]);
  const r1 = await call('POST', '/api/auth/login', { body: { login: A.login, password: 'не-тот-пароль' } });
  const r2 = await call('POST', '/api/auth/login', { body: { login: 'nobody-here', password: 'не-тот-пароль' } });
  assert.deepEqual([r1.status, r1.body], [401, { error: 'INVALID_CREDENTIALS' }]);
  assert.deepEqual([r2.status, r2.body], [r1.status, r1.body], 'по ответу не узнать, есть ли такой логин');
});

test('подделанный токен (изменена полезная нагрузка) не проходит', async () => {
  const { token } = await auth.login(A.login, A.password);
  const [h, , sig] = token.split('.');
  const forged = h + '.' + Buffer.from(JSON.stringify({ ...payloadOf(token), sub: 'admin', exp: 9999999999 })).toString('base64url') + '.' + sig;
  assert.throws(() => auth.verify(forged), e => e.code === 'BAD_TOKEN');
  const noneAlg = Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url') + '.' + token.split('.')[1] + '.';
  assert.throws(() => auth.verify(noneAlg), e => e.code === 'BAD_TOKEN');
  assert.equal((await call('GET', '/api/orders', { token: forged })).status, 401);
});

test('токен, подписанный другим секретом, не проходит', async () => {
  const { token } = await withSecret(OTHER_SECRET, () => auth.login(A.login, A.password));
  assert.throws(() => auth.verify(token), e => e.code === 'BAD_TOKEN');
  assert.equal((await call('GET', '/api/orders', { token })).status, 401);
});

test('истёкший токен не проходит', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const { token } = await auth.login(A.login, A.password);
  t.mock.timers.tick((12 * 60 * 60 - 60) * 1000);
  assert.equal(auth.verify(token).login, A.login, 'за минуту до срока ещё действует');
  t.mock.timers.tick(61 * 1000);
  assert.throws(() => auth.verify(token), e => e.code === 'TOKEN_EXPIRED');
  assert.throws(() => auth.requireSeller({ headers: { authorization: 'Bearer ' + token } }),
    e => e.code === 'UNAUTHORIZED' && e.reason === 'TOKEN_EXPIRED');
});

test('без заголовка Authorization кабинет отвечает 401 и ничего не меняет', async () => {
  const o = await newOrder();
  const w = await call('POST', '/api/orders/status', { body: { id: o.id, status: 'CANCELLED' } });
  assert.deepEqual([w.status, w.body.error], [401, 'UNAUTHORIZED']);
  assert.equal((await orders.byId(o.id)).status, 'NEW', 'статус не изменился');
  const r = await call('GET', '/api/orders');
  assert.equal(r.status, 401);
  assert.ok(!('orders' in r.body), 'заказы без входа не отдаются');
});

test('главный: чужой идентификатор в теле игнорируется, операция идёт от имени продавца из токена', async () => {
  const o = await newOrder();
  const { token } = await auth.login(A.login, A.password);
  const r = await call('POST', '/api/orders/status', {
    token,
    body: { id: o.id, status: 'PACKING', instanceId: 'someone-else', login: STRANGER.login, sub: STRANGER.login, seller: { login: STRANGER.login, instanceId: 'someone-else' } }
  });
  assert.equal(r.status, 200, 'владелец экземпляра выполняет операцию, подсказки из тела не мешают');
  assert.equal(r.body.status, 'PACKING');
  const last = r.body.history[r.body.history.length - 1];
  assert.equal(last.by, A.login, 'исполнитель — продавец из токена, а не из тела');
  assert.ok(!JSON.stringify(r.body.history).includes(STRANGER.login));
});

test('чужой экземпляр получает 403', async () => {
  const o = await newOrder();
  const { token } = await auth.login(STRANGER.login, STRANGER.password);
  assert.equal(auth.verify(token).instanceId, 'someone-else', 'токен сам по себе действителен');
  const w = await call('POST', '/api/orders/status', { token, body: { id: o.id, status: 'CANCELLED', instanceId: config.get('instance.id') } });
  assert.deepEqual([w.status, w.body.error], [403, 'FORBIDDEN'], 'идентификатор экземпляра в теле не помогает');
  assert.equal((await orders.byId(o.id)).status, 'NEW');
  assert.equal((await call('GET', '/api/orders', { token })).status, 403);
});

test('без JWT_SECRET вход отказывает, а не работает с подставленным значением', async () => {
  const { token } = await auth.login(A.login, A.password);
  for (const value of [undefined, '']) {
    await withSecret(value, async () => {
      await assert.rejects(() => auth.login(A.login, A.password), e => e.code === 'NO_SECRET');
      assert.throws(() => auth.verify(token), e => e.code === 'NO_SECRET', 'даже действительный токен не принимается');
      assert.throws(() => auth.assertConfigured(), e => e.code === 'NO_SECRET');
      const l = await call('POST', '/api/auth/login', { body: A });
      assert.equal(l.status, 503);
      assert.ok(!('token' in l.body), 'токен не выдан');
      assert.equal((await call('GET', '/api/orders', { token })).status, 503);
    });
  }
  await withSecret('short', () => assert.rejects(() => auth.login(A.login, A.password), e => e.code === 'WEAK_SECRET'));
});

test('после входа кабинет работает: заказы, смена статуса, /api/auth/me', async () => {
  const o = await newOrder();
  const l = await call('POST', '/api/auth/login', { body: A });
  assert.equal(l.status, 200);
  const me = await call('GET', '/api/auth/me', { token: l.body.token });
  assert.deepEqual(me.body, { seller: { login: A.login, instanceId: config.get('instance.id') }, owner: true });
  assert.equal((await call('GET', '/api/auth/me')).status, 401);
  const list = await call('GET', '/api/orders', { token: l.body.token });
  assert.equal(list.status, 200);
  assert.ok(list.body.orders.some(x => x.id === o.id));
  const w = await call('POST', '/api/orders/status', { token: l.body.token, body: { id: o.id } });
  assert.equal(w.body.status, 'PACKING');
});

test('витрина остаётся публичной: каталог, расчёт корзины, заказ, конфиг, живость', async () => {
  const cat = await call('GET', '/api/catalog');
  assert.equal(cat.status, 200);
  const q = await call('POST', '/api/cart/quote', { body: { items: [{ id: cat.body.items[0].id, qty: 1 }] } });
  assert.equal(q.status, 200);
  await newOrder();
  assert.equal((await call('GET', '/api/config')).status, 200);
  assert.equal((await call('GET', '/api/health')).status, 200);
});

test('скрипт заводит продавца без ручной правки файлов', () => {
  const env = { ...process.env, DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'add-seller-')) };
  const file = path.join(env.DATA_DIR, 'auth.json');
  try {
    const out = execFileSync(process.execPath, ['api/scripts/add-seller.js', 'Owner@Shop', 'пароль-из-скрипта'], { cwd: ROOT, env, encoding: 'utf8' });
    assert.match(out, /owner@shop/);
    const raw = fs.readFileSync(file, 'utf8');
    assert.ok(raw.includes('owner@shop') && !raw.includes('пароль-из-скрипта'));
    assert.throws(() => execFileSync(process.execPath, ['api/scripts/add-seller.js', 'owner@shop', 'ещё-один-пароль'], { cwd: ROOT, env, stdio: 'pipe' }),
      'повторный логин не заводится');
  } finally { fs.rmSync(env.DATA_DIR, { recursive: true, force: true }); }
});
