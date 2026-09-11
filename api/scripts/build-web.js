'use strict';
/**
 * Сборка статики витрины в web/dist:
 *   index.html   — метки <head> и тема из конфигурации (site.js), адрес API;
 *   cabinet.html — адрес API;
 *   legal/*.html — юридические страницы с реквизитами из конфигурации;
 *   assets/      — копия ассетов экземпляра.
 * Шаблоны бренда не содержат; собранное — содержит, поэтому dist не в git.
 *   API_URL=https://api.example node api/scripts/build-web.js [папка]
 */
const fs = require('fs');
const path = require('path');
const site = require('../lib/site');

const WEB = path.resolve(__dirname, '..', '..', 'web');

function build(outDir, { apiUrl } = {}) {
  const out = outDir || path.join(WEB, 'dist');
  const api = (s) => apiUrl ? s.split('__API_URL__').join(apiUrl) : s;
  const read = f => fs.readFileSync(path.join(WEB, f), 'utf8');
  // очищается содержимое, а не сама папка: локальный сервер, раздающий её, не теряет каталог
  fs.mkdirSync(out, { recursive: true });
  for (const f of fs.readdirSync(out)) fs.rmSync(path.join(out, f), { recursive: true, force: true });

  const written = [];
  const put = (rel, content) => {
    fs.mkdirSync(path.dirname(path.join(out, rel)), { recursive: true });
    fs.writeFileSync(path.join(out, rel), content);
    written.push(rel);
  };
  put('index.html', api(site.renderIndex(read('index.template.html'))));
  put('cabinet.html', api(read('cabinet.template.html')));
  for (const p of site.legalPages(null, read('legal.template.html'))) put(p.file, p.html);
  if (fs.existsSync(path.join(WEB, 'assets'))) {
    fs.cpSync(path.join(WEB, 'assets'), path.join(out, 'assets'), { recursive: true, filter: s => !/README\.md$|\.gitkeep$/.test(s) });
  }
  return { out, files: written };
}

if (require.main === module) {
  const r = build(process.argv[2] && path.resolve(process.argv[2]), { apiUrl: process.env.API_URL });
  console.log('Собрано в ' + r.out + ': ' + r.files.join(', '));
}

module.exports = { build };
