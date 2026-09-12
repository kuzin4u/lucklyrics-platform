'use strict';
/**
 * Два профиля на одном коде: магазин с площадкой и магазин без неё.
 * Различие — только в конфигурации: один и тот же сценарий (tests/profiles/probe.js)
 * и одна и та же приёмка (npm run smoke) проходят на обоих.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');
const { run: smoke } = require('../../api/scripts/smoke');

const ROOT = path.resolve(__dirname, '..', '..');
const WITH = 'config/brand.example.json';
const WITHOUT = 'config/brand.no-marketplace.json';
const CREDS = { login: 'smoke-check', password: 'пароль-приёмки-профиля-1' };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'profile-'));
const dirs = [];
const servers = [];

/** Тот же сценарий на заданном профиле — отдельным процессом: конфиг читается при старте. */
function probe(profile) {
  const r = spawnSync(process.execPath, ['tests/profiles/probe.js'], { cwd: ROOT, encoding: 'utf8', timeout: 60000,
    env: Object.assign({}, process.env, { BRAND_CONFIG: profile, BRAND_CONFIG_JSON: '', STORE_PROVIDER: 'memory' }) });
  assert.equal(r.status, 0, 'проба профиля ' + profile + ': ' + r.stderr);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}
/** Живой сервер на профиле: для приёмки npm run smoke. */
async function serve(profile, port) {
  const dir = tmp(); dirs.push(dir);
  const env = Object.assign({}, process.env, { BRAND_CONFIG: profile, BRAND_CONFIG_JSON: '', STORE_PROVIDER: 'file', DATA_DIR: dir,
    PORT: String(port), JWT_SECRET: 'profiles-test-secret-0123456789-abcdef', MODEL_API_KEY: '', MODEL_API_URL: '' });
  const add = spawnSync(process.execPath, ['api/scripts/add-seller.js', CREDS.login, CREDS.password], { cwd: ROOT, encoding: 'utf8', env });
  assert.equal(add.status, 0, add.stderr);
  const srv = spawn(process.execPath, ['api/server.js'], { cwd: ROOT, env, stdio: 'ignore' });
  servers.push(srv);
  const base = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + '/api/health')).ok) return base; } catch (e) { /* поднимается */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('сервер профиля ' + profile + ' не поднялся');
}

let a, b;
test.before(() => { a = probe(WITH); b = probe(WITHOUT); });
test.after(() => { servers.forEach(s => s.kill()); dirs.forEach(d => fs.rmSync(d, { recursive: true, force: true })); });

test('профиль без площадки — другой магазин, а не урезанный', () => {
  assert.deepEqual(b.profile, { instance: 'shop-no-mp', brand: 'Своя лавка', typography: 'warm', accent: '#b3541e',
    marketplace: false, channels: ['SITE', 'AGENT', 'BOT'], bufferDefault: 0 });
  assert.notDeepEqual(a.profile, b.profile);
  ['instance', 'brand', 'typography', 'accent'].forEach(k => assert.notEqual(a.profile[k], b.profile[k], 'совпало: ' + k));
  assert.ok(a.profile.channels.includes('MARKETPLACE') && !b.profile.channels.includes('BOT') === false);
});

test('на профиле без площадки сделка проходит целиком: каталог, корзина, заказ, списание, отмена, возврат', () => {
  assert.deepEqual(b.import, { rows: 33, created: 33, updated: 0, unchanged: 0, stock: 29, errors: 0 });
  assert.deepEqual(b.order, { lines: 1, total: 650, reserved: ['IMP-004×2', 'IMP-005×1'] }, 'набор одной строкой, компоненты списаны');
  assert.deepEqual(b.afterOrder, [10, 14], 'остаток уменьшился на состав набора');
  assert.equal(b.restored, true, 'после отмены остаток вернулся');
  assert.deepEqual(b.stockReasons, ['cancel', 'import', 'order']);
});

test('маршруты синхронизации отвечают «площадка выключена» с понятным кодом, а не ошибкой', async () => {
  assert.equal(b.sync.disabled, true);
  assert.match(b.sync.message, /площадка выключена в конфигурации/);
  assert.deepEqual([b.sync.run.disabled, b.sync.diff], [true, 'DISABLED']);
  assert.deepEqual([a.sync.run.disabled, a.sync.diff], [false, 'NO_DATA'], 'с площадкой — обычные ответы');
  // по HTTP — 200 с объяснением, а не 500 и не тишина
  const base = await serve(WITHOUT, 3961);
  const token = (await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(CREDS) })).json()).token;
  for (const route of ['/api/sync/log', '/api/sync/diff']) {
    const r = await fetch(base + route, { headers: { Authorization: 'Bearer ' + token } });
    const body = await r.json();
    assert.equal(r.status, 200, route);
    assert.match(body.message, /площадка выключена/, route);
  }
  const run = await fetch(base + '/api/sync/run', { method: 'POST', headers: { Authorization: 'Bearer ' + token } });
  assert.deepEqual([run.status, (await run.json()).disabled], [200, true]);
});

