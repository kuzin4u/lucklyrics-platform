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
 * и ничего не пишет. Негодное значение — ошибка строки, а не молчаливый 0:
 * в коде пекарни было parseInt(...) || 0, сюда это не переносится.
 *
 * Остаток — не описание товара: колонки остатка идут в stock.js отдельным
 * списком, и предпросмотр показывает их отдельно — видно, что перезапишется склад.
 * Нет колонки — остаток не трогается вовсе.
 *
 * Набор: колонка «состав набора» в формате SKU-001×2|SKU-003×1. Компоненты —
 * позиции каталога или этого же файла, в любом порядке строк. Набор в наборе
 * запрещён, ссылка на несуществующую позицию — ошибка строки.
 */
const catalog = require('./catalog');
const stock = require('./stock');

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
  photos:           ['photos', 'images', 'фотографии', 'изображения', 'галерея', 'photo', 'image', 'фото', 'изображение', 'картинки'],
  composition:      ['composition', 'состав', 'ингредиенты'],
  rating:           ['rating', 'рейтинг', 'оценка'],
  reviews:          ['reviews', 'отзывы', 'кол-во отзывов'],
  buffer:           ['buffer', 'страховой запас', 'буфер'],
  // «Состав» — ингредиенты (composition), состав набора — отдельная колонка
  components:       ['components', 'состав набора', 'комплект', 'bundle']
};
const STOCK_FIELDS = ['stock', 'marketplaceStock'];

