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

  'GET /api/orders': cabinet((req, res) => json(res, 200, { orders: orders.allOrders(), stats: orders.stats() })),

  'POST /api/orders/status': cabinet((req, res, query, body, seller) => {
    try { json(res, 200, orders.advance(body.id, body.status, seller.login)); }
    catch (e) { json(res, e.code === 'ORDER_NOT_FOUND' ? 404 : 400, { error: e.code || 'BAD_REQUEST' }); }
  }),

  'GET /api/marketplace/journal': cabinet((req, res) => json(res, 200, {
    dryRun: marketplace.isDry(), entries: marketplace.journal.slice(-50)
  }))
};

function readBody(req) {
  return new Promise(resolve => {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  const [pathname, qs] = req.url.split('?');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const handler = routes[req.method + ' ' + pathname];
  if (!handler) return json(res, 404, { error: 'NOT_FOUND', route: req.method + ' ' + pathname });
  const body = req.method === 'POST' ? await readBody(req) : {};
  try { await handler(req, res, new URLSearchParams(qs || ''), body); }
  catch (e) { json(res, 500, { error: 'INTERNAL', message: e.message }); }
});

if (require.main === module) {
  try { auth.assertConfigured(); }
  catch (e) { console.error('Сервер не запущен: ' + e.message); process.exit(1); }
  server.listen(PORT, () => console.log('api on :' + PORT + ' · конфиг ' + config.load()._source));
}
module.exports = { server, routes, config, brand, stock, payments, marketplace, catalog, orders, auth };
