'use strict';
/**
 * AI-помощник витрины. Единственная точка работы с моделью.
 *
 * Ключ — только из окружения (MODEL_API_KEY), в браузер и в ответы не попадает.
 * Без ключа или без дневного потолка помощник выключен: витрина работает, кнопки нет.
 * Модель вызывается прямым запросом к Messages API: SDK стал бы первой зависимостью.
 *
 * Границы — кодом, а не только промптом:
 * - предлагает только позиции этого каталога: идентификатор проверяется, недоступное
 *   по остатку отбрасывается; выдуманная позиция — ответ заменяется нейтральным;
 * - доставка, возврат, оплата — готовый ответ со ссылками на юридические страницы,
 *   модель не спрашивается; её ответ на эти темы тоже заменяется готовым;
 * - в промпт идут каталог и раздел «Факты» базы знаний, раздел политики — никогда;
 * - каждый ответ — в журнал: запрос, предложение, отброшенное, расход.
 * Лимиты из конфига бренда: сообщений в диалоге, диалогов с посетителя в сутки,
 * дневной потолок расхода. Сообщение засчитывается до вызова модели, поэтому
 * одновременные запросы предел не обходят; потолок проверяется перед вызовом.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const catalog = require('./catalog');
const stock = require('./stock');
const store = require('./store');
const site = require('./site');

const NAME = 'agent';
const ROOT = path.resolve(__dirname, '..', '..');
// Адрес Messages API: по умолчанию напрямую; MODEL_API_URL — свой прокси, если прямой доступ закрыт.
const apiUrl = () => process.env.MODEL_API_URL || 'https://api.anthropic.com/v1/messages';
const DIALOGS_KEPT = 500;
const IP_FACTOR = 4;             // запасной лимит по адресу: идентификатор посетителя легко сбросить
const MAX_TEXT = 1000;

/** Цены за миллион токенов, $: вход, выход. Запись в кэш — 1,25 входа, чтение — 0,1. */
const PRICES = [
  ['claude-haiku-4-5', 1, 5], ['claude-sonnet-5', 2, 10], ['claude-sonnet-4-6', 3, 15],
  ['claude-opus-5', 5, 25], ['claude-opus-4-8', 5, 25], ['claude-opus-4-7', 5, 25], ['claude-opus-4-6', 5, 25],
  ['claude-fable-5', 10, 50]
];

// Темы политики: не отвечаем сами. «Срок годности / хранения» — факт о продукте, не политика.
const POLICY = /(доставк|достав(им|ят|ить|лю)|курьер|самовывоз|возврат|вернуть|верн[её]т|обмен|оплат|предоплат|рассрочк|срок(и|а|ов)?\b(?!\s+(годности|хранения)))/i;

function fail(code, message, extra) {
  const e = new Error(message || code); e.code = code;
  throw Object.assign(e, extra);
}

/* ---------- настройки и доступность ---------- */

/** Ключ модели читается здесь и только здесь. */
const apiKey = () => process.env.MODEL_API_KEY || process.env.ANTHROPIC_API_KEY || '';

function settings() {
  const a = config.get('agent', {}) || {};
  return {
    enabled: a.enabled !== false, model: a.model,
    maxMessages: Number(a.maxMessagesPerDialog) || 15,
    maxDialogs: Number(a.maxDialogsPerVisitorPerDay) || 5,
    budget: Number(a.dailyBudgetUsd) || 0,
    timezone: a.timezone || 'Europe/Moscow',
    knowledgeFile: a.knowledgeFile || 'config/knowledge.md'
  };
}

