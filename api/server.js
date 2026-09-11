'use strict';
/**
 * Каркас серверного контура.
 * Отдаёт витрине публичную конфигурацию с готовой темой, проверку живости
 * для мониторинга и режим предпросмотра чужого конфига.
 * Ключи наружу не уходят ни при каких условиях.
 * Операции кабинета — только через cabinet(): продавец из токена, владелец экземпляра.
 */
const http = require('http');
const config = require('./lib/config');
const brand = require('./lib/brand');
const stock = require('./lib/stock');
const payments = require('./lib/payments');
const marketplace = require('./lib/marketplace/client');
const catalog = require('./lib/catalog');
const orders = require('./lib/orders');
const auth = require('./lib/auth');
const store = require('./lib/store');
const importer = require('./lib/import');
const sync = require('./lib/sync');

const PORT = Number(process.env.PORT || 3000);
const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};

/** Отказ модуля входа → HTTP. Нет секрета — вход выключен, это ошибка сервера. */
const AUTH_STATUS = { UNAUTHORIZED: 401, INVALID_CREDENTIALS: 401, FORBIDDEN: 403, NO_SECRET: 503, WEAK_SECRET: 503 };
function authFailed(res, e) {
  if (!(e.code in AUTH_STATUS)) return false;
  json(res, AUTH_STATUS[e.code], { error: e.code, reason: e.reason });
  return true;
}

/** Маршрут кабинета: продавец приходит пятым аргументом и только из токена. */
const cabinet = handler => (req, res, query, body) => {
  let seller;
  try { seller = auth.requireOwner(req); }
  catch (e) { if (authFailed(res, e)) return; throw e; }
  return handler(req, res, query, body, seller);
};

/** Конфиг запроса: активный либо предпросмотр по ?preview=slug. */
function configFor(query) {
  const slug = query && query.get && query.get('preview');
  if (!slug) return { cfg: config.load(), preview: false };
  return { cfg: config.loadNamed(slug), preview: true, slug };
}

