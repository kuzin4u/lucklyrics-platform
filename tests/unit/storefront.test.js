'use strict';
/**
 * Витрина: карточка по прямому адресу, «не найдено», юридические страницы,
 * метки для поисковиков и мессенджеров, медиа с запасным вариантом.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.STORE_PROVIDER = 'memory';
const { server, catalog, config, stock, importer } = require('../../api/server');
const site = require('../../api/lib/site');
const { build } = require('../../api/scripts/build-web');

const WEB = path.resolve(__dirname, '..', '..', 'web');
const TEMPLATE = fs.readFileSync(path.join(WEB, 'index.template.html'), 'utf8');
const clone = o => JSON.parse(JSON.stringify(o));
let base;
const get = async route => { const r = await fetch(base + route); return { status: r.status, body: await r.json() }; };

test.before(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + server.address().port;
});
test.after(() => server.close());

test('карточка открывается по прямому адресу и отдаёт данные позиции', async () => {
  catalog.reset(); await stock.reset();
  const r = await get('/api/product?id=SKU-001');
  assert.equal(r.status, 200);
  const p = r.body;
  assert.deepEqual([p.id, p.title, p.price], ['SKU-001', catalog.byId('SKU-001').title, catalog.byId('SKU-001').price]);
  assert.equal(p.available, stock.availableStock(catalog.byId('SKU-001'), 'SITE'));
  assert.ok(Array.isArray(p.photos) && p.fallback, 'медиа и запасной вариант');
  assert.ok(p.specs.some(s => s.name === 'Категория'), 'характеристики');
  // витрина ведёт ?id= на этот маршрут и умеет вернуться «назад»
  assert.match(TEMPLATE, /q\.get\('id'\)/);
  assert.match(TEMPLATE, /\/api\/product\?channel=SITE&id=/);
  assert.match(TEMPLATE, /addEventListener\('popstate', route\)/);

  // набор: компоненты со ссылками на свои карточки
  await importer.run('Артикул;Название;Цена;Состав набора\nKIT-1;Набор пробный;900;SKU-001×2|SKU-002×1\n');
  const kit = (await get('/api/product?id=KIT-1')).body;
  assert.deepEqual(kit.components.map(c => [c.id, c.qty, c.url]), [['SKU-001', 2, '?id=SKU-001'], ['SKU-002', 1, '?id=SKU-002']]);
  assert.equal(kit.components[0].title, catalog.byId('SKU-001').title);
});

test('несуществующий адрес позиции — внятное «не найдено», а не пустая страница', async () => {
  const r = await get('/api/product?id=' + encodeURIComponent('НЕТ-ТАКОГО'));
  assert.deepEqual([r.status, r.body.error, r.body.id], [404, 'NOT_FOUND', 'НЕТ-ТАКОГО']);
  assert.equal((await get('/api/product')).status, 404, 'без id — тоже «не найдено»');
  // у витрины для 404 свой экран с выходом в каталог; ошибка связи — свой, без текста исключения
  assert.match(TEMPLATE, /r\.status === 404[\s\S]{0,200}Такого товара нет[\s\S]{0,300}Перейти в каталог/);
  assert.match(TEMPLATE, /Не удалось загрузить витрину/);
  assert.doesNotMatch(TEMPLATE, /e\.message/, 'текст исключения покупателю не показывается');
});

test('юридические страницы собираются, реквизиты подставляются из конфигурации', () => {
  const cfg = clone(config.load());
  cfg.brand.legalName = 'ИП Проверочный П. П.';
  cfg.brand.contacts.email = 'shop@example.test';
  cfg.legal.requisites = { inn: '771234567890', ogrn: '', address: 'г. Тестовый, ул. Примерная, 1' };
  const pages = site.legalPages(cfg, fs.readFileSync(path.join(WEB, 'legal.template.html'), 'utf8'));
  assert.deepEqual(pages.map(p => p.file), ['legal/offer.html', 'legal/privacy.html', 'legal/returns.html']);
  for (const p of pages) {
    assert.match(p.html, /требует проверки юристом/i, p.file);
    assert.ok(!p.html.includes('{{'), 'все метки заполнены: ' + p.file);
    assert.ok(p.html.includes(cfg.brand.name));
  }
  const offer = pages[0].html;
  ['ИП Проверочный П. П.', '771234567890', 'г. Тестовый, ул. Примерная, 1', 'shop@example.test'].forEach(v => assert.ok(offer.includes(v), 'нет реквизита: ' + v));
  assert.match(offer, /ОГРН[^<]*<\/th><td><span class="missing">не указано/, 'незаполненное видно как незаполненное');

  // сборка кладёт страницы туда, куда ведут ссылки витрины; наружу — только ссылки
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'web-build-'));
  try {
    const r = build(out, { apiUrl: 'https://api.example.test' });
    const links = config.publicConfig().legal;
    for (const url of Object.values(links)) assert.ok(fs.existsSync(path.join(out, url)), 'нет страницы ' + url);
    assert.deepEqual(Object.keys(links).sort(), ['offerUrl', 'privacyUrl', 'returnsUrl'], 'в публичном конфиге — только ссылки');
    assert.ok(r.files.includes('index.html'));
    assert.ok(fs.readFileSync(path.join(out, 'index.html'), 'utf8').includes('https://api.example.test'));
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});

test('заголовок, описание и разметка для мессенджеров — из конфигурации, в шаблоне бренда нет', () => {
  const cfg = clone(config.load());
  for (const v of [cfg.brand.name, cfg.brand.domain, cfg.brand.tagline]) assert.ok(!TEMPLATE.includes(v), 'бренд в шаблоне: ' + v);

  const auto = site.headTags(cfg);
  assert.ok(auto.includes('<title>' + cfg.brand.name + ' — ' + cfg.brand.tagline + '</title>'), 'без seo — из бренда');
  assert.ok(auto.includes('<meta property="og:url" content="https://' + cfg.brand.domain + '/">'));

  cfg.seo = { title: 'Свежая выпечка "с доставкой"', description: 'Описание для поисковиков', image: '/assets/share.jpg' };
  const tags = site.headTags(cfg);
  assert.ok(tags.includes('<title>Свежая выпечка &quot;с доставкой&quot;</title>'), 'значения экранируются');
  assert.ok(tags.includes('<meta name="description" content="Описание для поисковиков">'));
  assert.ok(tags.includes('<meta property="og:title" content="Свежая выпечка &quot;с доставкой&quot;">'));
  assert.ok(tags.includes('<meta property="og:description" content="Описание для поисковиков">'));
  assert.ok(tags.includes('<meta property="og:image" content="https://' + cfg.brand.domain + '/assets/share.jpg">'), 'картинка — абсолютным адресом');
  assert.ok(tags.includes('summary_large_image'));

  const html = site.renderIndex(TEMPLATE, cfg);
  assert.ok(!html.includes('SITE_HEAD') && (html.match(/<title>/g) || []).length === 1, 'одна метка title, заглушка убрана');
  assert.ok(html.includes('--accent:' + cfg.brand.palette.accent), 'тема окрашивает страницу до ответа API');
});

test('импорт принимает колонку с изображениями и раскладывает несколько адресов', async () => {
  catalog.reset(); await stock.reset();
  const r = await importer.run([
    'Артикул;Название;Цена;Изображения',
    'IMG-1;С тремя фото;100;"https://cdn.example.test/1.jpg | https://cdn.example.test/2.jpg',
    'https://cdn.example.test/3.jpg"',          // перевод строки внутри ячейки — та же строка таблицы
    'IMG-2;Путь на сайте;100;/assets/img-2.png',
    'IMG-3;Негодный адрес;100;javascript:alert(1)'
  ].join('\n'));
  assert.deepEqual(catalog.byId('IMG-1').photos, ['https://cdn.example.test/1.jpg', 'https://cdn.example.test/2.jpg', 'https://cdn.example.test/3.jpg']);
  assert.deepEqual(catalog.byId('IMG-2').photos, ['/assets/img-2.png']);
  assert.deepEqual(r.errors.map(e => e.message), ['строка 4: фотографии: «javascript:alert(1)» — нужен адрес вида https://… или /путь']);
  const en = await importer.run('SKU,Name,Price,Images\nIMG-4,English,100,https://cdn.example.test/4.jpg|https://cdn.example.test/5.jpg\n');
  assert.equal(en.summary.errors, 0);
  assert.equal(catalog.byId('IMG-4').photos.length, 2);
  assert.equal((await get('/api/product?id=IMG-1')).body.photos.length, 3, 'карточка отдаёт все фото');
});

test('позиция без изображения отдаёт запасной вариант, а не пустоту', async () => {
  catalog.reset(); await stock.reset();
  await importer.run('Артикул;Название;Цена;Эмодзи\nNOIMG-1;шоколад горький;100;\nNOIMG-2;Мёд;100;🍯\n');
  const letter = (await get('/api/product?id=NOIMG-1')).body;
  assert.deepEqual([letter.photos, letter.fallback], [[], { kind: 'letter', value: 'Ш' }]);
  const emoji = (await get('/api/product?id=NOIMG-2')).body;
  assert.deepEqual(emoji.fallback, { kind: 'emoji', value: '🍯' });
  const shop = (await get('/api/catalog')).body.items;
  assert.ok(shop.every(p => p.fallback && String(p.fallback.value).length > 0), 'у каждой позиции витрины есть что показать');
  // витрина подменяет и картинку, которая не загрузилась
  assert.match(TEMPLATE, /onerror="imgFail\(this\)"/);
});
