'use strict';
/**
 * Приёмка живого контура — после каждого развёртывания:
 *   SMOKE_LOGIN=… SMOKE_PASSWORD=… npm run smoke <адрес API> [--web <адрес витрины>]
 *
 * Шаги: живость и режимы, публичность витрины, закрытость кабинета, вход,
 * сквозная сделка от каталога до заказа, списание остатка, смена статуса,
 * отмена и возврат остатка, синхронизация с площадкой (журнал, предпросмотр,
 * сверка). Печатает отчёт с отметками, код выхода 1 — если есть провал.
 *
 * Ничего не ломает: заказ создаётся один, помечен как тестовый и отменяется
 * в конце, даже если шаг посередине упал. Без учётных данных кабинета заказ
 * не создаётся вовсе — его нечем было бы отменить.
 */

const MARK = { ok: '✓', fail: '✗', warn: '⚠', skip: '·' };
const SMOKE_CUSTOMER = { name: 'SMOKE — тестовый заказ, будет отменён', phone: '+70000000000' };

function reporter(print) {
  const steps = [];
  let current = null;
  return {
    steps,
    step(title) { current = { title, checks: [], started: Date.now() }; steps.push(current); if (print) print('\n' + title); },
    check(status, text) {
      current.checks.push({ status, text });
      if (print) print('  ' + MARK[status] + ' ' + text);
      return status === 'ok';
    },
    get failed() { return steps.some(s => s.checks.some(c => c.status === 'fail')); }
  };
}

function client(base) {
  const root = String(base).replace(/\/+$/, '');
  const call = async function (method, route, { body, token, raw, type } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = type || 'application/json';
    if (token) headers.Authorization = 'Bearer ' + token;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15000);
    try {
      const r = await fetch(root + route, { method, headers, signal: ctl.signal,
        body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
      const text = await r.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* не JSON */ }
      return { status: r.status, json, text: raw ? text : undefined };
    } finally { clearTimeout(timer); }
  };
  call.base = root;
  return call;
}

/**
 * @param {string} base адрес API
 * @param {{login?:string, password?:string, web?:string, print?:Function}} opts
 * @returns {Promise<{ok:boolean, steps:object[], order?:string}>}
 */
async function run(base, opts = {}) {
  const r = reporter(opts.print);
  const api = client(base);
  const ctx = {};
  try { await scenario(api, r, opts, ctx); }
  catch (e) {
    r.check('fail', 'сценарий прерван: ' + (e.name === 'AbortError' ? 'нет ответа за 15 секунд' : e.message));
  } finally {
    if (ctx.orderId && !ctx.cancelled) {
      r.step('Уборка');
      const done = ctx.token && await api('POST', '/api/orders/status', { token: ctx.token, body: { id: ctx.orderId, status: 'CANCELLED' } }).catch(() => null);
      if (done && done.status === 200) r.check('warn', 'тестовый заказ ' + ctx.orderId + ' отменён при уборке после сбоя');
      else r.check('fail', 'тестовый заказ ' + ctx.orderId + ' не отменён — отмените его в кабинете вручную');
    }
  }
  if (opts.print) {
    const all = r.steps.flatMap(s => s.checks);
    const n = k => all.filter(c => c.status === k).length;
    opts.print('\nИтого: ' + n('ok') + ' ✓, ' + n('fail') + ' ✗, ' + n('warn') + ' ⚠' + (r.failed ? ' — ПРИЁМКА НЕ ПРОЙДЕНА' : ' — приёмка пройдена'));
  }
  return { ok: !r.failed, steps: r.steps, order: ctx.orderId };
}

