'use strict';
/**
 * Импорт каталога из CSV или JSON.
 *
 * Колонки сопоставляются по названиям — идея перенесена из действующего кода
 * пекарни (sheets-unified-api.gs): заголовок приводится к нижнему регистру без
 * пробелов по краям, для поля берётся первое совпавшее название из списка.
 * Колонка, которой нет среди известных, не теряется: создаётся у позиции
 * дополнительным полем (attrs). Пустая ячейка — «поле не прислали, не трогаем».
 *
 * Идемпотентность по артикулу: повторная загрузка обновляет, а не плодит дубли.
 * Ошибки собираются построчно и не прерывают разбор; строки с ошибками
 * пропускаются, остальные применяются. Предпросмотр считает то же самое
 * и ничего не пишет.
 */
const catalog = require('./catalog');

/** Поле каталога → возможные названия колонки, первое — основное. */
const COLUMNS = {
  id:               ['id', 'ид', 'артикул', 'sku', 'код'],
  title:            ['title', 'name', 'название', 'наименование'],
  price:            ['price', 'цена'],
  oldPrice:         ['oldprice', 'old_price', 'старая цена'],
  stock:            ['stock', 'остаток', 'количество', 'qty'],
  marketplaceStock: ['marketplacestock', 'marketplace_stock', 'остаток площадки'],
  fulfillment:      ['fulfillment', 'исполнение', 'схема'],
  category:         ['category', 'категория'],
  categoryTitle:    ['categorytitle', 'category_title', 'название категории'],
  unit:             ['unit', 'единица', 'ед'],
  weight:           ['weight', 'вес'],
  emoji:            ['emoji', 'эмодзи'],
  description:      ['description', 'desc', 'описание'],
  features:         ['features', 'особенности', 'преимущества'],
  photos:           ['photos', 'фотографии', 'галерея', 'photo', 'фото'],
  rating:           ['rating', 'рейтинг', 'оценка'],
  reviews:          ['reviews', 'отзывы', 'кол-во отзывов']
};

const TITLES = {
  id: 'артикул', title: 'название', price: 'цена', oldPrice: 'старая цена', stock: 'остаток',
  marketplaceStock: 'остаток площадки', fulfillment: 'схема исполнения', category: 'категория',
  categoryTitle: 'название категории', unit: 'единица', weight: 'вес', emoji: 'эмодзи',
  description: 'описание', features: 'особенности', photos: 'фотографии', rating: 'рейтинг', reviews: 'отзывы'
};

function fail(code, message, extra) {
  const e = new Error(message); e.code = code;
  throw Object.assign(e, extra);
}

/* ---------- разбор файла ---------- */

/** UTF-8, а если файл сохранён Excel в Windows-1251 — эта кодировка. */
function decode(input) {
  if (typeof input === 'string') return input.replace(/^\uFEFF/, '');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(input); }
  catch { return new TextDecoder('windows-1251').decode(input); }
}

function detectDelimiter(headerLine) {
  const counts = { ';': 0, ',': 0, '\t': 0 };
  let quoted = false;
  for (const ch of headerLine) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch in counts) counts[ch]++;
  }
  return Object.keys(counts).reduce((a, b) => (counts[b] > counts[a] ? b : a));
}

/** CSV по RFC 4180: кавычки, удвоенные кавычки, переводы строк внутри ячейки. */
function parseCsv(text) {
  const nl = text.search(/\r?\n/);
  const delim = detectDelimiter(nl === -1 ? text : text.slice(0, nl));
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') cell += c;
      else if (text[i + 1] === '"') { cell += '"'; i++; }
      else quoted = false;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (quoted) fail('BAD_FILE', 'файл обрывается внутри кавычек — проверьте парные кавычки');
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  const [headers = [], ...data] = rows;
  // строка файла = строка таблицы: заголовок — первая, данные — со второй
  return { headers, records: data.map((cells, i) => ({ line: i + 2, cells })) };
}

