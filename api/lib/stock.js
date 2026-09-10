'use strict';
/**
 * Остаток. Единственная точка чтения.
 *
 * Весь остальной код — витрина, кабинет, синхронизация с площадкой, оформление
 * заказа — спрашивает availableStock() и НЕ смотрит на поля товара напрямую.
 * Смена схемы резерва = замена тела одной функции.
 *
 * Схемы (config.stock.scheme):
 *   buffer — на площадку отдаём остаток минус страховой запас (по умолчанию)
 *   shared — общий пул: все каналы видят весь остаток
 *   split  — раздельные квоты по каналам
 *
 * Режим исполнения (у SKU, поле fulfillment):
 *   FBS — товар на нашем складе, остаток наш
 *   FBO — товар на складе площадки, наш остаток не участвует
 */
const config = require('./config');

const clampNonNegative = n => (n > 0 ? n : 0);

function bufferFor(sku) {
  const bySku = config.get('stock.bufferBySku', {}) || {};
  if (Object.prototype.hasOwnProperty.call(bySku, sku.id)) return Number(bySku[sku.id]) || 0;
  return Number(config.get('stock.bufferDefault', 0)) || 0;
}

function fulfillmentOf(sku) {
  return sku.fulfillment || config.get('stock.fulfillmentDefault', 'FBS');
}

/**
 * Доступный остаток товара в конкретном канале.
 * @param {{id:string, stock:number, fulfillment?:string, quotas?:Object}} sku
 * @param {string} channelCode SITE | MARKETPLACE | AGENT | BOT | VK
 * @returns {number}
 */
function availableStock(sku, channelCode) {
  const ch = config.channel(channelCode);
  const scheme = config.get('stock.scheme', 'buffer');
  const own = Number(sku.stock) || 0;

  // Товар на складе площадки: своим остатком не распоряжаемся.
  if (fulfillmentOf(sku) === 'FBO') {
    return ch.code === 'MARKETPLACE' ? Number(sku.marketplaceStock) || 0 : 0;
  }

  if (!ch.ownStock) return 0;

  if (scheme === 'shared') return clampNonNegative(own);

  if (scheme === 'split') {
    const q = (sku.quotas || {})[ch.code];
    return clampNonNegative(q === undefined ? 0 : Number(q));
  }

  // buffer: страховой запас не уходит на площадку, свои каналы видят весь остаток
  if (ch.code === 'MARKETPLACE') return clampNonNegative(own - bufferFor(sku));
  return clampNonNegative(own);
}

/** Можно ли продать qty штук в этом канале. */
function canSell(sku, channelCode, qty) {
  return qty > 0 && availableStock(sku, channelCode) >= qty;
}

/** Списание. Возвращает новый остаток; не даёт уйти в минус. */
function reserve(sku, channelCode, qty) {
  if (!canSell(sku, channelCode, qty)) {
    const e = new Error('NOT_ENOUGH_STOCK');
    e.code = 'NOT_ENOUGH_STOCK';
    throw e;
  }
  if (fulfillmentOf(sku) === 'FBO') return Number(sku.marketplaceStock) || 0;
  sku.stock = clampNonNegative((Number(sku.stock) || 0) - qty);
  return sku.stock;
}

/** Возврат остатка при отмене или возврате заказа. */
function release(sku, qty) {
  if (fulfillmentOf(sku) === 'FBO') return Number(sku.marketplaceStock) || 0;
  sku.stock = clampNonNegative((Number(sku.stock) || 0) + (Number(qty) || 0));
  return sku.stock;
}

module.exports = { availableStock, canSell, reserve, release, fulfillmentOf, bufferFor };