async function scenario(api, r, opts, ctx) {
  // 1. живость и режимы
  r.step('1. Живость и режимы');
  const h = await api('GET', '/api/health');
  if (!r.check(h.status === 200 && h.json && h.json.ok ? 'ok' : 'fail', 'GET /api/health → ' + h.status)) return;
  const m = h.json;
  r.check('ok', 'экземпляр ' + m.instance + ', хранилище ' + m.storage + ', схема остатка ' + m.stockScheme);
  r.check(m.marketplace === 'dry-run' ? 'ok' : 'warn', 'площадка: ' + m.marketplace + (m.marketplace === 'dry-run' ? '' : ' — запросы уходят в бой'));
  r.check(/:dry$/.test(m.payments) ? 'ok' : 'warn', 'платежи: ' + m.payments + (/:dry$/.test(m.payments) ? '' : ' — тестовый заказ создаст неоплаченный платёж, он истечёт сам'));
  r.check(/example/.test(m.configSource) ? 'warn' : 'ok', 'конфиг бренда: ' + m.configSource + (/example/.test(m.configSource) ? ' — это пример, бренд продавца не подключён' : ''));
  if (m.storage === 'memory') r.check('warn', 'хранилище в памяти: данные пропадут при перезапуске');

  // 2. витрина публична
  r.step('2. Витрина открыта покупателю');
  const cfg = await api('GET', '/api/config');
  r.check(cfg.status === 200 && cfg.json && cfg.json.theme ? 'ok' : 'fail', 'конфиг витрины без входа → ' + cfg.status + (cfg.json && cfg.json.theme ? ', магазин «' + cfg.json.theme.name + '»' : ''));
  const cat = await api('GET', '/api/catalog?channel=SITE');
  const items = (cat.json && cat.json.items) || [];
  r.check(cat.status === 200 && items.length ? 'ok' : 'fail', 'каталог без входа → ' + cat.status + ', позиций: ' + items.length);
  const pick = items.filter(p => p.kind !== 'bundle' && p.available >= 1).sort((a, b) => b.available - a.available)[0];
  if (pick) {
    const card = await api('GET', '/api/product?id=' + encodeURIComponent(pick.id));
    r.check(card.status === 200 && card.json.id === pick.id ? 'ok' : 'fail', 'карточка ?id=' + pick.id + ' → ' + card.status);
  }
  const miss = await api('GET', '/api/product?id=__smoke_missing__');
  r.check(miss.status === 404 ? 'ok' : 'fail', 'несуществующая позиция → ' + miss.status + ' (ожидается 404)');
  if (opts.web) await checkWeb(opts.web, api.base, r, cfg.json);

  // 3. кабинет закрыт
  r.step('3. Кабинет закрыт без входа');
  for (const [method, route] of [['GET', '/api/orders'], ['POST', '/api/orders/status'], ['GET', '/api/stock/log'],
                                 ['POST', '/api/stock/adjust'], ['POST', '/api/catalog/import'],
                                 ['GET', '/api/sync/log'], ['POST', '/api/sync/run'], ['GET', '/api/sync/diff'],
                                 ['POST', '/api/marketplace/orders'], ['POST', '/api/auth/password']]) {
    const x = await api(method, route, method === 'POST' ? { body: {} } : {});
    r.check(x.status === 401 ? 'ok' : 'fail', method + ' ' + route + ' → ' + x.status + (x.status === 401 ? '' : ' — ОТКРЫТО БЕЗ ВХОДА'));
  }
  // правдоподобная подделка: верный заголовок, чужая нагрузка, неверная подпись
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const forgedToken = b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64({ sub: 'admin', inst: 'any', exp: 4102444800 }) + '.forged-signature';
  const forged = await api('GET', '/api/orders', { token: forgedToken });
  r.check(forged.status === 401 ? 'ok' : 'fail', 'поддельный токен → ' + forged.status);

  // 4. вход — до сделки: без него тестовый заказ нечем отменить
  r.step('4. Вход в кабинет');
  if (!opts.login || !opts.password) {
    r.check('fail', 'нет учётных данных: задайте SMOKE_LOGIN и SMOKE_PASSWORD — сделка не проверяется, заказ не создаётся');
    return;
  }
  const login = await api('POST', '/api/auth/login', { body: { login: opts.login, password: opts.password } });
  if (!r.check(login.status === 200 && login.json.token ? 'ok' : 'fail', 'вход «' + opts.login + '» → ' + login.status + (login.status === 200 ? '' : ' ' + ((login.json || {}).error || '')))) return;
  ctx.token = login.json.token;
  const me = await api('GET', '/api/auth/me', { token: ctx.token });
  if (!r.check(me.status === 200 && me.json.owner ? 'ok' : 'fail', 'продавец этого экземпляра: ' + (me.json && me.json.owner ? 'да' : 'нет — чужой экземпляр'))) return;

  // 5. сквозная сделка
  r.step('5. Сделка: каталог → корзина → заказ');
  if (!r.check(pick ? 'ok' : 'fail', pick ? 'позиция для проверки: ' + pick.id + ' «' + pick.title + '», в наличии ' + pick.available : 'нет товара в наличии — сделку проверить не на чем')) return;
  const before = pick.available;
  const quote = await api('POST', '/api/cart/quote', { body: { items: [{ id: pick.id, qty: 1 }], channel: 'SITE' } });
  if (!r.check(quote.status === 200 && quote.json.total > 0 ? 'ok' : 'fail', 'расчёт корзины → ' + quote.status + (quote.json && quote.json.total ? ', итого ' + quote.json.total : ''))) return;
  const order = await api('POST', '/api/orders', { body: { items: [{ id: pick.id, qty: 1 }], channel: 'SITE', customer: SMOKE_CUSTOMER } });
  if (!r.check(order.status === 201 && order.json.id ? 'ok' : 'fail', 'заказ → ' + order.status + (order.json && order.json.id ? ', № ' + order.json.id : ''))) return;
  ctx.orderId = order.json.id;
  ctx.orderAt = order.json.at;
  r.check(order.json.total === quote.json.total ? 'ok' : 'fail', 'сумма заказа совпадает с расчётом корзины: ' + order.json.total);

  // 6. списание
  r.step('6. Списание остатка');
  const after = (await api('GET', '/api/product?id=' + encodeURIComponent(pick.id))).json.available;
  r.check(after === before - 1 ? 'ok' : 'fail', 'остаток ' + pick.id + ': было ' + before + ', стало ' + after + ' (ожидается ' + (before - 1) + ')');

  // 7. кабинет: заказ виден, статус меняется
  r.step('7. Кабинет: заказ и смена статуса');
  const list = await api('GET', '/api/orders', { token: ctx.token });
  r.check(list.status === 200 && list.json.orders.some(o => o.id === ctx.orderId) ? 'ok' : 'fail', 'заказ ' + ctx.orderId + ' в очереди кабинета');
  const packed = await api('POST', '/api/orders/status', { token: ctx.token, body: { id: ctx.orderId } });
  const last = packed.json && packed.json.history && packed.json.history[packed.json.history.length - 1];
  r.check(packed.status === 200 && packed.json.status === 'PACKING' ? 'ok' : 'fail', 'статус → ' + ((packed.json || {}).statusTitle || packed.status));
  r.check(last && last.by === opts.login ? 'ok' : 'fail', 'в истории заказа исполнитель — ' + (last ? last.by : '?'));

  // 8. отмена и возврат
  r.step('8. Отмена и возврат остатка');
  const cancel = await api('POST', '/api/orders/status', { token: ctx.token, body: { id: ctx.orderId, status: 'CANCELLED' } });
  ctx.cancelled = cancel.status === 200 && cancel.json.status === 'CANCELLED';
  r.check(ctx.cancelled ? 'ok' : 'fail', 'заказ отменён → ' + cancel.status);
  const back = (await api('GET', '/api/product?id=' + encodeURIComponent(pick.id))).json.available;
  r.check(back === before ? 'ok' : 'fail', 'остаток ' + pick.id + ' вернулся: ' + back + ' (было ' + before + ')');
  const log = await api('GET', '/api/stock/log?id=' + encodeURIComponent(pick.id), { token: ctx.token });
  const moves = ((log.json && log.json.entries) || []).filter(e => e.ref === ctx.orderId).map(e => e.reason).sort();
  r.check(moves.join(',') === 'cancel,order' ? 'ok' : 'fail', 'в журнале движений по заказу: ' + (moves.join(', ') || 'ничего'));

  // 9. синхронизация: движения заказа ушли посылкой, предпросмотр ничего не шлёт, сверка честная
  r.step('9. Синхронизация с площадкой');
  let s = (await api('GET', '/api/sync/log?limit=20', { token: ctx.token })).json;
  if (!r.check(s ? 'ok' : 'fail', 'журнал синхронизации виден в кабинете')) return;
  if (!s.active) { r.check('warn', 'синхронизация выключена в конфигурации — пропуск'); return; }
  r.check('ok', 'режим: ' + (s.mode === 'dry-run' ? 'сухой прогон' : 'боевой') + ', окно ' + s.windowMs + ' мс');
  const since = ctx.orderAt;
  const deadline = Date.now() + s.windowMs + 4000;
  let sent = null;
  while (!sent && Date.now() < deadline) {
    sent = s.entries.find(e => e.at >= since && e.kind === 'stocks' && e.rows.some(x => x.offer_id === pick.id));
    if (!sent) { await new Promise(res => setTimeout(res, 500)); s = (await api('GET', '/api/sync/log?limit=20', { token: ctx.token })).json; }
  }
  r.check(sent ? (sent.ok ? 'ok' : 'fail') : 'fail', sent
    ? 'заказ и отмена ушли одной посылкой остатков: ' + (sent.reasons || []).join(', ') + ' → ' + (sent.ok ? sent.response : sent.error)
    : 'по заказу нет посылки остатков за ' + Math.round((s.windowMs + 4000) / 1000) + ' с');
  const preview = (await api('POST', '/api/sync/run?dryRun=1', { token: ctx.token })).json || {};
  const row = (preview.stocks || []).find(x => x.offer_id === pick.id);
  r.check(preview.preview && row ? 'ok' : 'fail', 'предпросмотр: уйдёт цен ' + (preview.prices || []).length + ', остатков ' + (preview.stocks || []).length +
    (row ? ', ' + pick.id + ' — ' + row.stock + ' для площадки' : ''));
  const d = (await api('GET', '/api/sync/diff', { token: ctx.token })).json || {};
  if (s.mode === 'dry-run') r.check(d.status === 'NO_DATA' ? 'ok' : 'fail', 'сверка в сухом прогоне: ' + (d.status === 'NO_DATA' ? 'честно «данных площадки нет»' : d.status));
  else r.check(d.status === 'OK' ? 'ok' : 'warn', 'сверка с площадкой: ' + d.status + (d.mismatches ? ', расхождений ' + d.mismatches.length : ''));
}