function parseJson(text) {
  let data;
  try { data = JSON.parse(text); } catch (e) { fail('BAD_FILE', 'JSON не разобран: ' + e.message); }
  const list = Array.isArray(data) ? data : data && Array.isArray(data.items) ? data.items : null;
  if (!list) fail('BAD_FILE', 'в JSON нужен список позиций: [...] или {"items": [...]}');
  const headers = [];
  for (const it of list) if (it && typeof it === 'object') for (const k of Object.keys(it)) if (!headers.includes(k)) headers.push(k);
  return {
    headers,
    records: list.map((it, i) => ({
      line: i + 1, notObject: !it || typeof it !== 'object' || Array.isArray(it),
      cells: headers.map(h => (it && typeof it === 'object' ? it[h] : undefined))
    }))
  };
}

function formatOf(hint, text) {
  const h = String(hint || '').toLowerCase();
  if (h.includes('json')) return 'json';
  if (h.includes('csv')) return 'csv';
  return /^\s*[[{]/.test(text) ? 'json' : 'csv';
}

/** Заголовки → поля каталога. Нераспознанные — дополнительные поля позиции. */
function mapColumns(headers) {
  const head = headers.map(h => String(h == null ? '' : h).trim().toLowerCase());
  const byField = {};
  const used = new Set();
  for (const [field, names] of Object.entries(COLUMNS)) {
    for (const n of names) {
      const i = head.indexOf(n);
      if (i !== -1 && !used.has(i)) { byField[field] = i; used.add(i); break; }
    }
  }
  const extra = head.map((h, i) => i).filter(i => !used.has(i) && head[i]);
  return { byField, extra };
}

/* ---------- значения ---------- */

const isEmpty = v => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
const shown = v => (typeof v === 'string' ? '«' + v.trim() + '»' : JSON.stringify(v));

function number(v) {
  if (typeof v === 'number') return v;
  const s = String(v).replace(/[\s₽]/g, '').replace(/руб\.?$/i, '').replace(',', '.');
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : NaN;
}
const money = title => v => {
  const n = number(v);
  if (Number.isNaN(n)) throw title + ' не число (' + shown(v) + ')';
  if (n < 0) throw title + ' меньше нуля';
  return Math.round(n * 100) / 100;
};
const count = title => v => {
  const n = number(v);
  if (!Number.isInteger(n) || n < 0) throw title + ' — нужно целое число от нуля (' + shown(v) + ')';
  return n;
};
const text = v => String(v).trim();
const list = v => (Array.isArray(v) ? v.map(String) : String(v).split('|')).map(s => s.trim()).filter(Boolean);

const PARSE = {
  id: text, title: text, category: text, categoryTitle: text, unit: text, weight: text, emoji: text, description: text,
  price: money('цена'), oldPrice: money('старая цена'),
  stock: count('остаток'), marketplaceStock: count('остаток площадки'), reviews: count('отзывы'),
  rating: v => { const n = number(v); if (Number.isNaN(n) || n < 0 || n > 5) throw 'рейтинг — нужно число от 0 до 5 (' + shown(v) + ')'; return n; },
  fulfillment: v => { const s = String(v).trim().toUpperCase(); if (s !== 'FBS' && s !== 'FBO') throw 'схема исполнения — FBS или FBO (' + shown(v) + ')'; return s; },
  features: list, photos: list
};

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ---------- план ---------- */

/** Что будет создано, обновлено, оставлено и какие строки с ошибками. Ничего не меняет. */
function plan(parsed, items) {
  const { byField, extra } = mapColumns(parsed.headers);
  if (byField.id === undefined) {
    fail('BAD_FILE', 'нет колонки с артикулом: подойдёт ' + COLUMNS.id.join(', '), { columns: parsed.headers });
  }
  const current = new Map(items.map(p => [String(p.id), p]));
  const seen = new Map();
  const out = { created: [], updated: [], unchanged: [], errors: [] };
  const label = parsed.format === 'json' ? 'запись ' : 'строка ';

  for (const rec of parsed.records) {
    const where = label + rec.line;
    const problems = [];
    if (rec.notObject) { out.errors.push({ line: rec.line, message: where + ': ожидается объект позиции' }); continue; }
    if (rec.cells.every(isEmpty)) continue;                       // пустая строка — не ошибка

    const idCell = rec.cells[byField.id];
    if (isEmpty(idCell)) { out.errors.push({ line: rec.line, message: where + ': нет артикула' }); continue; }
    const id = text(idCell);
    if (seen.has(id)) {
      out.errors.push({ line: rec.line, id, message: where + ': артикул ' + id + ' уже был в строке ' + seen.get(id) });
      continue;
    }
    seen.set(id, rec.line);

    const values = {};
    for (const [field, i] of Object.entries(byField)) {
      if (field === 'id' || isEmpty(rec.cells[i])) continue;      // не прислали — не трогаем
      try { values[field] = PARSE[field](rec.cells[i]); }
      catch (msg) { problems.push(msg); }
    }
    const attrs = {};
    for (const i of extra) if (!isEmpty(rec.cells[i])) attrs[String(parsed.headers[i]).trim()] = text(rec.cells[i]);

    const old = current.get(id);
    if (!old) {
      if (values.title === undefined && !problems.some(m => m.startsWith('название'))) problems.push('нет названия — у новой позиции оно обязательно');
      if (values.price === undefined && !problems.some(m => m.startsWith('цена'))) problems.push('нет цены — у новой позиции она обязательна');
    }
    if (problems.length) {
      for (const m of problems) out.errors.push({ line: rec.line, id, message: where + ': ' + m });
      continue;
    }

    if (!old) {
      const item = Object.assign({ id }, values);
      if (Object.keys(attrs).length) item.attrs = attrs;
      out.created.push({ line: rec.line, id, title: item.title, item });
      continue;
    }
    const item = Object.assign({}, old, values);
    if (Object.keys(attrs).length) item.attrs = Object.assign({}, old.attrs, attrs);
    const changes = Object.keys(values).filter(f => !same(old[f], values[f]))
      .map(f => ({ field: f, title: TITLES[f], from: old[f], to: values[f] }));
    for (const [k, v] of Object.entries(attrs)) {
      if (!old.attrs || old.attrs[k] !== v) changes.push({ field: 'attrs.' + k, title: k, from: old.attrs && old.attrs[k], to: v });
    }
    if (changes.length) out.updated.push({ line: rec.line, id, title: item.title, changes, item });
    else out.unchanged.push({ line: rec.line, id, title: old.title });
  }

  out.columns = {
    recognized: Object.entries(byField).map(([field, i]) => ({ header: String(parsed.headers[i]).trim(), field, title: TITLES[field] })),
    created: extra.map(i => String(parsed.headers[i]).trim())
  };
  return out;
}

/** Новый список позиций: обновлённые на своих местах, новые — в конце. */
function apply(p, items) {
  const replaced = new Map(p.updated.map(u => [u.id, u.item]));
  return items.map(it => replaced.get(String(it.id)) || it).concat(p.created.map(c => c.item));
}

const strip = rows => rows.map(({ item, ...rest }) => rest);

/**
 * Импорт. input — текст или Buffer, format — подсказка (csv, json или Content-Type).
 * dryRun — только предпросмотр. Возвращает отчёт; строки с ошибками пропускаются.
 */
async function run(input, { format, dryRun } = {}) {
  const content = decode(input == null ? '' : input);
  if (!content.trim()) fail('BAD_FILE', 'файл пустой');
  const fmt = formatOf(format, content);
  const parsed = Object.assign(fmt === 'json' ? parseJson(content) : parseCsv(content), { format: fmt });

  let p = plan(parsed, catalog.all());
  const writes = p.created.length + p.updated.length;
  if (!dryRun && writes) {
    // план пересчитывается на момент записи — параллельный импорт не затрёт этот
    await catalog.save(items => apply(p = plan(parsed, items), items));
  }
  return {
    dryRun: !!dryRun, format: fmt, applied: !dryRun && writes > 0,
    summary: { rows: parsed.records.length, created: p.created.length, updated: p.updated.length,
      unchanged: p.unchanged.length, errors: p.errors.length },
    created: strip(p.created), updated: strip(p.updated), unchanged: p.unchanged,
    errors: p.errors, columns: p.columns
  };
}

module.exports = { run, parseCsv, mapColumns, decode, COLUMNS };
