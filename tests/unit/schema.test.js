'use strict';
const test = require('node:test');
const assert = require('node:assert');
const schema = require('../../api/lib/schema');
const config = require('../../api/lib/config');

const clone = o => JSON.parse(JSON.stringify(o));

test('рабочий конфиг проходит проверку без ошибок', () => {
  assert.deepEqual(schema.validate(config.load()), []);
});

test('ошибка называет поле и ожидаемое значение', () => {
  const bad = clone(config.load());
  bad.brand.palette.accent = '7b2ff7';           // забыли решётку
  const errors = schema.validate(bad);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /brand\.palette\.accent.*#RRGGBB/);
});

test('недопустимые значения перечислений отбиваются', () => {
  const bad = clone(config.load());
  bad.stock.scheme = 'какая-то-схема';
  bad.payments.settlementDefault = 'ESCROW';
  bad.brand.typography = 'comic';
  const errors = schema.validate(bad).join('\n');
  assert.match(errors, /stock\.scheme/);
  assert.match(errors, /settlementDefault/);
  assert.match(errors, /typography/);
});

test('сервис не поднимается на негодном конфиге', () => {
  const bad = clone(config.load());
  delete bad.brand.name;
  assert.throws(() => schema.assertValid(bad, 'brand.test.json'), /не прошла проверку/);
});

test('без идентификатора экземпляра конфиг не проходит: к нему привязан вход в кабинет', () => {
  const bad = clone(config.load());
  delete bad.instance;
  assert.match(schema.validate(bad).join('\n'), /instance\.id/);
});

test('повтор кодов каналов — ошибка', () => {
  const bad = clone(config.load());
  bad.channels.push(clone(bad.channels[0]));
  assert.match(schema.validate(bad).join('\n'), /коды каналов повторяются/);
});