const routes = {
  'GET /api/health': (req, res) => json(res, 200, {
    ok: true,
    instance: config.get('instance.id'),
    configSource: config.load()._source,
    marketplace: marketplace.isDry() ? 'dry-run' : 'live',
    payments: payments.adapterFor().name + (payments.adapterFor().live() ? ':live' : ':dry'),
    stockScheme: config.get('stock.scheme'),
    storage: store.name(),
    sync: marketplace.isDry() ? 'dry-run' : 'live',
    previews: config.listPreviews(),
    time: new Date().toISOString()
  }),

  'GET /api/config': (req, res, query) => {
    try {
      const { cfg, preview, slug } = configFor(query);
      const body = config.publicConfig(cfg);
      if (preview) body.preview = { active: true, slug };
      json(res, 200, body);
    } catch (e) {
      json(res, e.code === 'PREVIEW_NOT_FOUND' ? 404 : 400, { error: e.code || 'BAD_REQUEST' });
    }
  },

  'GET /api/theme': (req, res, query) => {
    try { json(res, 200, brand.theme(configFor(query).cfg)); }
    catch (e) { json(res, e.code === 'PREVIEW_NOT_FOUND' ? 404 : 400, { error: e.code || 'BAD_REQUEST' }); }
  },

  'GET /api/catalog': (req, res, query) => {
    const ch = (query && query.get('channel')) || 'SITE';
    try {
      json(res, 200, { channel: ch, categories: catalog.categories(), items: catalog.forChannel(ch) });
    } catch (e) { json(res, 400, { error: e.code || 'BAD_REQUEST' }); }
  },

  // Карточка для страницы витрины ?id=…: прямая ссылка и кнопка «назад» работают.
  'GET /api/product': (req, res, query) => {
    try { json(res, 200, catalog.product(query.get('id'), query.get('channel') || 'SITE')); }
    catch (e) { json(res, e.code === 'NOT_FOUND' ? 404 : 400, { error: e.code || 'BAD_REQUEST', id: e.id }); }
  },

  'POST /api/cart/quote': (req, res, query, body) => {
    try { json(res, 200, catalog.quote(body.items, body.channel || 'SITE')); }
    catch (e) { json(res, 409, { error: e.code || 'BAD_REQUEST', id: e.id, available: e.available }); }
  },

  'POST /api/orders': async (req, res, query, body) => {
    try { json(res, 201, await orders.create(body)); }
    catch (e) { json(res, e.code === 'NOT_ENOUGH_STOCK' ? 409 : 400, { error: e.code || 'BAD_REQUEST', id: e.id, available: e.available }); }
  },

  'POST /api/auth/login': async (req, res, query, body) => {
    try { json(res, 200, await auth.login(body.login, body.password)); }
    catch (e) { if (!authFailed(res, e)) throw e; }
  },

  'GET /api/auth/me': (req, res) => {
    try { const seller = auth.requireSeller(req); json(res, 200, { seller, owner: auth.owns(seller) }); }
    catch (e) { if (!authFailed(res, e)) throw e; }
  },

  'GET /api/orders': cabinet(async (req, res) => {
    const list = await orders.allOrders();
    json(res, 200, { orders: list, stats: orders.stats(list) });
  }),

  'POST /api/orders/status': cabinet(async (req, res, query, body, seller) => {
    try { json(res, 200, await orders.advance(body.id, body.status, seller.login)); }
    catch (e) { json(res, e.code === 'ORDER_NOT_FOUND' ? 404 : 400, { error: e.code || 'BAD_REQUEST' }); }
  }),

  // Тело — сам файл CSV или JSON; ?dryRun=1 — предпросмотр без записи.
  'POST /api/catalog/import': cabinet(async (req, res, query, body, seller) => {
    try {
      json(res, 200, await importer.run(req.rawBody, {
        format: query.get('format') || req.headers['content-type'],
        dryRun: ['1', 'true'].includes(query.get('dryRun')),
        by: seller.login
      }));
    } catch (e) {
      if (e.code !== 'BAD_FILE') throw e;
      json(res, 400, { error: 'BAD_FILE', message: e.message });
    }
  }),

  'GET /api/stock/log': cabinet((req, res, query) => json(res, 200, {
    entries: stock.log({ id: query.get('id') || undefined, limit: query.get('limit') })
  })),

  // Ручная правка: {id, value | delta, reason}. Кто правил — только из токена.
  'POST /api/stock/adjust': cabinet(async (req, res, query, body, seller) => {
    try {
      json(res, 200, await stock.adjust({ id: body.id, value: body.value, delta: body.delta, reason: body.reason, by: seller.login }));
    } catch (e) {
      const status = { UNKNOWN_SKU: 404, NEGATIVE_STOCK: 409 }[e.code] || 400;
      json(res, status, { error: e.code || 'BAD_REQUEST', id: e.id, available: e.available });
    }
  }),

  // Синхронизация с площадкой: журнал, ручной запуск (?dryRun=1 — только показать), сверка.
  'GET /api/sync/log': cabinet(async (req, res, query) => json(res, 200, await sync.log({ limit: query.get('limit') }))),
  'POST /api/sync/run': cabinet(async (req, res, query, body, seller) =>
    json(res, 200, await sync.run({ preview: ['1', 'true'].includes(query.get('dryRun')), by: seller.login }))),
  'GET /api/sync/diff': cabinet(async (req, res) => json(res, 200, await sync.diff())),

  'GET /api/marketplace/journal': cabinet((req, res) => json(res, 200, {
    dryRun: marketplace.isDry(), entries: marketplace.journal.slice(-50)
  }))
};

/** Сырое тело — Buffer: кодировку файла импорта определяет импорт, а не сервер. */
function readBody(req) {
  return new Promise(resolve => {
    const chunks = [];
    let size = 0;
    req.on('data', c => { chunks.push(c); size += c.length; if (size > 5e6) req.destroy(); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}
const parseJson = raw => { try { return raw.length ? JSON.parse(raw.toString('utf8')) : {}; } catch { return {}; } };

const server = http.createServer(async (req, res) => {
  const [pathname, qs] = req.url.split('?');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const handler = routes[req.method + ' ' + pathname];
  if (!handler) return json(res, 404, { error: 'NOT_FOUND', route: req.method + ' ' + pathname });
  req.rawBody = req.method === 'POST' ? await readBody(req) : Buffer.alloc(0);
  const body = parseJson(req.rawBody);
  try { await handler(req, res, new URLSearchParams(qs || ''), body); }
  catch (e) { json(res, 500, { error: 'INTERNAL', message: e.message }); }
});

if (require.main === module) {
  // без секрета и без годного конфига бренда — не стартуем: это защита, а не сбой
  try { config.load(); auth.assertConfigured(); }
  catch (e) { console.error('Сервер не запущен: ' + e.message); process.exit(1); }
  catalog.init().then(() => stock.init()).then(() => sync.start()).then(() => server.listen(PORT, () =>
    console.log('api on :' + PORT + ' · конфиг ' + config.load()._source + ' · хранилище ' + store.name())));
}
module.exports = { server, routes, config, brand, stock, payments, marketplace, catalog, orders, auth, store, importer, sync };
