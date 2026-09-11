'use strict';
/**
 * Единственная точка чтения конфигурации бренда.
 *
 * Правило проекта: никакой другой модуль не читает config/brand*.json напрямую
 * и не содержит значений конкретного продавца. Проверяется тестом
 * tests/unit/no-brand-in-code.test.js.
 *
 * Файлы: config/brand.json — активный, config/brand.<slug>.json — конфиги
 * других продавцов для режима предпросмотра.
 *
 * Источник активного конфига, по порядку:
 *   BRAND_CONFIG_JSON — содержимое целиком (площадка размещения: переменная
 *                       доступна и сборке статики, и серверу);
 *   BRAND_CONFIG      — путь к файлу;
 *   config/brand.json, а если его нет — brand.example.json (только разработка).
 * Источник задан явно, но негоден — отказ при старте, а не тихая подстановка
 * примера: иначе вместо магазина продавца поднимается демонстрационный.
 */
const fs = require('fs');
const path = require('path');
const schema = require('./schema');

const ROOT = path.resolve(__dirname, '..', '..');
const DIR = path.join(ROOT, 'config');
const CONFIG_PATH = process.env.BRAND_CONFIG
  ? path.resolve(ROOT, process.env.BRAND_CONFIG)
  : path.join(DIR, 'brand.json');
const FALLBACK_PATH = path.join(DIR, 'brand.example.json');

const cache = new Map();

function read(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  schema.assertValid(raw, path.basename(file));
  const cfg = { ...raw, _source: path.basename(file) };
  cfg.channelByCode = Object.fromEntries((cfg.channels || []).map(c => [c.code, c]));
  return cfg;
}

function fromEnvJson(text) {
  let raw;
  try { raw = JSON.parse(text); }
  catch (e) { throw new Error('BRAND_CONFIG_JSON: не разобран JSON — ' + e.message); }
  schema.assertValid(raw, 'BRAND_CONFIG_JSON');
  const cfg = { ...raw, _source: 'env:BRAND_CONFIG_JSON' };
  cfg.channelByCode = Object.fromEntries((cfg.channels || []).map(c => [c.code, c]));
  return cfg;
}

function load() {
  if (cache.has('active')) return cache.get('active');
  let cfg;
  if (process.env.BRAND_CONFIG_JSON) cfg = fromEnvJson(process.env.BRAND_CONFIG_JSON);
  else if (process.env.BRAND_CONFIG) {
    if (!fs.existsSync(CONFIG_PATH)) throw new Error('BRAND_CONFIG: нет файла ' + CONFIG_PATH);
    cfg = read(CONFIG_PATH);
  } else cfg = read(fs.existsSync(CONFIG_PATH) ? CONFIG_PATH : FALLBACK_PATH);
  cache.set('active', cfg);
  return cfg;
}

/**
 * Конфиг для предпросмотра. Только чтение, только из папки конфигов,
 * имя ограничено — иначе ссылкой можно вытащить чужой файл.
 */
function loadNamed(slug) {
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(String(slug || ''))) {
    const e = new Error('BAD_PREVIEW_NAME'); e.code = 'BAD_PREVIEW_NAME'; throw e;
  }
  if (cache.has(slug)) return cache.get(slug);
  const file = path.join(DIR, 'brand.' + slug + '.json');
  if (!fs.existsSync(file) || path.dirname(file) !== DIR) {
    const e = new Error('PREVIEW_NOT_FOUND'); e.code = 'PREVIEW_NOT_FOUND'; throw e;
  }
  const cfg = read(file);
  cache.set(slug, cfg);
  return cfg;
}

/** Доступные конфиги предпросмотра. */
function listPreviews() {
  if (!fs.existsSync(DIR)) return [];
  return fs.readdirSync(DIR)
    .map(f => (f.match(/^brand\.([a-z0-9-]+)\.json$/) || [])[1])
    .filter(s => s && s !== 'example');
}

function get(pathStr, dflt, cfg) {
  const c = cfg || load();
  const val = pathStr.split('.').reduce((o, k) => (o == null ? o : o[k]), c);
  return val === undefined ? dflt : val;
}

function channel(code, cfg) {
  const c = (cfg || load()).channelByCode[code];
  if (!c) throw new Error('неизвестный канал: ' + code);
  return c;
}

/** Публичная часть — то, что уходит витрине. Секреты и служебное не попадают. */
function publicConfig(cfg) {
  const c = cfg || load();
  const brand = require('./brand');
  return {
    theme: brand.theme(c),
    texts: c.texts || {},
    legal: require('./site').legalLinks(c),   // только ссылки: реквизиты — на самих страницах
    currency: c.catalog.currency,
    discountTiers: c.catalog.discountTiers,
    channels: c.channels.filter(x => x.enabled).map(x => ({ code: x.code, title: x.title })),
    agent: { enabled: require('./agent').available() }   // только «доступен ли»; ключ и причины — нет
  };
}

function reset() { cache.clear(); }

module.exports = { load, loadNamed, listPreviews, get, channel, publicConfig, reset, CONFIG_PATH };