test('синхронизация ничего не пишет при заказе и отмене, если площадки нет', () => {
  assert.deepEqual([b.sync.entries, b.sync.intents], [0, 0], 'ни записей в журнале, ни намерений клиента площадки');
  assert.ok(a.sync.entries > 0 && a.sync.intents > 0, 'с площадкой — пишет');
  assert.ok(!b.stockReasons.includes('sync'));
});

test('доступный остаток равен физическому: буфер ноль, функция та же', () => {
  assert.equal(b.stock.buffer, 0);
  assert.deepEqual([b.stock.site, b.stock.marketplace], [b.stock.physical, b.stock.physical]);
  assert.equal(a.stock.buffer, 2);
  assert.equal(a.stock.marketplace, a.stock.physical - 2, 'с буфером та же функция вычитает запас');
  assert.equal(a.stock.site, a.stock.physical);
});

test('импорт, наборы, помощник и авторизация работают одинаково на обоих профилях', () => {
  assert.deepEqual(b.import, a.import);
  assert.deepEqual([b.stock.kitSite, b.order.reserved], [a.stock.kitSite, a.order.reserved], 'наборы считаются одинаково');
  assert.deepEqual([b.agent.available, b.agent.items, b.agent.total, b.agent.dropped],
    [a.agent.available, a.agent.items, a.agent.total, a.agent.dropped], 'помощник одинаков');
  assert.notDeepEqual(b.agent.limits, a.agent.limits, 'а его пределы — из конфигурации профиля');
  assert.deepEqual([b.auth.token, b.auth.owner], [true, true]);
  assert.deepEqual([b.auth.instance, a.auth.instance], ['shop-no-mp', 'demo'], 'продавец привязан к своему экземпляру');
});

test('главный: оба профиля проходят один и тот же набор проверок, различаясь только конфигурацией', () => {
  const common = p => ({ import: p.import, order: p.order, afterOrder: p.afterOrder, afterCancel: p.afterCancel,
    restored: p.restored, stockReasons: p.stockReasons, site: p.stock.site, physical: p.stock.physical, kitSite: p.stock.kitSite,
    agent: { available: p.agent.available, items: p.agent.items, total: p.agent.total, dropped: p.agent.dropped },
    auth: { token: p.auth.token, owner: p.auth.owner } });
  assert.deepEqual(common(b), common(a));
});

test('в ядре нет условий про выключенную площадку', () => {
  // schema.js описывает поля конфигурации, а не поведение; sync.js и marketplace/ — сами модули площадки
  const core = fs.readdirSync(path.join(ROOT, 'api', 'lib')).filter(f => f.endsWith('.js') && !['sync.js', 'schema.js'].includes(f));
  const bad = [];
  for (const f of core) {
    const text = fs.readFileSync(path.join(ROOT, 'api', 'lib', f), 'utf8');
    for (const [i, line] of text.split('\n').entries()) {
      if (/^\s*(\*|\/\/)/.test(line)) continue;                       // комментарии — не условия
      if (/marketplace\.enabled|marketplace\s*\.\s*isDry|sync\.(active|run|log|diff)|площадка выключена/i.test(line)) bad.push(f + ':' + (i + 1) + ' ' + line.trim());
    }
  }
  assert.deepEqual(bad, [], 'ядро знает о выключенной площадке: ' + bad.join(' | '));
  // остаток, каталог, заказы и платежи вообще не упоминают модуль площадки
  for (const f of ['stock.js', 'catalog.js', 'orders.js', 'import.js', 'agent.js', 'auth.js', 'store.js']) {
    const text = fs.readFileSync(path.join(ROOT, 'api', 'lib', f), 'utf8');
    assert.ok(!/require\(['"].*(marketplace|sync)/.test(text), f + ' подключает модуль площадки');
  }
});

test('приёмка проходит на обоих профилях; шаги площадки при её отсутствии пропущены явно', async () => {
  const withMp = await smoke(await serve(WITH, 3962), CREDS);
  const withoutMp = await smoke(await serve(WITHOUT, 3963), CREDS);
  const marks = res => res.steps.flatMap(s => s.checks.map(c => c.status));
  assert.deepEqual([withMp.ok, withoutMp.ok], [true, true], 'обе приёмки пройдены');
  assert.ok(!marks(withMp).includes('skip'), 'с площадкой пропусков нет');
  const skipped = withoutMp.steps.flatMap(s => s.checks.filter(c => c.status === 'skip'));
  assert.equal(skipped.length, 1, 'ровно один явный пропуск');
  assert.match(skipped[0].text, /шаги площадки пропущены: площадка выключена/, 'пропуск с причиной, а не молчаливый');
  const sync = withoutMp.steps.find(s => s.title.includes('Синхронизация'));
  assert.ok(sync.checks.some(c => c.status === 'ok' && /DISABLED/.test(c.text)), 'сверка проверена и на этом профиле');
  const deal = t => withoutMp.steps.find(s => s.title.includes(t)).checks.every(c => c.status === 'ok');
  ['Сделка', 'Списание', 'Отмена', 'Кабинет'].forEach(t => assert.ok(deal(t), 'без площадки шаг «' + t + '» должен пройти'));
});
