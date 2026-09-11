'use strict';
/**
 * AI-помощник витрины. Модель не вызывается: подставляется поддельный ответчик,
 * в том числе с несуществующими позициями.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const KEY = 'sk-ant-test-SECRET-key-0123456789';
process.env.STORE_PROVIDER = 'memory';
process.env.JWT_SECRET = 'agent-test-secret-0123456789-abcdefghijk';
process.env.MODEL_API_KEY = KEY;
const { server, agent, catalog, stock, orders, auth, store, config } = require('../../api/server');

let base, token;
const cfg = () => config.load().agent;
function fakeModel(reply, items, usage = { input_tokens: 2000, output_tokens: 300 }) {
  const fn = async body => { fn.calls.push(body); return { model: 'claude-haiku-4-5-20251001', stop_reason: 'end_turn', usage,
    content: [{ type: 'text', text: JSON.stringify({ reply, items }) }] }; };
  fn.calls = [];
  return fn;
}
async function call(method, route, { body, tk, ip } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (tk) headers.Authorization = 'Bearer ' + tk;
  if (ip) headers['X-Forwarded-For'] = ip;
  const r = await fetch(base + route, { method, headers, body: body && JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, body: JSON.parse(text), raw: text };
}
const say = (text, extra) => call('POST', '/api/agent/message', { body: Object.assign({ visitorId: 'visitor-0001', text }, extra) });
async function fresh() {
  catalog.reset(); await stock.reset(); await orders.reset(); await store.write('agent', null); await agent.init();
  Object.assign(cfg(), { maxMessagesPerDialog: 15, maxDialogsPerVisitorPerDay: 5, dailyBudgetUsd: 2 });
}

test.before(async () => {
  await auth.register('agent-owner', 'пароль-помощника-1');
  token = (await auth.login('agent-owner', 'пароль-помощника-1')).token;
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + server.address().port;
});
test.after(() => server.close());

test('без ключа помощник выключен, витрина работает', async () => {
  await fresh();
  delete process.env.MODEL_API_KEY;
  try {
    assert.deepEqual(agent.status(), { available: false, reason: 'нет ключа модели (MODEL_API_KEY)' });
    assert.equal((await call('GET', '/api/config')).body.agent.enabled, false, 'кнопки на витрине нет');
    const r = await say('подберите подарок');
    assert.deepEqual([r.status, r.body.error], [503, 'AGENT_OFF']);
    assert.equal((await call('GET', '/api/catalog')).status, 200, 'каталог работает');
    const o = await call('POST', '/api/orders', { body: { items: [{ id: 'SKU-001', qty: 1 }], channel: 'SITE', customer: { name: 'Покупатель' } } });
    assert.equal(o.status, 201, 'заказ оформляется');
  } finally { process.env.MODEL_API_KEY = KEY; }
  assert.equal((await call('GET', '/api/config')).body.agent.enabled, true);
  const tpl = fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'index.template.html'), 'utf8');
  assert.match(tpl, /cfg\.agent && cfg\.agent\.enabled/, 'витрина показывает кнопку только при включённом помощнике');
});

test('предложенные позиции существуют в каталоге и доступны по остатку', async () => {
  await fresh();
  await stock.adjust({ id: 'SKU-005', value: 0, reason: 'кончился' });
  await stock.adjust({ id: 'SKU-003', value: 2, reason: 'мало' });
  agent._setResponder(fakeModel('Возьмите эти три позиции.', [{ id: 'SKU-001', qty: 2 }, { id: 'SKU-003', qty: 5 }, { id: 'SKU-005', qty: 1 }]));
  const r = await say('подберите на праздник до 2000');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.items.map(i => [i.id, i.qty]), [['SKU-001', 2], ['SKU-003', 2]], 'количество урезано до остатка, закончившееся убрано');
  for (const i of r.body.items) {
    const p = catalog.byId(i.id);
    assert.ok(p, 'позиция есть в каталоге');
    assert.deepEqual([i.title, i.price], [p.title, p.price], 'название и цена — из каталога, не от модели');
    assert.ok(stock.availableStock(p, 'SITE') >= i.qty);
  }
  assert.match(r.body.reply, /Часть позиций сейчас закончилась/);
  assert.equal(r.body.total, catalog.quote([{ id: 'SKU-001', qty: 2 }, { id: 'SKU-003', qty: 2 }], 'SITE').total, 'сумму считает сервер');
});

test('выдуманный идентификатор в ответе модели отбрасывается и в корзину не попадает', async () => {
  await fresh();
  agent._setResponder(fakeModel('Советую «Мёд липовый элитный» и позицию вторую.', [{ id: 'MED-ELITE-999', qty: 1 }, { id: 'SKU-002', qty: 1 }]));
  const r = await say('что-нибудь сладкое');
  assert.deepEqual(r.body.items.map(i => i.id), ['SKU-002']);
  assert.ok(!r.raw.includes('MED-ELITE-999') && !r.raw.includes('Мёд липовый элитный'), 'выдуманное не показано покупателю');
  assert.equal(r.body.reply, 'Вот что есть в каталоге по вашему запросу.');
  agent._setResponder(fakeModel('Возьмите «Сыр пармезан».', [{ id: 'PARM-1', qty: 3 }]));
  const only = await say('а сыр есть?', { dialogId: r.body.dialogId });
  assert.deepEqual(only.body.items, []);
  assert.match(only.body.reply, /Не нашёл в каталоге подходящих позиций/);
  const turn = (await agent.stats()).recent[0].turns[1];
  assert.deepEqual(turn.dropped, [{ id: 'PARM-1', reason: 'нет в каталоге' }], 'отброшенное — в журнале');
});

test('вопрос про доставку или возврат — готовый ответ со ссылкой, а не сочинение', async () => {
  await fresh();
  const model = fakeModel('Доставим завтра, вернуть можно в течение 14 дней.', []);
  agent._setResponder(model);
  for (const q of ['Сколько стоит доставка в Казань?', 'Можно вернуть, если не подойдёт?', 'Как оплатить картой?']) {
    const r = await say(q);
    assert.equal(r.body.policy, true, q);
    assert.match(r.body.reply, /в документах магазина/);
    assert.deepEqual(r.body.links.map(l => l.url), ['/legal/returns.html', '/legal/offer.html']);
  }
  assert.equal(model.calls.length, 0, 'модель на эти вопросы не спрашивается');
  // и если модель сама заговорила о доставке — её текст заменяется готовым
  const r = await say('подберите что-нибудь к чаю');
  assert.equal(model.calls.length, 1);
  assert.equal(r.body.policy, true);
  assert.ok(!r.body.reply.includes('14 дней'));
  // срок годности — факт о продукте, а не политика: к модели
  agent._setResponder(fakeModel('Срок годности указан в описании.', []));
  assert.equal((await say('какой срок годности?')).body.policy, false);
});

test('шестнадцатое сообщение в диалоге отклоняется', async () => {
  await fresh();
  const model = fakeModel('Хорошо.', []);
  agent._setResponder(model);
  let dialogId;
  for (let i = 1; i <= 15; i++) {
    const r = await say('вопрос ' + i, { dialogId });
    assert.equal(r.status, 200, 'сообщение ' + i);
    dialogId = r.body.dialogId;
    assert.equal(r.body.messagesLeft, 15 - i);
  }
  const r16 = await say('шестнадцатый вопрос', { dialogId });
  assert.deepEqual([r16.status, r16.body.error], [429, 'AGENT_MESSAGE_LIMIT']);
  assert.match(r16.body.message, /Начните новый/);
  assert.equal(model.calls.length, 15, 'модель не вызывалась в шестнадцатый раз');
  // шестой диалог посетителя за сутки — тоже нет
  for (let i = 0; i < 4; i++) assert.equal((await say('новый разговор')).status, 200);
  const sixth = await say('ещё один разговор');
  assert.deepEqual([sixth.status, sixth.body.error], [429, 'AGENT_DIALOG_LIMIT']);
});

test('дневной потолок останавливает помощника, витрина работает', async () => {
  await fresh();
  cfg().dailyBudgetUsd = 0.005;                                  // одного ответа хватит, чтобы упереться
  agent._setResponder(fakeModel('Вот подборка.', [{ id: 'SKU-001', qty: 1 }], { input_tokens: 4000, output_tokens: 400 }));
  assert.equal((await say('подберите')).status, 200);
  const r = await say('ещё подберите');
  assert.deepEqual([r.status, r.body.error], [429, 'AGENT_BUDGET']);
  assert.match(r.body.message, /на сегодня отдыхает/);
  assert.equal((await call('GET', '/api/config')).body.agent.enabled, false, 'кнопка на витрине скрывается');
  assert.equal((await call('GET', '/api/catalog')).status, 200);
  const o = await call('POST', '/api/orders', { body: { items: [{ id: 'SKU-002', qty: 1 }], channel: 'SITE', customer: { name: 'Покупатель' } } });
  assert.equal(o.status, 201, 'заказы идут');
  const st = await call('GET', '/api/agent/stats', { tk: token });
  assert.equal(st.body.reason, 'дневной потолок исчерпан');
  // потолок не задан — помощник не включается вовсе: работа без потолка — риск расхода
  cfg().dailyBudgetUsd = 0;
  assert.match(agent.status().reason, /не задан дневной потолок/);
});

test('ключ не попадает в публичный конфиг, ответы и журнал; уходит только в заголовок запроса к модели', async () => {
  await fresh();
  agent._setResponder(fakeModel('Вот.', [{ id: 'SKU-001', qty: 1 }]));
  const seen = [await call('GET', '/api/config'), await call('GET', '/api/health'), await say('подберите'),
    await call('GET', '/api/agent/stats', { tk: token })];
  for (const r of seen) assert.ok(!r.raw.includes(KEY), 'ключ в ответе');
  assert.ok(!JSON.stringify(await store.read('agent')).includes(KEY), 'ключ в журнале');
  // настоящий вызов модели: ключ — только в x-api-key, адрес — API Anthropic, модель — из конфига
  const saved = global.fetch;
  let req;
  global.fetch = async (url, opts) => { req = { url, opts }; return new Response(JSON.stringify({ model: 'claude-haiku-4-5-20251001', stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'text', text: '{"reply":"ok","items":[]}' }] }), { status: 200 }); };
  try {
    agent._setResponder(null);                                  // по умолчанию — прямой запрос к Messages API
    await agent.message({ visitorId: 'visitor-0002', ip: '1.2.3.4', text: 'подберите' });
  } finally { global.fetch = saved; }
  assert.equal(req.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(req.opts.headers['x-api-key'], KEY);
  assert.equal(req.opts.headers['anthropic-version'], '2023-06-01');
  const body = JSON.parse(req.opts.body);
  assert.equal(body.model, cfg().model);
  assert.ok(!req.opts.body.includes(KEY), 'ключ не в теле запроса');
  assert.equal(body.output_config.format.type, 'json_schema');
});

test('в промпт идёт раздел фактов базы знаний, а политика — нет', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kb-')), 'knowledge.md');
  fs.writeFileSync(file, '# База\n\n## Факты о продукте\nМёд не нагревается выше 40 °C.\n\n## Политика (помощник НЕ отвечает)\nВозврат в течение 14 дней.\n');
  const saved = cfg().knowledgeFile;
  cfg().knowledgeFile = file;
  try {
    const sys = agent._system().map(b => b.text).join('\n');
    assert.match(sys, /Мёд не нагревается выше 40 °C/);
    assert.ok(!sys.includes('14 дней'), 'политика в промпт не попадает');
    assert.ok(catalog.all().every(p => sys.includes(p.id)), 'каталог продавца в промпте');
  } finally { cfg().knowledgeFile = saved; }
});

test('каждый диалог записан в журнал с расходом; заказы с участием помощника посчитаны', async () => {
  await fresh();
  agent._setResponder(fakeModel('Возьмите две первых.', [{ id: 'SKU-001', qty: 2 }], { input_tokens: 2000, output_tokens: 300 }));
  const r = await say('подберите на двоих');
  await say('Сколько стоит доставка?', { dialogId: r.body.dialogId });
  const o = await call('POST', '/api/orders', { body: { items: [{ id: 'SKU-001', qty: 2 }], channel: 'SITE',
    customer: { name: 'Покупатель' }, agentDialogId: r.body.dialogId } });
  await call('POST', '/api/orders', { body: { items: [{ id: 'SKU-002', qty: 1 }], channel: 'SITE', customer: { name: 'Б' }, agentDialogId: 'DLG-ВЫДУМАН' } });
  const st = (await call('GET', '/api/agent/stats', { tk: token })).body;
  assert.equal((await call('GET', '/api/agent/stats')).status, 401, 'статистика — за входом');
  const d = st.recent[0];
  assert.deepEqual([d.id, d.messages, d.turns.length], [r.body.dialogId, 2, 2]);
  assert.deepEqual([d.turns[0].text, d.turns[0].items.map(i => i.id + '×' + i.qty)], ['подберите на двоих', ['SKU-001×2']]);
  assert.equal(d.turns[0].costUsd, 0.0035, '2000 × $1 + 300 × $5 за миллион');
  assert.deepEqual([d.turns[1].policy, d.turns[1].costUsd], [true, 0], 'готовый ответ ничего не стоит');
  assert.deepEqual([st.today.dialogs, st.today.messages, st.today.costUsd, st.month.costUsd], [1, 2, 0.0035, 0.0035]);
  assert.deepEqual(st.orders, { count: 1, revenue: o.body.total, avgCheck: Math.round(o.body.total) }, 'выдуманный диалог заказ не отмечает');
  assert.deepEqual(st.limits, { maxMessagesPerDialog: 15, maxDialogsPerVisitorPerDay: 5, dailyBudgetUsd: 2 });
});
