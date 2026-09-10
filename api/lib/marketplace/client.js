'use strict';
/**
 * Клиент площадки. Работает БЕЗ боевого ключа: в режиме сухого прогона запросы
 * не уходят, а фиксируются в журнале намерений. Это позволяет писать и
 * проверять синхронизацию до получения доступа.
 *
 * Боевой режим: задать MARKETPLACE_CLIENT_ID и MARKETPLACE_API_KEY в окружении
 * и снять marketplace.dryRun в конфигурации.
 */
const config = require('../config');

const CLIENT_ID = process.env.MARKETPLACE_CLIENT_ID;
const API_KEY   = process.env.MARKETPLACE_API_KEY;
const journal = [];

function isDry() {
  if (!CLIENT_ID || !API_KEY) return true;
  return Boolean(config.get('marketplace.dryRun', true));
}

async function call(method, endpoint, payload) {
  const entry = { at: new Date().toISOString(), method, endpoint, payload };
  if (isDry()) {
    journal.push(entry);
    console.log('[marketplace:dry]', method, endpoint);
    return { dryRun: true, ok: true, endpoint, sent: payload };
  }
  const res = await fetch(config.get('marketplace.baseUrl') + endpoint, {
    method,
    headers: { 'Client-Id': CLIENT_ID, 'Api-Key': API_KEY, 'Content-Type': 'application/json' },
    body: payload ? JSON.stringify(payload) : undefined
  });
  if (!res.ok) {
    const e = new Error('MARKETPLACE_HTTP_' + res.status);
    e.status = res.status;
    e.body = await res.text().catch(() => '');
    throw e;
  }
  return res.json();
}

const pushPrices  = items => call('POST', '/v1/product/import/prices', { prices: items });
const pushStocks  = items => call('POST', '/v2/products/stocks', { stocks: items });
const unfulfilled = (limit) => call('POST', '/v3/posting/fbs/unfulfilled/list', { limit: limit || 50, filter: {} });
const reviews     = (limit) => call('POST', '/v3/review/list', { limit: limit || 50 });

module.exports = { isDry, call, pushPrices, pushStocks, unfulfilled, reviews, journal,
  clearJournal: () => journal.splice(0, journal.length) };
