'use strict';
/**
 * Вход в кабинет. Единственная точка работы с сессией.
 *
 * Пароль — scrypt со случайной солью, в открытом виде не хранится нигде.
 * Токен — формат JWT (заголовок.полезная нагрузка.подпись, base64url),
 * подпись HMAC-SHA256. Всё на node:crypto, внешних пакетов нет.
 *
 * Продавцы — в хранилище под именем auth (store.js), где лежат — модуль не знает.
 * Секрет подписи — только JWT_SECRET из окружения. Нет секрета — нет работы:
 * подставленное значение по умолчанию обнулило бы всю защиту.
 * Идентификатор продавца берётся только из подписанного токена, никогда
 * из тела запроса или адреса.
 *
 * Смена пароля обрывает прежние сессии: в токене — отметка pwd, когда задан
 * пароль; запрос кабинета сверяет её с записью продавца. Иначе украденный токен
 * жил бы ещё 12 часов после смены пароля — как раз когда её делают.
 */
const crypto = require('crypto');
const { promisify } = require('util');
const config = require('./config');
const store = require('./store');

const scrypt = promisify(crypto.scrypt);

const NAME = 'auth';
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

const sellersOf = data => (data && data.sellers) || [];
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

/** Утверждения подписанного токена либо ошибка с кодом: BAD_TOKEN, TOKEN_EXPIRED, NO_SECRET. */
function claimsOf(token) {
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
  return claims;
}

/** Продавец из токена — только по подписи и сроку, без хранилища. */
function verify(token) {
  const c = claimsOf(token);
  return { login: c.sub, instanceId: c.inst };
}

/** Сессия продавца: токен на 12 часов с отметкой, когда задан пароль. */
function issue(seller, key) {
  const now = Math.floor(Date.now() / 1000);
  return {
    token: sign({ sub: seller.login, inst: seller.instanceId, pwd: seller.pwdAt || 0, iat: now, exp: now + TTL_SEC }, key),
    expiresAt: new Date((now + TTL_SEC) * 1000).toISOString(),
    seller: publicSeller(seller)
  };
}

// отметка строго растёт: две смены в одну миллисекунду не дают одинаковую
const nextPwdAt = prev => Math.max(Date.now(), (prev || 0) + 1);
function checkNewPassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    throw err('WEAK_PASSWORD', 'пароль короче ' + MIN_PASSWORD + ' символов');
  }
}

/* ---------- операции ---------- */

/**
 * Новый продавец. По умолчанию привязан к текущему экземпляру. force — перезаписать
 * существующий логин (пароль и экземпляр); его прежние сессии перестают действовать.
 */
async function register(login, password, { instanceId, force } = {}) {
  const l = normLogin(login);
  if (!/^[a-z0-9._@-]{3,64}$/.test(l)) throw err('BAD_LOGIN', 'логин: 3–64 символа, латиница, цифры, . _ @ -');
  checkNewPassword(password);
  const hash = await hashPassword(password);
  let seller, replaced = false;
  // проверка занятости внутри update: два одинаковых логина параллельно не пройдут
  await store.update(NAME, data => {
    const sellers = sellersOf(data);
    const old = sellers.find(s => s.login === l);
    if (old && !force) throw err('LOGIN_TAKEN', 'логин «' + l + '» уже заведён; перезаписать — ключ --force');
    replaced = !!old;
    seller = { login: l, instanceId: instanceId || currentInstance(), password: hash, pwdAt: nextPwdAt(old && old.pwdAt),
      createdAt: old ? old.createdAt : new Date().toISOString() };
    if (old) seller.updatedAt = new Date().toISOString();
    return { sellers: sellers.filter(s => s.login !== l).concat(seller) };
  });
  return Object.assign(publicSeller(seller), { replaced });
}

/**
 * Смена пароля из кабинета. Логин — из токена вызывающего. Нужен верный старый
 * пароль, новый от 8 символов, подтверждение, совпадающее с новым. Прежние сессии
 * обрываются, в ответ — новая, чтобы текущая страница продолжила работу.
 */
async function changePassword(login, { oldPassword, newPassword, confirm } = {}) {
  const key = secret();
  if (newPassword !== confirm) throw err('PASSWORD_MISMATCH', 'новый пароль и подтверждение не совпадают');
  checkNewPassword(newPassword);
  if (newPassword === oldPassword) throw err('SAME_PASSWORD', 'новый пароль совпадает со старым');
  const l = normLogin(login);
  const current = sellersOf(await store.read(NAME)).find(s => s.login === l);
  const ok = await checkPassword(String(oldPassword == null ? '' : oldPassword), current ? current.password : DUMMY);
  if (!current || !ok) throw err('WRONG_PASSWORD', 'старый пароль неверен');
  const hash = await hashPassword(newPassword);
  let seller;
  await store.update(NAME, data => {
    const sellers = sellersOf(data);
    const s = sellers.find(x => x.login === l);
    if (!s) throw err('WRONG_PASSWORD', 'старый пароль неверен');
    seller = Object.assign({}, s, { password: hash, pwdAt: nextPwdAt(s.pwdAt), updatedAt: new Date().toISOString() });
    return { sellers: sellers.map(x => (x.login === l ? seller : x)) };
  });
  return issue(seller, key);
}

/** Токен на 12 часов. Неверный пароль и чужой логин неотличимы: INVALID_CREDENTIALS. */
async function login(login, password) {
  const key = secret();
  const seller = sellersOf(await store.read(NAME)).find(s => s.login === normLogin(login));
  const ok = await checkPassword(String(password == null ? '' : password), seller ? seller.password : DUMMY);
  if (!seller || !ok) throw err('INVALID_CREDENTIALS', 'неверный логин или пароль');
  return issue(seller, key);
}

/**
 * Продавец из заголовка Authorization: Bearer, иначе UNAUTHORIZED (причина — в reason).
 * Кроме подписи и срока — сверка с записью продавца: удалён или сменил пароль —
 * токен больше не действует.
 */
async function requireSeller(req) {
  secret();
  const m = /^Bearer\s+(\S+)$/i.exec((req && req.headers && req.headers.authorization) || '');
  if (!m) throw err('UNAUTHORIZED', 'нужен вход', { reason: 'NO_TOKEN' });
  let c;
  try { c = claimsOf(m[1]); }
  catch (e) { throw err('UNAUTHORIZED', 'нужен вход', { reason: e.code }); }
  const s = sellersOf(await store.read(NAME)).find(x => x.login === c.sub);
  if (!s) throw err('UNAUTHORIZED', 'нужен вход', { reason: 'SELLER_GONE' });
  if ((s.pwdAt || 0) !== (c.pwd || 0)) throw err('UNAUTHORIZED', 'пароль изменён — нужен вход', { reason: 'PASSWORD_CHANGED' });
  return { login: c.sub, instanceId: c.inst };
}

/** Операция кабинета: продавец из токена и только владелец этого экземпляра, иначе FORBIDDEN. */
async function requireOwner(req) {
  const seller = await requireSeller(req);
  if (!owns(seller)) throw err('FORBIDDEN', 'чужой экземпляр');
  return seller;
}

module.exports = { register, login, changePassword, verify, requireSeller, requireOwner, owns, assertConfigured, TTL_SEC };
