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

function load() {
  if (cache.has('active')) return cache.get('active');
  const file = fs.existsSync(CONFIG_PATH) ? CONFIG_PATH : FALLBACK_PATH;
  const cfg = read(file);
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
    agent: { enabled: c.agent.enabled }
  };
}

function reset() { cache.clear(); }

module.exports = { load, loadNamed, listPreviews, get, channel, publicConfig, reset, CONFIG_PATH };
