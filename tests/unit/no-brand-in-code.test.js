'use strict';
/**
 * Инвариант модели white label: значения конкретного продавца не встречаются
 * в исходном коде — только в конфигурации. Тест падает, если константа утекла.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const config = require('../../api/lib/config');

const ROOT = path.resolve(__dirname, '..', '..');
// dist — собранная статика: бренд в ней есть по назначению, проверяются шаблоны
const SKIP_DIRS = new Set(['node_modules', '.git', 'config', 'tests', 'dist', 'data']);

function walk(dir, acc) {
  acc = acc || [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), acc); }
    else if (/\.(js|html|sh|yaml|yml)$/.test(e.name)) acc.push(path.join(dir, e.name));
  }
  return acc;
}

test('название бренда и домен не встречаются в коде', () => {
  const name = config.get('brand.name');
  const domain = config.get('brand.domain');
  const files = walk(ROOT);
  assert.ok(files.length > 3, 'файлы для проверки не найдены');
  const hits = [];
  for (const f of files) {
    const txt = fs.readFileSync(f, 'utf8');
    if (name && name.length > 3 && txt.includes(name)) hits.push([f, name]);
    if (domain && domain.length > 3 && txt.includes(domain)) hits.push([f, domain]);
  }
  assert.deepEqual(hits, [], 'бренд-зависимые значения в коде: ' +
    hits.map(h => path.relative(ROOT, h[0]) + ' → ' + h[1]).join(', '));
});

test('секреты не зашиты в код', () => {
  const files = walk(ROOT);
  const bad = [];
  for (const f of files) {
    const txt = fs.readFileSync(f, 'utf8');
    if (/(Api-Key|api_key|secret)\s*[:=]\s*['"][A-Za-z0-9_\-]{12,}['"]/.test(txt)) bad.push(f);
  }
  assert.deepEqual(bad, [], 'похоже на зашитый секрет: ' + bad.join(', '));
});