function createAgent(opts = {}) {
  let responder = opts.responder || callModel;
  let spent = { day: null, cost: 0 };        // копия расхода за сегодня: доступность — без чтения хранилища

  const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: settings().timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

  /** Доступен ли помощник и почему нет. Причина — для кабинета и журнала, не для покупателя. */
  function status() {
    const s = settings();
    if (!apiKey()) return { available: false, reason: 'нет ключа модели (MODEL_API_KEY)' };
    if (!s.enabled) return { available: false, reason: 'выключен в конфигурации (agent.enabled)' };
    if (!s.model) return { available: false, reason: 'не задана модель (agent.model)' };
    if (!(s.budget > 0)) return { available: false, reason: 'не задан дневной потолок расхода (agent.dailyBudgetUsd)' };
    if (spent.day === today() && spent.cost >= s.budget) return { available: false, reason: 'дневной потолок исчерпан', budget: true };
    return { available: true };
  }
  const available = () => status().available;

  async function init() {
    const s = await store.read(NAME);
    const d = s && s.days && s.days[today()];
    spent = { day: today(), cost: d ? d.cost : 0 };
  }

  /* ---------- промпт ---------- */

  /** Раздел «Факты» базы знаний. Политика в промпт не идёт никогда. */
  function facts() {
    let text = '';
    try { text = fs.readFileSync(path.resolve(ROOT, settings().knowledgeFile), 'utf8'); } catch { return ''; }
    const m = /^##\s*Факты[^\n]*\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/m.exec(text);
    return m ? m[1].replace(/<!--[\s\S]*?-->/g, '').trim() : '';
  }

  function systemBlocks() {
    const shop = config.get('brand.name');
    const list = catalog.all().map(p => [p.id, p.title, p.price + ' ₽', p.categoryTitle || p.category || '', p.weight || '',
      p.kind === 'bundle' ? 'набор: ' + p.components.map(c => c.id + '×' + c.qty).join(', ') : '',
      String(p.description || '').replace(/\s+/g, ' ').slice(0, 240)].filter(Boolean).join(' | ')).join('\n');
    const f = facts();
    const stable = [
      'Ты — помощник интернет-магазина «' + shop + '». Помогаешь покупателю подобрать товары из каталога ниже: по теме, поводу, бюджету и количеству.',
      'Правила:',
      '- Предлагай только позиции из каталога, по их артикулу. Других товаров не существует.',
      '- Свойства товара бери только из каталога и раздела «Факты». Если данных нет — так и скажи, не придумывай.',
      '- Не называй сроки и стоимость доставки, условия возврата и оплаты: скажи, что они в документах магазина.',
      '- Отвечай коротко: одно-три предложения, на языке покупателя. Цены в рублях. Укладывайся в названный бюджет.',
      '- В items — предлагаемый состав корзины: артикул и количество. Подбирать нечего — пустой список.',
      '', 'Каталог (артикул | название | цена | категория | вес | состав набора | описание):', list,
      '', 'Факты о продукте:', f || '(не заполнены — о свойствах сверх каталога не говори)'
    ].join('\n');
    const out = catalog.all().filter(p => stock.availableStock(p, 'SITE') <= 0).map(p => p.id);
    // каталог и факты меняются редко — кэшируются; наличие меняется с каждым заказом — после метки кэша
    return [{ type: 'text', text: stable, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'Сейчас нет в наличии, не предлагай: ' + (out.join(', ') || 'всё в наличии') }];
  }

  const SCHEMA = {
    type: 'object', additionalProperties: false, required: ['reply', 'items'],
    properties: {
      reply: { type: 'string' },
      items: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'qty'],
        properties: { id: { type: 'string' }, qty: { type: 'integer' } } } }
    }
  };

  /* ---------- ответы без модели ---------- */

  function policyAnswer() {
    const l = site.legalLinks();
    const links = [{ title: 'Доставка и возврат', url: l.returnsUrl }, { title: 'Публичная оферта', url: l.offerUrl }];
    return { reply: 'Сроки и стоимость доставки, условия возврата и оплаты я не называю — они в документах магазина: «Доставка и возврат» и «Публичная оферта». А подобрать товары помогу.', links };
  }

  /** Только позиции каталога, доступные по остатку. Остальное — в отброшенное с причиной. */
  function validate(raw) {
    const items = [], dropped = [];
    const want = new Map();
    for (const it of Array.isArray(raw) ? raw : []) {
      const id = String(it && it.id || '').trim();
      const qty = Math.max(1, Math.min(20, parseInt(it && it.qty, 10) || 1));
      if (id) want.set(id, (want.get(id) || 0) + qty);
    }
    for (const [id, qty] of want) {
      const p = catalog.byId(id);
      if (!p) { dropped.push({ id, reason: 'нет в каталоге' }); continue; }
      const available = stock.availableStock(p, 'SITE');
      if (available <= 0) { dropped.push({ id, reason: 'нет в наличии' }); continue; }
      items.push({ id: p.id, title: p.title, price: p.price, qty: Math.min(qty, available), available });
    }
    return { items, dropped };
  }

  function costOf(model, u = {}) {
    const [, inp, out] = PRICES.find(([prefix]) => String(model).startsWith(prefix)) || PRICES[PRICES.length - 1];
    const usd = ((u.input_tokens || 0) * inp + (u.cache_creation_input_tokens || 0) * inp * 1.25 +
      (u.cache_read_input_tokens || 0) * inp * 0.1 + (u.output_tokens || 0) * out) / 1e6;
    return Math.round(usd * 1e6) / 1e6;
  }

  /* ---------- диалог ---------- */

  const blank = () => ({ salt: crypto.randomBytes(16).toString('hex'), days: {}, dialogs: [] });
  const dayOf = (s, day) => (s.days[day] = s.days[day] || { cost: 0, dialogs: 0, messages: 0, visitors: {}, ips: {} });
  const hashIp = (salt, ip) => crypto.createHash('sha256').update(salt + String(ip || '')).digest('hex').slice(0, 16);

  /**
   * Сообщение покупателя. → { dialogId, reply, links?, items, total, messagesLeft }
   * Отказы с кодом и вежливым текстом: AGENT_OFF, AGENT_BUDGET, AGENT_DIALOG_LIMIT,
   * AGENT_MESSAGE_LIMIT, AGENT_UNAVAILABLE, BAD_MESSAGE.
   */
  async function message({ dialogId, visitorId, ip, text }) {
    const st = status();
    if (!st.available) {
      if (st.budget) fail('AGENT_BUDGET', 'Помощник на сегодня отдыхает. Каталог и корзина работают как обычно.');
      fail('AGENT_OFF', 'Помощник сейчас выключен. Каталог и корзина работают как обычно.');
    }
    const msg = String(text == null ? '' : text).trim();
    if (!msg || msg.length > MAX_TEXT) fail('BAD_MESSAGE', 'Напишите вопрос — до ' + MAX_TEXT + ' символов.');
    const s0 = settings(), day = today();
    const visitor = /^[A-Za-z0-9_-]{8,64}$/.test(String(visitorId || '')) ? String(visitorId) : null;

    // лимиты и засчитывание сообщения — одной операцией, до вызова модели
    let dialog;
    await store.update(NAME, s => {
      s = s || blank();
      const d = dayOf(s, day);
      if (d.cost >= s0.budget) fail('AGENT_BUDGET', 'Помощник на сегодня отдыхает. Каталог и корзина работают как обычно.');
      const ipKey = hashIp(s.salt, ip), who = visitor || 'ip:' + ipKey;
      dialog = dialogId ? s.dialogs.find(x => x.id === dialogId && x.visitor === who) : null;
      if (!dialog) {
        if ((d.visitors[who] || 0) >= s0.maxDialogs || (d.ips[ipKey] || 0) >= s0.maxDialogs * IP_FACTOR) {
          fail('AGENT_DIALOG_LIMIT', 'На сегодня разговоров с помощником достаточно — завтра он снова поможет. Каталог работает как обычно.');
        }
        dialog = { id: 'DLG-' + crypto.randomBytes(5).toString('hex').toUpperCase(), visitor: who, ip: ipKey,
          startedAt: new Date().toISOString(), messages: 0, cost: 0, turns: [] };
        s.dialogs.push(dialog);
        s.dialogs = s.dialogs.slice(-DIALOGS_KEPT);
        d.visitors[who] = (d.visitors[who] || 0) + 1; d.ips[ipKey] = (d.ips[ipKey] || 0) + 1; d.dialogs++;
      }
      if (dialog.messages >= s0.maxMessages) {
        fail('AGENT_MESSAGE_LIMIT', 'В этом разговоре уже ' + s0.maxMessages + ' сообщений. Начните новый — или оформите то, что уже в корзине.');
      }
      dialog.messages++; d.messages++;
      return s;
    });

    const turn = { at: new Date().toISOString(), text: msg, reply: '', items: [], dropped: [], policy: false, costUsd: 0, usage: null };
    try {
      if (POLICY.test(msg)) {
        Object.assign(turn, policyAnswer(), { policy: true });
      } else {
        const history = dialog.turns.flatMap(t => [{ role: 'user', content: t.text },
          { role: 'assistant', content: JSON.stringify({ reply: t.reply, items: t.items.map(i => ({ id: i.id, qty: i.qty })) }) }]);
        const res = await responder({
          model: s0.model, max_tokens: 1024, system: systemBlocks(),
          messages: history.concat({ role: 'user', content: msg }),
          output_config: { format: { type: 'json_schema', schema: SCHEMA } }
        });
        turn.usage = res.usage || null;
        turn.costUsd = costOf(res.model || s0.model, res.usage);
        let parsed = null;
        const block = (res.content || []).find(b => b.type === 'text');
        if (res.stop_reason !== 'refusal') { try { parsed = JSON.parse(block ? block.text : ''); } catch { parsed = null; } }
        const v = validate(parsed && parsed.items);
        turn.items = v.items; turn.dropped = v.dropped;
        turn.reply = parsed && typeof parsed.reply === 'string' ? parsed.reply.trim() : '';
        if (!parsed) turn.reply = 'Не получилось подобрать ответ. Переформулируйте, пожалуйста, или посмотрите каталог.';
        else if (v.dropped.some(x => x.reason === 'нет в каталоге')) {
          // модель назвала то, чего нет: её текст мог это описывать — заменяется
          turn.reply = v.items.length ? 'Вот что есть в каталоге по вашему запросу.' : 'Не нашёл в каталоге подходящих позиций. Уточните запрос или посмотрите категории.';
        } else if (v.dropped.length) turn.reply += ' Часть позиций сейчас закончилась — я убрал их из подборки.';
        if (POLICY.test(turn.reply)) Object.assign(turn, policyAnswer(), { policy: true });   // модель заговорила о доставке
      }
    } catch (e) {
      turn.error = e.status ? 'модель ответила ' + e.status : e.name === 'TimeoutError' ? 'модель не ответила вовремя' : 'нет связи с моделью';
    }

    // журнал и расход
    await store.update(NAME, s => {
      s = s || blank();
      const d = dayOf(s, day);
      const dl = s.dialogs.find(x => x.id === dialog.id);
      if (dl) { dl.turns.push(turn); dl.cost = Math.round((dl.cost + turn.costUsd) * 1e6) / 1e6; dl.lastAt = turn.at; }
      d.cost = Math.round((d.cost + turn.costUsd) * 1e6) / 1e6;
      spent = { day, cost: d.cost };
      for (const k of Object.keys(s.days)) if (k < isoDaysAgo(62)) delete s.days[k];
      return s;
    });
    if (turn.error) fail('AGENT_UNAVAILABLE', 'Помощник сейчас не отвечает. Каталог и корзина работают как обычно.');

    let total = null;
    try { if (turn.items.length) total = catalog.quote(turn.items.map(i => ({ id: i.id, qty: i.qty })), 'SITE').total; } catch { total = null; }
    return { dialogId: dialog.id, reply: turn.reply, links: turn.links, policy: turn.policy, items: turn.items, total,
      messagesLeft: Math.max(0, s0.maxMessages - dialog.messages) };
  }

  const isoDaysAgo = n => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);

  /** Есть ли такой диалог — для отметки заказа «с участием помощника». */
  async function hasDialog(id) {
    const s = await store.read(NAME);
    return !!(s && id && s.dialogs.some(d => d.id === id));
  }

  /** Сводка для кабинета: диалоги, заказы с участием помощника, расход, журнал. */
  async function stats({ limit } = {}) {
    const s = (await store.read(NAME)) || blank();
    const day = today(), month = day.slice(0, 7), st = status(), cfg = settings();
    const d = s.days[day] || { cost: 0, dialogs: 0, messages: 0 };
    const monthDays = Object.entries(s.days).filter(([k]) => k.startsWith(month)).map(([, v]) => v);
    const sum = (list, k) => Math.round(list.reduce((n, x) => n + (x[k] || 0), 0) * 1e6) / 1e6;
    const assisted = (await require('./orders').allOrders()).filter(o => o.agent && o.status !== 'CANCELLED');
    const revenue = assisted.reduce((n, o) => n + o.total, 0);
    return {
      available: st.available, reason: st.reason || null, model: cfg.model,
      limits: { maxMessagesPerDialog: cfg.maxMessages, maxDialogsPerVisitorPerDay: cfg.maxDialogs, dailyBudgetUsd: cfg.budget },
      today: { dialogs: d.dialogs, messages: d.messages, costUsd: d.cost },
      month: { dialogs: sum(monthDays, 'dialogs'), costUsd: sum(monthDays, 'cost') },
      dialogsTotal: s.dialogs.length,
      orders: { count: assisted.length, revenue, avgCheck: assisted.length ? Math.round(revenue / assisted.length) : 0 },
      recent: s.dialogs.slice(-(Number(limit) || 20)).reverse().map(x => ({ id: x.id, startedAt: x.startedAt, lastAt: x.lastAt,
        messages: x.messages, costUsd: x.cost, turns: x.turns.map(t => ({ at: t.at, text: t.text, reply: t.reply, policy: t.policy,
          items: t.items.map(i => ({ id: i.id, title: i.title, qty: i.qty })), dropped: t.dropped, costUsd: t.costUsd, error: t.error })) }))
    };
  }

  return { status, available, init, message, hasDialog, stats, costOf, facts, validate,
    _setResponder: fn => { responder = fn || callModel; }, _system: systemBlocks };
}

/** Прямой запрос к Messages API. Один повтор на перегрузку и сбой площадки модели. */
async function callModel(body) {
  let last;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await fetch(apiUrl(), {
      method: 'POST', signal: AbortSignal.timeout(30000),
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey(), 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body)
    });
    const json = await res.json().catch(() => null);
    if (res.ok) return json;
    last = Object.assign(new Error('MODEL_HTTP_' + res.status + (json && json.error ? ': ' + json.error.type : '')), { status: res.status });
    if (!(res.status === 429 || res.status >= 500) || attempt === 2) break;
    await new Promise(r => setTimeout(r, 1000));
  }
  throw last;
}

module.exports = Object.assign(createAgent(), { createAgent, callModel, POLICY });
