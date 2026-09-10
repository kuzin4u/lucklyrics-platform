'use strict';
/**
 * Каркас серверного контура.
 * Отдаёт витрине публичную конфигурацию с готовой темой, проверку живости
 * для мониторинга и режим предпросмотра чужого конфига.
 * Ключи наружу не уходят ни при каких условиях.
 */
const http = require('http');
const config = require('./lib/config');
const brand = require('./lib/brand');
const stock = require('./lib/stock');
const payments = require('./lib/payments');
const marketplace = require('./lib/marketplace/client');

const PORT = Number(process.env.PORT || 3000);
const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
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

  'GET /api/marketplace/journal': (req, res) => json(res, 200, {
    dryRun: marketplace.isDry(), entries: marketplace.journal.slice(-50)
  })
};

const server = http.createServer((req, res) => {
  const [pathname, qs] = req.url.split('?');
  const handler = routes[req.method + ' ' + pathname];
  if (handler) return handler(req, res, new URLSearchParams(qs || ''));
  json(res, 404, { error: 'NOT_FOUND', route: req.method + ' ' + pathname });
});

if (require.main === module) {
  server.listen(PORT, () => console.log('api on :' + PORT + ' · конфиг ' + config.load()._source));
}
module.exports = { server, routes, config, brand, stock, payments, marketplace };
