'use strict';
/**
 * Проверка конфигурации бренда при старте.
 *
 * Смысл в том, КОГДА всплывает ошибка. Без проверки опечатка в конфиге
 * превращается в кривую витрину у клиента через неделю. С проверкой сервис
 * не поднимается и говорит, какое поле и чем не устроило.
 */
const HEX = /^#[0-9a-fA-F]{6}$/;

const RULES = [
  ['brand.name',                 v => typeof v === 'string' && v.trim().length >= 2, 'непустая строка от двух символов'],
  ['brand.domain',               v => typeof v === 'string' && /^[a-z0-9.-]+\.[a-z]{2,}(\/.*)?$/i.test(v), 'домен вида example.ru'],
  ['brand.palette.accent',       v => HEX.test(String(v)), 'цвет вида #RRGGBB'],
  ['brand.typography',           v => ['neutral', 'warm', 'strict'].includes(v), 'один из наборов: neutral, warm, strict'],
  ['branding.poweredBy',         v => typeof v === 'boolean', 'true или false'],
  ['catalog.currency',           v => typeof v === 'string' && v.length === 3, 'код валюты из трёх букв'],
  ['catalog.discountTiers',      v => Array.isArray(v) && v.every(t => t && t.min > 0 && t.pct > 0), 'список ступеней {min, pct}'],
  ['stock.scheme',               v => ['buffer', 'shared', 'split'].includes(v), 'buffer, shared или split'],
  ['stock.bufferDefault',        v => Number.isFinite(Number(v)) && Number(v) >= 0, 'неотрицательное число'],
  ['stock.fulfillmentDefault',   v => ['FBS', 'FBO'].includes(v), 'FBS или FBO'],
  ['payments.provider',          v => typeof v === 'string' && v.length > 1, 'имя провайдера'],
  ['payments.settlementDefault', v => ['DIRECT', 'SYSTEM'].includes(v), 'DIRECT или SYSTEM'],
  ['marketplace.enabled',        v => typeof v === 'boolean', 'true или false'],
  ['channels',                   v => Array.isArray(v) && v.length > 0 && v.every(c => c.code && 'ownSum' in c && 'ownStock' in c),
                                      'список каналов с полями code, ownSum, ownStock'],
  ['agent.autonomy',             v => ['full', 'moderated', 'mixed'].includes(v), 'full, moderated или mixed']
];

const pick = (obj, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);

/** @returns {string[]} список ошибок; пустой массив = конфиг годен */
function validate(cfg) {
  const errors = [];
  for (const [path, ok, expect] of RULES) {
    const val = pick(cfg, path);
    if (val === undefined) { errors.push(path + ': поле обязательно (' + expect + ')'); continue; }
    if (!ok(val)) errors.push(path + ': ожидается ' + expect + ', получено ' + JSON.stringify(val));
  }
  const codes = (cfg.channels || []).map(c => c.code);
  if (new Set(codes).size !== codes.length) errors.push('channels: коды каналов повторяются');
  return errors;
}

function assertValid(cfg, source) {
  const errors = validate(cfg);
  if (errors.length) {
    throw new Error('Конфигурация ' + (source || '') + ' не прошла проверку:\n  · ' + errors.join('\n  · '));
  }
  return cfg;
}

module.exports = { validate, assertValid, RULES };