/** Витрина: собрана с тем же конфигом, смотрит на этот API, юридические страницы на месте. */
async function checkWeb(web, apiBase, r, pub) {
  const site = client(web);
  const index = await site('GET', '/', { raw: true });
  if (!r.check(index.status === 200 ? 'ok' : 'fail', 'витрина ' + web + ' → ' + index.status)) return;
  const siteName = (index.text.match(/<meta property="og:site_name" content="([^"]*)"/) || [])[1];
  const ogImage = /<meta property="og:image"/.test(index.text);
  r.check(siteName && pub && decode(siteName) === pub.theme.name ? 'ok' : 'fail',
    'заголовки витрины собраны с конфигом API: «' + decode(siteName || '?') + '»');
  r.check(ogImage ? 'ok' : 'warn', ogImage ? 'картинка для мессенджеров есть' : 'нет картинки для мессенджеров: seo.image или web/assets/preview.png');
  const baked = (index.text.match(/const API = "([^"]*)"\.startsWith/) || [])[1] || '';
  const apiOfSite = baked.startsWith('__API') ? '' : baked;
  const same = apiOfSite.replace(/\/+$/, '') === String(apiBase || '').replace(/\/+$/, '');
  r.check(same ? 'ok' : 'warn', 'витрина обращается к API: ' + (apiOfSite || '(тот же адрес)') + (same ? '' : ' — не тот, что проверяется'));
  for (const [key, title] of [['offerUrl', 'оферта'], ['privacyUrl', 'персональные данные'], ['returnsUrl', 'доставка и возврат']]) {
    const url = pub && pub.legal && pub.legal[key];
    if (!url) { r.check('fail', title + ': нет ссылки в конфиге'); continue; }
    const page = await site('GET', url.startsWith('/') ? url : '/' + url, { raw: true });
    r.check(page.status === 200 ? 'ok' : 'fail', title + ' ' + url + ' → ' + page.status);
    if (page.status === 200 && /требует проверки юристом/i.test(page.text)) r.check('warn', title + ': текст — заглушка, нужен юрист до запуска продаж');
  }
}
const decode = s => String(s).replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

if (require.main === module) {
  const args = process.argv.slice(2);
  const webAt = args.indexOf('--web');
  const web = webAt >= 0 ? args[webAt + 1] : undefined;
  const target = args.filter((a, i) => webAt < 0 || (i !== webAt && i !== webAt + 1))[0];
  if (!target) {
    console.error('Использование: SMOKE_LOGIN=… SMOKE_PASSWORD=… npm run smoke <адрес API> [--web <адрес витрины>]');
    process.exit(2);
  }
  console.log('Приёмка контура ' + target + (web ? ' и витрины ' + web : '') + ' — ' + new Date().toLocaleString('ru-RU'));
  run(target, { login: process.env.SMOKE_LOGIN, password: process.env.SMOKE_PASSWORD, web, print: s => console.log(s) })
    .then(res => process.exit(res.ok ? 0 : 1));
}

module.exports = { run };