const TITLES = {
  id: 'артикул', title: 'название', price: 'цена', oldPrice: 'старая цена', stock: 'остаток',
  marketplaceStock: 'остаток площадки', fulfillment: 'схема исполнения', category: 'категория',
  categoryTitle: 'название категории', unit: 'единица', weight: 'вес', emoji: 'эмодзи',
  description: 'описание', features: 'особенности', photos: 'фотографии', rating: 'рейтинг', reviews: 'отзывы',
  buffer: 'страховой запас', components: 'состав набора', kind: 'вид', composition: 'состав'
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

/** Фото: внешние адреса через | или перевод строки. Своего хранилища файлов нет. */
function photos(v) {
  const urls = (Array.isArray(v) ? v.map(String) : String(v).split(/[|\s]+/)).map(s => s.trim()).filter(Boolean);
  const bad = urls.find(u => !/^https?:\/\/[^\s"'<>]+$/i.test(u) && !/^\/[^\s"'<>]*$/.test(u));
  if (bad) throw 'фотографии: ' + shown(bad) + ' — нужен адрес вида https://… или /путь';
  return urls;
}

/** Состав набора: «SKU-001×2|SKU-003×1», множитель — × или *, без него — 1. */
function components(v) {
  const parts = Array.isArray(v) ? v : String(v).split('|');
  const out = [];
  for (const raw of parts) {
    let id, qty;
    if (raw && typeof raw === 'object') { id = text(raw.id == null ? '' : raw.id); qty = raw.qty === undefined ? 1 : number(raw.qty); }
    else {
      const s = String(raw).trim();
      if (!s) continue;
      const m = /^(.*?)\s*[×*]\s*(\S+)$/.exec(s);
      id = (m ? m[1] : s).trim(); qty = m ? number(m[2]) : 1;
    }
    if (!id) throw 'состав набора: пропущен артикул компонента (' + shown(String(raw)) + ')';
    if (!Number.isInteger(qty) || qty < 1) throw 'состав набора: кратность ' + id + ' — нужно целое число от 1';
    if (out.some(c => c.id === id)) throw 'состав набора: ' + id + ' указан дважды';
    out.push({ id, qty });
  }
  if (!out.length) throw 'состав набора пустой';
  return out;
}
const showComponents = cs => (cs || []).map(c => c.id + '×' + c.qty).join('|');

const PARSE = {
  id: text, title: text, category: text, categoryTitle: text, unit: text, weight: text, emoji: text, description: text,
  price: money('цена'), oldPrice: money('старая цена'),
  stock: count('остаток'), marketplaceStock: count('остаток площадки'), reviews: count('отзывы'),
  rating: v => { const n = number(v); if (Number.isNaN(n) || n < 0 || n > 5) throw 'рейтинг — нужно число от 0 до 5 (' + shown(v) + ')'; return n; },
  fulfillment: v => { const s = String(v).trim().toUpperCase(); if (s !== 'FBS' && s !== 'FBO') throw 'схема исполнения — FBS или FBO (' + shown(v) + ')'; return s; },
  features: list, photos, composition: text, buffer: count('страховой запас'), components
};

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ---------- план ---------- */

/**
 * Что будет создано, обновлено, оставлено, что перезапишется на складе
 * и какие строки с ошибками. Ничего не меняет.
 */
function plan(parsed, items, levelOf) {
  const { byField, extra } = mapColumns(parsed.headers);
  if (byField.id === undefined) {
    fail('BAD_FILE', 'нет колонки с артикулом: подойдёт ' + COLUMNS.id.join(', '), { columns: parsed.headers });
  }
  const current = new Map(items.map(p => [String(p.id), p]));
  const seen = new Map();
  const rows = [];
  const out = { created: [], updated: [], unchanged: [], stock: [], errors: [] };
  const label = (parsed.format === 'json' ? 'запись ' : 'строка ');
  const err = (line, id, m) => out.errors.push({ line, id, message: label + line + ': ' + m });

  // 1. разбор строк
  for (const rec of parsed.records) {
    if (rec.notObject) { err(rec.line, undefined, 'ожидается объект позиции'); continue; }
    if (rec.cells.every(isEmpty)) continue;                       // пустая строка — не ошибка
    const idCell = rec.cells[byField.id];
    if (isEmpty(idCell)) { err(rec.line, undefined, 'нет артикула'); continue; }
    const id = text(idCell);
    if (seen.has(id)) { err(rec.line, id, 'артикул ' + id + ' уже был в строке ' + seen.get(id)); continue; }
    seen.set(id, rec.line);

    const values = {}, problems = [];
    for (const [field, i] of Object.entries(byField)) {
      if (field === 'id' || isEmpty(rec.cells[i])) continue;      // не прислали — не трогаем
      try { values[field] = PARSE[field](rec.cells[i]); }
      catch (msg) { problems.push(msg); }
    }
    const stockVals = {};
    for (const f of STOCK_FIELDS) if (f in values) { stockVals[f] = values[f]; delete values[f]; }
    const attrs = {};
    for (const i of extra) if (!isEmpty(rec.cells[i])) attrs[String(parsed.headers[i]).trim()] = text(rec.cells[i]);

    const old = current.get(id);
    const bundle = 'components' in values || (old ? old.kind === 'bundle' : problems.some(m => m.startsWith('состав набора')));
    if ('components' in values && old && old.kind !== 'bundle') problems.push('позиция уже заведена как товар — набор заводится отдельным артикулом');
    if (bundle && Object.keys(stockVals).length) problems.push('у набора нет своего остатка — он считается из состава');
    if (bundle && 'buffer' in values) problems.push('страховой запас задаётся компонентам, а не набору');
    if (!old) {
      if (values.title === undefined && !problems.some(m => m.startsWith('название'))) problems.push('нет названия — у новой позиции оно обязательно');
      if (values.price === undefined && !problems.some(m => m.startsWith('цена'))) problems.push('нет цены — у новой позиции она обязательна');
    }
    rows.push({ line: rec.line, id, values, stockVals, attrs, old, bundle, problems });
  }

  // 2. состав наборов: компоненты — из каталога или из этого же файла, порядок строк не важен
  const rowOf = new Map(rows.map(r => [r.id, r]));
  const kindOf = cid => {
    const r = rowOf.get(cid), p = current.get(cid);
    if (r && !r.problems.length) return r.bundle ? 'bundle' : 'item';
    if (p) return p.kind === 'bundle' ? 'bundle' : 'item';        // строка с ошибкой, но позиция уже есть
    return r ? 'broken' : null;
  };
  for (const r of rows) {
    for (const c of r.values.components || []) {
      const k = c.id === r.id ? 'self' : kindOf(c.id);
      if (k === 'self') r.problems.push('набор не может входить в себя');
      else if (k === null) r.problems.push('компонент ' + c.id + ' не найден в каталоге');
      else if (k === 'broken') r.problems.push('компонент ' + c.id + ' не импортируется: ошибка в строке ' + rowOf.get(c.id).line);
      else if (k === 'bundle') r.problems.push('набор внутри набора запрещён: ' + c.id + ' — набор');
    }
  }

  // 3. итог по строкам
  for (const r of rows) {
    if (r.problems.length) { r.problems.forEach(m => err(r.line, r.id, m)); continue; }
    const { line, id, values, old } = r;
    const item = old ? Object.assign({}, old, values) : Object.assign({ id }, values);
    if (r.bundle) item.kind = 'bundle';
    if (Object.keys(r.attrs).length) item.attrs = Object.assign({}, old && old.attrs, r.attrs);

    const lv = levelOf(id);
    const stockRows = Object.entries(r.stockVals).filter(([f, v]) => lv[f] !== v)
      .map(([f, v]) => ({ line, id, title: item.title, field: f, fieldTitle: TITLES[f], from: old ? lv[f] : null, to: v }));
    out.stock.push(...stockRows);

    if (!old) { out.created.push({ line, id, title: item.title, kind: item.kind || 'item', item }); continue; }
    const changes = Object.keys(values).filter(f => !same(old[f], values[f])).map(f => f === 'components'
      ? { field: f, title: TITLES[f], from: showComponents(old[f]), to: showComponents(values[f]) }
      : { field: f, title: TITLES[f], from: old[f], to: values[f] });
    for (const [k, v] of Object.entries(r.attrs)) {
      if (!old.attrs || old.attrs[k] !== v) changes.push({ field: 'attrs.' + k, title: k, from: old.attrs && old.attrs[k], to: v });
    }
    if (changes.length) out.updated.push({ line, id, title: item.title, changes, item });
    else if (!stockRows.length) out.unchanged.push({ line, id, title: old.title });
  }

  out.errors.sort((a, b) => a.line - b.line);
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
 * dryRun — только предпросмотр, by — продавец из токена для журнала склада.
 * Возвращает отчёт; строки с ошибками пропускаются.
 */
async function run(input, { format, dryRun, by } = {}) {
  const content = decode(input == null ? '' : input);
  if (!content.trim()) fail('BAD_FILE', 'файл пустой');
  const fmt = formatOf(format, content);
  const parsed = Object.assign(fmt === 'json' ? parseJson(content) : parseCsv(content), { format: fmt });

  let p = plan(parsed, catalog.all(), stock.level);
  const writes = p.created.length + p.updated.length + p.stock.length;
  if (!dryRun && writes) {
    // план пересчитывается на момент записи — параллельный импорт не затрёт этот.
    // Сначала каталог, потом склад: при сбое между ними новая позиция видна с нулём, а не наоборот.
    if (p.created.length + p.updated.length) await catalog.save(items => apply(p = plan(parsed, items, stock.level), items));
    if (p.stock.length) await stock.setMany(p.stock.map(s => ({ id: s.id, field: s.field, value: s.to })), { reason: 'import', by });
  }
  return {
    dryRun: !!dryRun, format: fmt, applied: !dryRun && writes > 0,
    summary: { rows: parsed.records.length, created: p.created.length, updated: p.updated.length,
      unchanged: p.unchanged.length, stock: p.stock.length, errors: p.errors.length },
    created: strip(p.created), updated: strip(p.updated), unchanged: p.unchanged, stock: p.stock,
    errors: p.errors, columns: p.columns
  };
}

module.exports = { run, parseCsv, mapColumns, decode, COLUMNS };
