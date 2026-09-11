'use strict';
/**
 * Вход в кабинет. Единственная точка работы с сессией.
 *
 * Пароль — scrypt со случайной солью, в открытом виде не хранится нигде.
 * Токен — формат JWT (заголовок.полезная нагрузка.подпись, base64url),
 * подпись HMAC-SHA256. Всё на node:crypto, внешних пакетов нет.
 *
 * Секрет подписи — только JWT_SECRET из окружения. Нет секрета — нет работы:
 * подставленное значение по умолчанию обнулило бы всю защиту.
 * Идентификатор продавца берётся только из подписанного токена, никогда
 * из тела запроса или адреса.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const config = require('./config');

const scrypt = promisify(crypto.scrypt);

const ROOT = path.resolve(__dirname, '..', '..');
const FILE = process.env.AUTH_FILE
  ? path.resolve(ROOT, process.env.AUTH_FILE)
  : path.join(ROOT, 'data', 'auth.json');

const TTL_SEC = 12 * 60 * 60;
const MIN_SECRET = 32;
const MIN_PASSWORD = 8;
const KDF = { N: 16384, r: 8, p: 1, keylen: 64 };

const b64 = s => Buffer.from(s).toString('base64url');
const HEADER = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));

function err(code, message, extra) {
  const e = new Error(message || code); e.code = code;
  return Object.assign(e, extra);
}

/** Секрет читается здесь и только здесь, на каждой операции. */
function secret() {
  const s = process.env.JWT_SECRET || '';
  if (!s) throw err('NO_SECRET', 'JWT_SECRET не задан — вход в кабинет отключён');
  if (s.length < MIN_SECRET) throw err('WEAK_SECRET', 'JWT_SECRET короче ' + MIN_SECRET + ' символов');
  return s;
}
const assertConfigured = () => { secret(); };

const currentInstance = () => config.get('instance.id');
const owns = seller => !!seller && seller.instanceId === currentInstance();

/* ---------- хранилище ---------- */

function readStore() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return { sellers: [] }; throw e; }
}
function writeStore(store) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}
const normLogin = l => String(l == null ? '' : l).trim().toLowerCase();
const publicSeller = s => ({ login: s.login, instanceId: s.instanceId });

/* ---------- пароль ---------- */

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, KDF.keylen, KDF);
  return ['scrypt', KDF.N, KDF.r, KDF.p, salt.toString('base64url'), hash.toString('base64url')].join('$');
}
async function checkPassword(password, stored) {
  const [alg, N, r, p, salt, hash] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64url');
  const got = await scrypt(password, Buffer.from(salt, 'base64url'), expected.length, { N: +N, r: +r, p: +p });
  return crypto.timingSafeEqual(got, expected);
}
// Несуществующий логин проверяется против пустышки: тот же ответ и то же время.
const DUMMY = ['scrypt', KDF.N, KDF.r, KDF.p,
  crypto.randomBytes(16).toString('base64url'), crypto.randomBytes(KDF.keylen).toString('base64url')].join('$');

/* ---------- токен ---------- */

const hmac = (data, key) => crypto.createHmac('sha256', key).update(data).digest('base64url');

function sign(claims, key) {
  const body = HEADER + '.' + b64(JSON.stringify(claims));
  return body + '.' + hmac(body, key);
}

/** Продавец из токена либо ошибка с кодом: BAD_TOKEN, TOKEN_EXPIRED, NO_SECRET. */
function verify(token) {
  const key = secret();
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw err('BAD_TOKEN');
  const [h, p, sig] = parts;
  const expected = Buffer.from(hmac(h + '.' + p, key));
  const given = Buffer.from(sig);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) throw err('BAD_TOKEN');
  if (h !== HEADER) throw err('BAD_TOKEN');           // алгоритм зафиксирован, «none» не проходит
  let claims;
  try { claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')); } catch { throw err('BAD_TOKEN'); }
  if (!claims || typeof claims.sub !== 'string' || typeof claims.inst !== 'string' || !Number.isFinite(claims.exp)) {
    throw err('BAD_TOKEN');
  }
  if (Math.floor(Date.now() / 1000) >= claims.exp) throw err('TOKEN_EXPIRED');
  return { login: claims.sub, instanceId: claims.inst };
}

/* ---------- операции ---------- */

/** Новый продавец. По умолчанию привязан к текущему экземпляру. */
async function register(login, password, { instanceId } = {}) {
  const l = normLogin(login);
  if (!/^[a-z0-9._@-]{3,64}$/.test(l)) throw err('BAD_LOGIN', 'логин: 3–64 символа, латиница, цифры, . _ @ -');
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    throw err('WEAK_PASSWORD', 'пароль короче ' + MIN_PASSWORD + ' символов');
  }
  const store = readStore();
  if (store.sellers.some(s => s.login === l)) throw err('LOGIN_TAKEN', 'логин «' + l + '» уже заведён');
  const seller = {
    login: l, instanceId: instanceId || currentInstance(),
    password: await hashPassword(password), createdAt: new Date().toISOString()
  };
  store.sellers.push(seller);
  writeStore(store);
  return publicSeller(seller);
}

/** Токен на 12 часов. Неверный пароль и чужой логин неотличимы: INVALID_CREDENTIALS. */
async function login(login, password) {
  const key = secret();
  const seller = readStore().sellers.find(s => s.login === normLogin(login));
  const ok = await checkPassword(String(password == null ? '' : password), seller ? seller.password : DUMMY);
  if (!seller || !ok) throw err('INVALID_CREDENTIALS', 'неверный логин или пароль');
  const now = Math.floor(Date.now() / 1000);
  return {
    token: sign({ sub: seller.login, inst: seller.instanceId, iat: now, exp: now + TTL_SEC }, key),
    expiresAt: new Date((now + TTL_SEC) * 1000).toISOString(),
    seller: publicSeller(seller)
  };
}

/** Продавец из заголовка Authorization: Bearer, иначе UNAUTHORIZED (причина — в reason). */
function requireSeller(req) {
  secret();
  const m = /^Bearer\s+(\S+)$/i.exec((req && req.headers && req.headers.authorization) || '');
  if (!m) throw err('UNAUTHORIZED', 'нужен вход', { reason: 'NO_TOKEN' });
  try { return verify(m[1]); }
  catch (e) { throw err('UNAUTHORIZED', 'нужен вход', { reason: e.code }); }
}

/** Операция кабинета: продавец из токена и только владелец этого экземпляра, иначе FORBIDDEN. */
function requireOwner(req) {
  const seller = requireSeller(req);
  if (!owns(seller)) throw err('FORBIDDEN', 'чужой экземпляр');
  return seller;
}

module.exports = { register, login, verify, requireSeller, requireOwner, owns, assertConfigured, TTL_SEC, FILE };
